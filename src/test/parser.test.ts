import * as assert from 'assert';
import { parseSnippetFile } from '../parser';

suite('parseSnippetFile', () => {
	test('parses a simple literal-trigger snippet with flags', () => {
		const { snippets, errors } = parseSnippetFile('snippet mk "inline math" A\n\\$$1\\$\nendsnippet', 'test.snips');
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(snippets.length, 1);
		assert.strictEqual(snippets[0].trigger, 'mk');
		assert.strictEqual(snippets[0].description, 'inline math');
		assert.deepStrictEqual(snippets[0].flags, { auto: true, inWord: false, wordBoundary: false, beginningOfLine: false, mathOnly: false, hidden: false });
	});

	test('a regex trigger gets anchored to the end if it isn\'t already', () => {
		const { snippets } = parseSnippetFile('snippet `foo` "x" A\nbar\nendsnippet', 'test.snips');
		const trigger = snippets[0].trigger as RegExp;
		assert.ok(trigger instanceof RegExp);
		assert.strictEqual(trigger.source, 'foo$');
	});

	test('a regex trigger that already ends in $ is not double-anchored', () => {
		const { snippets } = parseSnippetFile('snippet `foo$` "x" A\nbar\nendsnippet', 'test.snips');
		assert.strictEqual((snippets[0].trigger as RegExp).source, 'foo$');
	});

	test('global block helpers are visible to every snippet generator in the file', () => {
		const text = 'global\nfunction shout(s) { return s.toUpperCase(); }\nendglobal\n\nsnippet x "x" A\n``rv = shout(\'hi\')``\nendsnippet';
		const { snippets, errors } = parseSnippetFile(text, 'test.snips');
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(snippets[0].generate(null, [], '', ''), 'HI');
	});

	test('priority applies only to the single snippet that follows it', () => {
		const text = 'priority 5\nsnippet a "a" A\nx\nendsnippet\n\nsnippet b "b" A\ny\nendsnippet';
		const { snippets } = parseSnippetFile(text, 'test.snips');
		assert.strictEqual(snippets[0].priority, 5);
		assert.strictEqual(snippets[1].priority, 0);
	});

	test('rv is spliced into the body unescaped, so a code block can build real tabstop syntax', () => {
		const text = 'snippet x "x" A\n``rv = "\\\\frac{a}{$1}$0"``\nendsnippet';
		const { snippets } = parseSnippetFile(text, 'test.snips');
		assert.strictEqual(snippets[0].generate(null, [], '', ''), '\\frac{a}{$1}$0');
	});

	test('capture groups from a regex trigger are available in code blocks as m[n]', () => {
		const text = 'snippet `([a-z])(\\d)` "x" A\n``rv = m[1] + "_" + m[2]``\nendsnippet';
		const { snippets } = parseSnippetFile(text, 'test.snips');
		const m = (snippets[0].trigger as RegExp).exec('x2');
		assert.strictEqual(snippets[0].generate(m, [], '', ''), 'x_2');
	});

	test('a malformed header reports an error but does not prevent the rest of the file from parsing', () => {
		const text = 'snippet\nbroken\nendsnippet\n\nsnippet ok "ok" A\ny\nendsnippet';
		const { snippets, errors } = parseSnippetFile(text, 'test.snips');
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(snippets.length, 1);
		assert.strictEqual(snippets[0].trigger, 'ok');
	});

	test('a compile error in one snippet body fails the whole file, matching hsnips\' single-Function-call model', () => {
		const text = 'snippet x "x" A\n``this is not valid js(``\nendsnippet';
		const { snippets, errors } = parseSnippetFile(text, 'test.snips');
		assert.strictEqual(snippets.length, 0);
		assert.ok(errors.length > 0);
	});
});
