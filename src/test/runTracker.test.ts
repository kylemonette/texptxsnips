import * as assert from 'assert';
import * as vscode from 'vscode';
import { RunTracker } from '../runTracker';

const uriA = vscode.Uri.parse('untitled:a.tex');
const uriB = vscode.Uri.parse('untitled:b.tex');

// An empty placeholder range: the cursor left at (line, character), nothing selected
function cursorAt(line: number, character: number): vscode.Range {
	return new vscode.Range(line, character, line, character);
}

function insertion(pos: vscode.Position, text: string): vscode.TextDocumentContentChangeEvent {
	return { range: new vscode.Range(pos, pos), rangeOffset: 0, rangeLength: 0, text };
}

// mk typed at the start of line 0 expands to "$|$": fresh run, own trailing text "$"
function expandMk(runs: RunTracker, uri = uriA) {
	runs.recordPlainExpansion(uri, new vscode.Range(0, 0, 0, 2), cursorAt(0, 1), '$');
}

// mk, then "int" typed right where mk left the cursor, expanding into a
// native session (4 fields) spanning line 0 only
function expandIntInsideMk(runs: RunTracker) {
	expandMk(runs);
	runs.onEdit(uriA, insertion(new vscode.Position(0, 1), 'int'));
	runs.recordNativeExpansion(uriA, new vscode.Range(0, 1, 0, 4), 0);
}

