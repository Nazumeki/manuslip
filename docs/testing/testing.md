# Testing

Use the Node/npm versions pinned by `.nvmrc` and `package.json`, then run `npm ci`.
Run commands from the repository root.

| Suite | Location | Command |
| --- | --- | --- |
| Desktop/library unit tests | `apps/desktop/test/unit/`, `packages/*/test/unit/` | `npm run test:unit` |
| Native search/files, HTTP sync/translation and SQLite | `apps/desktop/test/integration/` | `npm run test:integration` |
| Real Pandoc conversions | `apps/desktop/test/integration/main/pandoc/converter-native.test.ts` | `npm run test:pandoc` |
| Patch installation/equivalence, release and Linux launcher | `test/packaging/` | `npm run test:packaging` |
| Desktop E2E tests | `test/e2e/` | `npm run build:app`, then `npm run test:e2e` |
| Renderer integration tests | `test/e2e/indexed-reading.spec.ts`, `test/e2e/widget-lifetime.spec.ts` | `npm run test:e2e:fixtures` |
| Real Pandoc desktop exports | `test/e2e/pandoc*.spec.ts` | `npm run build:app`, then `npm run test:pandoc:e2e` |
| Packaged app tests | `test/e2e/`, excluding renderer integration tests | `npm run build`, then `npm run test:packaged` |
| Packaged runtime hardening | `test/packaging/hardened-smoke.mjs` | `npm run verify:package`, then `node test/packaging/hardened-smoke.mjs` |
| Performance and resource gates | `test/benchmark/` | `npm run test:performance` |
| Main-process source performance gates | `test/benchmark/search.spec.ts`, `test/benchmark/workspace.spec.ts`, `test/benchmark/resources.spec.ts` | `npm run test:performance:main` |

`npm run check` covers lint, repository layout/local links, lockfile policy, runtime boundaries,
dependency patch guards, formatting and types. `npm test` runs the common Vitest projects,
including native integration and parser patch equivalence, without requiring Pandoc.

## Focused runs and fixtures

The [Typora rendering and input comparison](typora-rendering-input.md) records granular
behavior differences, source evidence, exploratory observations and remaining comparison
traces. Its [fixture](../../test/e2e/fixtures/markdown/typora-comparison.md) keeps the same
syntax inputs available for manual checks in both applications.

The [input-lifecycle follow-up](typora-input-lifecycle.md) records native event ordering,
input information, focus/admission, linked extension updates and development-build timing.
Its retained probe harness contains expectations from before the corrections in
[input lifecycle fixes](typora-input-fixes.md). Use
`npm run test:e2e -- test/e2e/input-lifecycle-regressions.spec.ts` after `npm run build:app`
to check the current contracts. Exploratory timings do not replace the packaged gates.

The [input reference alignment](input-reference-alignment.md) records the Zed punctuation
contract, the local Typora implementation references, fixes and native timing evidence.
Run `npm run test:e2e -- test/e2e/input-reference-alignment.spec.ts` after rebuilding
to verify pairing, block completion, composition and table behavior against saved source.

```sh
npm test -- --project core
npx vitest run packages/editor/test/unit/replace.test.ts
npm run test:e2e -- test/e2e/files.spec.ts
npm run test:e2e -- --list
```

Unit files use `*.test.ts`; Playwright suites use `*.spec.ts`; Node packaging tests use
`*.test.mjs`. Keep fixtures with their owning suite. `test/helpers/` contains shared
HTTP/WebDAV fixtures, computed-color contrast checks and the packaged-executable selector.
HTTP fixtures bind to an ephemeral loopback port, close their connections at teardown and
report asynchronous handler failures to the owning test. Tests use isolated profiles and
temporary files. Set `MANUSLIP_PACKAGED_EXECUTABLE` to select another executable for desktop E2E tests.
Headless Linux Electron tests need Xvfb.

The packaged config requires an explicit executable, and the shared desktop launcher
checks that it is a packaged application loading `app.asar` through `manuslip-app:`.
It excludes renderer integration tests, which build dedicated Electron test apps with Vite;
CI runs those separately on all four platforms with `npm run test:e2e:fixtures`.
The packaging suite checks actual Playwright discovery so every common desktop case
belongs to exactly one of the packaged app and renderer integration suites.

Canonicalize temporary workspace/session roots with `realpath` after `mkdtemp`, before
deriving child paths or authorization grants. macOS temporary roots can pass through
`/var` symlinks; Windows temporary roots can use 8.3 aliases. Production grants require
canonical paths, so fixtures must use the same path identity rather than weakening
authorization checks.
The lockfile CLI regression also invokes the script through an aliased directory and
requires unsafe inputs to exit nonzero. Its entrypoint uses Node 24's `import.meta.main`;
comparing the raw argument path with the canonical module URL can silently skip validation.

