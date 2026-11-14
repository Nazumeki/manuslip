# Security Policy

Manuslip processes untrusted Markdown, HTML, images, links and translation responses.
It also reads and writes local files, invokes optional tools and stores provider credentials.
This policy explains supported versions, vulnerability reporting and the application's
security boundaries.

## Supported versions

Before version 1.0, security fixes target `main` and the latest published prerelease.

| Version | Supported |
| --- | --- |
| Latest commit on `main` | Yes |
| Latest published prerelease | Yes |
| Older builds and older prereleases | No |

## Reporting a vulnerability

Use GitHub private vulnerability reporting. Open the repository's Security tab and choose "Report a vulnerability". Please don't open a public issue, pull request, or discussion for a security problem.

If private reporting is unavailable, open an issue asking maintainers to enable it.
Do not include vulnerability details or proof-of-concept files in that public issue.

A useful report includes:

- The affected version, commit hash, or build you tested.
- Your operating system and, where relevant, the Electron version bundled with the build.
- Reproduction steps or a proof of concept. A minimal Markdown file or a short recording is often enough.
- Your assessment of impact: what an attacker gains, and what the user has to do for it to work.
- Any fix or mitigation you have in mind.

## What to expect

These are best-effort commitments from a volunteer project, not contractual service levels.

- Acknowledgement of your report within 3 business days.
- Initial triage, including a severity assessment and a decision on scope, within 7 business days.
- A coordinated disclosure timeline. The default is 90 days from the initial report. We can move faster or slower by mutual agreement, especially when a fix ships early or when users need time to update.
- Credit in the published advisory, unless you ask to stay anonymous.
- No bug bounty. Manuslip is a volunteer project and does not pay for reports.

## Scope

Reports may involve any of these attack surfaces:

- Markdown and HTML rendering: DOMPurify configuration, the strict Content Security Policy, raw HTML passthrough, link and autolink generation, and `data:` URIs. A gap here turns any opened document into script execution inside the app.
- Diagram and math rendering: Mermaid, MathJax, and the legacy `sequence` and `flowchart` blocks. Fenced blocks are untrusted input that reaches a renderer, so script injection through them counts.
- Renderer sandbox and IPC: escape from the sandboxed renderer, or abuse of the typed contextBridge API for path traversal, arbitrary file read or write, or shell and OS command execution.
- File handling: atomic save, file watching, workspace roots, writes to the asset folder, symlink handling, and encoding detection through iconv-lite and jschardet. These paths decide which files the app may touch.
- Optional Pandoc invocation and the bundled ripgrep binary: argument injection, process spawning, binary or PATH replacement, and `shell: false` enforcement.
- Translation providers: API key storage in Electron `safeStorage` (OS keychain), with session-only keys when no key store is available; exfiltration of prompts or document content, malicious provider responses, and SSRF through configurable base URLs.
- Auto-update and packaging: update feed integrity, installer signing, and anything that lets a third party ship code as Manuslip.

Out of scope:

- Reports that require an already compromised machine or local write access with the user's own privileges, except for missing URL/origin validation on configured translation endpoints.
- Missing hardening headers or best-practice deviations with no demonstrable impact.
- Dependency vulnerabilities with no reachable code path in Manuslip. Send those upstream to the dependency maintainers, and open a normal issue if Manuslip needs to bump the version.
- Social engineering of maintainers or contributors.
- Denial of service caused by opening an intentionally huge local file.

## Packaged runtime and release integrity

The editor loads at `manuslip-app://editor/index.html`. Its protocol handler serves only
the entry document and built script/style/icon/font assets, rejects other methods and
paths, and supplies CSP, MIME and no-sniff headers with each response. Document files
never become application-origin resources. Production builds disable Electron's Node
launch mode, Node environment options, CLI inspector and extra `file://` privileges,
and load application code only from ASAR. Windows/macOS also enable embedded ASAR
integrity validation; Electron does not implement that validation on Linux.

