import * as vscode from 'vscode';
import * as fs from 'fs';
import { SnippetStore } from './snippetStore';
import { MathContextTracker } from './mathContext';
import { getMatches, SnippetMatch } from './matching';
import { getSnippetsDir } from './utils';
import { advancePosition, resolveTemplate } from './snippetTemplate';
import { RunTracker } from './runTracker';

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
	const runs = new RunTracker();
	let expanding = false;

	const reportErrors = (errors: string[]) => {
		if (errors.length === 0) {return;}
		output.appendLine(errors.join('\n'));
		output.show(true);
	};

	// Diagnostic tracing for the run-tracking state machine, off by default
	// since it fires on every keystroke - enable texptxsnips.debug to
	// investigate expansion/chaining bugs. Lazy so the message strings
	// (several involve JSON.stringify) aren't built when disabled.
	const log = (build: () => string) => {
		if (vscode.workspace.getConfiguration('texptxsnips').get<boolean>('debug', false)) {
			output.appendLine(build());
		}
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

	// A snippet with 2+ distinct tabstops needs real Tab-to-jump navigation
	// between its fields (e.g. table, tplot, the theorem-family
	// environments), so it gets a genuine native session - protected
	// against a later nested auto-expand the same way a Tab-gated one
	// already is. A snippet with 0-1 tabstops has nothing to navigate
	// between, so it's resolved as plain text with the cursor placed
	// manually instead: this never starts a native session, so chaining
	// several of these in a row (e.g. multiple inline math shortcuts in
	// one $ $) is always safe regardless of what triggered it. See
	// RunTracker for how an outer run's own pending exit survives a nested
	// native session like this.
	async function expandMatch(editor: vscode.TextEditor, match: SnippetMatch, document: vscode.TextDocument) {
		const text = generateText(match, document);
		const resolved = resolveTemplate(text);
		log(() => `expandMatch "${match.snippet.description}" resolved=${JSON.stringify(resolved.text)} placeholderCount=${resolved.placeholderCount}`);

		if (resolved.placeholderCount >= 2) {
			// A single insertSnippet call over the trigger range replaces and
			// expands atomically, so one undo reverts the whole expansion.
			await editor.insertSnippet(new vscode.SnippetString(text), match.range);
			const nativeSessionEnd = resolved.firstPlaceholderOffset !== undefined
				? advancePosition(match.range.start, resolved.text.slice(0, resolved.firstPlaceholderOffset))
				: undefined;
			runs.recordNativeExpansion(document.uri, nativeSessionEnd);
			log(() => `  -> native session; ${runs.debugSnapshot(document.uri)}`);
			return;
		}

		await editor.edit((eb) => eb.replace(match.range, resolved.text));
		const cursorOffset = resolved.firstPlaceholderOffset ?? resolved.cursorOffset;
		const cursor = advancePosition(match.range.start, resolved.text.slice(0, cursorOffset));
		editor.selection = new vscode.Selection(cursor, cursor);

		const ownSuffix = resolved.firstPlaceholderOffset !== undefined ? resolved.text.slice(resolved.firstPlaceholderOffset) : undefined;
		runs.recordPlainExpansion(document.uri, cursor, ownSuffix);
		log(() => `  -> plain; cursor=${cursor.line}:${cursor.character}; ${runs.debugSnapshot(document.uri)}`);
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(async (event) => {
			if (event.contentChanges.length === 0) {return;}

			const minLine = Math.min(...event.contentChanges.map((c) => c.range.start.line));
			mathContext.invalidate(event.document.uri, minLine);

			// An undo/redo can reintroduce text that happens to match a
			// trigger (e.g. undoing an expansion restores the trigger text
			// itself) - auto-expanding in response would make undo a no-op.
			// Its edit shape also doesn't mean anything for run-tracking.
			if (event.reason !== undefined) {
				runs.reset(event.document.uri);
				return;
			}

			// expandMatch() already updates tracking itself for the edits it
			// makes; only track plain user keystrokes here.
			const change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
			if (!expanding) {
				runs.onEdit(event.document.uri, change);
				log(() => `onDidChangeTextDocument change=${change ? JSON.stringify(change.text) : 'n/a'}; ${runs.debugSnapshot(event.document.uri)}`);
			}

			if (expanding) {return;}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== event.document || !LANGUAGES.includes(event.document.languageId)) {return;}

			// editor.selection isn't guaranteed to have caught up with the
			// document edit yet at this point, so derive the cursor position
			// from the change itself rather than trusting the selection.
			if (change === undefined || change.range.start.line !== change.range.end.line || change.text.includes('\n')) {return;}
			const position = change.range.start.translate(0, change.text.length);

			// A session started via Tab may still be live at this position.
			if (runs.isNativeSessionActive(event.document.uri)) {return;}

			const matches = getMatches(store.getSnippets(event.document.languageId), event.document, position, mathContext);
			const auto = matches.find((m) => m.snippet.flags.auto);
			if (!auto) {return;}

			expanding = true;
			try {
				await expandMatch(editor, auto, event.document);
			} finally {
				expanding = false;
			}
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			mathContext.forget(doc.uri);
			runs.forget(doc.uri);
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
			if (matches.length > 0) {
				// The keybinding only fires when !inSnippetMode, so no outer
				// session can be live here - always safe to expand directly.
				expanding = true;
				try {
					await expandMatch(editor, matches[0], editor.document);
				} finally {
					expanding = false;
				}
				return;
			}

			// Nothing to expand - if we're sitting right where an auto-expand
			// run left off, jump past its innermost pending trailing text
			// (e.g. mk's closing $, or a chained fraction's own closing })
			// instead of inserting a literal tab.
			const exit = runs.tryExit(editor.document.uri, editor.selection.active);
			if (exit !== undefined) {
				log(() => `expandOnTab: exiting to ${exit.line}:${exit.character}; ${runs.debugSnapshot(editor.document.uri)}`);
				editor.selection = new vscode.Selection(exit, exit);
				return;
			}

			await vscode.commands.executeCommand('tab');
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