Keep the complete CommonMark corpus and size-dependent admission/boundary fixtures.
For expensive immutable inputs, share parsing and preparation across translation states
or layouts, compare every complete output against the independent native oracle, and
check resource cleanup between runs. Segmented fixtures can use small shared backing
arrays to avoid repeatedly scanning a large prefix just to decode test results.
Report independent CommonMark examples as separate parameterized cases rather than putting
the entire corpus under one default test deadline. Keep stateful seeded sequences intact.
Use native byte/array comparisons for large exact outputs and enumerate packed object
fields once, avoiding matcher overhead and repeated linear field lookups.
Whole-document and admission-boundary cases retain their complete fixtures and use
documented case-local deadlines; ordinary tests keep the default timeout. These deadlines
are correctness-test safeguards, not performance budgets.

Real Pandoc tests have their own Vitest project and tagged desktop cases. `npm test`,
`npm run test:integration` and `npm run test:e2e` exclude them, even when Pandoc is configured.
Set `MANUSLIP_TEST_PANDOC` to a trusted local Pandoc 3 executable before running the dedicated
commands below. Missing configuration fails those runs immediately. Common desktop tests
retain the missing/invalid Pandoc UI workflow, which needs no Pandoc installation.
Tests otherwise use local fake providers and dummy keys. Paid translation accounts are not required.

The reusable [Pandoc fixtures](../../apps/desktop/test/fixtures/pandoc/conversion.md) also
include [export](../../apps/desktop/test/fixtures/pandoc/export.md),
[translated reading](../../apps/desktop/test/fixtures/pandoc/reading.md) and
[reference/escaping](../../apps/desktop/test/fixtures/pandoc/references.md) examples.
Integration tests pass Markdown through the production parser, renderer and real converter,
then inspect DOCX, EPUB and LaTeX content, links, footnotes and embedded media. Desktop tests
also check local image paths containing Unicode/spaces, unchanged CRLF source bytes,
selection/undo and stale reading exports. Run the Pandoc cases after selecting the tool:

```sh
npm run test:pandoc
npm run build:app
npm run test:pandoc:e2e
```

The integration suite composes production services with real I/O: native search results
open and save files with encoding preservation, workspace and draft recovery survive
reopening, WebDAV transfers verify conditional writes and durable recovery, and provider
requests exercise HTTP cancellation, redirects, retries and SQLite cache invalidation.
The translation service tests use the SQLite store directly; Electron workflows also
exercise the bundled cache worker. The `workspace-search-flow` and `sync-restart-flow`
E2E specs drive the normal UI against native search and loopback servers, including stale
results, streaming cancellation and conflict recovery after a process restart.

The unmodified [CommonMark 0.31.2 corpus](../../packages/core/test/fixtures/commonmark-0.31.2/spec.json)
contains all 652 official examples from <https://spec.commonmark.org/0.31.2/spec.json>.
It is copyright John MacFarlane, CC-BY-SA 4.0; retain its adjacent `LICENSE`.
Tests compare normalized parser HTML, shared renderer structure and editor integration.
Application URL/HTML restrictions and Markdown extensions have separate checks. This data
is not bundled in the app.

## Performance gates

Build with `npm run build`, or `npm run build:app` followed by `npm run package:dir`.
Run benchmarks serially on a reference machine without competing builds or tests:

```sh
npm run test:performance
npm run test:performance -- --case single-paragraph --grep corpus
npm run test:performance -- --grep retained
npm run test:performance -- --grep "exact 50 MiB"
```

The runner selects the packaged executable for the current OS/architecture. Specs enforce
input/rendering latency, request backpressure, resource retention, cold widgets and exact
source-size boundaries. Budget assertions live beside their measurement methods in the
specs. Reports identify the hardware, runtime and executable/ASAR hashes. Input-to-frame
measurements estimate browser frame timing, not physical display presentation. Passing
correctness tests alone does not establish these hardware-dependent budgets.

The corpus gate keeps 500 ms freshness for prose, allows 750 ms for dense block lists,
and 2500 ms for deeply nested containers. Nested apply slices allow 16 ms; other slices
allow 4 ms. Every shape still requires Live Preview, all 20 edit samples, and exact saved bytes.

Keep automated performance checks tied to explicit assertions. Use DevTools for exploratory
profiles; keep measurement-only specs and historical benchmark baselines out of test suites.

`npm run test:performance:main` runs Node source benchmarks without a packaged executable.
It checks dense Unicode search result conversion and fragmented record framing against a
16 ms p95 budget each, and rescanning/sorting a 5,000-file workspace against a 50 ms p95
budget. Fixture setup is excluded from measurements. Reports include
CPU, platform and Node versions. These checks complement the packaged desktop gates;
run them serially without competing builds or tests. Search unit tests also enforce linear
byte-copy, delimiter-scan and UTF-8 decoding budgets independently of hardware speed.