The Packaged app tests job in the manual [Integration tests](.github/workflows/integration.yml)
workflow and release packaging read fuses from packaged binaries and smoke test an
unchanged executable with Node environment injection attempts.
Playwright's main-process automation uses a temporary copy with only its inspector fuse
re-enabled; that copy is never a release asset. The original executable and installer
remain untouched.

Version-tag releases require matching workspace versions, a tag commit on `main`,
verified runtime fuses and complete artifacts for all four supported targets.
SHA-256 checksums and GitHub build attestations accompany the candidate.
The final job verifies hashes and provenance before automatically publishing the release.
Repository administrators must configure the protected environments and signing secrets
described in the [distribution guide](docs/development/distribution.md). This repository
does not configure those account settings or supply certificates.

## Implemented workspace file access

The implemented folder browser accepts native folder selections and uses main-owned opaque
IDs for listing and opening. It excludes symlinks/junctions, rechecks canonical containment
and root identity, and retains grant checks for workspace-file reload/save. Session restoration
uses paths from private main-process metadata; renderer calls cannot supply restoration paths.
These checks are not an OS filesystem sandbox and do not eliminate filesystem check/use races.

Workspace search accepts an owned root ID and a bounded literal query. Main resolves and
checks the vendored binary for the runtime platform/architecture, invokes it with an argument
array and `shell: false`, and bounds process lifetime, output records, filenames and matches.
It follows no links, honors workspace ignore files, and excludes hidden paths, .git and
node_modules. Opening a result uses an owned result ID and repeats workspace file-grant checks.
The editor verifies the saved line before applying a search location to an existing buffer.

Spelling is opt-in. Windows/Linux use a packaged English dictionary, verified by size and
SHA-256 before populating Chromium's private cache. The dictionary download URL points only
to packaged local files; macOS uses its system checker. The app sends no text to a spelling
service and does not fetch internet dictionaries at runtime. Dictionary attribution and
provenance ship under `apps/desktop/vendor/dictionaries`.

Native launch/open-file requests and genuine file drops grant individual files through the
existing file-session lifecycle. The incoming queue stores bounded path metadata, not bodies.
Preload admits only trusted disk-backed drops; renderer-created File objects or path strings
cannot use this route through the public bridge. Public incoming-file methods accept opaque
main-owned IDs. File-drop handlers intercept browser navigation and editor text insertion.

## Implemented Mermaid diagrams

Mermaid diagrams use a hidden sandboxed BrowserWindow with a separate non-persistent
session and custom origin. Main checks that its renderer PID differs from the editor.
Its standalone preload exposes only diagram-ready, job and result messages; editor IPC
handlers reject this frame. The session permits only built entry/script/style/font assets,
denies permissions, navigation and popups, and applies CSP blocking network connections,
images, frames and workers. It grants no document or arbitrary filesystem access.

Document configuration directives and YAML frontmatter are rejected. Mermaid uses
strict security, SVG labels and fixed dagre/classic settings. Output CSS is flattened into
presentation attributes; active HTML, links, images, animation and style blocks are removed.
Both host and editor sanitize SVG, keeping references inside each diagram and giving each
mounted copy distinct IDs. Main owns a 3-second watchdog, one running/four pending jobs,
visible-consumer priority, cancellation, a bounded cache and a three-restart/minute budget.
Hung obsolete jobs count toward that budget; deliberate document/window revocation does not.
Source, SVG, node and element limits are defined in
[diagram contracts](packages/renderer/src/diagram.ts). Failures retain editable
source and offer manual Retry. Packaged tests deliberately freeze the host and verify that
typing, saving and another window remain responsive, then recover through Retry.

## Implemented clipboard and image loading

HTML paste uses a bounded, terminable Node worker running Turndown/GFM's local DOM
parser. It removes active HTML and constrains generated links; the resulting Markdown
still passes through the normal preview sanitizer. The worker runs trusted conversion
code and is not an OS security sandbox for third-party executable code.

