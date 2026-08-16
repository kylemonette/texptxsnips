import * as assert from 'assert';
import * as vscode from 'vscode';
import { getMatches } from '../matching';
import { MathContextTracker } from '../mathContext';
import { Snippet, SnippetFlags } from '../types';

const noFlags: SnippetFlags = { auto: false, inWord: false, wordBoundary: false, beginningOfLine: false, mathOnly: false, hidden: false };

function snippet(overrides: Partial<Snippet>): Snippet {
	return { trigger: 'x', description: '', priority: 0, source: 'test', flags: noFlags, generate: () => '', ...overrides };
}

async function matchesFor(text: string, snippets: Snippet[], mathContext = new MathContextTracker()) {
	const doc = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
	return getMatches(snippets, doc, new vscode.Position(0, text.length), mathContext);
}

suite('getMatches', function () {
	this.timeout(40000);

	// See mathContext.test.ts's teardown for why: unclosed editors/documents
	// accumulate across the whole run and degrade the shared Extension Host.
	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('regex triggers are not boundary-constrained by the w/default rule - only their own pattern matters', async () => {
		const snip = snippet({ trigger: /([a-zA-Z])(\d)$/, flags: { ...noFlags, wordBoundary: true } });
		const matches = await matchesFor('5x2', [snip]);
		assert.strictEqual(matches.length, 1, 'a regex trigger should match right after a word character even with the w flag');
	});

	test('string triggers ARE boundary-constrained by the default/w rule', async () => {
		const snip = snippet({ trigger: 'mk' });
		assert.strictEqual((await matchesFor('xmk', [snip])).length, 0, 'preceded by a word character, no i flag - should not match');
		assert.strictEqual((await matchesFor('x mk', [snip])).length, 1, 'preceded by whitespace - should match');
	});

	test('the i flag drops the boundary constraint for string triggers', async () => {
		const snip = snippet({ trigger: 'mk', flags: { ...noFlags, inWord: true } });
		assert.strictEqual((await matchesFor('xmk', [snip])).length, 1);
	});

	test('the b flag requires only whitespace before the trigger on the line', async () => {
		const snip = snippet({ trigger: 'thm', flags: { ...noFlags, beginningOfLine: true } });
		assert.strictEqual((await matchesFor('  thm', [snip])).length, 1, 'leading whitespace is fine');
		assert.strictEqual((await matchesFor('x thm', [snip])).length, 0, 'non-whitespace before it should block');
	});

	test('mathOnly gates on the math context tracker', async () => {
		const snip = snippet({ trigger: 'pi', flags: { ...noFlags, inWord: true, mathOnly: true } });
		assert.strictEqual((await matchesFor('this pi', [snip])).length, 0, 'not in math mode');
		assert.strictEqual((await matchesFor('$this pi', [snip])).length, 1, 'in math mode');
	});

	test('regex capture groups are attached to the match', async () => {
		const snip = snippet({ trigger: /([a-z])(\d)$/ });
		const matches = await matchesFor('x2', [snip]);
		assert.strictEqual(matches.length, 1);
		assert.strictEqual(matches[0].groups?.[1], 'x');
		assert.strictEqual(matches[0].groups?.[2], '2');
	});
});
