# Changelog

## 0.0.1

Initial release.

- `.snips` file format: `global`/`endglobal` blocks, `priority`, literal and regex triggers, backtick JS code blocks, flags (`A i w b m h`)
- Math-context detection for LaTeX via an incremental tokenizer (correctly distinguishes `\\[1em]` from `\[`, handles `\text{}`/environments/nesting)
- Auto-expand, Tab-gated manual expansion, and completion-list triggering
- Atomic, single-step undo for expansions
- Safe chaining of multiple auto-expand snippets inside one another (e.g. several inline math shortcuts inside one `$...$`) without corrupting a native tabstop session
- Multi-field snippets get full native Tab navigation between placeholders; single-field/no-field snippets stay lightweight and chainable
- `texptxsnips.reloadSnippets` and `texptxsnips.openSnippetsDir` commands
