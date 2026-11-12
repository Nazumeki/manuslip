# Workspace guidance

Design the workspace around local Markdown source and a separate translated reading copy.
Preserve text, keep typing responsive and make commands easy to find.
Use the [desktop guide](desktop.md) for controls, [visual foundations](foundations.md)
for appearance and [ADRs](../adr/index.md) for architectural decisions.

## Editing

- Preserve source, selection, scroll context and undo across views and appearance changes.
  Respect input-method composition and complete pending input before capturing or replacing text.
  [ADR 002](../adr/002-implementation-plan.md) defines ownership.
- Align rendered and editable prose. Editing a Live Preview block reveals its source until
  Escape or the caret leaves. Keep unchanged blocks rendered during semantic updates.
- Make selections follow characters and source line breaks. Reveal relevant syntax without
  extending highlights into empty line space. Preserve native double-click selection and caret placement.
- Keep math and diagram previews beside editable source. Put wide content in scroll regions
  with keyboard access. Unsupported content and rendering failures must retain Source access and recovery.
- Keep cell editing direct and structural table changes explicit. A rejected Apply retains
  its draft; unchanged Apply adds no undo event. See [ADR 007](../adr/007-visual-tables.md).

## Navigation and commands

Use one toolbar for workspace navigation, file and edit commands, tabs, view selection,
Save, Document actions and Preferences. Keep Save and the active view visible. Group
secondary commands in menus and explain what is needed to enable unavailable actions.

Start with navigation closed. **Files** shows the selected folder; **Outline** shows the
active document's headings. Preserve expanded folders, loaded pages and keyboard position
on refresh. Keep **Close folder** reachable when the tree is collapsed.

Label filename navigation separately from searches of saved file contents. Identify each
result's file and location, and distinguish empty folders, no matches, incomplete searches
and failures. Opening a result must preserve other drafts.

Keep tab selection and closing separate, and show unsaved changes. Put full paths in
document details and display statistics only for the current revision.

## Reading and settings

Keep each translation paired with its original and stack bilingual pairs at narrow widths.
Place provider setup, target language and recovery controls beside the actions they support:

| State | Guidance |
| --- | --- |
| Missing configuration | Name the missing requirement and open its setting. |
| Working | Show progress and Cancel; keep writing available. |
| Partial or failed | Preserve completed work and source fallback; offer Retry failed. |
| Source changed | Mark the reading copy stale and offer an explicit refresh. |

Preserve preference drafts across sections. Separate application settings, document
appearance and permissions. Document CSS must leave Source, Reset and controls usable
under [ADR 008](../adr/008-document-appearance.md).

For [export](desktop.md#export-and-presentation), [plugins](plugins.md) and [sync](sync.md),
show the input, destination and effect before applying changes, and explain how to recover.
Keep technical diagnostics out of product copy. Provide useful next actions after permission
denial, cancellation or an offline failure.

## Input and accessibility

Give every command keyboard access and an accessible name. Distinguish status with text,
not color alone. Preserve visible focus, composition and native selection. Closing a layer
returns focus to its trigger or a surviving control; later input takes precedence over
asynchronous focus restoration. Follow [motion rules](foundations.md#motion).

Check both interface languages, Chinese input, mixed RTL/LTR text, long paths, forced colors,
reduced motion, 320px width and 200% zoom. Keep narrow commands reachable.
Focus/typewriter modes remain retired under [ADR 005](../adr/005-writing-modes.md).

## Completing and leaving Markdown blocks

In Live Preview, type three backticks (optionally followed by a language) and
press Enter. The editor adds the closing fence and puts the caret on the empty
line inside. The same flow works for `$$` math and initial `+++` metadata;
initial `---` metadata requires the Typora extension.

Enter adds lines inside the body. Down Arrow at the body's end moves below the
block; Ctrl+Enter (Cmd+Enter on macOS) does so from anywhere in the body. You can
also click or select either fence and edit it as ordinary text. Backspace in an
empty body returns to the opener. Undo removes the completion in one step, and
redo puts the caret back inside. Completion preserves any prose below the block.

## Design reference

[Typora's quick start](https://support.typora.io/Quick-Start/) is the reference for readable
inline editing and expandable document details. Apply those principles within Manuslip's
requirements for preserving source and supporting accessible interaction.
