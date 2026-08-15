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
 */
function hasValidBoundary(textBeforeCursor: string, matchStart: number, flags: SnippetFlags): boolean {
	if (flags.inWord) {return true;}
	if (flags.beginningOfLine) {return /^\s*$/.test(textBeforeCursor.slice(0, matchStart));}
	const before = matchStart > 0 ? textBeforeCursor[matchStart - 1] : undefined;
	return before === undefined || !/\w/.test(before);
}

function findMatch(snippet: Snippet, document: vscode.TextDocument, position: vscode.Position, mathContext: MathContextTracker): SnippetMatch | null {
	const textBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);

	let start: number;
	let groups: RegExpExecArray | null = null;
	if (typeof snippet.trigger === 'string') {
		if (!textBeforeCursor.endsWith(snippet.trigger)) {return null;}
		start = textBeforeCursor.length - snippet.trigger.length;
	} else {
		const m = snippet.trigger.exec(textBeforeCursor);
		if (!m) {return null;}
		start = m.index;
		groups = m;
	}

	if (!hasValidBoundary(textBeforeCursor, start, snippet.flags)) {return null;}
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
