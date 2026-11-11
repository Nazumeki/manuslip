# Input lifecycle corrections

This records implementation changes following the
[input lifecycle audit](typora-input-lifecycle.md). The original audit and its JSON
remain historical evidence from before these fixes. Differences that describe deliberate
product policy or unmeasured Typora behavior are not treated as defects.

## Corrected contracts

| Finding | Correction | Verification |
| --- | --- | --- |
| BF01, BF03–BF05: keyboard focus at projected source | Document-boundary navigation reveals the source owning the destination caret. Before native typing, deletion, paste or composition, a projected caret receives a source editing session. Handlers do not reconstruct text from key events. | Exact saved source after first character, Backspace, paste, native debugger composition, undo and document-start input in smart prose, HTML, tables and footnotes. |
| Projection arrival during input | Remember the last accepted input caret, invalidate it when selection moves, and retain its editable source when delayed semantic output arrives. An initial file projection remains rendered. | Unit coverage for delayed projection, initial rendering and moved caret; chunk insertion after typed HTML in Live Preview. |
| Raw table session lifetime | Preserve the explicit source editing flag while mapping edits and reconciling refreshed blocks. Cell editing retains its separate ownership. | Raw table keyboard input across refresh, ordinary live-cell editing, parent undo and focus checks. |
| BF16, EX10: cell admission before normalization | Count escaped pipes and flattened line breaks before admitting the final source. The 4,096 UTF-16-unit cap applies to that final value. Reject an overflowing transaction atomically. A legacy oversized cell may shrink; synchronization from accepted parent source bypasses child admission so undo can restore it. | Escaped-pipe boundary and atomic rejection unit cases; legacy cell deletion and parent undo in Electron. |
| Inherited HTML insertion | Configure the HTML language with automatic tag closing disabled, both for Markdown HTML regions and fenced HTML. Retain syntax highlighting. | Typed opening/closing/void tags, chunk closing tags and undo in Source and Live Preview. |
| LK03–LK05 and linked destination freshness | Synchronize native input and capture the current semantic revision before activation. Resolve the same source occurrence against its new HTML. Require unchanged link structure apart from destinations; removed or changed owners cancel. A newer edit cancels the pending activation. Internal anchors use the current model too. | Hold the actual worker request, activate an old rendered reference, then change its URL, remove its definition or supersede the request. Verify the external destination or cancellation. Existing footnote navigation also passes. |
| PF22: hidden outline work | Only visible/expanded outline and document-detail consumers subscribe to metadata. Independent leases prevent closing one consumer from detaching another. With Source active and both closed, edits do not request semantic work. | No semantic applications beyond debounce while hidden; showing outline or details refreshes current headings/counts. |
| Input information | Add bounded `manuslip:input-accepted` scalar diagnostics at the accepted parent transaction boundary, including forwarded cell input. Record revisions, source lengths, selections, inserted/deleted units, range count, origin flags and composition/cell state. Record linked activation separately. | Browser assertions on accepted positions; type checks and existing document-controller tests. No document text is recorded by production diagnostics. |

Implementations live in [source input preparation](../../packages/editor/src/live-input.ts),
[session mapping](../../packages/editor/src/live-editing.ts),
[cell admission](../../packages/editor/src/live-table-source.ts),
[cell synchronization](../../packages/editor/src/live-table.ts),
[HTML support](../../packages/editor/src/syntax.ts),
[link activation and metadata ownership](../../apps/desktop/src/renderer/src/preview/controller.ts),
and [accepted input metadata](../../apps/desktop/src/renderer/src/document.ts).

## Regression evidence

On Windows, 2026-11-11:

- `npm run test:unit`: **282 files passed; 43,179 tests passed, one skipped**.
- The combined input, composition, mode, table, navigation and rendering Electron run:
  **53 tests passed**, including all 11 cases in
  [input lifecycle regressions](../../test/e2e/input-lifecycle-regressions.spec.ts).
- `npm run check`, `npm run build:app` and `npm run package:dir` passed.
- The previously flaky Save As/composition and rapid-mode/composition cases each
  passed three further isolated repetitions: **six of six passed**.
- `npm run test:performance -- corpus.spec.ts`: all six packaged 1 MiB cases passed
  their existing budgets, exact-source checks and zero-fallback checks. Each case
  includes 20 settled edits and 20 mode transitions. The
  [retained performance summary](typora-input-fixes-performance.json) includes the
  machine, actual bundle hash, corpus identities, method and phase measurements.

| Packaged corpus | Input-to-second-rAF p95 ms | Editor callback p95 ms | Semantic freshness p95 ms |
| --- | --- | --- | --- |
| Prose | 7.1 | 0.3 | 307.3 |
| Single paragraph | 26.0 | 0.2 | 285.4 |
| Mixed RTL | 6.1 | 0.2 | 263.2 |
| Repeated paragraphs | 12.5 | 0.2 | 512.0 |
| Many small blocks | 10.9 | 0.2 | 556.0 |
| Nested containers | 12.3 | 0.2 | 1,428.3 |

The initial prose-only packaged attempt aborted on an invalid timing sample before a
raw report was written. A prose-only retry and the complete six-case run passed strict
aggregation and all gates. The benchmark now writes raw metrics before aggregation and
includes the invalid value in its error message. The original sample's cause is still
unconfirmed; no samples are discarded or clamped to make a gate pass.

The accepted-input duration starts inside the controller callback. It does not measure
native event-to-transaction latency, the whole CodeMirror update, a compositor frame or
disk persistence. Existing semantic and persistence boundaries remain separate.

The earlier unexplained extra `r`, `W` and space observations did not recur in the
53-test run or six repetitions. This does not establish their original cause.
Composition and mode suites now retain
[native event provenance](../../test/e2e/input-provenance.ts) alongside
accepted transaction metadata on success and failure. No source character is discarded
to mask an unexplained event.

## Scope and remaining evidence

The production worker retains complete native parsing on cache misses. The experimental
fragment/packed parser is not enabled by these changes. Correctness across global
definitions and all configured grammars remains required before changing parsing strategy.
The performance improvement here removes work from Source when no visible semantic
consumer needs it; it does not claim incremental parsing.

Actual Windows IME candidate windows, hardware layouts, dead keys, AltGr, dictation and
Typora timing need matched manual/native measurements. Debugger composition tests verify
source ownership and commit history, not those OS surfaces. Markdown convenience commands
and the retired focus/typewriter modes are separate product decisions.

Run the current regression contracts with:

```sh
npm run build:app
npm run test:e2e -- test/e2e/input-lifecycle-regressions.spec.ts
```
