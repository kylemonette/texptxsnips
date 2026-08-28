'use strict';

// Minimal stand-in for the real `vscode` module, covering only the surface
// actually touched by the pure-logic source files (mathContext, matching,
// runTracker, snippetTemplate) and their tests. Installed in place of the
// real module by register.js so those suites can run under plain Node,
// without booting a real VS Code Extension Host. extension.test.ts (which
// needs real editors, completion providers, and commands) is excluded from
// this run and still goes through the full `vscode-test` suite.

class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
	translate(lineDelta = 0, characterDelta = 0) {
		return new Position(this.line + lineDelta, this.character + characterDelta);
	}
	isEqual(other) {
		return !!other && this.line === other.line && this.character === other.character;
	}
}

class Range {
	constructor(a, b, c, d) {
		if (typeof a === 'number') {
			this.start = new Position(a, b);
			this.end = new Position(c, d);
		} else {
			this.start = a;
			this.end = b;
		}
	}
}

class Uri {
	constructor(value) {
		this._value = value;
	}
	toString() {
		return this._value;
	}
	static parse(value) {
		return new Uri(value);
	}
	static file(path) {
		return new Uri('file://' + path);
	}
}

let nextDocId = 0;

class FakeTextDocument {
	constructor(content, languageId) {
		this._lines = content.split('\n');
		this.languageId = languageId;
		this.uri = Uri.parse(`untitled:unit-test-${nextDocId++}`);
	}
	lineAt(line) {
		return { text: this._lines[line], lineNumber: line };
	}
	_applyReplace(range, newText) {
		const before = this._lines[range.start.line].slice(0, range.start.character);
		const after = this._lines[range.end.line].slice(range.end.character);
		const inserted = newText.split('\n');
		inserted[0] = before + inserted[0];
		inserted[inserted.length - 1] += after;
		this._lines.splice(range.start.line, range.end.line - range.start.line + 1, ...inserted);
	}
}

class FakeTextEditor {
	constructor(document) {
		this.document = document;
	}
	async edit(callback) {
		const edits = [];
		callback({
			replace: (range, text) => edits.push({ range, text }),
			insert: (position, text) => edits.push({ range: new Range(position, position), text }),
			delete: (range) => edits.push({ range, text: '' }),
		});
		for (const { range, text } of edits) {
			this.document._applyReplace(range, text);
		}
		return true;
	}
}

module.exports = {
	Position,
	Range,
	Uri,
	workspace: {
		openTextDocument(options) {
			return Promise.resolve(new FakeTextDocument(options.content ?? '', options.language ?? 'plaintext'));
		},
	},
	window: {
		showTextDocument(document) {
			return Promise.resolve(new FakeTextEditor(document));
		},
	},
	commands: {
		executeCommand() {
			return Promise.resolve(undefined);
		},
	},
};
