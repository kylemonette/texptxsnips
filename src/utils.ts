import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where snippets lived before the default was derived from the editor itself - stable VS Code's User folder, on every editor. */
function legacySnippetsDir(): string {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'texptxsnips');
		case 'win32':
			return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'texptxsnips');
		default:
			return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Code', 'User', 'texptxsnips');
	}
}

/**
 * The editor's User folder, found from the extension's global storage
 * folder: `<User>/globalStorage/<extension>` for the default profile, or
 * `<User>/profiles/<id>/globalStorage/<extension>` for any other profile.
 * This holds for VS Code, Insiders, VSCodium, Cursor, portable mode and
 * remote hosts alike. Undefined for any other layout.
 */
export function userDirFromGlobalStorage(globalStoragePath: string): string | undefined {
	const storage = path.dirname(globalStoragePath);
	if (path.basename(storage) !== 'globalStorage') {return undefined;}
	const parent = path.dirname(storage);
	if (path.basename(parent) === 'User') {return parent;}
	const profiles = path.dirname(parent);
	if (path.basename(profiles) === 'profiles' && path.basename(path.dirname(profiles)) === 'User') {
		return path.dirname(profiles);
	}
	return undefined;
}

/**
 * A `texptxsnips` folder inside the editor's own User folder. Falls back to
 * the legacy location (stable VS Code's User folder) when the editor's
 * layout isn't recognized, or when only the legacy folder exists - so
 * snippets someone already keeps there aren't lost when using e.g.
 * Insiders, which used to read from it too.
 */
export function defaultSnippetsDir(globalStoragePath: string, legacyDir = legacySnippetsDir()): string {
	const userDir = userDirFromGlobalStorage(globalStoragePath);
	if (userDir === undefined) {return legacyDir;}
	const dir = path.join(userDir, 'texptxsnips');
	if (dir !== legacyDir && !fs.existsSync(dir) && fs.existsSync(legacyDir)) {return legacyDir;}
	return dir;
}

export function getSnippetsDir(globalStorageUri: vscode.Uri): string {
	const configured = vscode.workspace.getConfiguration('texptxsnips').get<string>('snippetsDir');
	if (configured && configured.trim().length > 0) {
		return configured.replace(/^~(?=$|\/|\\)/, os.homedir());
	}
	return globalStorageUri.scheme === 'file' ? defaultSnippetsDir(globalStorageUri.fsPath) : legacySnippetsDir();
}
