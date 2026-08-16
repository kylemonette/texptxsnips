import * as assert from 'assert';
import * as vscode from 'vscode';
import { RunTracker } from '../runTracker';

const uriA = vscode.Uri.parse('untitled:a.tex');
const uriB = vscode.Uri.parse('untitled:b.tex');

function insertion(pos: vscode.Position, text: string): vscode.TextDocumentContentChangeEvent {
	return { range: new vscode.Range(pos, pos), rangeOffset: 0, rangeLength: 0, text };
}

suite('RunTracker', () => {
	test('nested pending exits (e.g. a fraction chained inside mk) pop one level per exit', () => {
		const runs = new RunTracker();
		// mk expands: fresh run, own trailing text "$"
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		// user types "5" contiguously right where mk left the cursor
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), '5'));
		// a fraction expands, chained, with its own trailing text "}"
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 9), '}');

		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 9))?.character, 10, 'first exit should pop the fraction\'s }');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 10))?.character, 11, 'second exit should pop mk\'s $');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 11)), undefined, 'nothing left to exit');
	});

	test('a native session chained inside a plain run (e.g. int inside mk) pauses and later resumes the outer exit', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		assert.strictEqual(runs.isNativeSessionActive(uriA), false);

		runs.recordNativeExpansion(uriA, 0, 0);
		assert.strictEqual(runs.isNativeSessionActive(uriA), true);

		// once the native session has ended (only reachable in practice once
		// VS Code itself reports !inSnippetMode, i.e. endNativeSession has
		// been called), resume from wherever the cursor now is and exit
		// mk's own pending $
		runs.endNativeSession(uriA);
		const exit = runs.tryExit(uriA, new vscode.Position(5, 3));
		assert.strictEqual(exit?.line, 5);
		assert.strictEqual(exit?.character, 4);
	});

	test('a nested plain expansion at a later tabstop (e.g. pi at vector\'s $2) does not prematurely resume the paused outer exit', () => {
		const runs = new RunTracker();
		// mk expands: fresh run, own trailing text "$"
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		// a vector snippet (2+ tabstops) expands, chained inside mk, spanning line 0 only
		runs.recordNativeExpansion(uriA, 0, 0);
		assert.strictEqual(runs.isNativeSessionActive(uriA), true);

		// user tabs to $2 (no edit fires) and triggers a plain nested
		// expansion there, e.g. "pi" -> "\pi " - still well within the
		// native session's own line, so isNativeSessionActive stays true
		runs.onEdit(uriA, insertion(new vscode.Position(0, 20), 'p'));
		runs.onEdit(uriA, insertion(new vscode.Position(0, 21), 'i'));
		assert.strictEqual(runs.isNativeSessionActive(uriA), true, 'typing at a later tabstop on the same line must not look like leaving the session');
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 24), undefined);

		// the outer mk exit must still be paused, not resumed at the nested
		// position - only once VS Code confirms the session is truly over
		// does it become reachable again, from the real exit position
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 24)), undefined, 'must not resume at the nested pi position');
		runs.endNativeSession(uriA);
		const exit = runs.tryExit(uriA, new vscode.Position(0, 30));
		assert.strictEqual(exit?.character, 31, 'once truly exited, mk\'s own $ should still be reachable');
	});

	test('a plain expansion with no placeholder of its own (e.g. \\times) does not add a nesting level', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 8), undefined);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 8))?.character, 9, 'should pop straight to mk\'s $, no extra level');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 9)), undefined);
	});

	test('whitespace does not break a plain run (e.g. "5x^2 + 4x^2" is one ongoing expression)', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), ' '));
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 2))?.character, 3, 'the run, and mk\'s exit, should have survived the space');
	});

	test('an edit that does not touch the tracked position breaks the run', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 1), '$');
		runs.onEdit(uriA, insertion(new vscode.Position(5, 0), 'x')); // unrelated edit elsewhere
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 1)), undefined, 'run should be broken, exit no longer available');
	});

	test('tracking is isolated per document', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 5), '$');
		assert.strictEqual(runs.tryExit(uriB, new vscode.Position(0, 5)), undefined, 'document B must not see document A\'s pending exit');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 5))?.character, 6, 'document A\'s own exit should still work');
	});

	test('reset() clears tracking (the undo/redo case)', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 5), '$');
		runs.reset(uriA);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 5)), undefined);
	});

	test('forget() removes a closed document entirely', () => {
		const runs = new RunTracker();
		runs.recordPlainExpansion(uriA, new vscode.Position(0, 5), '$');
		runs.forget(uriA);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 5)), undefined);
	});
});
