# TeXPtxSnips

Snippet expansion for LaTeX and PreTeXt in VS Code.
Snippets live in plain text `.snips` files you edit yourself, using regex triggers and inline JavaScript for dynamic expansion.
This is the same general model as [HyperSnips](https://github.com/Oskar-Idland/hsnips), which was inspiration for this project.

## Quick start

Run **TeXPtxSnips: Open Snippets Directory** from the Command Palette to create and reveal your snippets folder, then add a file named after the language you want to target — `latex.snips`, `pretext.snips` — or `all.snips` for snippets shared across both. A minimal example:

```
snippet mk "inline math" A
\$$1\$
endsnippet
```

Type `mk` in a `.tex` file and it expands immediately, with your cursor left between the two `$`. Save the file (or run **TeXPtxSnips: Reload Snippets**) and new snippets take effect right away.

## The `.snips` file format

### Snippets

```
snippet trigger "description" flags
body text with $1 $2 tabstops
endsnippet
```

`trigger` is either a bare word (`mk`) or a backtick-delimited regular expression (`` `([a-zA-Z])(\d)` ``). A regex trigger is matched against the text immediately before the cursor and is always anchored to end exactly there, whether or not you write the trailing `$` yourself. Capture groups are available in the body as `m[1]`, `m[2]`, etc.

The body uses standard VS Code snippet syntax for tabstops: `$1`, `${1}`, `${1:default text}`, and `$0` for the final cursor position. A literal `$`, `\`, or `}` in your output needs to be escaped as `\$`, `\\`, `\}`.

### Flags

| Flag | Meaning |
| --- | --- |
| `A` | Expand immediately once the trigger matches — no need to accept it from a suggestion list or press Tab. |
| `i` | Match anywhere, including mid-word. |
| `w` | Require the trigger to sit at a word boundary (not preceded by a letter/digit). This is also the default when neither `i` nor `w` is given. |
| `b` | Only match when nothing but whitespace precedes the trigger on the line. |
| `m` | Only match inside LaTeX math mode (see below). |
| `h` | Hide from the completion list; still expandable via `A` or Tab. Has no effect without one of those. |

`i`, `w`, and `b` only constrain **bare-word** triggers. A regex trigger's own pattern is the entire boundary condition — write a lookbehind like `` `(?<!\\)pi` `` if you need one; the engine doesn't add anything on top. This matches how HyperSnips itself behaves, and it's a distinction worth knowing, since a flag that looks like it should constrain a regex trigger silently won't.

### Code blocks

A body can splice in JavaScript between double backticks. Assign to `rv` to produce output; the block's return value has no other effect on its own:

```
snippet `([a-zA-Z])(\d)` "auto subscript" wAm
``rv = m[1] + '_' + m[2]``
endsnippet
```

Available inside a code block: `m` (regex capture groups, or `null` for a bare-word trigger), `t` (tabstop contents — reserved for future live re-evaluation; currently always empty), `w` (workspace folder path), `path` (current file path). Whatever you assign to `rv` is spliced into the output as-is, including any snippet syntax it contains — this is deliberate, so a code block can construct real tabstops programmatically (`rv = '\\frac{' + m[1] + '}{$1}$0'`), but it also means a stray `$` in computed text will be read as a tabstop unless you escape it yourself.

### `global` blocks and `priority`

A `global` / `endglobal` block runs once when the file loads; anything it defines (functions, constants) is visible to every code block in that file:

```
global
function today() {
	return new Date().toISOString().slice(0, 10);
}
endglobal

snippet date "today's date" A
``rv = today()``$0
endsnippet
```

A `priority N` line applies to the single snippet that follows it (default `0`, higher wins when multiple snippets would otherwise match at the same spot).

### File naming and merging

A file's name (without `.snips`) is matched against the document's VS Code language ID: `latex.snips` applies to `.tex` files, `pretext.snips` to `.ptx` files. Snippets in `all.snips` are merged into every language.

## Math-context detection

Flagging a snippet `m` gates it on whether the cursor sits inside LaTeX math mode — `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, or a math environment (`equation`, `align`, `cases`, `pmatrix`, ...). This is done with a real incremental tokenizer that treats `\\` (the line-break command) as one atomic token distinct from `\[`.
This was done to prevent strings such as `\\[1em]` in a `tabular` row (to add whitespace after the row) being interpreted as the start of display math.
The `\text{}`, `\mathrm{}`, and similar font/language-switching commands are also handled, including math nested back inside them (`\text{the value $x$}`).

## Multi-field snippets

A snippet is expanded one of two ways, chosen automatically by how many distinct tabstops it has:

- **Two or more** tabstops like `\frac{$1}{$2}` gets a real native tabstop session — Tab moves between fields exactly as in any other VS Code snippet.
- **Zero or one** tabstops like `\pi` or `mk`'s `\$$1\$` is inserted as a plain edit with the cursor placed directly, and is always safe to trigger again from inside another such snippet. That's what makes chaining several `A`-flagged shortcuts inside one `$...$` work (typing a subscript, then a superscript, without leaving the outer expression).

## Manual expansion

A snippet without `A` doesn't expand as you type it.
Pressing **Tab** right after typing it expands it directly.

## Commands and settings

- **TeXPtxSnips: Reload Snippets** — re-read all `.snips` files (also happens automatically on save).
- **TeXPtxSnips: Open Snippets Directory** — create (if needed) and reveal the snippets folder.
- `texptxsnips.snippetsDir` — override the snippets folder. Defaults to a `texptxsnips` folder alongside VS Code's own `User` directory.