Local PNG/JPEG/GIF/WebP reads resolve relative to a main-owned file session, using the
captured workspace root or direct-open parent directory. The reader checks directory
identities, canonical containment, intermediate links/junctions, file identity, byte size,
and dimensions. Only raster bytes receive an owner/document-scoped opaque protocol URL;
file://, absolute paths, drive paths, UNC paths, alternate data streams and local SVG are
excluded. Protocol requests repeat grant/path checks. Save As resets the local scope;
closing a document/window revokes capabilities. These checks retain the filesystem
check/use limitations described above.

Remote images require permission for the current document. Native HTTPS requests send no
browser credentials, validate DNS addresses and redirects, and enforce byte, queue,
concurrency and timeout limits. Revocation cancels pending work and removes cached assets.
Local and remote reads use the same raster validation before preview or export. Each image
cache counts compressed bytes and estimated decoded RGBA memory toward its budget.
See the [image validator](apps/desktop/src/main/assets/image.ts) and
[asset limits](apps/desktop/src/shared/asset-contracts.ts) for the enforced checks.

Image paste reads only the native clipboard's PNG representation, retains one bounded
capture for at most 60 seconds, and exclusively creates a UUID filename in the document's
assets directory. The bridge exposes capture/import/discard operations, not arbitrary
filesystem writes or path access. Imports survive undo and document close; the app does
not automatically remove assets that another document could reference.

## Implemented HTML/PDF export

The editor captures source/revision and sends a strictly validated request, without a renderer
destination path. Main owns the native save dialog, document ownership, immutable local asset
grant, resource budgets, deadline and destination fingerprint. Open documents and their file
identities cannot be export targets. Atomic output preserves the existing conflict/metadata
checks and removes incomplete sibling temporaries. Cancellation is best effort once native
publication has begun; it cannot retract a completed filesystem operation.

Parsing, MathJax rendering and PDF page inspection run in a terminable Node worker with a
256 MiB old-generation heap bound. Export diagrams use their own isolated Mermaid host.
The hidden print BrowserWindow has a distinct non-persistent session/PID, sandbox, context
isolation and only a print-specific preload. Main accepts messages only from its exact main
frame/origin and active job. It cannot invoke editor IPC. CSP and session policy deny ambient
network, filesystem access, popups, navigation, permissions, frames and workers.

Only main-validated PNG/JPEG/GIF/WebP data reaches the print document. Local reads use the same
canonical grant checks as preview, captured before the destination dialog. Remote export reads
share the permission epochs and bounded network queue with preview, but have their own abort
signal and retain no repository cache entry. Cancellation aborts/removes their active/queued
work without cancelling unrelated preview requests. Revocation prevents cached export reuse.
Per-image, aggregate compressed/decoded, occurrence and output bounds apply before publication.
The print process sanitizes HTML and each SVG; scripts and document-supplied styles do not
survive. Self-contained HTML ships a restrictive CSP and no application bridge or JavaScript.

All resources must succeed: missing/blocked images or invalid math/diagrams abort the copy.
PDF waits for font/image readiness, prints at most 2,001 pages, then rejects more than 2,000
pages before writing. Worker, print and diagram hosts are disposed on success, failure, cancel
or document/window close. Packaged tests deliberately hang the print renderer and verify
continued source editing/saving, cancellation, cleanup and a successful fresh export.
Numeric limits live in [export contracts](apps/desktop/src/shared/export-contracts.ts);
verification commands are in the [testing guide](docs/testing/testing.md).

## Offline structural translation core

The shared translation package has no transport, credential or database access. The translated
preview calls it in a dedicated worker. Its provider payload type contains canonical text
and token metadata only. AST nodes, protected code/math/URL values, document ranges and local
reconstruction maps remain in each occurrence's plan. Duplicate prose with different protected
values can reuse a canonical result without sharing those values. Payload parsing rejects
unknown fields and bounds tokens/bytes. Output must retain exact token identities and balanced
parent relationships before text-only AST reconstruction. Missing, invalid or over-limit units
retain source. Provider output is never parsed as HTML or Markdown.

Translation cache identity uses MurmurHash3 x86 128 over the canonical payload, schema versions and output-affecting
provider/settings metadata. Endpoint normalization preserves routing configuration and rejects
common credential fields, user information, fragments and remote HTTP. These checks are not a
substitute for adapter-specific option admission, main-owned credentials, bounded transport,
redirect policy or log redaction. The fixture provider performs local
deterministic substitutions only and is not exposed as a real translation service.

