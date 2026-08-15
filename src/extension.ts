import * as vscode from 'vscode';
import * as fs from 'fs';
import { SnippetStore } from './snippetStore';
import { MathContextTracker } from './mathContext';
import { getMatches, SnippetMatch } from './matching';
import { getSnippetsDir } from './utils';

const LANGUAGES = ['latex', 'pretext'];
const TRIGGER_CHARACTERS = ['\\', '{', '}', '_', '^', '$', "'", '-', '.', ',', ':', ';'];

function workspacePath(document: vscode.TextDocument): string {
	return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? '';
}

function generateText(match: SnippetMatch, document: vscode.TextDocument): string {
	return match.snippet.generate(match.groups, [], workspacePath(document), document.uri.fsPath);
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('TeXPtxSnips');
	const store = new SnippetStore(getSnippetsDir());
	const mathContext = new MathContextTracker();
	let expanding = false;

	const reportErrors = (errors: string[]) => {
		if (errors.length === 0) {return;}
		output.appendLine(errors.join('\n'));
		output.show(true);
	};

	const reload = async () => reportErrors(await store.load());
	reload();

	let watcher = store.watch(reload);
	context.subscriptions.push(watcher);

	const completionProvider: vscode.CompletionItemProvider = {
		provideCompletionItems(document, position) {
			const snippets = store.getSnippets(document.languageId);
			const matches = getMatches(snippets, document, position, mathContext).filter((m) => !m.snippet.flags.hidden);
			return matches.map((match) => {
				const label = typeof match.snippet.trigger === 'string' ? match.snippet.trigger : document.getText(match.range);
				const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
				item.detail = match.snippet.description;
				item.range = match.range;
				item.filterText = document.getText(match.range);
				item.insertText = new vscode.SnippetString(generateText(match, document));
				return item;
			});
		},
	};

	for (const language of LANGUAGES) {
		context.subscriptions.push(
			vscode.languages.registerCompletionItemProvider({ language }, completionProvider, ...TRIGGER_CHARACTERS)
		);
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async (event) => {
			if (event.contentChanges.length === 0) {return;}

			const minLine = Math.min(...event.contentChanges.map((c) => c.range.start.line));
			mathContext.invalidate(event.document.uri, minLine);

			if (expanding) {return;}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== event.document || !LANGUAGES.includes(event.document.languageId)) {return;}

			const position = editor.selection.active;
			const matches = getMatches(store.getSnippets(event.document.languageId), event.document, position, mathContext);
			const auto = matches.find((m) => m.snippet.flags.auto);
			if (!auto) {return;}

			expanding = true;
			try {
				// A single insertSnippet call over the trigger range replaces and
				// expands atomically, so one undo reverts the whole expansion.
				await editor.insertSnippet(new vscode.SnippetString(generateText(auto, event.document)), auto.range);
			} finally {
				expanding = false;
			}
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => mathContext.forget(doc.uri))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('texptxsnips.reloadSnippets', async () => {
			store.setDir(getSnippetsDir());
			watcher.dispose();
			watcher = store.watch(reload);
			context.subscriptions.push(watcher);
			await reload();
			vscode.window.showInformationMessage('TeXPtxSnips: snippets reloaded.');
		}),
		vscode.commands.registerCommand('texptxsnips.openSnippetsDir', async () => {
			const dir = getSnippetsDir();
			await fs.promises.mkdir(dir, { recursive: true });
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('texptxsnips.snippetsDir')) {
				vscode.commands.executeCommand('texptxsnips.reloadSnippets');
			}
		})
	);
}

export function deactivate() {}
