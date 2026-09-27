import * as assert from 'assert';
import * as vscode from 'vscode';
import { MathContextTracker } from '../mathContext';

async function isMathAt(lines: string[], line: number, character: number, language = 'plaintext'): Promise<boolean> {
	const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language });
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

	test('inside <m>...</m> is math in a pretext document', async () => {
		const result = await isMathAt(['<p>Consider <m>x + </m></p>'], 0, 19, 'pretext');
		assert.strictEqual(result, true);
	});

	test('outside <m>...</m> is not math in a pretext document', async () => {
		const result = await isMathAt(['<p>Consider <m>x</m> here</p>'], 0, 25, 'pretext');
		assert.strictEqual(result, false);
	});

	test('<m>...</m> in a non-pretext document is not treated as math', async () => {
		const result = await isMathAt(['<m>x + </m>'], 0, 7, 'plaintext');
		assert.strictEqual(result, false);
	});

	test('nested <mrow> inside <md> is math', async () => {
		const lines = ['<md>', '  <mrow>x = y + </mrow>', '</md>'];
		assert.strictEqual(await isMathAt(lines, 1, 15, 'pretext'), true);
	});

	test('self-closing tag does not affect math state', async () => {
		const result = await isMathAt(['<p>before <br/> <m>x + </m></p>'], 0, 22, 'pretext');
		assert.strictEqual(result, true);
	});

	test('$ does not trigger math in a pretext document', async () => {
		const result = await isMathAt(['<p>Price is $5 and $$10$$ or \\(x\\) or \\[y\\]</p>'], 0, 40, 'pretext');
		assert.strictEqual(result, false);
	});

	test('$ inside <m>...</m> stays math in a pretext document', async () => {
		const result = await isMathAt(['<p><m>x = $5</m></p>'], 0, 11, 'pretext');
		assert.strictEqual(result, true);
	});

	test('bmatrix nested inside $...$ is math', async () => {
		const result = await isMathAt(['$\\begin{bmatrix} 1 & '], 0, 21);
		assert.strictEqual(result, true);
	});

	test('cases nested inside equation is math', async () => {
		const lines = ['\\begin{equation}', 'f(x) = \\begin{cases} 1 & '];
		assert.strictEqual(await isMathAt(lines, 1, 25), true);
	});

	test('array nested inside \\[...\\] is math', async () => {
		const lines = ['\\[ \\begin{array}{cc} 1 & '];
		assert.strictEqual(await isMathAt(lines, 0, 25), true);
	});

	test('subarray nested inside a math environment is math', async () => {
		const lines = ['\\begin{equation}', '\\sum_{\\begin{subarray}{l} i \\in ', '\\end{subarray}} x_i'];
		assert.strictEqual(await isMathAt(lines, 1, 33), true);
	});

	test('smallmatrix nested inside $...$ is math', async () => {
		const result = await isMathAt(['$\\begin{smallmatrix} 1 & '], 0, 25);
		assert.strictEqual(result, true);
	});

	test('split, gathered, aligned, alignedat all inherit math from an enclosing environment', async () => {
		for (const env of ['split', 'gathered', 'aligned', 'alignedat']) {
			const lines = ['\\begin{equation}', `\\begin{${env}} x = `];
			assert.strictEqual(await isMathAt(lines, 1, env.length + 10), true, `${env} should be math`);
		}
	});

	test('tikzcd starts math mode on its own, without being nested in math', async () => {
		const lines = ['\\begin{tikzcd}', 'A \\arrow[r] & '];
		assert.strictEqual(await isMathAt(lines, 1, 13), true);
	});

	test('tikzcd nested inside \\[...\\] is still math', async () => {
		const lines = ['\\[', '\\begin{tikzcd}', 'A \\arrow[r] & '];
		assert.strictEqual(await isMathAt(lines, 2, 13), true);
	});

	test('a later \\cite{} switches back to text even when an earlier word on the line has \\cite as a prefix', async () => {
		// \citep contains "cite" as a substring - a naive whole-line search for
		// "cite" would land on the \citep occurrence instead of the real \cite
		// that follows, and wrongly conclude it isn't followed by "{".
		const result = await isMathAt(['$\\citep{a} \\cite{'], 0, 17);
		assert.strictEqual(result, false);
	});

	test('two \\begin with different-length environment names on the same line both resolve correctly', async () => {
		// A naive whole-line search for "begin" would find the first \begin
		// again when processing the second, misreading its environment name
		// and desyncing the scan position by the name-length difference
		// ("align" vs "bmatrix") - which would leave the trailing "\end{align}"
		// unmatched and the line stuck in math mode.
		const lines = ['\\begin{align}\\begin{bmatrix}1\\end{bmatrix}\\end{align} x + '];
		assert.strictEqual(await isMathAt(lines, 0, lines[0].length), false, 'should be back in text mode after both environments close');
	});

	test('two \\end with different-length environment names on the same line both pop correctly', async () => {
		const lines = ['\\begin{equation}\\begin{bmatrix}1\\end{bmatrix}\\end{equation} x'];
		assert.strictEqual(await isMathAt(lines, 0, lines[0].length), false, 'should have returned to text mode after \\end{equation}');
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
