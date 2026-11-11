# Typora rendering and input comparison

Audit date: 2026-11-11. Manuslip revision: `0e2e53e`.

The [input-lifecycle follow-up](typora-input-lifecycle.md) adds event traces, input
metadata, before/after state, linked extension updates, and measured performance.
It also corrects the HTML auto-closing interpretation in I14: disabling completion
suggestions does not disable the bundled HTML language's automatic closing tags.

Manuslip has substantial Markdown rendering support, but its input contract differs from
Typora's. It edits authoritative source in CodeMirror 6, decorates ordinary syntax, and
replaces selected semantic ranges with rendered widgets. Clicking a widget can open an
explicit source-edit session. Consequently, supporting a syntax does not imply matching
Typora's typing, selection, navigation, clipboard, or activation behavior.

This is an implementation exploration, not a request to change those contracts. In
particular, literal input and the retirement of focus/typewriter modes are existing
product decisions. Differences below are not automatically defects or proposed features.

## Evidence and limits

Manuslip evidence combines source inspection, a fresh application build, 35 passing
Electron end-to-end tests, and isolated exploratory probes. The probes save and reread
actual source, rather than inferring source from decorated DOM. Their exact inputs and
outputs are in [typora-input-observations.json](typora-input-observations.json).

Typora evidence is its official documentation retrieved on the audit date. No Typora
binary was run; no executable was found in the checked standard Windows installation
paths. This report does not claim access to Typora's parser, internal document model,
render scheduler, undo implementation, or current bundled library versions. Documentation
describes behavior, not proof of its internal implementation. Theme, OS, preferences, and
Typora version must be pinned before attempting visual or behavioral parity measurements.

Use the [comparison fixture](../../test/e2e/fixtures/markdown/typora-comparison.md) for
manual follow-up. A fixture is a collection of inputs, not a list of passing assertions.

Verdicts:

- **D**: a supported difference between Manuslip evidence and documented Typora behavior.
- **E**: capability exists in both; exact behavior or pixels are not asserted identical.
- **V**: Manuslip implementation is established; a direct Typora comparison is still needed.

The inventory contains **207 behavior entries**: 105 documented differences, 20 shared
capabilities, and 82 implementation details awaiting a direct comparison. A further 24
interaction traces specify the unresolved manual work.

An entry with several punctuation examples describes one implementation rule. Distinct
keys, edit surfaces, syntax contexts, permissions, and lifecycle transitions are separate
entries. This keeps differences actionable without counting every Unicode character as a
separate feature.

## Findings that change the comparison most

1. **Paragraph entry:** ordinary Enter writes one newline in both Manuslip editing modes.
   Typora documents a paragraph break in its hybrid view. The visible result may look
   similar while exported structure differs. See I01 and W01–W03.
2. **Whitespace depends on projection:** four spaces measured about `18.64px` in an ordinary
   editable line and `4.67px` in a smart-punctuation paragraph on the same page. The latter
   has `white-space: normal`; the original source still contains four spaces. Typora
   documents preserving repeated whitespace in its editing view. See W04–W05.
3. **Dollar delimiters:** `$ x $`, `$x$2`, and `$2 and $3` each rendered as one formula in
   Manuslip. Typora's current documented default delimiter rules exclude these cases.
   This is a parsing difference, including a currency false positive, independent of
   font choice or MathJax output. See M02–M04.
4. **Table boundaries:** Tab at the final cell exits Manuslip's table without adding a row;
   Typora documents row creation with Tab. Structural editing also uses a separate staged
   dialog in Manuslip. See T04 and T12–T20.
5. **Input automation:** pairing, Markdown continuation, formatting commands, and rich
   paste are separate from rendering. Manuslip deliberately supports much less automatic
   source rewriting. See I03–I16, K01–K18, and P01–P10.

## Implementation map

| Layer | Manuslip implementation | Consequence for comparison |
| --- | --- | --- |
| Authoritative text | [editor state and keys](../../packages/editor/src/index.ts), [document controller](../../apps/desktop/src/renderer/src/document.ts) | Source offsets and transactions remain authoritative in Live Preview. |
| Immediate syntax | [Lezer Markdown setup](../../packages/editor/src/syntax.ts), [inline decorations](../../packages/editor/src/live-inline.ts) | Ordinary emphasis can react before semantic rendering completes. Markdown input keymaps, HTML completion suggestions, and URL wrapping are disabled; the bundled HTML language still installs automatic closing tags. |
| Semantic parse | [desktop grammar](../../packages/core/src/document-markdown.ts), [transforms](../../packages/core/src/document-transforms.ts) | Desktop behavior must be traced through `parseDocumentMarkdown`; the lower-level fixed `parseMarkdown` grammar alone is insufficient. |
| Rendered projection | [block decorations](../../packages/editor/src/live-blocks.ts), [model mapping](../../packages/editor/src/live-model-changes.ts) | Changed projections are removed/mapped while worker results arrive; untouched projections can remain mounted. |
| Editing session | [live editing](../../packages/editor/src/live-editing.ts), [activation](../../packages/editor/src/live-interactions.ts) | Activation, selection, source exposure, and session exit are distinct transitions. |
| Coordinate mapping | [rendered text hits](../../packages/editor/src/live-position.ts), [source positions](../../packages/editor/src/live-source-position.ts), [preview positions](../../packages/editor/src/live-preview-position.ts) | A rendered glyph needs a source mapping; a visual click is not simply a native text caret operation. |
| Table input | [embedded cell editor](../../packages/editor/src/live-table.ts), [cell filter](../../packages/editor/src/live-table-source.ts), [structural dialog](../../apps/desktop/src/renderer/src/TableEditor.tsx) | Immediate cell edits and staged structural edits have different navigation and undo contracts. |
| Input ownership | [composition barrier](../../packages/editor/src/input-synchronization.ts), [embedded editors](../../packages/editor/src/embedded-editor.ts) | Save, view changes, and other commands wait for pending native input. |
| Expensive output | [math](../../packages/renderer/src/math.ts), [diagram host](../../apps/desktop/src/renderer/diagram/main.ts), [preview widgets](../../apps/desktop/src/renderer/src/preview/widgets.ts) | SVG generation, async loading, fallbacks, and geometry need their own checks. |

