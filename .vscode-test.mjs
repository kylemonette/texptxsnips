import { defineConfig } from '@vscode/test-cli';

// Opt-in, local-only way to skip the download: point this at your installed
// VS Code's binary (e.g. on macOS,
// "/Applications/Visual Studio Code.app/Contents/MacOS/Code") to reuse it
// instead of downloading a separate copy. Left unset, this falls back to the
// normal (downloaded, isolated-profile) behavior, so it stays portable for
// anyone else/CI who hasn't set it.
const executablePath = process.env.VSCODE_TEST_EXECUTABLE_PATH;
console.log(
	executablePath
		? `[texptxsnips] VSCODE_TEST_EXECUTABLE_PATH is set - reusing ${executablePath}, no download.`
		: '[texptxsnips] VSCODE_TEST_EXECUTABLE_PATH is not set in this process - will download VS Code.'
);

export default defineConfig({
	files: 'out/test/**/*.test.js',
	useInstallation: executablePath ? { fromPath: executablePath } : undefined,
});