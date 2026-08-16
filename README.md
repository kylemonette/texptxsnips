[![Version](https://vsmarketplacebadges.dev/version-short/KyleMonette.texptxsnips.png)](https://marketplace.visualstudio.com/items?itemName=KyleMonette.texptxsnips)
[![Version](https://vsmarketplacebadges.dev/rating-short/KyleMonette.texptxsnips.png)](https://marketplace.visualstudio.com/items?itemName=KyleMonette.texptxsnips)
[![Version](https://vsmarketplacebadges.dev/installs/KyleMonette.texptxsnips.png)](https://marketplace.visualstudio.com/items?itemName=KyleMonette.texptxsnips)

# TeXPtxSnips

Snippet engine for LaTeX and PreTeXt in VS Code.

Forked from [HyperSnips V2](https://github.com/Oskar-Idland/hsnips) (itself descended from [hsnips](https://github.com/draivin/hsnips) and [UltiSnips](https://github.com/SirVer/ultisnips)) to fix a handful of tabstop bugs and add PreTeXt support.

## Quick start

Run **TeXPtxSnips: Open Snippets Directory** from the Command Palette, then add a file named after the language you want — `latex.snips`, `pretext.snips` — or `all.snips` for snippets shared across both. A minimal example:

```
snippet mk "inline math" A
\$$1\$
endsnippet
```

Type `mk` in a `.tex` file and it expands immediately, cursor left between the two `$`. Save the file (or run **TeXPtxSnips: Reload Snippets**) to pick up changes.

## The `.snips` file format

### Snippets

```
snippet trigger "description" flags
body text with $1 $2 tabstops
endsnippet
```

`trigger` is a bare word (`mk`) or a backtick-delimited regex (`` `([a-zA-Z])(\d)` ``), matched against the text right before the cursor. Capture groups are available in the body as `m[1]`, `m[2]`, etc.

The body uses standard VS Code snippet syntax: `$1`, `${1}`, `${1:default text}`, `$0` for the final cursor position. Escape a literal `$`, `\`, or `}` as `\$`, `\\`, `\}`.

### Flags

| Flag | Meaning |
| --- | --- |
| `A` | Expand immediately on match, no Tab needed. |
| `i` | Match anywhere, including mid-word. |
| `w` | Require a word boundary before the trigger. Default when `i`/`w` are both omitted. |
| `b` | Only match at the start of a line (whitespace before it is fine). |
| `m` | Only match inside math mode. |
| `h` | Hide from the completion list; still expands via `A` or Tab. |

`i`, `w`, `b` only apply to bare-word triggers — a regex trigger's pattern is the whole boundary condition.

### Code blocks

Splice in JavaScript between double backticks; assign to `rv` to produce output:

```
snippet `([a-zA-Z])(\d)` "auto subscript" wAm
``rv = m[1] + '_' + m[2]``
endsnippet
```

Available inside: `m` (regex capture groups), `t` (tabstop contents), `w` (workspace path), `path` (current file path). `rv` is spliced in as-is, so it can contain real snippet syntax (`rv = '\\frac{' + m[1] + '}{$1}$0'`) — escape any `$` you don't want treated as a tabstop.

### `global` blocks and `priority`

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

A `global` block runs once on load; its functions and constants are visible to every code block in the file. `priority N` applies to the single snippet that follows it (default `0`, higher wins on a tie).

### File naming and merging

A file's name (minus `.snips`) is matched against the document's language ID — `latex.snips` for `.tex`, `pretext.snips` for `.ptx`. `all.snips` applies everywhere.

### Syntax highlighting

`.snips` files get their own highlighting out of the box — triggers, flags, tabstops, and code blocks (with real JavaScript inside).

## Math mode

The `m` flag gates a snippet on LaTeX math context — `$...$`, `$$...$$`, `\(...\)`, `\[...\]`, or a math environment (`equation`, `align`, `cases`, `pmatrix`, ...) — including `\text{}` correctly switching back to prose mid-formula.

## Multi-field snippets

Two or more tabstops (`\frac{$1}{$2}`) get a real native Tab session. Zero or one tabstop is inserted as plain text with the cursor placed directly, which is what lets several `A`-flagged shortcuts chain inside one `$...$`.

## Manual expansion

A snippet without `A` doesn't expand as you type — press **Tab** right after typing it.

## Commands and settings

- **TeXPtxSnips: Reload Snippets** — re-read all `.snips` files (also happens automatically on save).
- **TeXPtxSnips: Open Snippets Directory** — create (if needed) and reveal the snippets folder.
- `texptxsnips.snippetsDir` — override the snippets folder. Defaults to a `texptxsnips` folder alongside VS Code's own `User` directory.