The tables below cite the implementation at each section boundary. **V** rows deliberately
avoid inventing a Typora counterpart. Equivalent capabilities are retained so that the
comparison does not incorrectly report implemented features as missing.

## I — Newlines, literal input, and source mutation

Manuslip: [key setup](../../packages/editor/src/index.ts#L115),
[syntax configuration](../../packages/editor/src/syntax.ts#L12),
[raw-input tests](../../test/e2e/raw-input-rendering.spec.ts#L45), and recorded probes.
Typora: [line breaks](https://support.typora.io/Line-Break/),
[auto pairing](https://support.typora.io/Auto-Pair/),
[Markdown reference](https://support.typora.io/Markdown-Reference/), and
[source-mode list continuation release note](https://support.typora.io/What's-New-1.5/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| I01 | Enter in Live prose | Inserts exactly one `\n`; no paragraph command. Reproduced. | Hybrid Enter creates a paragraph break. | D |
| I02 | Enter in Source prose | Inserts exactly one `\n`. Reproduced. | Compare Source separately from Typora hybrid mode. | V |
| I03 | Enter after `- item` | Does not insert the next bullet in either mode. Tested and reproduced. | List continuation is documented, including Source-mode maintenance. | D |
| I04 | Enter after `1. item` | Does not insert/increment another numbered marker. Tested. | Automatic list continuation. | D |
| I05 | Enter after `> quote` | Does not insert another `>` marker. Tested. | Quote continuation is documented. | D |
| I06 | Enter after an indented line | Does not carry indentation. Reproduced. | Measure Typora Source and code input separately. | V |
| I07 | Shift+Enter after four-space indentation | Carries four spaces through inherited `insertNewlineAndIndent`. Reproduced in both modes. | Hybrid Shift+Enter is a line-break command; indentation details need a run. | V |
| I08 | Enter versus Shift+Enter | Both insert a single newline; indentation behavior differs. | Hybrid keys distinguish paragraphs from lines. | D |
| I09 | Tab in a list line | Inserts literal `\t`; does not nest the list. Reproduced. | Tab is documented as an indent command. | D |
| I10 | Type `(`, `[`, or `{` | Inserts the typed character only. Tested. | Optional bracket pairing. | D |
| I11 | Type a single/double quote | No generated closing quote. Tested. | Optional quote pairing. | D |
| I12 | Type a Markdown delimiter | No Markdown pairing extension is installed. | Optional Markdown-symbol pairing. | D |
| I13 | Select text, then type a delimiter | Ordinary replacement; no Markdown surround-selection command is installed. | Optional selection wrapping. | D |
| I14 | Type an HTML opening tag | HTML suggestions are disabled, but the bundled HTML language installs `autoCloseTags`. Native character entry of `<div>` generates `</div>`; inserting a whole string follows a different path. See the input-lifecycle follow-up. | Direct HTML entry is supported; exact completion requires a run. | V |
| I15 | Paste a URL over a selection | Replaces the selection with URL text; `pasteURLAsLink: false`. Tested. | Confirm current Typora URL-over-selection behavior directly. | V |
| I16 | Backspace around generated pairs | No Markdown/bracket pairing extension is installed; inherited HTML auto-closing has its own `input.complete` transactions. | Pair deletion/overtype details require paired-input tests. | V |
| I17 | Enter after an opening code fence | Writes a newline; does not generate a closing fence. Reproduced. | Typora has a dedicated fence-entry interaction. | D |
| I18 | Empty list item, then Enter | No Markdown-specific empty-item exit handler is registered. | Measure source changes for one and two consecutive Returns. | V |
| I19 | Backspace at list/quote start | Inherits CodeMirror deletion; no semantic list/quote command is registered. | Measure marker removal, merging, and unnesting separately. | V |
| I20 | Ctrl/Cmd+Enter in main editor | Inherits CodeMirror's blank-line command, outside higher-priority widget handlers. | Do not equate this with Typora math/table completion shortcuts. | V |

## K — Formatting and editing shortcuts

Manuslip: [installed keymap](../../packages/editor/src/index.ts#L115),
[Edit menu](../../apps/desktop/src/renderer/src/EditingTools.tsx),
[native menu](../../apps/desktop/src/main/index.ts), and `defaultKeymap` from the pinned
`@codemirror/commands` dependency. No application Markdown formatting commands were found.
Typora: [shortcut reference](https://support.typora.io/Shortcut-Keys/).
Keys below use the Windows/Linux spelling; macOS mappings must be tested independently.

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| K01 | Ctrl+B | No bold command; selected `text` stayed unchanged in both modes. | Strong formatting. | D |
| K02 | Ctrl+I | Inherited `selectParentSyntax`, not an italic command. | Emphasis formatting. | D |
| K03 | Ctrl+U | No underline command installed. | Underline formatting. | D |
| K04 | Ctrl+K | No hyperlink formatting command installed. | Hyperlink insertion. | D |
| K05 | Ctrl+Shift+I | No image formatting command installed. | Image insertion. | D |
| K06 | Ctrl+Shift+backtick | No inline-code formatting command installed. | Inline code. | D |
| K07 | Alt+Shift+5 | No strike formatting command installed. | Strikethrough. | D |
| K08 | Ctrl+backslash | No clear-format command installed. | Clear formatting. | D |
| K09 | Ctrl+1 | Switches to Source. | Heading 1. | D |
| K10 | Ctrl+2 | Switches to Live Preview. | Heading 2. | D |
| K11 | Ctrl+3 | Opens translated reading through application routing. | Heading 3. | D |
| K12 | Ctrl+4 through Ctrl+6 | No heading-level commands installed. | Heading levels. | D |
| K13 | Ctrl+T | No insert-table command installed. Existing-table editing is separate. | Insert table. | D |
| K14 | Ctrl+Shift+K | Inherited `deleteLine`: deletes a source line. Reproduced in both modes. | Code fences. | D |
| K15 | Ctrl+Shift+M | No insert-math command installed. | Math block. | D |
| K16 | Ctrl+Shift+Q | No blockquote formatting command installed. | Quote block. | D |
| K17 | Ctrl+Shift+brackets | No ordered/unordered-list formatting commands installed. | List formatting. | D |
| K18 | Ctrl+/ | Inherited `toggleComment`; wrapped `alpha` as `<!-- alpha -->` in both modes. | Source toggle. | D |
| K19 | Ctrl+D | Inherits CodeMirror selection of the next matching occurrence. | Word selection; interaction differs. | D |
| K20 | Alt+Up/Down | Inherits source-line movement. | Compare behavior in list, code, table, and prose contexts. | V |
| K21 | Custom shortcut configuration | No shortcut-remapping preference or command registry for formatting was found. | Menu shortcut customization. | D |
| K22 | Undo after switching Source/Live | Same document/history survives compartment reconfiguration. | Compare exact undo groups, rather than assuming a view switch loses history. | V |

## L — Live rendering, activation, and selection

Manuslip: [inline rendering](../../packages/editor/src/live-inline.ts),
[block rendering](../../packages/editor/src/live-blocks.ts),
[session state](../../packages/editor/src/live-editing.ts),
[Escape](../../packages/editor/src/live-interactions.ts),
[selection overlap](../../packages/editor/src/live-selection.ts),
[selection painting](../../packages/editor/src/selection.ts), and
[navigation](../../packages/editor/src/live-navigation.ts).
Typora: [live preview](https://support.typora.io/Quick-Start/#live-preview) and
[inline activation](https://support.typora.io/Markdown-Reference/#span-elements).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| L01 | Finish ordinary emphasis | Lezer decorations can hide markers without waiting for worker output. | Inline live rendering. | E |
| L02 | Caret inside bold/italic/code | Delimiters appear while the inner text retains its type style. | Smart syntax exposure exists; compare exact boundary positions. | E |
| L03 | Caret at delimiter boundaries | `caretTouches` includes both endpoints. Adjacent formatting can reveal at a shared boundary. | Exact endpoint inclusion is undocumented. | V |
| L04 | Nested formatting | `formatCaret` walks formatting ancestors, so exposure can involve an outer span. | Measure nested emphasis/code combinations. | V |
| L05 | Caret in a simple heading | Heading markers can reappear while heading typography remains. | Block markers are documented as hidden after rendering; exact re-entry needs a run. | V |
| L06 | Caret in a simple list/quote | Active syntax nodes can expose their block markers. | Measure per-item versus whole-container exposure. | V |
| L07 | Click transformed prose | Can open source for the owning semantic paragraph/list/quote, rather than one inline token. | Compare exposure granularity for the same content. | V |
| L08 | Click code, math, image, or HTML widget | Uses a mapped source-edit session; the rendered widget is not an editable DOM representation of source. | Comparable source access exists; internal Typora model is unknown. | V |
| L09 | Collapsed caret near a projection | Does not itself count as a nonempty source-revealing selection. | Measure keyboard traversal into rendered blocks. | V |
| L10 | Nonempty selection overlaps a projection | Overlapping rendered block is replaced by source. | Measure drag/Shift-selection exposure and reflow. | V |
| L11 | Selection ends exactly at block start | Half-open overlap does not reveal the next block. | Exact boundary behavior needs a run. | V |
| L12 | Move caret within an active session | Source remains open through semantic refresh. | Compare update/closure timing while typing. | V |
| L13 | Move selection outside active source range | Explicit editing session closes. | Measure exit into each neighboring block kind. | V |
| L14 | Escape during an active source session | Closes session and moves caret to the mapped end/next boundary. | Do not assume Typora's Escape has the same meaning. | V |
| L15 | Escape during composition | Session-exit handler yields rather than closing active IME input. | Requires real IME comparison. | V |
| L16 | Shift+Up/Down into projected prose | Reveals source before CodeMirror measures the selection destination. | Measure visual goal-column and selection reflow. | V |
| L17 | Drag or double-click rendered text | Custom handlers preserve native selection paths and map clicks to source. Existing tests cover several cases. | Exact word boundaries and click timing need matching OS settings. | V |
| L18 | Select multiline text | Custom marks/geometry paint selected characters without full-width line tails. | Compare screenshots at wraps, blank lines, and bidi transitions. | V |
| L19 | Multiple/rectangular selections | CodeMirror support is explicitly enabled in the main editor. | Do not infer Typora support or absence without a run. | V |
| L20 | Escaped punctuation/entity/emoji under caret | Shows source hints with decoded glyph support; otherwise renders decoded text. | Compare glyph duplication, hint positioning, and source selection. | V |

## W — Whitespace, paragraphs, and grammar edges

Manuslip: [live line-break preservation](../../packages/editor/src/live-line-breaks.ts),
[projection CSS](../../apps/desktop/src/renderer/src/styles.css#L1687),
[desktop grammar](../../packages/core/src/document-markdown.ts),
[CommonMark guide](../guides/commonmark.md), and recorded measurements.
Typora: [whitespace policy](https://support.typora.io/Line-Break/),
[strict mode](https://support.typora.io/Strict-Mode/), and
[Markdown reference](https://support.typora.io/Markdown-Reference/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| W01 | Authored single newline in prose | Live preserves it, including semantic prose via `br[data-source-break]`. | Editing preserves single breaks by default. | E |
| W02 | Same source in reading/export | Live-only added `br` elements are not inserted into reading/export HTML. A soft break can collapse. | Separate editing/export policies exist. | E |
| W03 | Choose newline preservation policy | No separate editing/export whitespace preference was found. | Both policies are configurable. | D |
| W04 | Four spaces in ordinary editable prose | Native line used `break-spaces`; measured `18.640625px` for the run. | Editing whitespace preservation. | E |
| W05 | Four spaces in smart-punctuation prose | Semantic `p` used `normal`; run collapsed to `4.671875px`. Reproduced with `Quoted "one    two".` | Editing whitespace preservation. | D |
| W06 | Click/open the W05 paragraph | Source is preserved; transition to editable text can change whitespace width. | Measure the corresponding Typora activation geometry. | V |
| W07 | Two spaces plus newline | Hard-break punctuation can be hidden while the break remains. | Markdown hard breaks. | E |
| W08 | `###Header` without a space | CommonMark heading rules; no permissive-heading preference. | Non-strict mode accepts it as a heading. | D |
| W09 | Undersized list continuation indentation | Fixed CommonMark-based grammar, with no relaxed-list mode. | Strict/non-strict list parsing differs. | D |
| W10 | Four-space code block | Supported by CommonMark parsing. | Documentation specifies fenced rather than original indented code style. | D |
| W11 | Multiline code span | Semantic formatting normalizes the code-span contents; original newlines remain source. Covered by tests. | Measure exact inline-code normalization on the fixture. | V |
| W12 | CRLF/CR input file | Editing uses normalized lines while save preserves the file's newline convention; tests cover LF/CRLF/CR. | Compare file bytes separately from visible line breaks. | V |

## P — Clipboard and pasted content

Manuslip: [paste routing](../../apps/desktop/src/renderer/src/paste.ts),
[large-text preparation](../../apps/desktop/src/renderer/src/paste-text.ts),
[clipboard tests](../../test/e2e/clipboard-assets.spec.ts), and
[multiple-selection paste tests](../../test/e2e/multiselection-paste.spec.ts).
Typora: [clipboard formats and defaults](https://support.typora.io/Copy-and-Paste/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| P01 | Clipboard offers text and HTML | Plain text wins in Source and Live, including native/toolbar paste. Tested. | Hybrid paste prefers HTML conversion. | D |
| P02 | Ctrl/Cmd+Shift+V with mixed formats | Keeps plain text, as does ordinary paste for this case. | Explicit plain-source alternative to rich paste. | D |
| P03 | Mixed text, HTML, and image representations | Text wins; image import is not chosen while plain text exists. | Compare representation precedence with an actual mixed clipboard. | V |
| P04 | Only HTML on clipboard | Conversion service exists, but routine DOM paste does not automatically invoke its HTML branch. | HTML-to-Markdown smart paste. | D |
| P05 | Copy a whole Live document | Existing test asserts exact original Markdown, including hidden syntax. | Default plain-text representation is rendered text unless configured otherwise. | D |
| P06 | Rich clipboard serialization | No app-installed copy serializer for themed HTML/RTF was found. | Rich clipboard output. | D |
| P07 | Copy-as-Markdown command | No distinct command or default-copy preference. | Explicit source-copy action. | D |
| P08 | Copy-as-HTML-code command | No distinct command. | HTML-code action. | D |
| P09 | Copy without theme styling | No distinct command. | Separate clipboard option. | D |
| P10 | Large text paste | At 256 KiB characters, preparation is sliced; CRLF/CR normalize; commit is one isolated undo transaction. | Typora's implementation/thresholds are not documented. | V |
| P11 | Paste while async import is pending | Original selection ranges are mapped; overlapping edits can invalidate the pending paste. | Measure concurrent typing and cancelled import. | V |
| P12 | Multiple-selection paste | Matching line/selection counts distribute one line per selection; otherwise content is repeated. | Compare distribution and undo in Typora. | V |

## T — Tables: entry, cells, boundaries, and structure

Manuslip: [Live cell implementation](../../packages/editor/src/live-table.ts),
[cell filter](../../packages/editor/src/live-table-source.ts),
[dialog](../../apps/desktop/src/renderer/src/TableEditor.tsx),
[model and limits](../../apps/desktop/src/renderer/src/table-model.ts),
[controller](../../apps/desktop/src/renderer/src/table.ts), and
[ADR 007](../adr/007-visual-tables.md).
Typora: [table editing](https://support.typora.io/Table-Editing/).

**Two surfaces must be distinguished:** Live cells use embedded CodeMirror; the structural
dialog uses ordinary inputs and an Apply/Cancel draft. Some navigation described in the
desktop guide belongs to that dialog, not every Live cell.

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| T01 | Type a header row only | No automatic table-construction command; a valid parsed table needs its Markdown separator. | Header-based table creation. | D |
| T02 | Single-click a rendered cell | Mounts one embedded source editor at mapped hit position. | Direct cell editing exists. | E |
| T03 | Focus a table/cell, press F2 | Opens a cell editor. Enter also activates focused cells. | Compare keyboard entry and focus order. | V |
| T04 | Tab in final Live cell | Exits to neighboring document text; no row is added. Reproduced. | Tab can add a row. | D |
| T05 | Tab in an interior Live cell | Moves to next cell, including across the row boundary. | Cell navigation; exact edge behavior needs a run. | E |
| T06 | Shift+Tab in first Live cell | Exits backwards; no cell/row is created. | Compare reverse boundary behavior. | V |
| T07 | Enter in Live cell | Moves one row down in the same column; exits at the end. | Compare Enter independently of row insertion. | V |
| T08 | Shift+Enter in Live cell | Moves one row up; does not insert `<br>`. | Multiline-cell input needs a direct comparison. | V |
| T09 | Ctrl/Cmd+Enter in Live cell | No table-specific insert-row binding; embedded default keymap remains. | Dedicated insert-row shortcut. | D |
| T10 | Up/Down in Live cell | Inherits text-caret commands; no explicit row-move binding. | Compare row traversal at first/last wrapped line. | V |
| T11 | Alt+Left/Right in Live cell | Inherits platform CodeMirror behavior; no explicit table-column move binding. | Do not apply dialog navigation expectations to this surface. | V |
| T12 | Add/remove a row structurally | Open Document actions → Edit table; modify draft and Apply. | In-table commands/context menu. | D |
| T13 | Add/remove a column structurally | Same staged dialog. | In-table context menu. | D |
| T14 | Move a row | Draft commands move it up/down; no row-edge drag UI. | Row drag handles. | D |
| T15 | Move a column | Draft commands move it left/right; no column-edge drag UI. | Column drag handles. | D |
| T16 | Change column alignment | Draft alignment controls, applied as a source transaction. | Floating table controls. | D |
| T17 | Resize table dimensions | Add/remove draft rows and columns; no dimension-picker tooltip. | Table resize picker/numeric dimensions. | D |
| T18 | Apply a structural edit | One guarded, undoable source replacement; no-op Apply adds no history. | Compare undo granularity with a sequence of Typora operations. | V |
| T19 | Cancel structural editing | Discards the dialog draft. Live cell keystrokes are already committed. | Compare cancellation with direct cell editing separately. | V |
| T20 | Dialog Enter/Shift+Enter, Up/Down, Alt+Left/Right | Moves draft input focus by row/column. | Different surface from Typora's inline controls. | D |
| T21 | Type an unescaped pipe in Live cell | Inserts an escape to keep it in the cell. Reproduced. | Compare escaping, especially in code spans. | V |
| T22 | Paste newline into Live cell | Converts newline to a space. Reproduced. | Compare paste and Shift+Enter separately. | V |
| T23 | More than 4096 UTF-16 units in Live cell | Transaction rejected by the cell filter. Source remains an alternative. | No matching Typora limit established. | V |
| T24 | Sparse Markdown row | Missing cells can be materialized with a local prefix/suffix when edited. | Compare exact source normalization. | V |
| T25 | Start editing a cell | Existing widths are measured and locked with `colgroup` while its editor is mounted. | Compare column resizing during entry/typing. | V |
| T26 | Large structural draft | Bounded by 200 rows, 32 columns, 2048 cells, 256 KiB input, and 512 KiB output. | No matching Typora limits established. | V |
| T27 | Undo/redo inside a Live cell | Commands route to the parent document history. | Compare grouping across neighboring cells and structural changes. | V |

## G — Extensions, metadata, notes, and links

Manuslip: [extension defaults](../../packages/core/src/conventions.ts),
[desktop grammar](../../packages/core/src/document-markdown.ts),
[conventions](../../packages/core/src/document-transforms.ts),
[inline footnotes](../../packages/core/src/inline-footnotes.ts),
[reference rendering](../../packages/renderer/src/convention-handlers.ts),
[front matter](../../packages/editor/src/live-frontmatter.ts), and
[navigation policy](../../packages/renderer/src/urls.ts).
Typora: [Markdown reference](https://support.typora.io/Markdown-Reference/),
[YAML](https://support.typora.io/YAML/), and
[task commands](https://support.typora.io/Task-List/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| G01 | `[TOC]` in a fresh profile | Literal unless the Typora extension switch is enabled; switch defaults off. | TOC convention is built in. | D |
| G02 | Initial YAML in a fresh profile | Metadata interpretation is gated by that same off-by-default switch. | YAML support is built in. | D |
| G03 | Enabled YAML in Live | Body remains native editable text; metadata fences are hidden atomically. | Compare activation, collapse, and fence exposure. | V |
| G04 | YAML image/export keys | Kept as authored text; do not configure image roots, copying, export headers, or export variables. | YAML configuration/variables. | D |
| G05 | Initial TOML `+++` metadata | Recognized independently of Typora switch. | TOML compatibility needs a direct Typora check. | V |
| G06 | Bare URL/email | GFM literal autolinking defaults off with GitHub switch; angle-bracket autolinks are separate. | Bare autolinking is documented. | D |
| G07 | Alerts | GitHub switch enables alerts; it defaults off. | Optional alerts also exist. | E |
| G08 | Strikethrough and highlight | Both controlled by the single Opt switch, default on. | Compare independent preference combinations. | V |
| G09 | Subscript/superscript | Supported independently of Opt; whitespace inside delimiters is rejected. | Optional scripts exist; parsing edge cases need a run. | E |
| G10 | Emoji shortcodes | Offline lookup; unknown names stay literal; no completion UI is installed. | Emoji completion is documented. | D |
| G11 | Definition lists | Semantic `dl` rendering, including nested formatted content. | Exact Typora support is not established by this audit. | V |
| G12 | Named footnotes | Supports numbering, multiple references, definitions and return links. | Footnotes are supported. | E |
| G13 | Hover a footnote reference | Navigation and styled reference exist; no content-hover popup implementation was found. | Footnote hover preview. | D |
| G14 | Click reference/return link | Navigates with unmounted-viewport handling; ordinary modifier requirement is bypassed for notes. | Compare scroll targets and focus restoration. | V |
| G15 | Inline footnote `^[body]` | Supported with balanced/escaped brackets and rich content. | Compare accepted inline-note syntax directly. | V |
| G16 | Heading `{#id .class}` | Explicit attributes/Unicode-aware deduplicated anchors; generated TOC shares IDs. | Compare generated and explicit anchors on identical headings. | V |
| G17 | Click ordinary link | Plain click edits source; modifier click requests navigation. | Same documented edit/open distinction. | E |
| G18 | HTTP/mail/file/relative link | `safeLink` admits only HTTPS without credentials and non-whitespace fragments. | Broader link examples include HTTP/email; local navigation also needs verification. | D |
| G19 | Toggle a task checkbox | One source edit with shared undo; also works in projected lists. | Click-to-toggle exists. | E |
| G20 | Set task status via command | No task-status command menu; checkbox or literal source editing is available. | Task-status menu. | D |

## M — Mathematics

Manuslip: [math grammar](../../packages/core/src/document-markdown.ts),
[extra delimiters](../../packages/core/src/latex-delimiters.ts),
[math promotion](../../packages/core/src/document-transforms.ts),
[MathJax renderer](../../packages/renderer/src/math.ts),
[layout](../../packages/renderer/src/math-layout.ts),
[source mapping](../../packages/editor/src/live-math-position.ts),
[preview placement](../../packages/editor/src/live-preview-layout.ts), and recorded probes.
Typora: [math behavior and preferences](https://support.typora.io/Math/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| M01 | `$x$` | Math enabled by default under LaTeX switch; probe renders one formula. | Inline math has an enable preference. Default/version should be pinned. | E |
| M02 | `$ x $` | Renders a formula. Reproduced. | Current default rejects boundary spaces. | D |
| M03 | `$x$2` | Renders a formula followed by digit. Reproduced. | Current default rejects digit after closing delimiter. | D |
| M04 | `$2 and $3` | Parses a math span beginning at the first dollar. Reproduced. | Current default avoids this currency case. | D |
| M05 | Choose legacy/Pandoc dollar rules | No compatible-mode preference; uses remark-math grammar. | Legacy inline-math preference. | D |
| M06 | `\(x\)` and `\[x\]` | Custom delimiter parser supports inline/display forms. Inline probe confirmed. | Compare non-dollar forms directly. | V |
| M07 | `math`, `tex`, `latex` code fences | Promoted into display math when LaTeX is enabled. | Compare fence-language semantics directly. | V |
| M08 | Type `$$`, then Enter | Raw newline command; no math-entry completion command or closing fence insertion. | Dedicated math-block entry. | D |
| M09 | Finish an active formula | Explicit source session, companion preview, Escape/caret exit. | Completion button, arrows, and modifier-Return are documented. | D |
| M10 | Large active source/preview pair | Can dock the preview in a bounded panel until the session ends. | Placement/scroll geometry requires direct comparison. | V |
| M11 | Cross-expression `\label`/`\ref` | Fresh TeX/document per expression; no shared equation-reference registry. | Cross-equation references. | D |
| M12 | Auto equation numbering | No document-wide numbering preference or shared counter state. | AMS/all-equation numbering options. | D |
| M13 | Reuse a macro defined in another expression | Each expression starts with a fresh TeX input; macro scope is local. | Measure document-wide macro lifetime in Typora. | V |
| M14 | Physics and chemistry | Both packages bundled; physics is always included when math renders. | Chemistry support and optional physics setting. | D |
| M15 | Bare `\\` line-break compatibility option | No auto-wrapper preference; authored environments remain necessary. | Optional display-line wrapper. | D |
| M16 | Math font/output | MathJax 4.1.3 to self-contained SVG with no shared font cache. | Typora docs discuss MathJax 3; installed version/pixel output unmeasured. | V |
| M17 | Large/slow formula | 4096 UTF-8-byte input limit, 1000 macro expansion limit, worker watchdog; source fallback retained. | No corresponding Typora bounds established. | V |
| M18 | Tall/wide/inline formula or clicked glyph | Baseline/depth and source maps drive placement; wide math scrolls; dedicated tests cover first click and zoom. | Compare identical expressions/fonts at matched zoom. | V |

## C — Code blocks

Manuslip: [source keys](../../packages/editor/src/index.ts),
[widget highlighting](../../packages/editor/src/code-widget.ts),
[session activation](../../packages/editor/src/live-editing.ts), and
[Live setup](../../packages/editor/src/live.ts).
Typora: [code fences](https://support.typora.io/Code-Fences/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| C01 | Known fence language | Lazy-loaded Lezer highlighting. | Highlighted code. | E |
| C02 | Unknown fence language | Remains literal escaped code. | Compare unknown identifiers and aliases. | V |
| C03 | Change fence language | Edit literal info string; no language picker widget. | Dedicated language input. | D |
| C04 | New fence default language | No default/last-used language setting. | Default/last-used language options. | D |
| C05 | Select All inside code source | Main editor selects the document; no embedded code-local selection command. | Code-local Select All. | D |
| C06 | Copy Code Content | No dedicated code-copy action found. | Dedicated copy action. | D |
| C07 | Auto-indent selected code | No code-tool action; inherited commands do not constitute a code-formatting tool. | Auto-indent action. | D |
| C08 | Display code line numbers in Live | Global Source gutter preference exists; Live hides gutters and has no per-fence numbers. | Fence line-number preference. | D |
| C09 | Long code line | Rendered code uses overflow behavior; no independent fence-wrap preference. | Fence wrapping preference. | D |
| C10 | More than 64 KiB code content | Widget highlighting is skipped; source is retained. | No matching threshold established. | V |

## H — HTML and embedded content

Manuslip: [HTML policy](../../packages/core/src/document-html.ts),
[sanitizer](../../packages/renderer/src/sanitize.ts),
[per-document controls](../../apps/desktop/src/renderer/src/MarkdownRenderSettings.tsx), and
[image sizing](../../packages/renderer/src/image-layout.ts).
Typora: [HTML support](https://support.typora.io/HTML/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| H01 | Raw HTML in a fresh document | Literal source by default; sanitized rendering must be enabled per document. | HTML rendering integrated into editing. | D |
| H02 | Safe inline semantic tags | Supports ruby, kbd, scripts, bidi, and other allowlisted tags when enabled. | Inline HTML support. | E |
| H03 | `<details>`/`<summary>` | Deliberately remain literal; Markdown inside can still parse. | Disclosure HTML renders. | D |
| H04 | `<video>`/`<audio>` | Outside tag allowlist; no playable embedded media. | Media embedding. | D |
| H05 | `<iframe>` | Not admitted. | Sandboxed iframe embedding. | D |
| H06 | Arbitrary inline HTML styles | Removed except safe image size/zoom styles. | Inline style examples include text styling. | D |
| H07 | Authored HTML IDs | Sanitizer scopes IDs and rewrites references/header relations. | Documentation disallows authored class/ID/data attributes. | D |
| H08 | Script/event attributes | Removed; raw source is preserved. | Scripts/events excluded from ordinary document HTML. | E |
| H09 | Hidden/empty HTML elements | No general Typora-style visibility override identified; most hide styles are removed first. | Editing visibility treatment. | D |
| H10 | HTML block with nested Markdown | CommonMark HTML-block boundaries determine literal versus parsed content. | Compare block boundaries and blank-line variants directly. | V |

## A — Images, asset paths, and diagrams

Manuslip: [URL policy](../../packages/renderer/src/urls.ts),
[asset implementation](../../apps/desktop/src/main/assets),
[paste](../../apps/desktop/src/renderer/src/paste.ts),
[native drops](../../apps/desktop/src/preload/index.ts#L433),
[diagram validation](../../packages/renderer/src/diagram.ts),
[legacy adapters](../../packages/renderer/src/legacy-diagram.ts), and
[diagram host](../../apps/desktop/src/renderer/diagram/main.ts).
Typora: [images](https://support.typora.io/Images/) and
[diagrams](https://support.typora.io/Draw-Diagrams-With-Markdown/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| A01 | Remote image | Current-document permission required before fetching. | Remote images supported; compare offline/permission defaults. | V |
| A02 | Absolute, file-URL, or backslash image path | Local-image policy rejects it; uses authorized relative references. | Absolute/relative paths supported. | D |
| A03 | Relative image path | Resolves relative to a saved document under asset authorization. | Relative paths supported. | E |
| A04 | `typora-root-url` | Does not change image resolution. | Root override supported. | D |
| A05 | Native disk-file drop | Preload intercepts files and sends them to incoming-file routing, not image insertion in CodeMirror. | Image-file drops insert image references. | D |
| A06 | Image-only clipboard | Captures/imports the image, requiring a named document; cancelled Save As leaves source unchanged. | Clipboard images supported. | E |
| A07 | Clipboard-image destination | App-controlled local import; no configurable upload/copy-image rule UI found. | Destination rules/upload integration. | D |
| A08 | Raster file formats | Guide/asset reader admits PNG/JPEG/GIF/WebP after validation. `safeImage` alone is not the full admission policy. | Test BMP/AVIF/SVG and other formats directly. | V |
| A09 | `<img width height style="zoom:50%">` | Safe sizing preserved only when sanitized HTML is enabled. | HTML image sizing. | E |
| A10 | Interactive image resizing/alignment | No image resize/alignment command UI found; edit source sizing. | Image command support. | D |
| A11 | Mermaid configuration directive or front matter | Rejected by `checkDiagramSource`, including `%%{...}%%` and leading `---`. | Inline Mermaid config supported. | D |
| A12 | Mermaid global theme/layout settings | Fixed strict setup: theme follows app, classic look, dagre layout, HTML labels off. No document settings UI. | Mermaid configuration controls. | D |
| A13 | Legacy sequence/flow syntax | Converts a bounded subset to Mermaid. Unsupported syntax retains source with explanation. | Uses js-sequence/flowchart.js; broader syntax and styling differ. | D |
| A14 | Legacy hand theme, styles, links, directional ports | Not equivalent to original legacy libraries; subset explicitly excludes several constructs. | Legacy library features/options. | D |
| A15 | Save/copy a diagram independently | No diagram-specific save/copy command found; document export is available. | Diagram save/copy actions. | D |
| A16 | Large/slow diagram | 64 KiB source, 2000 nodes, 4000 edges, 3-second timeout and bounded SVG. | No matching Typora limits established. | V |

## S — Typography, punctuation, and writing modes

Manuslip: [typography choices](../../packages/renderer/src/typography.ts),
[appearance policy](../adr/008-document-appearance.md),
[punctuation processor](../../packages/core/src/document-markdown.ts#L73),
[styles](../../apps/desktop/src/renderer/src/styles.css), and
[retirement decision](../adr/005-writing-modes.md).
Typora: [typesetting](https://support.typora.io/Typeset/),
[punctuation](https://support.typora.io/SmartyPants/), and
[focus/typewriter modes](https://support.typora.io/Focus-and-Typewriter-Mode/).

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| S01 | Plain versus Source typography | Source defaults to 15px/1.75 monospace; Live to 17px/1.8 UI font, 808px outer measure with padding. | Exact Typora metrics depend on selected theme. | V |
| S02 | Set document typography | Constrained serif/sans/mono choices, size/leading/measure steps; overrides persist outside Markdown. | CSS-driven customization. | D |
| S03 | Import arbitrary theme CSS | Restricted local CSS, 64 KiB; rejects at-rules, URLs, custom properties, pseudo selectors, arbitrary classes/attributes, and `!important`. | Full theme/custom CSS model. | D |
| S04 | Use CSS to keep Markdown syntax permanently visible | Restricted document CSS cannot target editor internals. Source mode is available. | Syntax-preserving themes can target editor metadata. | D |
| S05 | Quotes/dashes/ellipsis in rendered prose | SmartyPants runs when relevant characters exist; original ASCII source remains. No separate punctuation toggle found. | Optional punctuation conversion. | D |
| S06 | Convert punctuation on input | No such input mutation; rendering-only behavior. | Input or rendering modes. | D |
| S07 | Custom quote patterns | No quote-style preference. | Platform-specific patterns. | D |
| S08 | Unicode punctuation as Markdown syntax | No remap option for curly quotes/full-width quote markers and similar variants. | Unicode remapping option. | D |
| S09 | Focus mode | Deliberately retired, with preference migration preventing restoration. | Supported mode. | D |
| S10 | Typewriter mode | Deliberately retired; no fixed caret-centering behavior. | Supported mode. | D |

## U — Scheduling, composition, limits, and recovery

Manuslip: [input barrier](../../packages/editor/src/input-synchronization.ts),
[semantic service](../../apps/desktop/src/renderer/src/semantics/service.ts),
[limits](../../packages/core/src/contracts.ts),
[document limit](../../packages/editor/src/limits.ts),
[preview controller](../../apps/desktop/src/renderer/src/preview/controller.ts), and
[composition tests](../../test/e2e/composition-input.spec.ts).
Typora's scheduling and input internals are not documented; these are comparison targets,
not claims that Typora lacks these mechanisms.

| ID | Trigger/context | Manuslip | Typora reference / remaining comparison | Verdict |
| --- | --- | --- | --- | --- |
| U01 | Typing requiring semantic rendering | Semantic debounce 150ms, maximum publication delay 1000ms; apply work is sliced. These are configuration values, not measured latency. | Measure distributions for the same edit trace. | V |
| U02 | Edit one projected range | Changed projections drop immediately; unchanged blocks map forward until replacement output arrives. | Measure flicker and layout stability. | V |
| U03 | Long inline leaf | Above 32 Ki UTF-16 units, main-thread Lezer inline work is bounded; semantic parser still processes source. | Compare pathological paragraph behavior and UI responsiveness. | V |
| U04 | Source document above 2 MiB | Semantic preview admission limit; Source remains usable up to 50 MiB editing limit. | No corresponding Typora limits established. | V |
| U05 | Native composition active during Save/New/Save As | Flush waits for composition end and CodeMirror measurement before capture/replacement. Selected tests passed. | Compare with real OS IME and native commands. | V |
| U06 | Composition restarts before deferred end | Commands stay guarded; dedicated tests passed in both modes. | Compare restart/cancellation traces. | V |
| U07 | Composition starts while Live is rendered | Block replacements are suppressed; inline decorations also yield, except retained metadata styling. | Measure transient whole-document exposure/reflow. | V |
| U08 | Switch tabs or close during composition | Defers ownership changes; tests verify committed final text remains with original document. | Compare native candidate-window and undo behavior. | V |
| U09 | IME inside table cell | Embedded editor flushes before parent; cell synchronization avoids replacing ongoing composition. | Test real CJK input, candidate selection, and cell exit. | V |
| U10 | Rendering error/worker failure | Source fallback and retry/status paths; expensive output has watchdogs and budgets. | Compare error affordances and text preservation, not merely success cases. | V |

## Direct comparison cases still required

The following are intentionally **not** claimed differences. They need a licensed Typora
installation with recorded version/theme/settings and OS-native input. The highest useful
granularity here is an interaction trace with before/after source, selection offsets,
scroll offsets, focus target, undo steps, and screenshots.

| Case | Minimal trace | Evidence to capture |
| --- | --- | --- |
| V01 | Left/Right across every inline opening/closing delimiter | Cursor offsets and marker exposure at each step. |
| V02 | Up/Down across paragraph, heading, list, quote, and code boundaries | Visual column, source line, and skipped widgets. |
| V03 | Home/End and Ctrl/Cmd+Home/End inside rendered widgets | Destination and whether source opens. |
| V04 | Page Up/Down through a long table and tall formula | Caret entry, scroll delta, and focus ownership. |
| V05 | Backspace/Delete before/after each atomic image, math, rule, and table | Source deleted, confirmation behavior, undo. |
| V06 | Double-/triple-click and drag across a rendered/source boundary | Native word/paragraph selection and reflow. |
| V07 | Shift-click and reverse-direction selection | Half-open boundaries and preserved anchor. |
| V08 | Multi-cursor and rectangle selection through formatted text | Secondary selections and clipboard distribution. |
| V09 | Emoji ZWJ, combining marks, surrogate pairs, CJK punctuation | Grapheme movement/deletion and hit testing. |
| V10 | Mixed Arabic/Hebrew, Latin, numbers, tabs | Visual/logical selection, caret affinity, and undo. |
| V11 | CJK IME candidate commit, cancel, restart, and reconversion | Native candidate window, source, and command ordering. |
| V12 | IME while a math/diagram result arrives | Focus, composition ownership, and layout jump. |
| V13 | Empty item Enter twice, Backspace to unnest, Tab/Shift+Tab | Exact markers, spaces, numbering, and undo boundaries. |
| V14 | Interleave cell edits, row insertion, undo, redo, and mode changes | Parent/cell history ownership and source spellings. |
| V15 | Multiline and tab-separated paste into selected table cells | Cell distribution, escaping, and normalization. |
| V16 | Enter/Shift+Enter/Ctrl+Enter inside a cell at every edge | Destination, new row, multiline content, and retained focus. |
| V17 | Rich copy from a partial formatted range and whole block | Native text/plain, text/html, and RTF clipboard payloads. |
| V18 | HTML-only, image-only, text+HTML+image, and file clipboards | Format precedence, permissions, destinations, cancellation. |
| V19 | Large document, distant footnote, TOC and duplicate/Unicode headings | Offscreen navigation, anchor spelling, and scroll restoration. |
| V20 | Local/remote/data images with slow load, error, retry, and resizing | Placeholder size, decode transition, and retained caret. |
| V21 | Wide code, wide math, wide table, 200% zoom, forced colors | Overflow, selection painting, horizontal scroll, focus rings. |
| V22 | Switch theme/font/width while source session or cell is active | Reflow, caret position, scroll context, and history. |
| V23 | Rapid typing and undo while semantic/diagram worker is busy | Input-to-paint timing, stale output, dropped input, memory. |
| V24 | Repeat all syntax with defaults, then matching extension switches | Distinguish preference differences from parser differences. |

## Validation performed

`npm run build:app` passed. This focused run passed **35/35** tests in approximately 2.1 minutes:

```sh
npx playwright test --config test/e2e/playwright.config.ts raw-input-rendering markdown-interaction table-editing composition-input composition-handoff markdown-linebreaks --reporter=list
```

It covers literal punctuation/newlines/paste, nested and multiline rendering, metadata,
task toggles, English/Chinese table editing, structural fallbacks, source preservation,
composition barriers, and LF/CRLF/CR selection behavior. It does not validate Typora.

There are **22 exploratory observation records**, including five separate math delimiter
inputs in one record. They confirm 18 keyboard cases, two table cases, a whitespace
measurement, and the math cases. `matched` fields compare observed source or geometry
against the Manuslip behavior under investigation; they are not Typora parity results.

Other relevant existing suites were inspected, but not all executed in this audit:
[selection](../../test/e2e/selection-rendering.spec.ts),
[first formula click](../../test/e2e/latex-first-click.spec.ts),
[inline math](../../test/e2e/inline-math-preview.spec.ts),
[source/preview geometry](../../test/e2e/live-editing-context.spec.ts),
[HTML](../../test/e2e/html-support.spec.ts), and
[footnote navigation](../../test/e2e/footnote-navigation.spec.ts).

## Suggested order for any future parity work

1. Decide the desired source contract for Enter, continuation, pairing, and clipboard
   behavior. Existing literal-input tests expressly protect the current behavior.
2. Resolve the repeated-space projection discrepancy. Match whitespace preservation
   between decorated and projected prose without changing authored source or export policy.
3. Decide whether dollar math should use Typora's current rules, a compatibility option,
   or Manuslip's existing permissive grammar. Keep the currency cases explicit.
4. Specify Live-cell versus structural-dialog navigation independently, then decide final
   Tab, modifier-Return, multiline-cell entry, and insertion semantics.
5. Capture the unresolved traces in a real Typora build before changing activation,
   selection, IME, undo, source mapping, or scroll behavior.
6. Treat full CSS themes, media embeds, upload rules, and permissive links as product-scope
   choices. Focus/typewriter retirement should remain respected unless explicitly revisited.

No editor behavior was changed by this exploration.