## Translation transport, credentials and cache

Main now owns OpenAI-compatible Chat Completions, Ollama chat and DeepL adapters. Settings/credential
submission and unit requests have distinct strict IPC schemas and require the authorized editor
main frame. Unit requests also require a live owned document, settings revision, cache generation,
canonical payload and recomputed MurmurHash3 identity. Hashes index derived data, and are not
an authentication boundary: cache reuse requires exact canonical settings/payload equality
and validated output. Different payloads that collide within a plan are rejected; main shares
jobs only when their full settings and payloads match. Credential bindings still use SHA-256.
Requests cannot carry source/AST/bindings. The
translated-view consumer extracts eligible prose from an immutable, exact-revision semantic
capture. Tests exercise this transport through the real bridge using local services and dummy
credentials, never paid providers.

Two requests run globally, with bounded queues, a total deadline and limited transient retries.
Native Node transport has no browser cookies/referrer or ambient proxy authentication. Remote
endpoints require HTTPS; explicit loopback endpoints may use HTTP. localhost resolves to a pinned
loopback address. Only bounded 307/308 redirects within the original origin preserve POST and
credentials. Responses are bounded and must finish normally without tool calls/refusals and pass
placeholder validation. Streaming fragments and truncated responses are rejected, never cached.
Provider messages, endpoint URLs, document prose and keys are not logged or returned as errors.
Chat-provider glossary/formality instructions are prompt-based and may not be followed by the model.

DeepL uses native `DeepL-Auth-Key` authentication and XML v2 over synthetic tags containing only
canonical token IDs and eligible prose. Protected values and source markup never enter that XML.
Only a tiny bounded XML grammar is accepted back: no DTD, external entities, arbitrary tags,
attributes or executable markup; original token identity/nesting is revalidated before caching.
Native formality requires target support; an existing glossary UUID requires an explicit source
and support from both languages. No glossary-creation or remote-management API is invoked.
The explicit Load supported languages command sends an authenticated GET to the configured
server without document text. Cache-miss translation may perform the same discovery first.
The default route is `/v3/languages?resource=translate_text`; an optional full proxy route must
share the translation endpoint's origin. Metadata is capped at 256 KiB/512 stable languages,
with a ten-second network deadline and one explicit discovery alongside the two unit jobs.
Only one connection's metadata is retained in memory for 15 minutes. Key/settings changes,
cache clearing and window close abort discovery and reject late results. Translation JSON is
capped at 128 KiB. HTTP 456 reports exhausted quota without retry; missing keys fail before HTTP.
Opening preferences/reading, editing, changing layout and Load cached remain offline.

New key inputs clear synchronously before IPC. Keys remain in main memory or, by explicit choice,
encrypted in `translation-credential.json` using asynchronous Electron safeStorage. Keys bind to
adapter, full endpoint and profile; changing that connection prevents reuse. Key stores are
accessed only on explicit setting/translation/language-discovery commands, with a timeout. Locked/unavailable stores
and Linux basic_text refuse persistence; the UI offers an explicit session-only alternative.
Translation configuration schema 2 reads legacy schema 1 without rewriting on load; saving uses
schema 2 so older applications preserve the new settings as future data. Future-version
key/config files are not overwritten. OS protection does not protect against
another process already running as the same user, or a compromised application process.

