import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseSnippetFile } from './parser';
import { Snippet } from './types';

/** Whether a file name has the `.snips` extension, in any case. */
function isSnipsFile(name: string): boolean {
	return name.toLowerCase().endsWith('.snips');
}

/**
 * Loads `<languageId>.snips` files from the snippets directory. Snippets
 * defined in `all.snips` are merged into every language's list, and used on
 * their own for a language with no file of its own.
 */
export class SnippetStore {
	private byLanguage = new Map<string, Snippet[]>();

	constructor(private dir: string) {}

	setDir(dir: string) {
		this.dir = dir;
	}

	getSnippets(languageId: string): Snippet[] {
		return this.byLanguage.get(languageId.toLowerCase()) ?? this.byLanguage.get('all') ?? [];
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
			if (!isSnipsFile(entry)) {continue;}
			const languageId = entry.slice(0, -'.snips'.length).toLowerCase();
			const full = path.join(this.dir, entry);
			let text: string;
			try {
				text = await fs.promises.readFile(full, 'utf8');
			} catch (err) {
				errors.push(`${full}: ${(err as Error).message}`);
				continue;
			}
			// parseSnippetFile reports problems as errors rather than
			// throwing, but one file must never stop the rest from loading.
			try {
				const parsed = parseSnippetFile(text, entry);
				errors.push(...parsed.errors);
				map.set(languageId, parsed.snippets);
			} catch (err) {
				errors.push(`${entry}: failed to load: ${(err as Error).message}`);
			}
		}

		const shared = map.get('all') ?? [];
		for (const [languageId, snippets] of map) {
			const merged = languageId === 'all' ? [...snippets] : [...snippets, ...shared];
			map.set(languageId, merged.sort((a, b) => b.priority - a.priority));
		}

		this.byLanguage = map;
		return errors;
	}

	/**
	 * Watches for file changes and invokes `onReload` on each one - which is
	 * expected to itself call `load()` (as `extension.ts`'s reload callback
	 * does), not just react to a load this method already performed.
	 */
	watch(onReload: () => void): vscode.Disposable {
		// Watches every file and filters here, since a glob is case-sensitive
		// on some platforms and load() accepts e.g. LaTeX.SNIPS too.
		const pattern = new vscode.RelativePattern(vscode.Uri.file(this.dir), '*');
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const onFile = (uri: vscode.Uri) => {
			if (isSnipsFile(path.basename(uri.fsPath))) {onReload();}
		};
		const disposables = [watcher.onDidChange(onFile), watcher.onDidCreate(onFile), watcher.onDidDelete(onFile)];
		return vscode.Disposable.from(watcher, ...disposables);
	}
}
