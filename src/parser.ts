import { ParsedSnippetFile, Snippet, SnippetFlags, SnippetGenerator } from './types';

const HEADER_RE = /^snippet(?:\s+`([^`]+)`|\s+(\S+))(?:\s+"([^"]*)")?(?:\s+([A-Za-z]+))?\s*$/;
const PRIORITY_RE = /^priority\s+(-?\d+)\s*$/;
const SNIPPET_LINE_RE = /^snippet(\s|$)/;
const KNOWN_FLAGS = 'Aiwbmh';

function parseFlags(chars: string): SnippetFlags {
	return {
		auto: chars.includes('A'),
		inWord: chars.includes('i'),
		wordBoundary: chars.includes('w'),
		beginningOfLine: chars.includes('b'),
		mathOnly: chars.includes('m'),
		hidden: chars.includes('h'),
	};
}

interface Header {
	trigger: string | RegExp;
	description: string;
	flags: SnippetFlags;
	/** flag characters that aren't one of KNOWN_FLAGS, reported as a warning */
	unknownFlags: string;
}

/** Parses a `snippet ...` header line, or returns why it can't be used. */
function parseHeader(line: string): Header | string {
	const m = HEADER_RE.exec(line.trim());
	if (!m) {return 'malformed snippet header';}
	const [, regexSrc, literal, description, flagChars] = m;
	const flags = parseFlags(flagChars ?? '');
	const unknownFlags = [...(flagChars ?? '')].filter((c) => !KNOWN_FLAGS.includes(c)).join('');

	let trigger: string | RegExp;
	if (regexSrc !== undefined) {
		// Anchor to the end of the scanned text, so a match always ends
		// exactly at the cursor. Wrapped in a group so the anchor applies to
		// the whole pattern - a bare `$` suffix would only bind to the last
		// alternative of `a|b`, and checking for an existing trailing `$`
		// would mistake an escaped literal `\$` for an anchor.
		try {
			trigger = new RegExp(`(?:${regexSrc})$`);
		} catch (err) {
			return `invalid regex trigger (${(err as Error).message})`;
		}
	} else {
		trigger = literal!;
	}
	return { trigger, description: description ?? '', flags, unknownFlags };
}

/** Splits a body on ``code`` blocks and compiles it to a JS source snippet returning the expanded string. */
function compileBodySource(body: string): string {
	const CODE_RE = /``([\s\S]*?)``/g;
	let out = 'function(m,w,path){\nlet out="";\nlet rv;\n';
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CODE_RE.exec(body))) {
		out += `out+=${JSON.stringify(body.slice(lastIndex, match.index))};\n`;
		out += `rv=undefined;\n${match[1]}\n`;
		// rv is spliced in raw, not escaped: a code block is allowed to
		// build literal $1/}/\\ snippet syntax (e.g. programmatically
		// inserting a real tabstop into its own output). A block that never
		// assigns rv contributes nothing, rather than the text "undefined".
		out += 'out+=(rv===undefined||rv===null)?"":String(rv);\n';
		lastIndex = CODE_RE.lastIndex;
	}
	out += `out+=${JSON.stringify(body.slice(lastIndex))};\n`;
	out += 'return out;\n}';
	return out;
}

/**
 * Compiles a file's `global` block and every snippet body into one JS
 * source, evaluated in a single Function call so `global` helpers close
 * over every snippet generator.
 */
function compileGenerators(globalCode: string, bodies: string[], source: string): { generators: SnippetGenerator[]; errors: string[] } {
	const src = `(function(){
${globalCode}
return [
${bodies.map(compileBodySource).join(',\n')}
];
})()`;
	try {
		const generators = new Function(`return ${src};`)() as SnippetGenerator[];
		return { generators, errors: [] };
	} catch (err) {
		return { generators: [], errors: [`${source}: failed to compile snippets: ${(err as Error).message}`] };
	}
}

export function parseSnippetFile(text: string, source: string): ParsedSnippetFile {
	const lines = text.split(/\r?\n/);
	const errors: string[] = [];
	const headers: Header[] = [];
	const bodies: string[] = [];
	const priorities: number[] = [];
	let globalCode = '';
	let pendingPriority = 0;

	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i].trim();

		if (trimmed === 'global') {
			const start = ++i;
			while (i < lines.length && lines[i].trim() !== 'endglobal') {i++;}
			if (i >= lines.length) {
				errors.push(`${source}: missing endglobal for the global block at line ${start}`);
			}
			globalCode += lines.slice(start, i).join('\n') + '\n';
			i++;
			continue;
		}

		const priorityMatch = PRIORITY_RE.exec(trimmed);
		if (priorityMatch) {
			pendingPriority = parseInt(priorityMatch[1], 10);
			i++;
			continue;
		}

		if (SNIPPET_LINE_RE.test(trimmed)) {
			const header = parseHeader(lines[i]);
			i++;
			if (typeof header === 'string') {
				errors.push(`${source}: ${header}: ${lines[i - 1]}`);
				while (i < lines.length && lines[i].trim() !== 'endsnippet') {i++;}
				i++;
				pendingPriority = 0;
				continue;
			}
			if (header.unknownFlags) {
				errors.push(`${source}: unknown flag(s) "${header.unknownFlags}" ignored in: ${lines[i - 1]}`);
			}
			const bodyStart = i;
			while (i < lines.length && lines[i].trim() !== 'endsnippet') {i++;}
			if (i >= lines.length) {
				errors.push(`${source}: missing endsnippet for the snippet at line ${bodyStart}: ${lines[bodyStart - 1]}`);
			}
			bodies.push(lines.slice(bodyStart, i).join('\n'));
			i++;
			headers.push(header);
			priorities.push(pendingPriority);
			pendingPriority = 0;
			continue;
		}

		if (trimmed === '' || trimmed.startsWith('#')) {
			i++;
			continue;
		}

		errors.push(`${source}: unexpected line: ${lines[i]}`);
		i++;
	}

	const { generators, errors: compileErrors } = compileGenerators(globalCode, bodies, source);
	errors.push(...compileErrors);
	if (compileErrors.length > 0) {
		return { snippets: [], errors };
	}

	const snippets: Snippet[] = headers.map((header, idx) => ({
		trigger: header.trigger,
		description: header.description,
		flags: header.flags,
		priority: priorities[idx],
		generate: generators[idx],
		source,
	}));

	return { snippets, errors };
}
