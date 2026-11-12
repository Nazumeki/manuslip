import { isolateHistory } from '@codemirror/commands'
import { EditorSelection, type EditorState, type Extension, Prec } from '@codemirror/state'
import { type EditorView, keymap } from '@codemirror/view'
import { closedBlockAt } from './block-boundaries'
import { activateLiveBlock, editingBlock, editLiveBlock } from './live-editing'
import { blockSourceRange, inlineProjection, isComposing } from './live-model'
import { blockAtPreview, previewHitAtPoint } from './live-preview-position'
import { delimitedSourcePosition } from './live-source-position'

export function finishBlockTransaction(state: EditorState, paragraph = false) {
  if (state.readOnly || state.field(isComposing, false)) return null
  if (paragraph) {
    const selection = state.selection.main
    if (!selection.empty || state.selection.ranges.length !== 1) return null
    const block = closedBlockAt(state, selection.head)
    if (!block || selection.head < block.bodyFrom) return null
    const after = state.sliceDoc(block.to, Math.min(state.doc.length, block.to + 2))
    const insert = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    return state.update({
      ...(insert ? { changes: { from: block.to, insert } } : {}),
      effects: editLiveBlock.of(null),
      selection: { anchor: block.to + 2 },
      annotations: isolateHistory.of('full'),
      userEvent: 'input.type',
      scrollIntoView: true,
    })
  }
  const editing = editingBlock(state)
  if (!editing) return null
  const at =
    !inlineProjection(editing.block.kind) && blockSourceRange(state, editing.block)
      ? Math.min(state.doc.length, editing.to + 1)
      : editing.to
  return state.update({
    effects: editLiveBlock.of(null),
    selection: EditorSelection.cursor(at, 1),
    scrollIntoView: true,
  })
}

export function liveInteractions(): Extension {
  return [
    Prec.high(
      keymap.of([
        {
          key: 'ArrowDown',
          run(view) {
            if (view.compositionStarted) return false
            const selection = view.state.selection.main
            const block = closedBlockAt(view.state, selection.head)
            if (!block || (selection.head !== block.bodyTo && selection.head !== block.to))
              return false
            const transaction = finishBlockTransaction(view.state, true)
            if (!transaction) return false
            view.dispatch(transaction)
            return true
          },
        },
        {
          key: 'Backspace',
          run(view) {
            if (view.compositionStarted) return false
            const transaction = dismissEmptyBlock(view.state)
            if (!transaction) return false
            view.dispatch(transaction)
            return true
          },
        },
        {
          key: 'Escape',
          run(view) {
            if (view.compositionStarted) return false
            const editing = editingBlock(view.state)
            const transaction = finishBlockTransaction(view.state)
            if (!transaction) return false
            view.dispatch(transaction)
            if (editing?.block.kind === 'html') {
              // Return keyboard users to the output they just finished editing.
              // Native typing stays in the source editor until Escape is explicit.
              const output = [...view.dom.querySelectorAll<HTMLElement>('.cm-live-html')].find(
                (element) => blockAtPreview(view, element)?.from === editing.block.from,
              )
              output?.focus({ preventScroll: true })
              output?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            }
            return true
          },
        },
        {
          key: 'Mod-Enter',
          run(view) {
            if (view.compositionStarted) return false
            const transaction = finishBlockTransaction(view.state, true)
            if (!transaction) return false
            view.dispatch(transaction)
            return true
          },
        },
      ]),
    ),
  ]
}

export function dismissEmptyBlock(state: EditorState) {
  const selection = state.selection.main
  if (
    state.readOnly ||
    state.field(isComposing, false) ||
    !selection.empty ||
    state.selection.ranges.length !== 1
  )
    return null
  const block = closedBlockAt(state, selection.head)
  if (
    !block ||
    selection.head !== block.bodyTo ||
    block.bodyTo < block.bodyFrom ||
    !/^[\t ]*$/.test(state.sliceDoc(block.bodyFrom, block.bodyTo))
  )
    return null
  return state.update({
    changes: { from: block.bodyFrom - 1, to: block.to },
    selection: { anchor: block.bodyFrom - 1 },
    effects: editLiveBlock.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: 'delete.backward',
    scrollIntoView: true,
  })
}

export function activateRendered(
  view: EditorView,
  container: HTMLElement,
  event?: MouseEvent | KeyboardEvent,
): void {
  if (
    view.state.readOnly ||
    view.composing ||
    view.state.field(isComposing) ||
    !view.dom.contains(container)
  )
    return
  const current = editingBlock(view.state)
  const hit = event instanceof MouseEvent ? previewHitAtPoint(view, container, event) : undefined
  const block = hit?.block ?? blockAtPreview(view, container, event)
  if (!block || ['table', 'emoji'].includes(block.kind)) return
  if (current && current.from <= block.from && current.to >= block.to) {
    view.focus()
    return
  }
  let at = hit?.at
  if (at === undefined && (block.kind === 'math' || block.kind === 'inlineMath')) {
    const source = view.state.doc.sliceString(block.from, block.to)
    const start = block.kind === 'math' ? Math.max(0, block.value.search(/\S/)) : 0
    const position = delimitedSourcePosition(source, block.value, start)
    if (position !== undefined) at = block.from + position
  }
  activateLiveBlock(view, block, at)
}
