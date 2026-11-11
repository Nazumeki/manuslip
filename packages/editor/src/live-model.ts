import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import { mapUnchangedBlocks } from './live-model-changes'
import { preserveTaskToggle } from './live-task-changes'

export interface LiveBlock {
  id: string
  from: number
  to: number
  kind: string
  html: string
  value: string
  syntax?: 'mermaid' | 'sequence' | 'flowchart'
  placement?: 'after-document'
  listStart?: number
  lines: number
}
export interface LiveModel {
  blocks: readonly LiveBlock[]
  anchors?: readonly LiveAnchor[]
}
export interface LiveAnchor {
  from: number
  id: string
  rendered?: boolean
  placement?: 'after-document'
}
/** Identity of the rendered link, retained while its semantic revision refreshes. */
export interface LiveLink {
  block: LiveBlock
  index: number
  count: number
}
export function inlineProjection(kind: string): boolean {
  return [
    'inlineMath',
    'image',
    'link',
    'subscript',
    'superscript',
    'emoji',
    'footnoteReference',
  ].includes(kind)
}
export function proseProjection(kind: string): boolean {
  return ['paragraph', 'heading', 'blockquote', 'list', 'defList', 'footnoteDefinition'].includes(
    kind,
  )
}
export interface LiveOptions {
  sourceLabel(): string
  previewLabel?(): string
  taskLabel(): string
  render(container: HTMLElement, block: LiveBlock, signal: AbortSignal, measure: () => void): void
  openLink(url: string, link?: LiveLink): void
}
export const setLiveModel = StateEffect.define<LiveModel | null>()
export const composingEffect = StateEffect.define<boolean>()
export const liveModel = StateField.define<LiveModel | null>({
  create: () => null,
  update: (model, transaction) => {
    if (transaction.docChanged && model)
      model = preserveTaskToggle(model, transaction) ?? mapUnchangedBlocks(model, transaction)
    for (const effect of transaction.effects) if (effect.is(setLiveModel)) model = effect.value
    return model
  },
})
export const isComposing = StateField.define<boolean>({
  create: () => false,
  update: (composing, transaction) => {
    for (const effect of transaction.effects)
      if (effect.is(composingEffect)) composing = effect.value
    return composing
  },
})

/** Semantic positions can start after block indentation. A block widget owns that
 * whitespace too, but must never consume neighboring text on the same source line.
 */
export function blockSourceRange(
  state: EditorState,
  block: LiveBlock,
): { from: number; to: number } | undefined {
  const first = state.doc.lineAt(block.from)
  const last = state.doc.lineAt(block.to)
  if (!/^[ \t]*$/.test(state.doc.sliceString(first.from, block.from))) return undefined
  if (block.kind === 'defList' && last.from === block.to) return { from: first.from, to: block.to }
  if (!/^[ \t]*$/.test(state.doc.sliceString(block.to, last.to))) return undefined
  return { from: first.from, to: last.to }
}
