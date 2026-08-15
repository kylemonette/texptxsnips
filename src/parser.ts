import { ParsedSnippetFile, Snippet, SnippetFlags, SnippetGenerator } from './types';

const HEADER_RE = /^snippet(?:\s+`([^`]+)`|\s+(\S+))(?:\s+"([^"]*)")?(?:\s+([A-Za-z]+))?\s*$/;
const PRIORITY_RE = /^priority\s+(-?\d+)\s*$/;

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
}

function parseHeader(line: string): Header | null {
	const m = HEADER_RE.exec(line.trim());
	if (!m) {return null;}
	const [, regexSrc, literal, description, flagChars] = m;
	const flags = parseFlags(flagChars ?? '');

	let trigger: string | RegExp;
	if (regexSrc !== undefined) {
		// anchor to the end of the scanned text, like hsnips, so a match
		// always ends exactly at the cursor
		trigger = new RegExp(regexSrc.endsWith('$') ? regexSrc : regexSrc + '$');
	} else {
		trigger = literal!;
	}
	return { trigger, description: description ?? '', flags };
}

/** Splits a body on ``code`` blocks and compiles it to a JS source snippet returning the expanded string. */
function compileBodySource(body: string): string {
	const CODE_RE = /``([\s\S]*?)``/g;
	let out = 'function(m,t,w,path){\nlet out="";\nlet rv;\n';
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CODE_RE.exec(body))) {
		out += `out+=${JSON.stringify(body.slice(lastIndex, match.index))};\n`;
		out += `rv=undefined;\n${match[1]}\n`;
		out += 'out+=__esc(rv);\n';
		lastIndex = CODE_RE.lastIndex;
	}
	out += `out+=${JSON.stringify(body.slice(lastIndex))};\n`;
	out += 'return out;\n}';
	return out;
}

/**
 * Compiles a file's `global` block and every snippet body into one JS
 * source, evaluated in a single Function call so `global` helpers close
 * over every snippet generator - mirrors hsnips' code-interpolation model.
 */
function compileGenerators(globalCode: string, bodies: string[], source: string): { generators: SnippetGenerator[]; errors: string[] } {
	const src = `(function(){
function __esc(v){return String(v).replace(/[\\\\$}]/g, c => '\\\\' + c);}
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

		if (trimmed.startsWith('snippet')) {
			const header = parseHeader(lines[i]);
			i++;
			if (!header) {
				errors.push(`${source}: malformed snippet header: ${lines[i - 1]}`);
				while (i < lines.length && lines[i].trim() !== 'endsnippet') {i++;}
				i++;
				pendingPriority = 0;
				continue;
			}
			const bodyStart = i;
			while (i < lines.length && lines[i].trim() !== 'endsnippet') {i++;}
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
