import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  blockSourceRange,
  inlineProjection,
  type LiveBlock,
  liveModel,
  setLiveModel,
} from './live-model'
import { delimitedSourcePosition } from './live-source-position'

export interface LiveEditing {
  from: number
  to: number
  block: LiveBlock
  /** Keyboard input can reveal a table's source instead of opening a cell. */
  source?: boolean
}

export const editLiveBlock = StateEffect.define<LiveEditing | null>()

export function sourceRange(state: EditorState, block: LiveBlock): { from: number; to: number } {
  if (block.placement === 'after-document')
    return { from: Math.max(0, block.from - 1), to: block.to }
  return (
    (!inlineProjection(block.kind) && blockSourceRange(state, block)) || {
      from: block.from,
      to: block.to,
    }
  )
}

/** Editing is an explicit, mapped session. A collapsed caret and a pending semantic
 * refresh must never close the source that the user is currently typing into.
 */
export const liveEditing = StateField.define<LiveEditing | null>({
  create: () => null,
  update(editing, transaction) {
    if (editing && transaction.docChanged) {
      let replaced = false
      transaction.changes.iterChangedRanges((from, to) => {
        if (editing && from <= editing.from && to >= editing.to) replaced = true
      })
      const from = transaction.changes.mapPos(editing.from, -1)
      const to = transaction.changes.mapPos(editing.to, 1)
      editing =
        !replaced && from < to
          ? {
              ...editing,
              from,
              to,
              block: {
                ...editing.block,
                from: transaction.changes.mapPos(editing.block.from, -1),
                to: transaction.changes.mapPos(editing.block.to, 1),
              },
            }
          : null
    }
    for (const effect of transaction.effects) {
      if (effect.is(editLiveBlock)) editing = effect.value
      if (effect.is(setLiveModel) && effect.value === null) editing = null
    }
    if (!editing) return null
    const current = editing
    if (
      transaction.selection &&
      transaction.state.selection.ranges.some(
        (range) => range.from < current.from || range.to > current.to,
      )
    )
      return null
    // Pointer/keyboard selections don't change semantic ownership. Resolve the
    // block only when the model changes, rather than walking it on every caret
    // movement.
    if (transaction.startState.field(liveModel) === transaction.state.field(liveModel))
      return editing
    const blocks = transaction.state.field(liveModel)?.blocks
    const sourceKinds = ['code', 'diagram', 'math', 'html']
    const block =
      blocks?.find(
        (block) => block.kind === current.block.kind && block.from === current.block.from,
      ) ??
      (sourceKinds.includes(current.block.kind)
        ? blocks?.find(
            (block) => block.from === current.block.from && sourceKinds.includes(block.kind),
          )
        : undefined)
    if (block && block !== editing.block) {
      editing = { ...editing, ...sourceRange(transaction.state, block), block }
    }
    return editing
  },
})

export function editingBlock(state: EditorState): LiveEditing | null {
  return state.field(liveEditing, false) ?? null
}

export function activateLiveBlock(
  view: EditorView,
  block: LiveBlock,
  at?: number,
  options: { focus?: boolean; scrollIntoView?: boolean } = {},
): void {
  const { from, to } = sourceRange(view.state, block)
  const current = editingBlock(view.state)
  if (current?.from === from && current.block.kind === block.kind) {
    if (at !== undefined) view.dispatch({ selection: { anchor: Math.max(from, Math.min(to, at)) } })
    if (options.focus !== false) view.focus()
    return
  }
  let anchor = at ?? from
  if (at === undefined && ['diagram', 'code', 'math'].includes(block.kind)) {
    const position = delimitedSourcePosition(
      view.state.doc.sliceString(block.from, block.to),
      block.value,
      0,
    )
    const first = view.state.doc.lineAt(from)
    if (position !== undefined) anchor = block.from + position
    else if (/^\s*(?:`{3,}|~{3,}|\$\$)/.test(first.text)) anchor = Math.min(first.to + 1, to)
  }
  view.dispatch({
    effects: editLiveBlock.of({ from, to, block }),
    selection: { anchor: Math.max(from, Math.min(to, anchor)) },
    scrollIntoView: options.scrollIntoView ?? true,
  })
  if (options.focus !== false) view.focus()
}

export function caretTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some(
    (range) => range.empty && range.head >= from && range.head <= to,
  )
}
