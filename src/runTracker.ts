import * as vscode from 'vscode';
import { advancePosition } from './snippetTemplate';

interface RunState {
	// Position where a real native tabstop session (2+ distinct
	// placeholders) started via Tab may still be live. Auto-expand is
	// gated on this being undefined, since VS Code's snippet controller
	// can't tell our own edits apart from a nested snippet insertion - any
	// programmatic edit landing inside its tracked range loses track of
	// its remaining tabstops. Normal typing doesn't trip this because it
	// goes through VS Code's own input pipeline rather than an extension's
	// edit API.
	nativeSessionEnd?: vscode.Position;
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
	// stack while the nested native session is live, resumed once we can
	// next confirm it's over.
	pausedExits?: string[];
}

function freshState(): RunState {
	return { pendingExits: [] };
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
		return this.state(uri).nativeSessionEnd !== undefined;
	}

	/** Advances or breaks tracking for a single plain user keystroke. Callers must not invoke this for edits they made themselves. */
	onEdit(uri: vscode.Uri, change: vscode.TextDocumentContentChangeEvent | undefined) {
		const state = this.state(uri);

		if (state.nativeSessionEnd !== undefined) {
			// Whitespace also breaks this one: it only exists to protect a
			// real Tab-started session, and once the user has moved on to
			// typing unrelated content there's no reason to keep guarding it.
			const stillLive = change !== undefined && !/\s/.test(change.text) && change.range.end.isEqual(state.nativeSessionEnd);
			state.nativeSessionEnd = stillLive ? advancePosition(change!.range.start, change!.text) : undefined;
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

	/** Records a real native tabstop session starting (2+ distinct placeholders). */
	recordNativeExpansion(uri: vscode.Uri, nativeSessionEnd: vscode.Position | undefined) {
		const state = this.state(uri);
		state.nativeSessionEnd = nativeSessionEnd;
		if (state.autoRunEnd !== undefined && state.pendingExits.length > 0) {
			state.pausedExits = state.pendingExits;
		}
		state.autoRunEnd = undefined;
		state.pendingExits = [];
	}

	/** Records a plain-text expansion (0-1 distinct placeholders) whose cursor ended up at `cursor`, with its own trailing text `ownSuffix` if it had a placeholder. */
	recordPlainExpansion(uri: vscode.Uri, cursor: vscode.Position, ownSuffix: string | undefined) {
		const state = this.state(uri);
		const resuming = this.tryResume(state);
		if (state.autoRunEnd === undefined && !resuming) {
			state.pendingExits = ownSuffix !== undefined ? [ownSuffix] : [];
		} else if (ownSuffix !== undefined) {
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
	 * !inSnippetMode) resumes a paused outer run first.
	 */
	tryExit(uri: vscode.Uri, position: vscode.Position): vscode.Position | undefined {
		const state = this.state(uri);
		if (state.autoRunEnd === undefined) {
			this.tryResume(state, position);
		}
		if (state.pendingExits.length === 0 || state.autoRunEnd === undefined || !state.autoRunEnd.isEqual(position)) {
			return undefined;
		}
		const suffix = state.pendingExits.pop()!;
		const exit = advancePosition(state.autoRunEnd, suffix);
		state.autoRunEnd = exit;
		return exit;
	}

	private tryResume(state: RunState, atPosition?: vscode.Position): boolean {
		if (state.autoRunEnd !== undefined || state.pausedExits === undefined) {return false;}
		state.pendingExits = state.pausedExits;
		state.pausedExits = undefined;
		if (atPosition !== undefined) {state.autoRunEnd = atPosition;}
		return true;
	}

	/** Formats current state for diagnostic logging. */
	debugSnapshot(uri: vscode.Uri): string {
		const s = this.state(uri);
		const pos = (p: vscode.Position | undefined) => (p ? `${p.line}:${p.character}` : 'undefined');
		return `nativeSessionEnd=${pos(s.nativeSessionEnd)} autoRunEnd=${pos(s.autoRunEnd)} pendingExits=${JSON.stringify(s.pendingExits)} pausedExits=${JSON.stringify(s.pausedExits)}`;
	}
}
