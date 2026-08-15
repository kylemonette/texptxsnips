import * as vscode from 'vscode';
import * as fs from 'fs';
import { SnippetStore } from './snippetStore';
import { MathContextTracker } from './mathContext';
import { getMatches, SnippetMatch } from './matching';
import { getSnippetsDir } from './utils';
import { advancePosition, resolveTemplate } from './snippetTemplate';

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

	// Position where an unbroken, whitespace-free run of typing since the
	// last *native* snippet session started currently ends - i.e. whether
	// that session may still be live there. VS Code's snippet controller
	// can't tell our own edits apart from a nested snippet insertion: any
	// programmatic edit landing inside its tracked range, via insertSnippet
	// *or* a plain editor.edit, loses track of its remaining tabstops.
	// Normal typing doesn't trip this because it goes through VS Code's own
	// input pipeline rather than an extension's edit API.
	//
	// Auto-expand (typing-triggered, below) never itself starts a native
	// session - it always resolves to plain text with the cursor placed
	// manually - so chaining several auto snippets in a row (e.g. multiple
	// inline math shortcuts in one $ $) never risks this at all. This only
	// matters for a *different* live session: one started deliberately via
	// Tab (texptxsnips.expandOnTab), whose own remaining tabstops an
	// auto-expand triggered while typing inside it could still corrupt.
	let contiguousRunEnd: vscode.Position | undefined;

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

	// Starts a real native tabstop session. Only safe where no other live
	// session can conflict with it (Tab is disabled while inSnippetMode).
	async function applyExpansion(editor: vscode.TextEditor, match: SnippetMatch, document: vscode.TextDocument) {
		const text = generateText(match, document);
		const resolved = resolveTemplate(text);
		// A single insertSnippet call over the trigger range replaces and
		// expands atomically, so one undo reverts the whole expansion.
		await editor.insertSnippet(new vscode.SnippetString(text), match.range);
		contiguousRunEnd = resolved.firstPlaceholderOffset !== undefined
			? advancePosition(match.range.start, resolved.text.slice(0, resolved.firstPlaceholderOffset))
			: undefined;
	}

	// Never starts a native session, so it's always safe to call regardless
	// of what else is going on - used for every typing-triggered expansion.
	async function applyPlainExpansion(editor: vscode.TextEditor, match: SnippetMatch, document: vscode.TextDocument) {
		const text = generateText(match, document);
		const resolved = resolveTemplate(text);
		await editor.edit((eb) => eb.replace(match.range, resolved.text));
		const cursorOffset = resolved.firstPlaceholderOffset ?? resolved.cursorOffset;
		const cursor = advancePosition(match.range.start, resolved.text.slice(0, cursorOffset));
		editor.selection = new vscode.Selection(cursor, cursor);
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
				contiguousRunEnd = undefined;
				return;
			}

			// applyExpansion() already updates contiguousRunEnd itself for the
			// edit it makes; only track plain user keystrokes here. A
			// keystroke that doesn't land exactly at the tracked end, or that
			// is whitespace, breaks the run.
			if (!expanding && contiguousRunEnd) {
				const change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
				if (change && change.range.isEmpty && change.range.start.isEqual(contiguousRunEnd) && !/\s/.test(change.text)) {
					contiguousRunEnd = advancePosition(contiguousRunEnd, change.text);
				} else {
					contiguousRunEnd = undefined;
				}
			}

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

			// A session started via Tab may still be live at this position -
			// see contiguousRunEnd's comment for why we can't safely edit here.
			if (contiguousRunEnd !== undefined) {return;}

			const matches = getMatches(store.getSnippets(event.document.languageId), event.document, position, mathContext);
			const auto = matches.find((m) => m.snippet.flags.auto);
			if (!auto) {return;}

			expanding = true;
			try {
				await applyPlainExpansion(editor, auto, event.document);
			} finally {
				expanding = false;
			}
		}),
		vscode.workspace.onDidCloseTextDocument((doc) => mathContext.forget(doc.uri))
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

			// The keybinding only fires when !inSnippetMode, so no outer
			// session can be live here - always safe to expand directly.
			expanding = true;
			try {
				await applyExpansion(editor, matches[0], editor.document);
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
