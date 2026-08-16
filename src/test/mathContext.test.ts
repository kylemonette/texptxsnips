import * as assert from 'assert';
import * as vscode from 'vscode';
import { MathContextTracker } from '../mathContext';

async function isMathAt(lines: string[], line: number, character: number): Promise<boolean> {
	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
	return new MathContextTracker().isMath(doc, new vscode.Position(line, character));
}

suite('MathContextTracker', function () {
	// Real editor operations (showTextDocument/editor.edit) are slow in this
	// test environment - mocha's 2s default is too tight for them.
	this.timeout(40000);

	// Leaving editors open accumulates across the whole run and visibly
	// degrades the shared Extension Host by the time later suites run
	// (observed as "Extension host is unresponsive" and E2E timeouts) -
	// close whatever this test opened before moving on.
	teardown(async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('\\\\[1em] inside a tabular row is not math, despite containing \\[', async () => {
		const result = await isMathAt(['\\begin{tabular}{cc}', 'a & b \\\\[1em]', 'c & d'], 1, 13);
		assert.strictEqual(result, false);
	});

	test('basic $...$ math is detected', async () => {
		assert.strictEqual(await isMathAt(['$x + '], 0, 5), true);
	});

	test('basic \\[...\\] display math is detected', async () => {
		assert.strictEqual(await isMathAt(['\\[ x + '], 0, 7), true);
	});

	test('plain text is not math', async () => {
		assert.strictEqual(await isMathAt(['no math here'], 0, 5), false);
	});

	test('\\text{} inside a math environment toggles back to text, then math again after', async () => {
		const lines = ['\\begin{equation}', 'a = \\text{hello world} + b'];
		assert.strictEqual(await isMathAt(lines, 1, 10), false, 'inside \\text{} should not be math');
		assert.strictEqual(await isMathAt(lines, 1, 27), true, 'after \\text{} should return to math');
	});

	test('nested $...$ inside \\text{} inside a math environment is still math', async () => {
		const lines = ['\\begin{equation} a = \\text{test $abc$} \\end{equation}'];
		assert.strictEqual(await isMathAt(lines, 0, 35), true);
	});

	test('invalidate() picks up a real edit that removes an opening $', async () => {
		const doc = await vscode.workspace.openTextDocument({ content: 'before $x\nstill math\nend$ after', language: 'plaintext' });
		const editor = await vscode.window.showTextDocument(doc);
		const tracker = new MathContextTracker();
		assert.strictEqual(tracker.isMath(doc, new vscode.Position(2, 3)), true, 'should be math before the edit');

		await editor.edit((eb) => eb.replace(new vscode.Range(0, 7, 0, 8), ''));
		tracker.invalidate(doc.uri, 0);
		assert.strictEqual(tracker.isMath(doc, new vscode.Position(2, 3)), false, 'stale cache should not survive invalidate()');
	});
});
