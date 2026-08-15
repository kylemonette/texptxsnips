import * as vscode from 'vscode';

type Mode = 'text' | 'math';

// Environments whose body is typeset in math mode.
const MATH_ENVIRONMENTS = new Set([
	'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
	'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*',
	'alignat', 'alignat*', 'math', 'displaymath', 'array',
	'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix',
	'split', 'gathered', 'aligned', 'alignedat', 'subarray', 'tikzcd',
]);

// Commands whose brace argument switches back to prose/text mode.
// \mathrm, \mathbf, \operatorname etc. are math-symbol formatting, not a
// language switch, so they stay in math context and are deliberately excluded.
const TEXT_SWITCH_COMMANDS = new Set(['text', 'textrm', 'textnormal', 'mbox', 'intertext']);

type Frame =
	| { kind: 'root' }
	| { kind: 'group'; mode: Mode }
	| { kind: 'dollar' }
	| { kind: 'dollardollar' }
	| { kind: 'paren' }
	| { kind: 'bracket' }
	| { kind: 'env'; mode: Mode };

function frameMode(frame: Frame): Mode {
	switch (frame.kind) {
		case 'root':
			return 'text';
		case 'group':
		case 'env':
			return frame.mode;
		default:
			return 'math';
	}
}

function currentMode(stack: Frame[]): Mode {
	return frameMode(stack[stack.length - 1]);
}

/**
 * Scans LaTeX source left to right, tokenizing control sequences as atomic
 * units before ever comparing substrings. This is what keeps `\\[1em]` from
 * being misread as the display-math opener `\[`: the leading `\\` is
 * consumed as one control-symbol token, leaving `[` as a plain character.
 */
function scanLine(text: string, stack: Frame[]): Frame[] {
	const out = stack.slice();
	let i = 0;
	while (i < text.length) {
		const c = text[i];

		if (c === '%') {
			break; // rest of the line is a comment
		}

		if (c === '\\') {
			const next = text[i + 1];
			if (next === undefined) {
				i += 1;
				continue;
			}
			if (/[a-zA-Z]/.test(next)) {
				let j = i + 1;
				while (j < text.length && /[a-zA-Z]/.test(text[j])) {j++;}
				const name = text.slice(i + 1, j);
				i = j;
				handleControlWord(name, text, out, (skip) => { i += skip; });
				continue;
			}
			// control symbol: backslash + exactly one non-letter char
			if (next === '(') {
				out.push({ kind: 'paren' });
			} else if (next === ')') {
				popIf(out, 'paren');
			} else if (next === '[') {
				out.push({ kind: 'bracket' });
			} else if (next === ']') {
				popIf(out, 'bracket');
			}
			i += 2;
			continue;
		}

		if (c === '{') {
			out.push({ kind: 'group', mode: currentMode(out) });
			i += 1;
			continue;
		}
		if (c === '}') {
			if (out.length > 1) {out.pop();}
			i += 1;
			continue;
		}

		if (c === '$') {
			if (text[i + 1] === '$') {
				if (out[out.length - 1]?.kind === 'dollardollar') {out.pop();}
				else {out.push({ kind: 'dollardollar' });}
				i += 2;
			} else {
				if (out[out.length - 1]?.kind === 'dollar') {out.pop();}
				else {out.push({ kind: 'dollar' });}
				i += 1;
			}
			continue;
		}

		i += 1;
	}
	return out;
}

function popIf(stack: Frame[], kind: Frame['kind']) {
	if (stack[stack.length - 1]?.kind === kind) {stack.pop();}
}

function handleControlWord(name: string, text: string, stack: Frame[], advance: (n: number) => void) {
	if (name === 'begin' || name === 'end') {
		const rest = text.slice(text.indexOf(name) + name.length);
		const match = /^\{([^}]*)\}/.exec(rest);
		if (match) {
			advance(match[0].length);
			const envName = match[1];
			if (name === 'begin') {
				stack.push({ kind: 'env', mode: MATH_ENVIRONMENTS.has(envName) ? 'math' : currentMode(stack) });
			} else {
				popIf(stack, 'env');
			}
		}
		return;
	}
	if (TEXT_SWITCH_COMMANDS.has(name) && text[text.indexOf(name) + name.length] === '{') {
		advance(1); // consume the opening brace here so it inherits text mode
		stack.push({ kind: 'group', mode: 'text' });
	}
}

/**
 * Tracks LaTeX math-mode context per document with an incremental,
 * forward-only tokenizer, instead of rescanning the whole buffer on every
 * keystroke. On edit, cached line states from the first changed line onward
 * are dropped and lazily rebuilt only up to whatever line is next queried.
 */
export class MathContextTracker {
	/** stacks[i] = frame stack at the start of line i, per document */
	private caches = new Map<string, Frame[][]>();

	invalidate(uri: vscode.Uri, fromLine: number) {
		const stacks = this.caches.get(uri.toString());
		if (!stacks) {return;}
		stacks.length = Math.min(stacks.length, fromLine + 1);
	}

	forget(uri: vscode.Uri) {
		this.caches.delete(uri.toString());
	}

	isMath(document: vscode.TextDocument, position: vscode.Position): boolean {
		const key = document.uri.toString();
		let stacks = this.caches.get(key);
		if (!stacks) {
			stacks = [[{ kind: 'root' }]];
			this.caches.set(key, stacks);
		}

		for (let line = stacks.length - 1; line < position.line; line++) {
			stacks.push(scanLine(document.lineAt(line).text, stacks[line]));
		}

		const stackBefore = stacks[position.line];
		const finalStack = scanLine(document.lineAt(position.line).text.slice(0, position.character), stackBefore);
		return currentMode(finalStack) === 'math';
	}
}
