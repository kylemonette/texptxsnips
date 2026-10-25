import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnippetStore } from '../snippetStore';

async function storeWith(files: Record<string, string>): Promise<SnippetStore> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texptxsnips-store-'));
	for (const [name, text] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), text);
	}
	const store = new SnippetStore(dir);
	await store.load();
	fs.rmSync(dir, { recursive: true, force: true });
	return store;
}

suite('SnippetStore', () => {
	test('all.snips alone still provides snippets for a language with no file of its own', async () => {
		const store = await storeWith({ 'all.snips': 'snippet d "d" A\nx\nendsnippet\n' });
		assert.strictEqual(store.getSnippets('latex').length, 1);
		assert.strictEqual(store.getSnippets('pretext').length, 1);
	});

	test('all.snips is merged into a language file, sorted by priority', async () => {
		const store = await storeWith({
			'latex.snips': 'snippet a "a" A\nx\nendsnippet\n',
			'all.snips': 'priority 5\nsnippet b "b" A\ny\nendsnippet\n',
		});
		assert.deepStrictEqual(store.getSnippets('latex').map((s) => s.trigger), ['b', 'a']);
	});

	test('all.snips on its own is sorted by priority too', async () => {
		const store = await storeWith({ 'all.snips': 'snippet a "a" A\nx\nendsnippet\n\npriority 5\nsnippet b "b" A\ny\nendsnippet\n' });
		assert.deepStrictEqual(store.getSnippets('latex').map((s) => s.trigger), ['b', 'a']);
	});
});
