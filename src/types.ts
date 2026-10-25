export interface SnippetFlags {
	/** A - expand immediately on match, without going through the completion list */
	auto: boolean;
	/** i - trigger may match in the middle of a word. String triggers only */
	inWord: boolean;
	/** w - trigger must not follow a word character; the default when neither i nor w is given. String triggers only */
	wordBoundary: boolean;
	/** b - trigger only matches when preceded solely by whitespace on the line */
	beginningOfLine: boolean;
	/** m - trigger only matches inside math context */
	mathOnly: boolean;
	/** h - excluded from the completion list; still expands via `auto` or Tab */
	hidden: boolean;
}

export type SnippetGenerator = (m: RegExpExecArray | null, w: string, path: string) => string;

export interface Snippet {
	trigger: string | RegExp;
	description: string;
	flags: SnippetFlags;
	priority: number;
	generate: SnippetGenerator;
	/** file the snippet was parsed from, for error reporting */
	source: string;
}

export interface ParsedSnippetFile {
	snippets: Snippet[];
	errors: string[];
}
