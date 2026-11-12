# v0.1.2 validation

Reviewed on Windows x64, Node 24.18.1, 2026-11-12.

The review covers completion/caret history, editable punctuation, metadata,
clicking below the document, HTML source/output focus and preview ownership.
It fixed duplicate completion on indented existing fences and restored quoted
diagram previews. Regression expectations now reflect bracket pairing, explicit
table exit, unfinished fences and visible active rule markers. The concurrent
translation fixture routes responses by source paragraph rather than HTTP arrival.

| Check | Result |
| --- | --- |
| Lint, formatting, types, boundaries and dependency patch guards | Passed |
| Full Vitest run, including unit, integration and packaging projects | 43,373 passed; 1 skipped |
| Editor rerun after review fixes | 896 passed |
| Node packaging tests | 37 passed; 6 platform-specific skips |
| Real Pandoc 3.13 conversions | 15 passed |
| Real Pandoc desktop exports | 3 passed |
| Windows package and installer build | Passed |
| Package validation and hardened production runtime smoke | Passed |
| Full packaged desktop workflows | 340 initially passed; 7 failures investigated and resolved |
| All five affected desktop test files, rebuilt package | 56 passed, including all seven previously failing cases |
| Main-process performance gates | 5 passed |
| Packaged performance gates | 6 passed |
| Dependency audit at repository high-severity threshold | Passed; 3 low and 8 moderate advisories remain |
| Installer install/uninstall execution | Blocked at preflight by existing Manuslip registration; requires a clean Windows account |

The full desktop suite was not repeated after the targeted fixes; all affected
files were rerun against the rebuilt package. Linux and macOS execution remains
with the release workflow. Tests above ran before the metadata-only version bump.
No existing installation was removed to bypass the installer preflight.
