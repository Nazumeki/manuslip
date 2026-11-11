import { syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { codeHighlightStyle } from './highlight'
import { blockDecorations } from './live-blocks'
import { liveEditing } from './live-editing'
import { frontmatterDecorations } from './live-frontmatter'
import { inlineDecorations } from './live-inline'
import { liveInput } from './live-input'
import { liveInteractions } from './live-interactions'
import type { LiveOptions } from './live-model'
import { livePreviewPlacement } from './live-preview-layout'
import { livePreviewScroll } from './live-preview-scroll'
import { tableEditing } from './live-table'
import { liveMarkdownInput } from './markdown-input'

export { navigateLiveAnchor } from './live-anchors'
export {
  composingEffect,
  isComposing,
  type LiveAnchor,
  type LiveBlock,
  type LiveLink,
  type LiveModel,
  type LiveOptions,
  liveModel,
  setLiveModel,
} from './live-model'
export { OccurrenceTracker } from './occurrences'
export function livePreview(options: LiveOptions): Extension[] {
  return [
    EditorView.lineWrapping,
    syntaxHighlighting(codeHighlightStyle),
    frontmatterDecorations,
    liveEditing,
    liveInput,
    liveMarkdownInput,
    livePreviewPlacement,
    blockDecorations(options),
    inlineDecorations(options),
    tableEditing,
    liveInteractions(),
    livePreviewScroll(options),
    EditorView.editorAttributes.of({ 'data-mode': 'live' }),
    EditorView.theme({ '.cm-gutters': { display: 'none' } }),
  ]
}
