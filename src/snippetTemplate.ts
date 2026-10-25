import * as vscode from 'vscode';

export interface ResolvedTemplate {
	/** Raw vscode.SnippetString syntax with tabstops/escapes resolved to plain text. */
	text: string;
	/** Offset of $0 (final tabstop) in `text`, or end-of-text if absent. */
	cursorOffset: number;
	/** Offset of the lowest-numbered tabstop other than $0, if any. */
	firstPlaceholderOffset: number | undefined;
	/** Offset just past that tabstop's default text (equal to firstPlaceholderOffset when it has none); defined exactly when it is. */
	firstPlaceholderEnd: number | undefined;
	/** Count of distinct tabstop numbers other than $0 (repeats of the same $N count once). */
	placeholderCount: number;
	/**
	 * True when only a real VS Code snippet session can insert this
	 * faithfully: 2+ distinct tabstops to Tab between, a tabstop repeated as
	 * a mirror, a choice, a variable, or a transform. `text` is then only an
	 * approximation (e.g. mirrors and variables render empty), good enough
	 * to count its lines.
	 */
	needsNativeSession: boolean;
}

interface ParseState {
	out: string;
	cursorOffset: number | undefined;
	firstPlaceholderNum: number | undefined;
	firstPlaceholderOffset: number | undefined;
	firstPlaceholderEnd: number | undefined;
	/** occurrences of each tabstop number other than $0 */
	counts: Map<number, number>;
	/** set by syntax only a native session renders: choices, variables, transforms */
	unsupported: boolean;
}

/**
 * Resolves raw vscode.SnippetString syntax to plain text, the way VS Code
 * renders a snippet's initial state (defaults kept, nested placeholders
 * expanded). Follows VS Code's own snippet grammar: only \$, \} and \\ are
 * escapes, `$`/`${` that doesn't start a valid construct (including an
 * unterminated `${1:...`) is literal text, and a `}` is only special while
 * inside a placeholder's default. Used to predict where a native snippet
 * session would place the cursor, without actually starting one.
 */
export function resolveTemplate(template: string): ResolvedTemplate {
	const state: ParseState = {
		out: '',
		cursorOffset: undefined,
		firstPlaceholderNum: undefined,
		firstPlaceholderOffset: undefined,
		firstPlaceholderEnd: undefined,
		counts: new Map(),
		unsupported: false,
	};
	parseSequence(template, 0, state, false);
	const repeated = [...state.counts.values()].some((n) => n > 1);
	return {
		text: state.out,
		cursorOffset: state.cursorOffset ?? state.out.length,
		firstPlaceholderOffset: state.firstPlaceholderOffset,
		firstPlaceholderEnd: state.firstPlaceholderEnd,
		placeholderCount: state.counts.size,
		needsNativeSession: state.unsupported || repeated || state.counts.size >= 2,
	};
}

/**
 * Appends the rendering of `t` from index `i` to `state.out`. Inside a
 * placeholder's default (`nested`), stops at the first unescaped `}` and
 * returns its index; otherwise runs to the end. Returns `t.length` if it
 * runs out of text.
 */
function parseSequence(t: string, i: number, state: ParseState, nested: boolean): number {
	while (i < t.length) {
		const c = t[i];
		if (c === '\\' && i + 1 < t.length && '$}\\'.includes(t[i + 1])) {
			state.out += t[i + 1];
			i += 2;
			continue;
		}
		if (nested && c === '}') {return i;}
		if (c === '$') {
			const next = parseDollar(t, i, state);
			if (next !== null) {
				i = next;
				continue;
			}
		}
		state.out += c;
		i += 1;
	}
	return i;
}

/**
 * Parses a tabstop, placeholder, choice, variable or transform starting at
 * the `$` at index `i`, appending its rendering to `state.out`. Returns the
 * index just past it, or null (with `state` untouched) if it isn't a valid
 * construct, in which case the `$` is literal text.
 */
