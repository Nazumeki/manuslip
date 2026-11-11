# Input fixes review and validation

Reviewed the current uncommitted input/rendering changes against `0e2e53e` on Windows x64,
2026-11-11. Production source was left unchanged during this review.

## Findings

All four findings are P2 correctness issues. The ordinary input regression suite passes;
these are additional contexts outside its existing assertions.

1. **Fence completion uses syntax that may not cover the caret.**
   `packages/editor/src/markdown-input.ts:18` resolves the current syntax tree without
   checking its coverage. For `('Paragraph **text**.\n\n').repeat(1000) +
   '```js\ntext\n```'`, a freshly updated source state has 21,014 units but only 3,002
   parsed units. Calling `blockOpeningTransaction` at EOF inserts `\n\n` and another
   closing fence after the existing closer. The same result occurs with 10,000 and
   40,000 paragraphs. Require reliable syntax coverage, or defer completion and use
   ordinary newline behavior when context is unavailable. Native editor confirmation
   is recorded separately below.

2. **Fence gestures also run inside literal HTML and frontmatter.**
   `packages/editor/src/markdown-input.ts:24` checks the line's spelling after excluding
   only an enclosing `FencedCode`. With `<div>\n```js` or `<!--\n~~~`, the syntax tree
   correctly identifies `HTMLBlock`/`CommentBlock`, but Enter's transaction still adds
   a blank body and matching fence. An unfinished YAML scalar,
   `---\nvalue: |\n  ```js`, is transformed too. These are literal contents of the
   surrounding construct. Gate completion on eligible Markdown context and exclude
   the active metadata region.

3. **Mod+Enter recognizes invalid code closers as the end of the body.**
   `packages/editor/src/live-interactions.ts:16` accepts any three-or-more backticks
   or tildes without matching the opener's character and minimum length. In
   a block with a four-backtick opener and three-backtick final line, or a backtick
   opener and tilde final line, the final line is code content in an unclosed fenced
   block. With the caret after `text`, `finishBlockTransaction(state,
   true)` nevertheless ends the editing session and inserts paragraph spacing after
   the block. This moves a caret that is still in the body; subsequent prose remains
   inside the unclosed code fence. Resolve the actual closing fence before calculating
   the eligible body-end position.

4. **Table Shift+Enter renders literally inside formatting when HTML is disabled.**
   `packages/renderer/src/projection-engine.ts:213` permits the generated attribute-free
   `<br />` only when its immediate parent is `tableCell`. In a strong/emphasis/link
   node inside a cell, that test fails. For example, `| **a<br />b** |` renders
   `<strong>a&#x3C;br />b</strong>` rather than a line break, while the unformatted
   cell works. Apply the safe-break exception throughout a table cell's inline
   descendants, retaining the attribute restriction and literal behavior outside tables.

## Validation

| Check | Result |
| --- | --- |
| `npm run check` | Passed: lint, format, layout/docs, lockfile, import boundaries, parser patch guards, TypeScript |
| `npm test -- --maxWorkers=2 --reporter=dot` | Passed: 293 files; 43,306 passed, 1 skipped; 170.41 s |
| Additional Node packaging tests | Passed: 37 passed, 6 platform-specific skips |
| `npm run build` | Passed: current renderer/main/preload and Windows NSIS package |
| Hardened package open/edit/save smoke | Passed |
| `npm run test:packaged` | Running |
| `npm run test:pandoc`, Pandoc 3.13 | Passed: 15 tests |
| Pandoc desktop tests | Pending |
| Packaged and main-process performance gates | Pending |
| `npm run test:installer` | Blocked by its clean-account assertion: this account has an existing Manuslip installation |

The installer check stopped before installing anything. Read-only preflight found the
existing installation under `D:/Office/Manuslip`, its registrations, shortcuts, and Open
With advertisements. Run this check in a clean Windows account as required by
[distribution.md](../development/distribution.md).

Temporary diagnostic probes and logs are in the ignored `test/packaging/result` directory.
They exercise the production transaction and renderer functions and record exact input,
syntax coverage, resulting source, and HTML. They are review evidence, not new assertions
in the product test suite. Full validation logs are retained there as `input-review-*.log`.
