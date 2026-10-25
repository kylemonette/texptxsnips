import * as assert from 'assert';
import * as vscode from 'vscode';
import { advancePosition, indentTemplate, resolveTemplate } from '../snippetTemplate';

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

	test('escapes inside a placeholder default are resolved, and an escaped } does not close it', () => {
		assert.strictEqual(resolveTemplate('${1:\\$x}').text, '$x');
		assert.strictEqual(resolveTemplate('${1:a\\}b}c').text, 'a}bc');
		assert.strictEqual(resolveTemplate('${1:a\\\\}b').text, 'a\\b', 'an escaped backslash before } still lets } close the default');
	});

	test('a nested placeholder renders its own default and counts as a second tabstop', () => {
		const r = resolveTemplate('${1:a${2:b}}c');
		assert.strictEqual(r.text, 'abc');
		assert.strictEqual(r.placeholderCount, 2);
		assert.strictEqual(r.firstPlaceholderOffset, 0);
		assert.strictEqual(r.needsNativeSession, true);
	});

	test('an unterminated ${1:... is literal text, as in VS Code', () => {
		const r = resolveTemplate('${1:abc');
		assert.strictEqual(r.text, '${1:abc');
		assert.strictEqual(r.placeholderCount, 0);
		assert.strictEqual(r.needsNativeSession, false);
	});

	test('a $ or } that does not start a construct is literal text', () => {
		assert.strictEqual(resolveTemplate('a $ b } ${ c').text, 'a $ b } ${ c');
	});

	test('needsNativeSession: 0-1 tabstops stay plain, 2+ go native', () => {
		assert.strictEqual(resolveTemplate('^2$0').needsNativeSession, false);
		assert.strictEqual(resolveTemplate('\\$$1\\$$0').needsNativeSession, false);
		assert.strictEqual(resolveTemplate('\\frac{$1}{$2}$0').needsNativeSession, true);
	});

	test('needsNativeSession: a tabstop repeated as a mirror goes native even when it is the only one', () => {
		const r = resolveTemplate('\\begin{$1}\n$0\n\\end{$1}');
		assert.strictEqual(r.placeholderCount, 1);
		assert.strictEqual(r.needsNativeSession, true);
	});

	test('needsNativeSession: choices, variables and transforms go native', () => {
		const choice = resolveTemplate('${1|left,right|}');
		assert.strictEqual(choice.text, 'left');
		assert.strictEqual(choice.needsNativeSession, true);
		assert.strictEqual(resolveTemplate('$TM_FILENAME').needsNativeSession, true);
		assert.strictEqual(resolveTemplate('${TM_FILENAME}').needsNativeSession, true);
		assert.strictEqual(resolveTemplate('${TM_FILENAME:x}').needsNativeSession, true);
		assert.strictEqual(resolveTemplate('${TM_FILENAME/(.*)/${1:/upcase}/}').needsNativeSession, true);
		assert.strictEqual(resolveTemplate('$1 ${1/(.*)/${1:/upcase}/}').needsNativeSession, true);
	});
});

suite('indentTemplate', () => {
	const spaces4 = { insertSpaces: true, indentSize: 4 };
	const tabs4 = { insertSpaces: false, indentSize: 4 };

	test('every line after the first gets the trigger line\'s indent', () => {
		assert.strictEqual(indentTemplate('\\[\n$1\n\\]$0', '    ', spaces4), '\\[\n    $1\n    \\]$0');
	});

	test('a single-line template is unchanged', () => {
		assert.strictEqual(indentTemplate('\\$$1\\$', '    ', spaces4), '\\$$1\\$');
	});

	test('leading tabs become spaces when the editor inserts spaces', () => {
		assert.strictEqual(indentTemplate('a\n\tb', '', spaces4), 'a\n    b');
		assert.strictEqual(indentTemplate('a\n  \tb', '', spaces4), 'a\n    b', 'a tab reaches the next indent stop, not a fixed width');
	});

	test('leading spaces become tabs when the editor inserts tabs', () => {
		assert.strictEqual(indentTemplate('a\n        b', '', tabs4), 'a\n\t\tb');
		assert.strictEqual(indentTemplate('a\n    b', '\t', tabs4), 'a\n\t\tb');
		assert.strictEqual(indentTemplate('a\n      b', '', tabs4), 'a\n\t  b', 'leftover columns stay as spaces');
	});

	test('a blank line gets the indent too, as insertSnippet does', () => {
		assert.strictEqual(indentTemplate('a\n\nb', '  ', spaces4), 'a\n  \n  b');
	});

	test('only leading whitespace changes, not whitespace later in a line', () => {
		assert.strictEqual(indentTemplate('a\n\tb\tc', '', spaces4), 'a\n    b\tc');
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
