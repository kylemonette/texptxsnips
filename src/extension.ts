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
	let nativeSessionEnd: vscode.Position | undefined;

	// Since auto-expand never starts a real snippet session, there's no
	// native tabstop for Tab to jump past afterwards either - so we track
	// our own lightweight "exit points" instead: the trailing static text of
	// every snippet-with-a-placeholder expanded so far in the current
	// unbroken typing run, innermost last. Chaining a snippet that itself
	// has a placeholder (e.g. a fraction's denominator) inside another
	// (e.g. mk's $ $) nests a second trailing boundary between the cursor
	// and the outer one, so a single flat suffix isn't enough - each Tab
	// press with nothing left to expand pops and jumps past one level.
	// Kept as text rather than a length because it can contain newlines
	// that a plain character offset can't walk. autoRunEnd tracks the run
	// the same way nativeSessionEnd does.
	let autoRunEnd: vscode.Position | undefined;
	let pendingExits: string[] = [];

	// A chained plain-run expansion can itself need a real native session.
	// Going native clears pendingExits/autoRunEnd
	// since a live native session must own navigation, but that would
	// otherwise silently strand whatever the plain run was still waiting to
	// exit. pausedExits holds that stack while the nested native session is live,
	// and gets restored once we can next confirm it's over - either the
	// next expandMatch (a fresh trigger typed right after) or expandOnTab
	// (gated on VS Code's own !inSnippetMode, so that's a reliable signal).
	let pausedExits: string[] | undefined;

	const reportErrors = (errors: string[]) => {
		if (errors.length === 0) {return;}
		output.appendLine(errors.join('\n'));
		output.show(true);
	};

	// Temporary diagnostic tracing for the run-tracking state machine.
	const log = (msg: string) => output.appendLine(msg);
	const posStr = (p: vscode.Position | undefined) => p ? `${p.line}:${p.character}` : 'undefined';

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
	// environments), so it gets a genuine native session - protected by
	// nativeSessionEnd against a later nested auto-expand the same way a
	// Tab-gated one already is. A snippet with 0-1 tabstops has nothing to
	// navigate between, so it's resolved as plain text with the cursor
	// placed manually instead: this never starts a native session, so
	// chaining several of these in a row (e.g. multiple inline math
	// shortcuts in one $ $) is always safe regardless of what triggered it.
	async function expandMatch(editor: vscode.TextEditor, match: SnippetMatch, document: vscode.TextDocument) {
		const text = generateText(match, document);
		const resolved = resolveTemplate(text);
		log(`expandMatch "${match.snippet.description}" range=[${match.range.start.line}:${match.range.start.character},${match.range.end.line}:${match.range.end.character}) resolved=${JSON.stringify(resolved.text)} placeholderCount=${resolved.placeholderCount} firstPlaceholderOffset=${resolved.firstPlaceholderOffset}`);

		if (resolved.placeholderCount >= 2) {
			// A single insertSnippet call over the trigger range replaces and
			// expands atomically, so one undo reverts the whole expansion.
			await editor.insertSnippet(new vscode.SnippetString(text), match.range);
			nativeSessionEnd = resolved.firstPlaceholderOffset !== undefined
				? advancePosition(match.range.start, resolved.text.slice(0, resolved.firstPlaceholderOffset))
				: undefined;
			// The native session owns navigation now. If this was chained
			// inside a plain run with something still pending (e.g. mk's
			// closing $), stash it rather than dropping it - see pausedExits.
			if (autoRunEnd !== undefined && pendingExits.length > 0) {
				pausedExits = pendingExits;
			}
			autoRunEnd = undefined;
			pendingExits = [];
			log(`  -> native session; nativeSessionEnd=${posStr(nativeSessionEnd)} autoRunEnd/pendingExits cleared, pausedExits=${JSON.stringify(pausedExits)}`);
			return;
		}

		await editor.edit((eb) => eb.replace(match.range, resolved.text));
		const cursorOffset = resolved.firstPlaceholderOffset ?? resolved.cursorOffset;
		const cursor = advancePosition(match.range.start, resolved.text.slice(0, cursorOffset));
		editor.selection = new vscode.Selection(cursor, cursor);

		// A fresh trigger with no run of its own currently live, but a
		// paused stack waiting from a native session that must therefore
		// just have ended (a new expansion means we're back to plain
		// typing) - pick the paused run back up rather than starting over.
		const resuming = autoRunEnd === undefined && pausedExits !== undefined;
		if (resuming) {
			pendingExits = pausedExits!;
			pausedExits = undefined;
			log(`  resumed paused run; pendingExits=${JSON.stringify(pendingExits)}`);
		}

		if (autoRunEnd === undefined && !resuming) {
			// First expansion of a genuinely fresh run: start the exit stack
			// from scratch with this one's own trailing text, if it has any.
			pendingExits = resolved.firstPlaceholderOffset !== undefined ? [resolved.text.slice(resolved.firstPlaceholderOffset)] : [];
			log(`  -> plain, fresh run; cursor=${posStr(cursor)} pendingExits=${JSON.stringify(pendingExits)}`);
		} else {
			// Chained within an existing (possibly just-resumed) run: a
			// snippet with its own placeholder (e.g. a fraction's
			// denominator) nests a new trailing boundary inside whatever
			// was already pending - push it as the new innermost level. One
			// with no placeholder of its own doesn't add a new boundary.
			if (resolved.firstPlaceholderOffset !== undefined) {
				pendingExits.push(resolved.text.slice(resolved.firstPlaceholderOffset));
			}
			log(`  -> plain, chained; cursor=${posStr(cursor)} pendingExits=${JSON.stringify(pendingExits)}`);
		}
		autoRunEnd = cursor;
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
				nativeSessionEnd = undefined;
				autoRunEnd = undefined;
				pendingExits = [];
				pausedExits = undefined;
				return;
			}

			// applyExpansion()/applyPlainExpansion() already update their own
			// tracked end for the edit they make; only track plain user
			// keystrokes here. Any edit that touches the tracked end - typing
			// there, or backspacing/typing over content right before it -
			// keeps the run going; an edit elsewhere breaks it.
			const change = event.contentChanges.length === 1 ? event.contentChanges[0] : undefined;
			log(`onDidChangeTextDocument expanding=${expanding} changes=${event.contentChanges.length} change=${change ? `range=[${change.range.start.line}:${change.range.start.character},${change.range.end.line}:${change.range.end.character}) text=${JSON.stringify(change.text)}` : 'n/a'} autoRunEnd=${posStr(autoRunEnd)} nativeSessionEnd=${posStr(nativeSessionEnd)}`);
			const advanceIfTouching = (end: vscode.Position): vscode.Position | undefined => {
				if (change === undefined || !change.range.end.isEqual(end)) {return undefined;}
				return advancePosition(change.range.start, change.text);
			};

			if (!expanding && nativeSessionEnd) {
				// Whitespace also breaks this one: it only exists to protect a
				// real Tab-started session, and once the user has moved on to
				// typing unrelated content there's no reason to keep guarding it.
				const before = nativeSessionEnd;
				nativeSessionEnd = change && !/\s/.test(change.text) ? advanceIfTouching(nativeSessionEnd) : undefined;
				if (nativeSessionEnd === undefined) {log(`  nativeSessionEnd broken (was ${posStr(before)})`);}
			}
			if (!expanding && autoRunEnd) {
				// No whitespace check here: a space or newline can be part of
				// the same ongoing expression (e.g. "5x^2 + 4x^2", or content
				// spanning multiple lines inside dm) - only an edit that
				// doesn't touch the tracked position means we've moved on.
				const before = autoRunEnd;
				autoRunEnd = advanceIfTouching(autoRunEnd);
				if (autoRunEnd === undefined) {
					log(`  autoRunEnd broken (was ${posStr(before)}); pendingExits cleared (was ${JSON.stringify(pendingExits)})`);
					pendingExits = [];
				} else {
					log(`  autoRunEnd advanced ${posStr(before)} -> ${posStr(autoRunEnd)}`);
				}
			}

			if (expanding) {return;}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== event.document || !LANGUAGES.includes(event.document.languageId)) {return;}

			// editor.selection isn't guaranteed to have caught up with the
			// document edit yet at this point, so derive the cursor position
			// from the change itself rather than trusting the selection.
			if (change === undefined || change.range.start.line !== change.range.end.line || change.text.includes('\n')) {return;}
			const position = change.range.start.translate(0, change.text.length);

			// A session started via Tab may still be live at this position -
			// see nativeSessionEnd's comment for why we can't safely edit here.
			if (nativeSessionEnd !== undefined) {return;}

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
		vscode.workspace.onDidCloseTextDocument((doc) => mathContext.forget(doc.uri))
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('texptxsnips.expandOnTab', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !editor.selection.isEmpty || !LANGUAGES.includes(editor.document.languageId)) {
				log(`expandOnTab: no editor/non-empty selection/wrong language -> fallback tab`);
				await vscode.commands.executeCommand('tab');
				return;
			}

			log(`expandOnTab: cursor=${posStr(editor.selection.active)} autoRunEnd=${posStr(autoRunEnd)} pendingExits=${JSON.stringify(pendingExits)} pausedExits=${JSON.stringify(pausedExits)} nativeSessionEnd=${posStr(nativeSessionEnd)}`);
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

			// Nothing to expand and no live run of our own - but if there's a
			// paused stack, a nested native session (e.g. int) must have just
			// ended, since this command only runs when VS Code itself
			// confirms !inSnippetMode. Resume tracking from here so the
			// outer exit is still reachable below.
			if (autoRunEnd === undefined && pausedExits !== undefined) {
				autoRunEnd = editor.selection.active;
				pendingExits = pausedExits;
				pausedExits = undefined;
				log(`expandOnTab: resumed paused run at ${posStr(autoRunEnd)}; pendingExits=${JSON.stringify(pendingExits)}`);
			}

			// Nothing to expand - if we're sitting right where an auto-expand
			// run left off, jump past the innermost pending trailing text
			// (e.g. a chained fraction's own closing }) instead of inserting
			// a literal tab. If that leaves an outer one still pending (e.g.
			// mk's closing $), a further Tab press exits that one too.
			if (pendingExits.length > 0 && autoRunEnd !== undefined && editor.selection.active.isEqual(autoRunEnd)) {
				const suffix = pendingExits.pop()!;
				const exit = advancePosition(autoRunEnd, suffix);
				log(`expandOnTab: popped ${JSON.stringify(suffix)}, exiting to ${posStr(exit)}, ${pendingExits.length} level(s) still pending`);
				editor.selection = new vscode.Selection(exit, exit);
				autoRunEnd = exit;
				return;
			}

			log(`expandOnTab: no match, no pending exit -> fallback tab`);
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
