import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import { unclosedCodeFence } from './fenced-code'
import { editingBlock, editLiveBlock, type LiveEditing } from './live-editing'
import type { LiveBlock } from './live-model'

/** Preview ownership follows the editing session, including pending worker results. */
export function hasEditingPreview(block: LiveBlock, state: EditorState): boolean {
  // HTML switches between editable source and rendered output. Showing both
  // while typing duplicates the block and can move the caret as output grows.
  return (
    ['math', 'inlineMath', 'diagram'].includes(block.kind) &&
    !(block.kind === 'diagram' && unclosedCodeFence(state, block.from, block.to))
  )
}

export const dockLivePreview = StateEffect.define<LiveEditing>()

// Once a source/preview pair outgrows the viewport, keep its preview in a bounded
// panel until editing ends. Resizing or an asynchronous render must not repeatedly
// move it between the document and panel, or replace the source editor's focus.
export const livePreviewPlacement = StateField.define<boolean>({
  create: () => false,
  update(docked, transaction) {
    const editing = editingBlock(transaction.state)
    if (
      !editing ||
      !hasEditingPreview(editing.block, transaction.state) ||
      transaction.effects.some((effect) => effect.is(editLiveBlock))
    )
      return false
    return (
      docked ||
      transaction.effects.some((effect) => effect.is(dockLivePreview) && effect.value === editing)
    )
  },
})

export function previewIsDocked(state: EditorState): boolean {
  return state.field(livePreviewPlacement, false) ?? false
}
