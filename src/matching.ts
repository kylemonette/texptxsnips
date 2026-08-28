import * as vscode from 'vscode';
import { Snippet, SnippetFlags } from './types';
import { MathContextTracker } from './mathContext';

export interface SnippetMatch {
	snippet: Snippet;
	range: vscode.Range;
	groups: RegExpExecArray | null;
}

/**
 * A match always ends exactly at the cursor, so "word boundary" and the
 * default rule coincide: both just require the character before the match
 * to not be a word character. `i` (inWord) drops that constraint entirely.
 * Only constrains bare-word triggers - a regex trigger's pattern is the sole
 * word-boundary mechanism (e.g. an auto-subscript regex needs to match right
 * after a digit, which this would otherwise block).
 */
function hasWordBoundary(textBeforeCursor: string, matchStart: number, flags: SnippetFlags): boolean {
	if (flags.inWord) {return true;}
	const before = matchStart > 0 ? textBeforeCursor[matchStart - 1] : undefined;
	return before === undefined || !/\w/.test(before);
}

/**
 * `b` requires nothing but whitespace before the match on the line. Unlike
 * i/w, this applies to both trigger kinds: it's an added constraint on top
 * of whatever the trigger already matched, not a substitute for the regex's
 * own boundary logic - so a regex trigger can rely on `b` for this instead
 * of re-deriving it with its own `^\s*` (a bare `^`, unlike `b`, anchors to
 * the true start of the string and rejects any leading whitespace).
 */
function isAtLineStart(textBeforeCursor: string, matchStart: number): boolean {
	return /^\s*$/.test(textBeforeCursor.slice(0, matchStart));
}

function findMatch(snippet: Snippet, document: vscode.TextDocument, position: vscode.Position, mathContext: MathContextTracker): SnippetMatch | null {
	const textBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);

	let start: number;
	let groups: RegExpExecArray | null = null;
	if (typeof snippet.trigger === 'string') {
		if (!textBeforeCursor.endsWith(snippet.trigger)) {return null;}
		start = textBeforeCursor.length - snippet.trigger.length;
		// i/w only constrain string triggers. A regex trigger's pattern is
		// the sole word-boundary mechanism (e.g. a (?<!\\) lookbehind) - the
		// flags still control auto-expand/math-gating/etc, just not this check.
		if (!hasWordBoundary(textBeforeCursor, start, snippet.flags)) {return null;}
	} else {
		const m = snippet.trigger.exec(textBeforeCursor);
		if (!m) {return null;}
		start = m.index;
		groups = m;
	}

	if (snippet.flags.beginningOfLine && !isAtLineStart(textBeforeCursor, start)) {return null;}
	if (snippet.flags.mathOnly && !mathContext.isMath(document, position)) {return null;}

	return {
		snippet,
		range: new vscode.Range(position.line, start, position.line, position.character),
		groups,
	};
}

export function getMatches(snippets: Snippet[], document: vscode.TextDocument, position: vscode.Position, mathContext: MathContextTracker): SnippetMatch[] {
	const matches: SnippetMatch[] = [];
	for (const snippet of snippets) {
		const match = findMatch(snippet, document, position, mathContext);
		if (match) {matches.push(match);}
	}
	return matches;
}
