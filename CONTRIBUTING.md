# Contributing to Manuslip

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately through
the [security policy](SECURITY.md). Discuss large API, package, document-model or UX changes
in an issue before implementation.

## Setup

Use Node.js 24 from `.nvmrc`, npm 11 and Git. npm workspaces and `package-lock.json` are
the supported dependency workflow. Native rebuilds may require Xcode Command Line Tools
on macOS, Visual Studio C++ Build Tools and Python on Windows, or `build-essential` and
Python on Linux.

```sh
npm ci
npm run dev
```

Postinstall applies [pinned dependency patches](docs/development/dependency-patches.md),
installs Electron and runs Electron dependency rebuilding. Interrupted installs can be
retried with `npm install`; unknown dependency contents require reviewing the patch guard.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop app with hot reload |
| `npm run check` | Lint, layout/local links, lockfile policy, process boundaries, patch guards, formatting and types |
| `npm run check:lockfile` | Validate dependency registries, integrity hashes and workspace links before installing |
| `npm run audit:dependencies` | Audit all locked dependencies; fail for high/critical vulnerabilities |
| `npm run format` | Apply Biome formatting |
| `npm test` | Common Vitest projects without an external Pandoc requirement |
| `npm run test:unit` | Desktop and library unit tests |
| `npm run test:integration` | Native child-process, filesystem, sync and translation integration tests |
| `npm run test:pandoc` | Real Pandoc conversions; requires `MANUSLIP_TEST_PANDOC` |
| `npm run test:pandoc:e2e` | Real Pandoc desktop exports against existing assets |
| `npm run test:packaging` | Dependency installation, release and platform launcher checks |
| `npm run build:app` | Build application assets for Electron E2E |
| `npm run test:e2e` | Run workflows against existing assets |
| `npm run test:e2e:fixtures` | Run source-built browser fixtures without packaging |
| `npm run build` | Build assets and unsigned native installers |
| `npm run test:packaged` | Run workflows against the unpacked application |
| `npm run test:performance` | Run hardware-dependent packaged performance gates |
| `npm run test:performance:main` | Run search/workspace source performance gates without packaging |
| `npm run clean` | Remove build output and generated test results |

See [testing](docs/testing/testing.md) for focused runs, fixtures and output locations,
[assets](docs/development/assets.md) for icons/fonts/dictionaries, and
[distribution](docs/development/distribution.md) for installer and release commands.

## Code and architecture

- Use strict TypeScript, named exports and Biome formatting. Fix types instead of suppressing
  errors with `any`, `@ts-ignore` or `@ts-expect-error`.
- CodeMirror owns text and history. Source, Live Preview and reading derive from captured
  revisions. Whole-document parsing stays off the typing path; asynchronous work rejects
  stale results and releases owned resources.
- Keep the renderer sandboxed. Filesystem, network and OS operations pass through validated
  typed preload contracts and main-owned capabilities. Sanitize all rendered HTML/SVG.
- Translate canonical prose payloads only. Preserve protected code, math, destinations and
  document structure. Keep credentials in main and requests explicit.
- Put interface strings in locale resources. Update both READMEs together for changes to
  the overview, prerequisites or quick-start commands.

The [architecture guide](docs/architecture/desktop.md) describes package and process ownership.
Use [workspace guidance](docs/guides/workspace.md) and [visual foundations](docs/guides/foundations.md)
for interface changes.

## Tests and documentation

Keep tests that check observable behavior, independent equivalence, data preservation,
security boundaries, cancellation or enforced resource budgets. A regression test should
fail for the bug it protects. Avoid assertions that merely repeat implementation details,
record measurements without checking a requirement, or depend on a screenshot being viewed.
Use relevant unit/integration/E2E checks for the behavior changed.

Keep documentation current and actionable in `docs/<topic>/` with lowercase kebab-case
filenames. Extend an existing guide when possible; create a separate document only for
substantial guidance that does not fit. Maintain [ADRs](docs/adr/index.md) for significant architectural
choices: state context, status, decision, alternatives and consequences, and link current
code/guidance. Supersede a materially changed accepted decision with a new numbered ADR;
retain the old rationale and link its replacement. Update the ADR index and architecture
guide together. Do not commit review reports, implementation journals, temporary plans,
benchmark histories or validation/changelog records.
Keep generated results in ignored suite directories and licenses beside their assets.

## Pull requests

Branch from `main`, keep changes focused and rebase when updating the branch. Use a
Conventional Commit subject for the PR title, such as `fix(editor): preserve selection on paste`.
Allowed types are `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`
and `revert`; use `!` and explain breaking changes when applicable.

Sign off commits with `git commit -s` under the Developer Certificate of Origin. Describe
the resulting behavior and relevant verification in the PR. Run `npm run check` and the
affected tests; CI runs source, unit/integration/packaging checks and builds application
assets on Linux x64, Windows x64 and macOS x64/arm64. The manual Pandoc and Packaged
desktop workflows run real Pandoc conversions/exports and packaged desktop/Windows
installer checks on the same targets. Source-built browser fixtures run in their own
CI jobs. Dependency security runs separately on Linux and also runs daily.
Run the manual workflows before release; see
[testing](docs/testing/testing.md).
A maintainer review is required before merge. Contributions use the [MIT license](LICENSE).
