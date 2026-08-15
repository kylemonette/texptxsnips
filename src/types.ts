export interface SnippetFlags {
	/** A - expand immediately on match, without going through the completion list */
	auto: boolean;
	/** i - trigger may match in the middle of a word */
	inWord: boolean;
	/** w - trigger must match a whole word (word-boundary on both sides) */
	wordBoundary: boolean;
	/** b - trigger only matches when preceded solely by whitespace on the line */
	beginningOfLine: boolean;
	/** m - trigger only matches inside LaTeX math context */
	mathOnly: boolean;
	/** h - excluded from the completion list; requires `auto` */
	hidden: boolean;
}

export type SnippetGenerator = (m: RegExpExecArray | null, t: string[], w: string, path: string) => string;

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
