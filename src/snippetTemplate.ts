import * as vscode from 'vscode';

export interface ResolvedTemplate {
	/** Raw vscode.SnippetString syntax with tabstops/escapes resolved to plain text. */
	text: string;
	/** Offset of $0 (final tabstop) in `text`, or end-of-text if absent. */
	cursorOffset: number;
	/** Offset of the lowest-numbered tabstop other than $0, if any. */
	firstPlaceholderOffset: number | undefined;
}

/**
 * Resolves raw vscode.SnippetString syntax ($0, $1, ${1}, ${1:default},
 * \$ \\ \}) to plain text, the way VS Code renders a snippet's initial
 * state (defaults kept). Used to predict where a native snippet session
 * would place the cursor, without actually starting one.
 */
export function resolveTemplate(template: string): ResolvedTemplate {
	let out = '';
	let cursorOffset: number | undefined;
	let firstPlaceholderOffset: number | undefined;
	let firstPlaceholderNum: number | undefined;
	let i = 0;
	while (i < template.length) {
		const c = template[i];
		// VS Code's snippet grammar only recognizes \$, \} and \\ as escapes;
		// any other backslash (e.g. LaTeX's \[, \], \\) is a literal char.
		if (c === '\\' && i + 1 < template.length && '$}\\'.includes(template[i + 1])) {
			out += template[i + 1];
			i += 2;
			continue;
		}
		if (c === '$') {
			let j = i + 1;
			const braced = template[j] === '{';
			if (braced) {j++;}
			const numStart = j;
			while (j < template.length && /[0-9]/.test(template[j])) {j++;}
			if (j > numStart) {
				const num = parseInt(template.slice(numStart, j), 10);
				let defaultText = '';
				if (braced && template[j] === ':') {
					let depth = 1;
					let k = j + 1;
					while (k < template.length && depth > 0) {
						if (template[k] === '{') {depth++;}
						else if (template[k] === '}') {depth--;}
						if (depth > 0) {k++;}
					}
					defaultText = template.slice(j + 1, k);
					j = k;
				}
				if (braced && template[j] === '}') {j++;}
				if (num === 0) {
					cursorOffset = out.length;
				} else if (firstPlaceholderNum === undefined || num < firstPlaceholderNum) {
					firstPlaceholderNum = num;
					firstPlaceholderOffset = out.length;
				}
				out += defaultText;
				i = j;
				continue;
			}
		}
		out += c;
		i += 1;
	}
	return { text: out, cursorOffset: cursorOffset ?? out.length, firstPlaceholderOffset };
}

/** Advances a Position by inserted text, accounting for embedded newlines. */
export function advancePosition(start: vscode.Position, text: string): vscode.Position {
	const lines = text.split('\n');
	if (lines.length === 1) {return start.translate(0, text.length);}
	return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}
