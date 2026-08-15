import * as vscode from 'vscode';
import * as fs from 'fs';
import { SnippetStore } from './snippetStore';
import { MathContextTracker } from './mathContext';
import { getMatches, SnippetMatch } from './matching';
import { getSnippetsDir } from './utils';
import { advancePosition, hasNavigableTabstops, resolvePlainText } from './snippetTemplate';

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

	// Line span of the last snippet we put into native tabstop mode, so a
	// second auto-expand triggered while it's still live can avoid starting
	// a nested snippet session - VS Code's own SnippetController2 corrupts
	// the outer session's tabstops when a snippet is inserted inside one.
	let activeSnippetLines: { start: number; end: number } | undefined;

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

	async function expand(editor: vscode.TextEditor, match: SnippetMatch, document: vscode.TextDocument) {
		const text = generateText(match, document);
		const nested = activeSnippetLines !== undefined
			&& match.range.start.line >= activeSnippetLines.start
			&& match.range.start.line <= activeSnippetLines.end;

		if (nested) {
			const { text: plain, cursorOffset } = resolvePlainText(text);
			await editor.edit((eb) => eb.replace(match.range, plain));
			const cursor = advancePosition(match.range.start, plain.slice(0, cursorOffset));
			editor.selection = new vscode.Selection(cursor, cursor);
		} else {
			// A single insertSnippet call over the trigger range replaces and
			// expands atomically, so one undo reverts the whole expansion.
			await editor.insertSnippet(new vscode.SnippetString(text), match.range);
			if (hasNavigableTabstops(text)) {
				const lineCount = (text.match(/\n/g) ?? []).length;
				activeSnippetLines = { start: match.range.start.line, end: match.range.start.line + lineCount };
			} else {
				activeSnippetLines = undefined;
			}
		}
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async (event) => {
			if (event.contentChanges.length === 0) {return;}

			const minLine = Math.min(...event.contentChanges.map((c) => c.range.start.line));
			mathContext.invalidate(event.document.uri, minLine);

			if (activeSnippetLines) {
				for (const change of event.contentChanges) {
					if (change.range.start.line >= activeSnippetLines.start && change.range.start.line <= activeSnippetLines.end) {
						const removedLines = change.range.end.line - change.range.start.line;
						const addedLines = (change.text.match(/\n/g) ?? []).length;
						activeSnippetLines.end += addedLines - removedLines;
					}
				}
			}

			// An undo/redo can reintroduce text that happens to match a
			// trigger (e.g. undoing an expansion restores the trigger text
			// itself) - auto-expanding in response would make undo a no-op.
			if (event.reason !== undefined) {return;}

			if (expanding) {return;}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== event.document || !LANGUAGES.includes(event.document.languageId)) {return;}

			// editor.selection isn't guaranteed to have caught up with the
			// document edit yet at this point, so derive the cursor position
			// from the change itself rather than trusting the selection.
			if (event.contentChanges.length !== 1) {return;}
			const change = event.contentChanges[0];
			if (change.range.start.line !== change.range.end.line || change.text.includes('\n')) {return;}
			const position = change.range.start.translate(0, change.text.length);

			const matches = getMatches(store.getSnippets(event.document.languageId), event.document, position, mathContext);
			const auto = matches.find((m) => m.snippet.flags.auto);
			if (!auto) {return;}

			expanding = true;
			try {
				await expand(editor, auto, event.document);
			} finally {
				expanding = false;
			}
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => mathContext.forget(doc.uri)),
		vscode.window.onDidChangeTextEditorSelection((event) => {
			if (!activeSnippetLines) {return;}
			const line = event.selections[0]?.active.line;
			if (line === undefined || line < activeSnippetLines.start || line > activeSnippetLines.end) {
				activeSnippetLines = undefined;
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('texptxsnips.expandOnTab', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !editor.selection.isEmpty || !LANGUAGES.includes(editor.document.languageId)) {
				await vscode.commands.executeCommand('tab');
				return;
			}

			const matches = getMatches(store.getSnippets(editor.document.languageId), editor.document, editor.selection.active, mathContext);
			if (matches.length === 0) {
				await vscode.commands.executeCommand('tab');
				return;
			}

			expanding = true;
			try {
				await expand(editor, matches[0], editor.document);
			} finally {
				expanding = false;
			}
		}),
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
