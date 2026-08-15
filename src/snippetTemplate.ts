import * as vscode from 'vscode';

/**
 * Resolves raw vscode.SnippetString syntax ($0, $1, ${1}, ${1:default},
 * \$ \\ \}) to plain text, for inserting as a normal edit instead of
 * starting a new native snippet session. Tabstops without a default
 * collapse to nothing; $0/${0} marks the resulting cursor offset.
 */
export function resolvePlainText(template: string): { text: string; cursorOffset: number } {
	let out = '';
	let cursorOffset: number | undefined;
	let i = 0;
	while (i < template.length) {
		const c = template[i];
		if (c === '\\' && i + 1 < template.length) {
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
				const num = template.slice(numStart, j);
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
				if (num === '0') {cursorOffset = out.length;}
				out += defaultText;
				i = j;
				continue;
			}
		}
		out += c;
		i += 1;
	}
	return { text: out, cursorOffset: cursorOffset ?? out.length };
}

/** Advances a Position by inserted text, accounting for embedded newlines. */
export function advancePosition(start: vscode.Position, text: string): vscode.Position {
	const lines = text.split('\n');
	if (lines.length === 1) {return start.translate(0, text.length);}
	return new vscode.Position(start.line + lines.length - 1, lines[lines.length - 1].length);
}

/** True if the template has real navigable placeholders beyond a bare final $0. */
export function hasNavigableTabstops(template: string): boolean {
	return /\$\{?[1-9]/.test(template);
}