function parseDollar(t: string, i: number, state: ParseState): number | null {
	let j = i + 1;
	const braced = t[j] === '{';
	if (braced) {j++;}

	const num = /^[0-9]+/.exec(t.slice(j));
	if (num) {
		const n = parseInt(num[0], 10);
		j += num[0].length;
		if (!braced) {
			recordTabstop(state, n, state.out.length);
			return j;
		}
		if (t[j] === '}') {
			recordTabstop(state, n, state.out.length);
			return j + 1;
		}
		if (t[j] === ':') {
			const snapshot = { ...state, counts: new Map(state.counts) };
			const offset = state.out.length;
			recordTabstop(state, n, offset);
			const end = parseSequence(t, j + 1, state, true);
			if (end < t.length) {
				// still the first placeholder, not displaced by a lower-numbered one nested in its default
				if (state.firstPlaceholderNum === n && state.firstPlaceholderOffset === offset) {
					state.firstPlaceholderEnd = state.out.length;
				}
				return end + 1;
			}
			Object.assign(state, snapshot); // unterminated: backtrack to literal text
			return null;
		}
		if (t[j] === '|') {
			const end = findChoiceEnd(t, j + 1);
			if (end === null) {return null;}
			const offset = state.out.length;
			recordTabstop(state, n, offset);
			state.out += t.slice(j + 1, end).split(',')[0];
			if (state.firstPlaceholderNum === n && state.firstPlaceholderOffset === offset) {
				state.firstPlaceholderEnd = state.out.length;
			}
			state.unsupported = true;
			return end + 2;
		}
		if (t[j] === '/') {
			const end = findClosingBrace(t, j + 1);
			if (end === null) {return null;}
			recordTabstop(state, n, state.out.length);
			state.unsupported = true;
			return end + 1;
		}
		return null;
	}

	const name = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(t.slice(j));
	if (!name) {return null;}
	j += name[0].length;
	if (!braced) {
		state.unsupported = true;
		return j;
	}
	if (t[j] === '}') {
		state.unsupported = true;
		return j + 1;
	}
	if (t[j] === ':') {
		const snapshot = { ...state, counts: new Map(state.counts) };
		const end = parseSequence(t, j + 1, state, true);
		if (end < t.length) {
			state.unsupported = true;
			return end + 1;
		}
		Object.assign(state, snapshot);
		return null;
	}
	if (t[j] === '/') {
		const end = findClosingBrace(t, j + 1);
		if (end === null) {return null;}
		state.unsupported = true;
		return end + 1;
	}
	return null;
}

function recordTabstop(state: ParseState, n: number, offset: number) {
	if (n === 0) {
		state.cursorOffset = offset;
		return;
	}
	state.counts.set(n, (state.counts.get(n) ?? 0) + 1);
	if (state.firstPlaceholderNum === undefined || n < state.firstPlaceholderNum) {
		state.firstPlaceholderNum = n;
		state.firstPlaceholderOffset = offset;
		state.firstPlaceholderEnd = offset;
	}
}

/** Index of the `|` of a choice's closing `|}`, searching from `i` and skipping escapes. */
function findChoiceEnd(t: string, i: number): number | null {
	for (; i < t.length - 1; i++) {
		if (t[i] === '\\') {i++; continue;}
		if (t[i] === '|' && t[i + 1] === '}') {return i;}
	}
	return null;
}

/** Index of the `}` closing a transform, searching from `i`, skipping escapes and nested `${...}` in its format. */
function findClosingBrace(t: string, i: number): number | null {
	let depth = 0;
	for (; i < t.length; i++) {
		if (t[i] === '\\') {i++; continue;}
		if (t[i] === '{') {depth++;}
		else if (t[i] === '}') {
			if (depth === 0) {return i;}
			depth--;
		}
	}
	return null;
}

export interface IndentOptions {
	insertSpaces: boolean;
	indentSize: number;
}

/** Rewrites leading whitespace in the editor's style, counting a tab as reaching the next indent stop - VS Code's own normalizeIndentation. */
function normalizeIndentation(line: string, options: IndentOptions): string {
	const wsEnd = line.search(/[^ \t]/);
	const ws = wsEnd === -1 ? line : line.slice(0, wsEnd);
	let columns = 0;
	for (const ch of ws) {
		columns = ch === '\t' ? columns + options.indentSize - (columns % options.indentSize) : columns + 1;
	}
	let result = '';
	if (!options.insertSpaces) {
		result = '\t'.repeat(Math.floor(columns / options.indentSize));
		columns %= options.indentSize;
	}
	return result + ' '.repeat(columns) + line.slice(ws.length);
}

/**
 * Adjusts a raw snippet template's whitespace the way VS Code's
 * insertSnippet does before inserting it: every line after the first gets
 * `indent` (the trigger line's own leading whitespace) prefixed, and each
 * line's leading whitespace is normalized to the editor's tabs/spaces
 * setting. Lets a plain-text expansion line up the same as a native one.
 */
export function indentTemplate(template: string, indent: string, options: IndentOptions): string {
	return template
		.split(/\r\n|\r|\n/)
		.map((line, idx) => normalizeIndentation(idx === 0 ? line : indent + line, options))
		.join('\n');
}

/** Advances a Position by inserted text, accounting for embedded newlines. */
export function advancePosition(start: vscode.Position, text: string): vscode.Position {
	const lines = text.split('\n');
	if (lines.length === 1) {return start.translate(0, text.length);}
	return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}
