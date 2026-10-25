import * as vscode from 'vscode';
import { advancePosition } from './snippetTemplate';

interface LineSpan {
	start: number;
	end: number;
}

interface RunState {
	// Line span a real native tabstop session (2+ distinct placeholders)
	// may still be live within. Tracked as a line range rather than a
	// single point because Tab-navigating between its own tabstops (e.g.
	// $1 to $2) moves the cursor with no edit event to follow, so a single
	// tracked position goes stale the moment the user leaves the first
	// tabstop - any edit still landing within the original lines is
	// presumed part of the same session. Cleared for certain only once VS
	// Code itself confirms the session is over (see endNativeSession).
	nativeSessionLines?: LineSpan;
	// Position where an unbroken run of plain (0-1 placeholder) auto-expand
	// chaining currently ends. Plain expansions never start a native
	// session, so chaining several of them (e.g. multiple inline math
	// shortcuts in one $ $) is always safe regardless of what triggered it.
	autoRunEnd?: vscode.Position;
	// Trailing static text of every snippet-with-a-placeholder expanded so
	// far in the current run, innermost last. Chaining a snippet that
	// itself has a placeholder (e.g. a fraction's denominator) inside
	// another (e.g. mk's $ $) nests a second trailing boundary, so a
	// single flat suffix isn't enough - each exit pops and jumps past one
	// level. Kept as text rather than a length since it can contain
	// newlines a plain character offset can't walk.
	pendingExits: string[];
	// A chained plain run can itself need a real native session (e.g. int,
	// with 4 fields). Going native must hand navigation to VS Code, which
	// means clearing autoRunEnd/pendingExits - but that would otherwise
	// silently strand whatever the plain run was still waiting to exit
	// (e.g. mk's closing $, just past int's own template). This holds that
	// stack, along with the line span of the session it was paused for.
	// It's only resumed from within that span (the stranded exit sits just
	// past the session's template), and dropped as soon as an edit lands
	// outside it, since the user has moved on.
	paused?: { exits: string[]; lines: LineSpan };
}

function freshState(): RunState {
	return { pendingExits: [] };
}

/**
 * Returns false if `change` landed outside `span`. Otherwise grows or
 * shrinks `span` by the number of lines the change adds or removes, and
 * returns true.
 */
function trackSpan(span: LineSpan, change: vscode.TextDocumentContentChangeEvent | undefined): boolean {
	if (change === undefined || change.range.end.line < span.start || change.range.end.line > span.end) {return false;}
	const added = (change.text.match(/\n/g) ?? []).length;
	const removed = change.range.end.line - change.range.start.line;
	span.end = Math.max(span.start, span.end + added - removed);
	return true;
}

/**
 * Tracks, per document, how far an unbroken run of auto-expand chaining
 * currently extends and what trailing text (if any) still needs exiting
 * past, plus whether a real native tabstop session may still be live.
 * Scoped per document so switching editors can't let stale tracking from
 * one document affect another.
 */
export class RunTracker {
	private states = new Map<string, RunState>();

	private state(uri: vscode.Uri): RunState {
		const key = uri.toString();
		let state = this.states.get(key);
		if (!state) {
			state = freshState();
			this.states.set(key, state);
		}
		return state;
	}

	forget(uri: vscode.Uri) {
		this.states.delete(uri.toString());
	}

	/** Drops all tracking for a document - e.g. after an undo/redo, whose edit shape doesn't mean anything for run-tracking. */
	reset(uri: vscode.Uri) {
		this.states.set(uri.toString(), freshState());
	}

	isNativeSessionActive(uri: vscode.Uri): boolean {
		return this.state(uri).nativeSessionLines !== undefined;
	}

	/** Advances or breaks tracking for a single plain user keystroke. Callers must not invoke this for edits they made themselves. */
	onEdit(uri: vscode.Uri, change: vscode.TextDocumentContentChangeEvent | undefined) {
		const state = this.state(uri);

		if (state.nativeSessionLines !== undefined && !trackSpan(state.nativeSessionLines, change)) {
			state.nativeSessionLines = undefined;
		}
		if (state.paused !== undefined && !trackSpan(state.paused.lines, change)) {
			state.paused = undefined;
		}

		if (state.autoRunEnd !== undefined) {
			// No whitespace check here: a space or newline can be part of the
			// same ongoing expression (e.g. "5x^2 + 4x^2", or content
			// spanning multiple lines inside dm) - only an edit that doesn't
			// touch the tracked position means we've moved on.
			const stillLive = change !== undefined && change.range.end.isEqual(state.autoRunEnd);
			state.autoRunEnd = stillLive ? advancePosition(change!.range.start, change!.text) : undefined;
			if (state.autoRunEnd === undefined) {
				state.pendingExits = [];
			}
		}
	}

