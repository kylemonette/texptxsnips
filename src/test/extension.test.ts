import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function waitFor(check: () => boolean, timeoutMs = 45000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {throw new Error('timed out waiting for condition');}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

// Waits until the document's version stops changing for `quietMs`, rather
// than a fixed delay - the extension's own async auto-expand reaction to a
// typed character can take a variable amount of time in this environment,
// and a fixed pause isn't reliably long enough to outlast it.
async function waitForQuiescence(doc: vscode.TextDocument, quietMs = 300, timeoutMs = 30000) {
	const start = Date.now();
	let lastVersion = doc.version;
	let lastChangeAt = Date.now();
	while (Date.now() - lastChangeAt < quietMs) {
		if (Date.now() - start > timeoutMs) {throw new Error('timed out waiting for the document to settle');}
		await new Promise((resolve) => setTimeout(resolve, 20));
		if (doc.version !== lastVersion) {
			lastVersion = doc.version;
			lastChangeAt = Date.now();
		}
	}
}

// Inserts one character at a time via editor.edit() rather than simulating
// keyboard input through the 'type' command: onDidChangeTextDocument fires
// identically either way, so this exercises the real auto-expand path just
// as faithfully, without depending on this environment's input pipeline.
// Re-reads editor.selection.active before each character rather than
// tracking position locally, since the extension's own async auto-expand
// reaction (triggered by the previous character) can itself move the
// cursor - e.g. replacing "mk" with "$$" leaves it between the $ signs, not
// wherever a naive running total would predict - and waits for the
// document to settle before reading it, so that reaction (whatever it
// does) has definitely finished first. Retries a failed edit() (VS Code can
// reject one that races a concurrent edit from the extension's own reaction).
async function typeInto(editor: vscode.TextEditor, doc: vscode.TextDocument, text: string) {
	for (const ch of text) {
		let applied = false;
		for (let attempt = 0; attempt < 5 && !applied; attempt++) {
			const position = editor.selection.active;
			applied = await editor.edit((eb) => eb.insert(position, ch));
			if (!applied) {await new Promise((resolve) => setTimeout(resolve, 50));}
		}
		if (!applied) {throw new Error(`editor.edit() kept failing to insert ${JSON.stringify(ch)}`);}
		await waitForQuiescence(doc);
	}
}

suite('Extension end-to-end', () => {
	let tempDir: string;
	let originalSnippetsDir: string | undefined;

	suiteSetup(async function () {
		this.timeout(60000);
		const ext = vscode.extensions.getExtension('kylemonette.texptxsnips');
		assert.ok(ext, 'extension should be discoverable by id');
		if (!ext!.isActive) {
			await ext!.activate();
		}

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texptxsnips-test-'));
		fs.writeFileSync(
			path.join(tempDir, 'latex.snips'),
			[
				'snippet mk "inline math" A',
				'\\$$1\\$',
				'endsnippet',
				'',
				'snippet `([a-zA-Z])(\\d)` "auto subscript" Aim',
				'``rv = m[1] + "_" + m[2]``',
				'endsnippet',
				'',
				'snippet thm "theorem" b',
				'\\begin{theorem}',
				'$1',
				'\\end{theorem}',
				'$0',
				'endsnippet',
			].join('\n')
		);

		const config = vscode.workspace.getConfiguration('texptxsnips');
		originalSnippetsDir = config.get<string>('snippetsDir');
		await config.update('snippetsDir', tempDir, vscode.ConfigurationTarget.Global);
		await vscode.commands.executeCommand('texptxsnips.reloadSnippets');
	});

	suiteTeardown(async function () {
		this.timeout(30000);
		await vscode.workspace.getConfiguration('texptxsnips').update('snippetsDir', originalSnippetsDir, vscode.ConfigurationTarget.Global);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// See mathContext.test.ts's teardown for why: unclosed editors accumulate
	// across the whole run and degrade the shared Extension Host - this
	// suite runs last and is the most sensitive to that (each test opens a
	// real, shown editor and types into it).
	teardown(async function () {
		this.timeout(20000);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('mk auto-expands and a chained subscript works inline', async function () {
		this.timeout(60000);
		const doc = await vscode.workspace.openTextDocument({ content: '', language: 'latex' });
		const editor = await vscode.window.showTextDocument(doc);
		await typeInto(editor, doc, 'mk5x2');
		await waitFor(() => doc.getText() === '$5x_2$');
		assert.strictEqual(doc.getText(), '$5x_2$');
	});

	test('an auto-expansion is a single atomic edit, so it undoes in one step', async function () {
		this.timeout(60000);
		const doc = await vscode.workspace.openTextDocument({ content: '', language: 'latex' });
		const editor = await vscode.window.showTextDocument(doc);
		const versionBefore = doc.version;
		await typeInto(editor, doc, 'mk');
		// mk's body is \$$1\$ - both \$ resolve to a literal $, so the
		// expanded result is "$$", not the raw unresolved template text.
		await waitFor(() => doc.getText() === '$$');
		// "m" and "k" are 1 edit each; the "mk" -> "$$" auto-expansion must
		// be exactly 1 more. If it were a separate delete-then-insert (the
		// original bug this design avoids), this would be 4, not 3, and a
		// single undo wouldn't fully revert it - executeCommand('undo')
		// itself isn't reliable to assert against directly here since it
		// depends on real editor focus, which this headless test host
		// doesn't reliably provide.
		assert.strictEqual(doc.version - versionBefore, 3, 'auto-expansion should be exactly one additional edit, not a separate delete+insert');
	});

	test('a non-auto snippet does not expand on typing but does on Tab', async function () {
		this.timeout(60000);
		const doc = await vscode.workspace.openTextDocument({ content: '', language: 'latex' });
		const editor = await vscode.window.showTextDocument(doc);
		await typeInto(editor, doc, 'thm');
		assert.strictEqual(doc.getText(), 'thm', 'thm has no A flag - typing it alone should not expand it');

		await vscode.commands.executeCommand('texptxsnips.expandOnTab');
		await waitFor(() => doc.getText().startsWith('\\begin{theorem}'));
		assert.ok(doc.getText().includes('\\begin{theorem}') && doc.getText().includes('\\end{theorem}'));
	});
});
