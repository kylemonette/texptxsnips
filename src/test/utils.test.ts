import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSnippetsDir, resolveConfiguredDir, userDirFromGlobalStorage } from '../utils';

const EXT = 'kylemonette.texptxsnips';

suite('default snippets directory', () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'texptxsnips-utils-'));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('the default profile\'s global storage sits directly in the User folder', () => {
		const user = path.join(root, 'Code - Insiders', 'User');
		assert.strictEqual(userDirFromGlobalStorage(path.join(user, 'globalStorage', EXT)), user);
	});

	test('a non-default profile\'s global storage still leads back to the User folder', () => {
		const user = path.join(root, 'VSCodium', 'User');
		assert.strictEqual(userDirFromGlobalStorage(path.join(user, 'profiles', '-6a2b1c', 'globalStorage', EXT)), user);
	});

	test('an unrecognized layout gives no User folder, and the legacy location is used', () => {
		const storage = path.join(root, 'somewhere', 'else', EXT);
		const legacy = path.join(root, 'legacy', 'texptxsnips');
		assert.strictEqual(userDirFromGlobalStorage(storage), undefined);
		assert.strictEqual(defaultSnippetsDir(storage, legacy), legacy);
	});

	test('the editor\'s own folder is used when the legacy one does not exist', () => {
		const user = path.join(root, 'Cursor', 'User');
		const legacy = path.join(root, 'Code', 'User', 'texptxsnips');
		assert.strictEqual(defaultSnippetsDir(path.join(user, 'globalStorage', EXT), legacy), path.join(user, 'texptxsnips'));
	});

	test('an existing legacy folder is kept when the editor\'s own folder does not exist yet', () => {
		const user = path.join(root, 'Code - Insiders', 'User');
		const legacy = path.join(root, 'Code', 'User', 'texptxsnips');
		fs.mkdirSync(legacy, { recursive: true });
		assert.strictEqual(defaultSnippetsDir(path.join(user, 'globalStorage', EXT), legacy), legacy);
	});

	test('the editor\'s own folder wins once it exists, even alongside a legacy one', () => {
		const user = path.join(root, 'Code - Insiders', 'User');
		const legacy = path.join(root, 'Code', 'User', 'texptxsnips');
		fs.mkdirSync(legacy, { recursive: true });
		fs.mkdirSync(path.join(user, 'texptxsnips'), { recursive: true });
		assert.strictEqual(defaultSnippetsDir(path.join(user, 'globalStorage', EXT), legacy), path.join(user, 'texptxsnips'));
	});

	test('stable VS Code resolves to the same folder as before', () => {
		const user = path.join(root, 'Code', 'User');
		const legacy = path.join(user, 'texptxsnips');
		assert.strictEqual(defaultSnippetsDir(path.join(user, 'globalStorage', EXT), legacy), legacy);
	});
});

suite('configured snippets directory', () => {
	const home = path.join(os.tmpdir(), 'home');

	test('~ and ~/... start from the home folder', () => {
		assert.strictEqual(resolveConfiguredDir('~', home), home);
		assert.strictEqual(resolveConfiguredDir('~/snips', home), path.join(home, 'snips'));
	});

	test('a relative path starts from the home folder too, not the working directory', () => {
		assert.strictEqual(resolveConfiguredDir('snips', home), path.join(home, 'snips'));
		assert.strictEqual(resolveConfiguredDir('Dropbox/snips', home), path.join(home, 'Dropbox', 'snips'));
	});

	test('an absolute path is kept as is', () => {
		const abs = path.join(os.tmpdir(), 'elsewhere', 'snips');
		assert.strictEqual(resolveConfiguredDir(abs, home), abs);
	});

	test('surrounding whitespace is ignored', () => {
		assert.strictEqual(resolveConfiguredDir('  ~/snips ', home), path.join(home, 'snips'));
	});

	test('a ~ that is part of a name is not the home folder', () => {
		assert.strictEqual(resolveConfiguredDir('~snips', home), path.join(home, '~snips'));
	});
});