`translation-cache.sqlite` and its WAL/shared-memory sidecars live in the Electron userData profile.
Successful canonical prose and translations are document-derived user data stored unencrypted;
code/math/URL reconstruction bindings and credentials are excluded. One lazy dedicated SQLite
worker reuses parameterized statements and atomically replaces entries/evicts old data. WAL uses
full synchronization and automatic checkpoints; a 32 MiB WAL threshold forces a truncating
checkpoint, with writes paused if pinned readers prevent it. All database/sidecar paths
reject links and use private file modes where supported. Clear requires a successful checkpoint.
Entries expire 30 days after writing; reads do not extend their lifetime. Logical data is capped
at 256 MiB, the database at 320 MiB and entries at 50,000. Eviction accounts for SQLite page
pressure as well as logical bytes. LRU touches are coalesced in a bounded queue and synced in
batches, on idle and before eviction. Busy/full writes roll back without disabling healthy
reads; subsequent writes and clearing can recover. Schema 2 rebuilds legacy cache entries
that cannot be safely rekeyed from SHA-256. Corruption is quarantined away from drafts; future
schemas stay untouched. Database, sidecar and quarantine bytes share a 384 MiB footprint budget.
Persistence failures report degradation while
in-memory translation continues. Clear advances the global generation, cancels every subscription,
orders deletion after old writes, and removes only the derived cache/sidecars/quarantine before
reopening empty. Late results cannot repopulate it; failures are reported rather than claiming a
successful clear. Cache deletion is logical filesystem deletion, not secure erasure of storage.
Session/document/owner close cancels work; a shared request aborts when its last subscriber leaves.

Translated reading owns derived data only and cannot dispatch editor changes. Opening the view
and typing never call a provider; Translate/Refresh/Retry Failed explicitly allow network use,
while Load cached never does. At most two unit subscriptions run per active view. Source edits
mark the captured copy stale; refreshing reconciles occurrences through mapped source ranges,
cancels changed occurrences, and can retain unchanged in-flight units. Tab suspension terminates
its reading worker, releases the capture and cancels every subscription. Settings/cache generation
changes discard derived output; late responses cannot revive it. A five-second reading-worker
watchdog and bounded messages, outputs, projection and shared DOM budgets fail to source fallback.
The translated output buffer is capped at 16 MiB, shared snapshots at 64 MiB and reading-worker
ownership at 64 MiB. Large buffered restores use bounded 8 MiB requests. Complete worker
responses have a separate 64 MiB wire limit and 32 MiB retained projection limit; large bilingual
copies retain indexed rows. UTF-16 output accounting allows 24 MiB UTF-8 reconstruction.
Provider output is validated again before reconstruction and reaches the same HTML/SVG sanitizer,
isolated math/diagram renderers and main-owned image capabilities as Live Preview. Per-render
unpredictable heavy-slot names prevent source raw HTML from impersonating internal resource slots.
The reading copy has no editable controls; task checkboxes remain disabled. Bilingual layouts
share one native scroll surface and stable logical block anchors; layout changes never call a
provider. Sanitized reference IDs and accessibility references are scoped independently to each
copy, including source raw HTML, so duplicate footnotes cannot target the other language.

Reading export captures immutable source, languages, layout and indexed completed prose outputs.
Stale or incomplete copies require explicit confirmation before a destination dialog opens;
untranslated units then retain source. One private pending capture is limited to 64 MiB serialized,
10,000 outputs, 256 KiB per output and 16 MiB aggregate UTF-16 output accounting. Export HTML is
bounded at 64 MiB UTF-8. Tab suspension cancels
the pending choice and releases it. Subsequent edits/provider responses cannot mutate the capture.
The isolated export worker reparses source, re-extracts the plan and validates every indexed
output/placeholder before reconstruction. Renderer-supplied AST/HTML is never accepted. Both
copies together use the existing export markup, slot, asset, page, deadline and output limits.
Artifacts identify target language, layout, source revision, completion and stale/source fallback.

## Disclosure policy

We follow coordinated disclosure. Please don't publish details, a proof of concept, or a working exploit before a fix is available or before the agreed disclosure date, whichever comes first.

Advisories are published through GitHub Security Advisories (GHSA). When a report meets the usual thresholds, we request a CVE identifier as part of the advisory. The advisory credits the reporter unless anonymity was requested.

## Safe harbor

We consider good-faith security research authorized when it stays within this policy. Test against your own installs, your own documents, and your own provider credentials. Don't access other people's data, degrade the service for anyone else, or run tests against third-party infrastructure such as translation APIs or update servers. We will not pursue legal action for research conducted under this policy.
