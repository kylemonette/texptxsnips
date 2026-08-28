'use strict';

// Mocha --require hook for the unit run: makes require('vscode') resolve to
// the stub instead of failing, since there's no real Extension Host (and no
// real 'vscode' package in node_modules - VS Code injects that module itself
// at runtime) to provide it under plain Node.
const Module = require('module');
const stub = require('./vscode-stub.js');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return stub;
	}
	return originalLoad.apply(this, arguments);
};