Separate memory gates exercise twenty distinct search records with 500 matches each and
ten fresh catalogs listing 5,000 files. Observed memory growth (Node heap plus external
storage, including buffers) must stay below 16 MiB for search and 32 MiB for workspace
catalogs. After each cycle, two garbage collections must leave less than 4 MiB of growth;
disposed catalogs must also return native watcher counts to baseline. Memory probes and
garbage collection run separately from latency measurements. These observations cover
the Node source process at workload checkpoints, rather than whole-application peak RSS.

Benchmark summaries reject missing, non-finite and negative timing samples. Desktop
probe regressions run with `npm run test:e2e -- test/e2e/benchmark-probes.spec.ts`, checking
startup readiness, successive file opens, document counts, mode shortcuts and typing
through accessible controls. Counts are read from the Document details disclosure;
probes do not depend on welcome copy or icon button text.

## Outputs and CI

| Output | Ignored location |
| --- | --- |
| E2E failures, traces and exports | `test/e2e/result/` |
| Benchmark runs and reports | `test/benchmark/result/<run-id>/` |
| Main-process source benchmark reports | `test/benchmark/result/main/<run-id>/` |
| Installer/release output | `test/packaging/result/` |
| Workspace-volume unit fixtures | `apps/desktop/test/unit/result/` |
| Native process fixtures | `apps/desktop/test/integration/result/` |

Use `test.info().outputPath()` for browser attachments so retries own their output.
Temporary inputs should be cleaned up by their tests. `npm run clean` removes build
output and generated result directories.

CI runs on Linux x64, Windows x64 and macOS x64/arm64. Each **Source checks and tests** job
validates the lockfile before `npm ci`, then runs `npm run check`, `npm run test:unit`,
`npm run test:integration`, `npm run test:packaging` and `npm run build:app`.
Each source job also tests missing and invalid Pandoc configuration without installing Pandoc.
The **Renderer integration tests** jobs cover reading views and editor previews on the
same matrix, using dedicated test apps built from source.
The CI unit command adds `--maxWorkers=2 --reporter=dot`: fewer simultaneous dense
fixtures leave CPU/memory headroom, and failed corpus cases do not expand every passing
example in the log. Source jobs have a 25-minute ceiling covering installation, all
suites, build and desktop smoke; shared Intel macOS runners have 45 minutes. Full-size
packed-reading capacity fixtures reuse their parsed input for the native oracle and
have case-local 60-second completion deadlines. Individual correctness tests remain
separately bounded; these deadlines are not performance budgets.

Real Pandoc conversions and the full packaged desktop E2E suite run through the manual
[Integration tests](../../.github/workflows/integration.yml) workflow. In GitHub Actions,
select **Integration tests**, choose **Run workflow** and select the branch to test.
Its **Pandoc integration tests** and **Packaged app tests** jobs each check out the selected
commit and run the same four-platform matrix. They run independently of each other
and of CI.
The Pandoc job installs Pandoc 3.13, selects its absolute executable path, runs
`npm run test:pandoc`, builds the app and runs `npm run test:pandoc:e2e`.
The packaged app job builds unsigned installers, verifies runtime fuses and
runs the application E2E suite against the built package. Renderer integration tests
run in CI. Windows also runs installation and uninstallation
checks. Both jobs retain test evidence for seven days on failure. Linux desktop tests
use Xvfb in all workflows.

Release validates the tag, builds installers, verifies runtime hardening and runs
packaged security smoke tests before attesting and publishing artifacts.

Dependency security runs once on Linux for pull requests, pushes to `main`, manual runs
and daily at 03:23 UTC. Scheduled runs execute only this job, without installing dependencies.
`npm run check:lockfile` accepts HTTPS tarballs from `registry.npmjs.org` and the existing
`registry.npmmirror.com` mirror, requires valid SHA-512 integrity hashes and permits local
links only to actual declared workspaces inside the repository. Credentials, query strings,
fragments, Git sources and other filesystem dependencies are rejected. An overriding
`npm-shrinkwrap.json` is also rejected so installations use the validated lockfile.

`npm run audit:dependencies` audits the lockfile against the public npm advisory service,
including development, optional and peer dependencies. High or critical vulnerabilities
fail the job; lower severities remain visible in its report. Registry errors also fail the
job. This command reports findings without changing dependency versions or running install scripts.

Run desktop E2E, native builds and packaged-app tests separately on the target platform
before release. Windows installer checks use `npm run test:installer` in a clean account,
checking install, exact saved bytes, restart and uninstall restoration.
See [distribution](../development/distribution.md). Performance budgets and physical
OS/IME/assistive-technology behavior also require separate runs.