	/**
	 * Records a real native tabstop session starting (2+ distinct
	 * placeholders) from the trigger text at `trigger`, spanning through
	 * line `endLine` of its initial (pre-edit) rendering. An outer run's
	 * pending exits are paused only if the trigger was typed right where
	 * that run left off.
	 */
	recordNativeExpansion(uri: vscode.Uri, trigger: vscode.Range, endLine: number) {
		const state = this.state(uri);
		const continuing = state.autoRunEnd !== undefined && state.autoRunEnd.isEqual(trigger.end);
		state.nativeSessionLines = { start: trigger.start.line, end: endLine };
		if (continuing && state.pendingExits.length > 0) {
			state.paused = { exits: state.pendingExits, lines: { ...state.nativeSessionLines } };
		}
		state.autoRunEnd = undefined;
		state.pendingExits = [];
	}

	/**
	 * Confirms a live native session (if any) is over. Only meaningful to
	 * call once VS Code itself reports !inSnippetMode (i.e. from the
	 * Tab-exit command's own handler) - that's the one signal here that
	 * isn't just a position-based guess.
	 */
	endNativeSession(uri: vscode.Uri) {
		this.state(uri).nativeSessionLines = undefined;
	}

	/**
	 * Records a plain-text expansion (0-1 distinct placeholders) of the
	 * trigger text at `trigger`, whose cursor ended up at `cursor`, with its
	 * own trailing text `ownSuffix` if it had a placeholder. It joins the
	 * current run only if the trigger was typed right where that run left
	 * off (e.g. not a Tab-expansion somewhere else) - otherwise it starts a
	 * fresh one.
	 */
	recordPlainExpansion(uri: vscode.Uri, trigger: vscode.Range, cursor: vscode.Position, ownSuffix: string | undefined) {
		const state = this.state(uri);

		// Nested inside a still-live native tabstop session: any outer run's
		// paused exit must stay paused until that session genuinely ends, not
		// get resumed at this nested position - our own Tab-exit has no way
		// to fire yet anyway, since native navigation still owns Tab.
		if (state.nativeSessionLines !== undefined) {return;}

		const continuing = state.autoRunEnd !== undefined && state.autoRunEnd.isEqual(trigger.end);
		if (!continuing && !this.tryResume(state, trigger.start)) {
			state.pendingExits = [];
		}
		if (ownSuffix !== undefined) {
			state.pendingExits.push(ownSuffix);
		}
		state.autoRunEnd = cursor;
	}

	/**
	 * If nothing matched to expand at `position`, pops and returns the
	 * position just past the innermost pending exit (e.g. a chained
	 * fraction's own closing }), when the cursor is sitting right where the
	 * run left off - undefined otherwise. A native session having just
	 * ended (the caller only invokes this once VS Code itself reports
	 * !inSnippetMode) resumes a paused outer run first, if the cursor is
	 * still within that session's lines. A still-active native session
	 * refuses outright, rather than relying solely on the caller having
	 * called endNativeSession() first.
	 */
	tryExit(uri: vscode.Uri, position: vscode.Position): vscode.Position | undefined {
		const state = this.state(uri);
		if (state.nativeSessionLines !== undefined) {return undefined;}
		if (state.autoRunEnd === undefined && this.tryResume(state, position)) {
			state.autoRunEnd = position;
		}
		if (state.pendingExits.length === 0 || state.autoRunEnd === undefined || !state.autoRunEnd.isEqual(position)) {
			return undefined;
		}
		const suffix = state.pendingExits.pop()!;
		const exit = advancePosition(state.autoRunEnd, suffix);
		state.autoRunEnd = exit;
		return exit;
	}

	/** Restores paused exits as the pending ones, if `at` is within the line span of the session they were paused for. */
	private tryResume(state: RunState, at: vscode.Position): boolean {
		const paused = state.paused;
		if (paused === undefined || at.line < paused.lines.start || at.line > paused.lines.end) {return false;}
		state.pendingExits = paused.exits;
		state.paused = undefined;
		return true;
	}
}