suite('RunTracker', () => {
	test('nested pending exits (e.g. a fraction chained inside mk) pop one level per exit', () => {
		const runs = new RunTracker();
		expandMk(runs);
		// user types "5/" contiguously right where mk left the cursor
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), '5/'));
		// a fraction expands from the "/", chained, with its own trailing text "}"
		runs.recordPlainExpansion(uriA, new vscode.Range(0, 2, 0, 3), cursorAt(0, 9), '}');

		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 9))?.character, 10, 'first exit should pop the fraction\'s }');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 10))?.character, 11, 'second exit should pop mk\'s $');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 11)), undefined, 'nothing left to exit');
	});

	test('a native session chained inside a plain run (e.g. int inside mk) pauses and later resumes the outer exit', () => {
		const runs = new RunTracker();
		expandMk(runs);
		assert.strictEqual(runs.isNativeSessionActive(uriA), false);

		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), 'int'));
		runs.recordNativeExpansion(uriA, new vscode.Range(0, 1, 0, 4), 0);
		assert.strictEqual(runs.isNativeSessionActive(uriA), true);

		// once the native session has ended (only reachable in practice once
		// VS Code itself reports !inSnippetMode, i.e. endNativeSession has
		// been called), resume from wherever the cursor now is on the
		// session's line and exit mk's own pending $
		runs.endNativeSession(uriA);
		const exit = runs.tryExit(uriA, new vscode.Position(0, 12));
		assert.strictEqual(exit?.line, 0);
		assert.strictEqual(exit?.character, 13);
	});

	test('a nested plain expansion at a later tabstop (e.g. pi at vector\'s $2) does not prematurely resume the paused outer exit', () => {
		const runs = new RunTracker();
		expandMk(runs);
		// a vector snippet (2+ tabstops) expands, chained inside mk, spanning line 0 only
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), 'vec'));
		runs.recordNativeExpansion(uriA, new vscode.Range(0, 1, 0, 4), 0);
		assert.strictEqual(runs.isNativeSessionActive(uriA), true);

		// user tabs to $2 (no edit fires) and triggers a plain nested
		// expansion there, e.g. "pi" -> "\pi " - still well within the
		// native session's own line, so isNativeSessionActive stays true
		runs.onEdit(uriA, insertion(new vscode.Position(0, 20), 'p'));
		runs.onEdit(uriA, insertion(new vscode.Position(0, 21), 'i'));
		assert.strictEqual(runs.isNativeSessionActive(uriA), true, 'typing at a later tabstop on the same line must not look like leaving the session');
		runs.recordPlainExpansion(uriA, new vscode.Range(0, 20, 0, 22), cursorAt(0, 24), undefined);

		// the outer mk exit must still be paused, not resumed at the nested
		// position - only once VS Code confirms the session is truly over
		// does it become reachable again, from the real exit position
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 24)), undefined, 'must not resume at the nested pi position');
		runs.endNativeSession(uriA);
		const exit = runs.tryExit(uriA, new vscode.Position(0, 30));
		assert.strictEqual(exit?.character, 31, 'once truly exited, mk\'s own $ should still be reachable');
	});

	test('a paused exit is dropped once an edit lands outside its session\'s lines', () => {
		const runs = new RunTracker();
		expandIntInsideMk(runs);
		runs.onEdit(uriA, insertion(new vscode.Position(10, 0), 'an unrelated paragraph'));
		assert.strictEqual(runs.isNativeSessionActive(uriA), false);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 12)), undefined, 'Tab back on the session line must not jump anymore');
	});

	test('a paused exit is not resumed from outside its session\'s lines', () => {
		const runs = new RunTracker();
		expandIntInsideMk(runs);
		runs.endNativeSession(uriA);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(20, 5)), undefined, 'Tab far away should insert a tab, not jump');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 12))?.character, 13, 'still reachable from the session line');
	});

	test('an expansion away from where the run left off (e.g. Tab elsewhere) starts a fresh run', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.recordPlainExpansion(uriA, new vscode.Range(7, 0, 7, 3), cursorAt(7, 3), '}');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(7, 3))?.character, 4, 'its own } should be exitable');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(7, 4)), undefined, 'mk\'s $ from the old run must not be popped here');
	});

	test('the native session span shrinks when lines inside it are deleted', () => {
		const runs = new RunTracker();
		// a 4-line native snippet on lines 0-3
		runs.recordNativeExpansion(uriA, new vscode.Range(0, 0, 0, 3), 3);
		// join lines 1-3 into line 1, leaving the session on lines 0-1
		runs.onEdit(uriA, { range: new vscode.Range(1, 0, 3, 0), rangeOffset: 0, rangeLength: 0, text: '' });
		assert.strictEqual(runs.isNativeSessionActive(uriA), true);
		runs.onEdit(uriA, insertion(new vscode.Position(3, 0), 'x'));
		assert.strictEqual(runs.isNativeSessionActive(uriA), false, 'line 3 is now outside the session');
	});

	test('a tabstop default left selected (e.g. choose\'s r) is recognized, and Tab from its end exits past the suffix', () => {
		const runs = new RunTracker();
		const def = new vscode.Range(0, 11, 0, 12);
		runs.recordPlainExpansion(uriA, new vscode.Range(0, 0, 0, 3), def, '}');
		assert.strictEqual(runs.isSelectedDefault(uriA, def), true);
		assert.strictEqual(runs.isSelectedDefault(uriA, new vscode.Range(0, 5, 0, 12)), false, 'a different selection is the user\'s own');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 12))?.character, 13);
		assert.strictEqual(runs.isSelectedDefault(uriA, def), false, 'exiting clears it');
	});

	test('typing over a selected default continues the run, and the default is no longer selected', () => {
		const runs = new RunTracker();
		const def = new vscode.Range(0, 11, 0, 12);
		runs.recordPlainExpansion(uriA, new vscode.Range(0, 0, 0, 3), def, '}');
		runs.onEdit(uriA, { range: def, rangeOffset: 0, rangeLength: 1, text: 'kk' });
		assert.strictEqual(runs.isSelectedDefault(uriA, def), false);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 13))?.character, 14, 'exit from the end of what replaced it');
	});

	test('a plain expansion with no placeholder of its own (e.g. \\times) does not add a nesting level', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), 'xx'));
		runs.recordPlainExpansion(uriA, new vscode.Range(0, 1, 0, 3), cursorAt(0, 8), undefined);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 8))?.character, 9, 'should pop straight to mk\'s $, no extra level');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 9)), undefined);
	});

	test('whitespace does not break a plain run (e.g. "5x^2 + 4x^2" is one ongoing expression)', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.onEdit(uriA, insertion(new vscode.Position(0, 1), ' '));
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 2))?.character, 3, 'the run, and mk\'s exit, should have survived the space');
	});

	test('an edit that does not touch the tracked position breaks the run', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.onEdit(uriA, insertion(new vscode.Position(5, 0), 'x')); // unrelated edit elsewhere
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 1)), undefined, 'run should be broken, exit no longer available');
	});

	test('tracking is isolated per document', () => {
		const runs = new RunTracker();
		expandMk(runs);
		assert.strictEqual(runs.tryExit(uriB, new vscode.Position(0, 1)), undefined, 'document B must not see document A\'s pending exit');
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 1))?.character, 2, 'document A\'s own exit should still work');
	});

	test('reset() clears tracking (the undo/redo case)', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.reset(uriA);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 1)), undefined);
	});

	test('forget() removes a closed document entirely', () => {
		const runs = new RunTracker();
		expandMk(runs);
		runs.forget(uriA);
		assert.strictEqual(runs.tryExit(uriA, new vscode.Position(0, 1)), undefined);
	});
});
