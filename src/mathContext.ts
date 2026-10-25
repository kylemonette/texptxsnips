import * as vscode from 'vscode';

type Mode = 'text' | 'math';

// Environments that switch into math mode on their own, without needing an
// enclosing math context. Environments only valid inside math (bmatrix,
// cases, aligned, ...) aren't listed - they inherit math from their
// surroundings. `tikzcd` isn't an amsmath environment, but its cells are
// typeset in math mode, so it's listed too.
const MATH_ENVIRONMENTS = new Set([
	'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
	'multline', 'multline*', 'eqnarray', 'eqnarray*', 'flalign', 'flalign*',
	'alignat', 'alignat*', 'math', 'displaymath', 'tikzcd',
]);

// Commands whose brace argument switches back to prose/text mode, plus
// commands whose argument is a key or label rather than math. \mathrm is
// listed too: it's math formatting, but mostly used for upright words (e.g.
// \mathrm{if}) where math snippets would misfire. \mathbf, \operatorname
// etc. stay in math context.
const TEXT_SWITCH_COMMANDS = new Set([
	'text', 'textrm', 'textnormal', 'textbf', 'textit', 'textsf', 'texttt',
	'textup', 'textsl', 'textsc', 'textmd', 'emph', 'mathrm', 'mbox', 'hbox',
	'intertext', 'shortintertext', 'tag',
	'label', 'cite', 'ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref',
]);

// PreTeXt XML elements whose body is typeset in math mode.
const MATH_TAGS = new Set(['m', 'me', 'men', 'md', 'mdn', 'mrow']);

// PreTeXt XML elements whose body is prose even when nested inside a math
// element - e.g. <intertext> between the <mrow>s of an <md>/<mdn>.
const TEXT_TAGS = new Set(['intertext']);

type Frame =
	| { kind: 'root' }
	| { kind: 'group'; mode: Mode }
	| { kind: 'dollar' }
	| { kind: 'dollardollar' }
	| { kind: 'paren' }
	| { kind: 'bracket' }
	| { kind: 'env'; mode: Mode }
	| { kind: 'xmlcomment' };

function frameMode(frame: Frame): Mode {
	switch (frame.kind) {
		case 'root':
		case 'xmlcomment':
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
 * units before ever comparing substrings. When `isXml` is set (PreTeXt
 * documents), `<tag>...</tag>` elements are tokenized the same way `\begin`/
 * `\end` are, so math elements like `<m>`/`<me>`/`<md>` switch into math mode,
 * and `<!-- ... -->` comments (which may span lines) are skipped entirely.
 */
function scanLine(text: string, stack: Frame[], isXml: boolean): Frame[] {
	const out = stack.slice();
	let i = 0;
	while (i < text.length) {
		const c = text[i];

		if (isXml && out[out.length - 1].kind === 'xmlcomment') {
			const end = text.indexOf('-->', i);
			if (end === -1) {break;} // comment continues onto the next line
			out.pop();
			i = end + 3;
			continue;
		}
		if (isXml && text.startsWith('<!--', i)) {
			out.push({ kind: 'xmlcomment' });
			i += 4;
			continue;
		}

		if (c === '%' && !isXml) {
			break; // rest of the line is a comment
		}

		if (isXml && c === '<') {
			const next = handleXmlTag(text, i, out);
			if (next !== null) {
				i = next;
				continue;
			}
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
				handleControlWord(name, text, j, out, (skip) => { i += skip; });
				continue;
			}
			// control symbol: backslash + exactly one non-letter char
			if (!isXml) {
				if (next === '(') {
					out.push({ kind: 'paren' });
				} else if (next === ')') {
					popIf(out, 'paren');
				} else if (next === '[') {
					out.push({ kind: 'bracket' });
				} else if (next === ']') {
					popIf(out, 'bracket');
				}
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

		if (c === '$' && !isXml) {
			// Inside inline math, a `$` always closes it, even when another
			// `$` follows - `$a$$b$` is two inline maths, not display math.
			if (out[out.length - 1]?.kind === 'dollar') {
				out.pop();
				i += 1;
			} else if (text[i + 1] === '$') {
				if (out[out.length - 1]?.kind === 'dollardollar') {out.pop();}
				else {out.push({ kind: 'dollardollar' });}
				i += 2;
			} else {
				out.push({ kind: 'dollar' });
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

/**
 * Parses a `<tag ...>`, `</tag>`, or self-closing `<tag .../>` starting at
 * index `i`, updating `stack` for math elements. Returns the index just past
 * the tag, or null if `i` isn't the start of a well-formed tag on this line
 * (e.g. attributes spanning multiple lines), in which case `<` is left as a
 * plain character.
 */
function handleXmlTag(text: string, i: number, stack: Frame[]): number | null {
	const closing = text[i + 1] === '/';
	const start = i + (closing ? 2 : 1);
	const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(text.slice(start));
	if (!nameMatch) {return null;}
	const name = nameMatch[0];

	let j = start + name.length;
	let quote: string | null = null;
	while (j < text.length) {
		const ch = text[j];
		if (quote) {
			if (ch === quote) {quote = null;}
		} else if (ch === '"' || ch === '\'') {
			quote = ch;
		} else if (ch === '>') {
			break;
		}
		j++;
	}
	if (j >= text.length) {return null;} // tag not closed on this line

	const selfClosing = !closing && text[j - 1] === '/';
	if (!closing && !selfClosing) {
		const mode = MATH_TAGS.has(name) ? 'math' : TEXT_TAGS.has(name) ? 'text' : currentMode(stack);
		stack.push({ kind: 'env', mode });
	} else if (closing) {
		popIf(stack, 'env');
	}
	return j + 1;
}

/**
 * `pos` is the index in `text` just past the control word's name (i.e. right
 * after "begin"/"end"/etc.) - passed in directly rather than re-derived with
 * `text.indexOf(name)`, which would find the leftmost occurrence of the name
 * anywhere on the line instead of this one (wrong on a line with two `\begin`
 * of different-length environment names, or e.g. a `\cite` after an earlier
 * `\citep`, whose name contains "cite" as a prefix).
 */
function handleControlWord(name: string, text: string, pos: number, stack: Frame[], advance: (n: number) => void) {
	if (name === 'begin' || name === 'end') {
		const rest = text.slice(pos);
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
	if (TEXT_SWITCH_COMMANDS.has(name)) {
		// Skip a star and any [optional] arguments (e.g. \tag*{..},
		// \cite[p.~3]{key}) to reach the brace argument.
		let k = pos;
		if (text[k] === '*') {k++;}
		while (text[k] === '[') {
			const close = text.indexOf(']', k);
			if (close === -1) {return;}
			k = close + 1;
		}
		if (text[k] !== '{') {return;}
		advance(k - pos + 1); // consume the opening brace here so it inherits text mode
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

		const isXml = document.languageId === 'pretext';
		for (let line = stacks.length - 1; line < position.line; line++) {
			stacks.push(scanLine(document.lineAt(line).text, stacks[line], isXml));
		}

		const stackBefore = stacks[position.line];
		const finalStack = scanLine(document.lineAt(position.line).text.slice(0, position.character), stackBefore, isXml);
		return currentMode(finalStack) === 'math';
	}
}
