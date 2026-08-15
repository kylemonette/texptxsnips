import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseSnippetFile } from './parser';
import { Snippet } from './types';

/**
 * Loads `<languageId>.snips` files from the snippets directory. Snippets
 * defined in `all.snips` are merged into every language's list, matching
 * the filename-as-scope convention from hsnips.
 */
export class SnippetStore {
	private byLanguage = new Map<string, Snippet[]>();

	constructor(private dir: string) {}

	setDir(dir: string) {
		this.dir = dir;
	}

	getSnippets(languageId: string): Snippet[] {
		return this.byLanguage.get(languageId.toLowerCase()) ?? [];
	}

	async load(): Promise<string[]> {
		const map = new Map<string, Snippet[]>();
		const errors: string[] = [];

		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.dir);
		} catch {
			this.byLanguage = map;
			return errors;
		}

		for (const entry of entries) {
			if (!entry.toLowerCase().endsWith('.snips')) {continue;}
			const languageId = path.basename(entry, '.snips').toLowerCase();
			const full = path.join(this.dir, entry);
			let text: string;
			try {
				text = await fs.promises.readFile(full, 'utf8');
			} catch (err) {
				errors.push(`${full}: ${(err as Error).message}`);
				continue;
			}
			const parsed = parseSnippetFile(text, entry);
			errors.push(...parsed.errors);
			map.set(languageId, parsed.snippets);
		}

		const shared = map.get('all') ?? [];
		for (const [languageId, snippets] of map) {
			if (languageId === 'all') {continue;}
			map.set(languageId, [...snippets, ...shared].sort((a, b) => b.priority - a.priority));
		}

		this.byLanguage = map;
		return errors;
	}

	watch(onReload: () => void): vscode.Disposable {
		const pattern = new vscode.RelativePattern(vscode.Uri.file(this.dir), '*.snips');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const reload = async () => {
			await this.load();
			onReload();
		};
		const disposables = [watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload)];
		return vscode.Disposable.from(watcher, ...disposables);
	}
}
