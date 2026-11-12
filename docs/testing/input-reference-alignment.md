# Input reference alignment

The 2026-11-11 input pass uses Zed for punctuation behavior and the local Typora
1.14.10 Windows implementation for the existing Markdown editing paths. It adds
no completion menu, language service, extension API or preference.

## References

- Zed commit `985bbf42e684ef5b5a9312a6abf075aeafbaf5b9`:
  [Markdown pairs](https://github.com/zed-industries/zed/blob/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/grammars/src/markdown/config.toml)
  and [input implementation](https://github.com/zed-industries/zed/blob/985bbf42e684ef5b5a9312a6abf075aeafbaf5b9/crates/editor/src/input.rs).
- Typora resources at
  `D:/Project/user/Nazumeki/manuslip-typora/work/typora-re/sample/Typora/resources`.
  The already extracted `typemark` modules beside that sample provide readable
  references: `045750_parser-mark.js`, `010142_source-view.js`,
  `041901_table-edit.js`, `003544_fences.js`, and `057371_math-block.js`.
  These reference files were inspected without modification.

This is a correction of the inspected paths, not a claim that every Typora
interaction or platform has identical behavior.

## Behavior contract

| Path | Corrected behavior |
| --- | --- |
| Empty Markdown caret | `(`, `[`, `{`, `<` generate their closer before whitespace, EOF, or Zed's `;:.,=}])>` boundary characters. |
| Prose markers | Quotes, backticks, `*`, and `~` remain literal at an empty caret and surround selected text. `_`, `$`, `=`, and `^` remain literal. |
| Selected content | Surrounds retain the selected content, direction, and independent ranges. A second marker can surround the same selection. A selection made entirely of delimiter characters is replaced literally, so editing a closer never recursively surrounds it. |
| Escaped opener | An opener preceded by an odd backslash run stays literal. |
| Owned closer | Typing the generated closer moves the caret across it with no source mutation. Authored closers remain ordinary input. |
| Empty pair deletion | Backspace removes an owned empty pair atomically. Other carets delete their own selection or complete grapheme. |
| Pair lifetime | Interior edits map the generated closer. Leaving the region or undo/redo releases ownership. |
| Pair Enter | Enter inside a generated bracket opens an indented body and retains the closing line in one transaction. Cell Enter keeps table navigation. |
| Code language | Existing CodeMirror language data supplies code pairs. Quotes inside an already open string do not generate another closer. |
| Composition | Pair input, pair Backspace, pair Enter, block opening, navigation and block finishing defer to native composition. No text comes from a key name or synthetic `beforeinput` event. |
| Delayed projection | A selection-only closer skip retains the input caret, so a semantic publication cannot hide source before the next native input. |
| Source Enter | Continues existing Markdown lists and blockquotes; an empty item removes its marker. |
| Live block entry | Enter after a code fence, `$$`, or first-line TOML/enabled YAML opener creates its empty body and matching closing line, including before existing prose. The caret starts inside the body; code indentation is retained. Source editing activates in the same transaction without waiting for a semantic publication. Existing closers and HTML/comment content are never completed again. |
| Completion history | Completion is an isolated undo step. Undo restores the opener; redo restores the interior caret. Backspace in an empty body dismisses the completion and returns to the opener without removing neighboring text. |
| Unfinished fences | Live Preview retains unclosed code/diagram fences as editable source. Reading and export retain CommonMark's EOF fence semantics. |
| Delimiter visibility | Both metadata fences stay visible while its source is active; rule markers stay literal under the caret. Code-fence markers use the surrounding source font size and theme colors. |
| Metadata typing | A single-line `+++` or enabled `---` cannot iterate a nonexistent second line or leave DOM input absent from accepted source. |
| Dollar math | Default single-dollar math rejects leading/trailing whitespace, a backslash immediately before the closer, and a digit immediately after it. Escaped interior dollars remain TeX source. Flow math and double-dollar grammar retain the pinned compiler. |
| Scripts | Escaped spaces in existing subscript/superscript syntax render as spaces. Original Markdown positions and saved bytes remain intact. |
| Table Shift+Enter | Inserts `<br />` into the current cell instead of moving upward. Attribute-free `br` tags render as cell line breaks with general HTML disabled. Other HTML keeps its existing policy. |
| Table Tab | Moves forward and selects the destination cell content; the last cell appends a row and opens its first cell. Shift+Tab moves backward and selects the destination. Ordinary Enter removes a selection before moving below, selecting the destination only when no source was removed. |
| Table Mod+Enter | Inserts a row below the active row, retaining the active column. A header insertion follows the alignment separator. |
| Table history | Row creation and any selected-cell deletion form one atomic parent-history entry. Rejected row creation preserves the selected content. Cell input, normalization, caret forwarding and undo continue to use that same source. |
| Empty table cells | New text is placed between existing padding, including generated empty rows. |
| Table limits | Direct row creation shares the dialog's row, column, total-cell and source-byte limits. Normalized cell input shares its cell-unit limit. |
| Leaving a block | Mod+Enter from anywhere in a closed code, diagram, math or metadata body moves below it without altering the body. Down Arrow at the body end or closing-line end does the same. Existing paragraph spacing is reused; EOF receives a blank paragraph. Ordinary Enter remains inside the body. Escape finishes a source session without changing source. Selection, read-only state and composition suppress these editing gestures. |
| Semantic scheduling | Small Live documents coalesce completion punctuation for 16 ms; ordinary input, paste and large documents retain the 150 ms debounce. Parsing stays in the worker with one running and one newest pending request. |
| Input information | Accepted-source measures record positions, lengths, selection counts and punctuation actions. Selection-only skips are measured separately and never counted as document edits. No document content is added to performance metadata. |
| Transport timing | Cross-context transport delays are bounded at zero because independently rounded performance clocks can otherwise report small negative durations. The benchmark continues to reject invalid samples. |

## Native timing evidence

The completion UX refinement also checks Typora's documented
[fence entry](https://support.typora.io/Code-Fences/) and
[optional auto-pair behavior](https://support.typora.io/Auto-Pair/). The local
`003544_fences.js` handles Down at the last body line and Backspace in an empty
code editor. Manuslip adopts those navigation principles while keeping its
closing delimiters editable. It does not enable every optional Typora punctuation
pair by default or claim identical UI behavior.

The regression suite `test/e2e/input-reference-alignment.spec.ts` verifies native
typing immediately after completion and redo, mid-document insertion, body exits,
empty-block dismissal, literal closer replacement, and exact saved source. Unit
tests additionally cover indentation, metadata/plugin switches, syntax coverage,
existing closers and undo isolation. The measurements below describe the earlier
input pass, not new performance measurements for this refinement.

[Raw observations](input-reference-performance.json) contain six verified samples
per case from an isolated, unpackaged production Electron build. Each sample
checks exact source through native Save and reads the resulting temporary file.
The link sample verifies a source caret at offset 20,029, avoiding visual-line
`End` as a source-position oracle.

| Input | Keydown to accepted source, median (range), ms | Keydown to semantic apply, median (range), ms |
| --- | --- | --- |
| Source bracket pair | 1.7 (1.5–2.5) | No active semantic consumer |
| Strong-emphasis closer | 1.2 (1.1–1.6) | 20.7 (19.6–21.9) |
| Inline-math closer | 1.0 (1.0–1.2) | 20.8 (19.8–24.7) |
| Emoji closer | 1.5 (1.4–1.7) | 21.0 (20.2–38.7) |
| 20,029-unit link closer | 3.4 (3.4–4.4) | 23.0 (22.1–27.1) |

All 30 sources matched; no page errors or long tasks occurred in these samples.
Semantic apply does not measure final math SVG readiness or compositor
presentation. These measurements include instrumentation on one Windows machine;
they are not a Typora/Zed runtime speed comparison or a packaged release gate.

## Verification

- The full unit run passed 43,238 tests with one skipped before the final small
  caret/row-padding/pair-newline/timing corrections. The affected editor and worker
  suites were rerun after those corrections, including 1,452 passing tests for
  punctuation, caret lifetime, scheduling, and both worker transport paths.
- Repository lint, format, layout, lockfile, dependency patch checks, import
  boundaries, and TypeScript passed. The production application build passed.
- The 43-check native run covered input references, lifecycle regressions,
  composition barriers, mode changes, projected editing, and visual tables.
  Its HTML closer regression was fixed and passed a dedicated rerun. A long-HTML
  layout timeout also passed the rerun; all five HTML checks passed together.
- After the final pair-Enter and table-selection changes, the eight reference
  checks plus four existing visual-table checks passed together: 12/12.
- The final Windows package passed `npm run test:performance -- corpus.spec.ts`:
  all six 1 MiB corpora met their existing input, callback, semantic freshness,
  application-slice and mode-switch gates, with zero fallback. Input-to-frame
  p95 ranged from 6.4 to 25.4 ms; editor callback p95 was at most 0.2 ms.
  [Retained packaged results](input-reference-corpus.json) include machine,
  executable/ASAR hashes, samples and corpus budgets.
- `test/e2e/input-reference-alignment.spec.ts` covers pairs, selection direction,
  source-neutral skipping, generated-pair Enter, IME punctuation, list
  continuation, progressive metadata, block opening, table line breaks, row
  creation/undo, and math finishing against saved source.

OS candidate windows, alternative keyboard layouts, other platforms and packaged
release performance require their existing separate validation runs.
