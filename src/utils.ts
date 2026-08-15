import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

function defaultSnippetsDir(): string {
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

export function getSnippetsDir(): string {
	const configured = vscode.workspace.getConfiguration('texptxsnips').get<string>('snippetsDir');
	if (configured && configured.trim().length > 0) {
		return configured.replace(/^~(?=$|\/|\\)/, os.homedir());
	}
	return defaultSnippetsDir();
}

/** Escapes vscode.SnippetString metacharacters (\, $, }) in dynamically generated text. */
export function escapeSnippetSyntax(value: string): string {
	return value.replace(/[\\$}]/g, (c) => `\\${c}`);
}
