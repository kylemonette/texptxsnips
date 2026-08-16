import * as assert from 'assert';
import * as vscode from 'vscode';
import { advancePosition, resolveTemplate } from '../snippetTemplate';

suite('resolveTemplate', () => {
	test('a bare $0 collapses and is not treated as a navigable placeholder', () => {
		const { text, firstPlaceholderOffset } = resolveTemplate('^2$0');
		assert.strictEqual(text, '^2');
		assert.strictEqual(firstPlaceholderOffset, undefined);
	});

	test('escaped $ } \\\\ are unescaped, and a placeholder default is kept', () => {
		const { text } = resolveTemplate('\\$${1:x}\\$$0');
		assert.strictEqual(text, '$x$');
	});

	test('LaTeX\'s \\[ \\] survive intact - only $, }, \\\\ are real snippet escapes', () => {
		const { text, firstPlaceholderOffset } = resolveTemplate('\\[\n$1\n\\]$0');
		assert.strictEqual(text, '\\[\n\n\\]');
		assert.strictEqual(firstPlaceholderOffset, 3);
	});

	test('a tabstop with no default collapses to an empty string', () => {
		assert.strictEqual(resolveTemplate('a$1b$0').text, 'ab');
	});

	test('a template with no $0 at all still resolves and reports its placeholder', () => {
		const { text, firstPlaceholderOffset } = resolveTemplate('\\$$1\\$');
		assert.strictEqual(text, '$$');
		assert.strictEqual(firstPlaceholderOffset, 1);
	});

	test('firstPlaceholderOffset follows tabstop number order, not left-to-right order', () => {
		assert.strictEqual(resolveTemplate('$2 then $1').firstPlaceholderOffset, 6);
	});

	test('placeholderCount counts distinct tabstop numbers, not occurrences', () => {
		assert.strictEqual(resolveTemplate('^2$0').placeholderCount, 0);
		assert.strictEqual(resolveTemplate('\\$$1\\$').placeholderCount, 1);
		assert.strictEqual(resolveTemplate('\\frac{$1}{$2} $0').placeholderCount, 2);
		assert.strictEqual(resolveTemplate('\\begin{$1}\n$2\n\\end{$1}\n$0').placeholderCount, 2, 'repeated $1 (mirrored) counts once');
	});
});

suite('advancePosition', () => {
	test('single-line text advances the character only', () => {
		const p = advancePosition(new vscode.Position(2, 5), 'abc');
		assert.strictEqual(p.line, 2);
		assert.strictEqual(p.character, 8);
	});

	test('multi-line text advances the line and resets the character', () => {
		const p = advancePosition(new vscode.Position(2, 5), 'ab\ncd');
		assert.strictEqual(p.line, 3);
		assert.strictEqual(p.character, 2);
	});
});
