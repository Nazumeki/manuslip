import { EditorSelection, type EditorState, type Extension, Prec } from '@codemirror/state'
import { type EditorView, keymap } from '@codemirror/view'
import { activateLiveBlock, editingBlock, editLiveBlock } from './live-editing'
import { blockSourceRange, inlineProjection, isComposing } from './live-model'
import { blockAtPreview, previewHitAtPoint } from './live-preview-position'
import { delimitedSourcePosition } from './live-source-position'

export function finishBlockTransaction(state: EditorState, paragraph = false) {
  const editing = editingBlock(state)
  if (!editing || state.readOnly || state.field(isComposing, false)) return null
  if (paragraph) {
    if (!['math', 'code', 'diagram'].includes(editing.block.kind)) return null
    const selection = state.selection.main
    if (!selection.empty || state.selection.ranges.length !== 1) return null
    const last = state.doc.lineAt(editing.block.to)
    const first = state.doc.lineAt(editing.block.from)
    const opening = state.doc.sliceString(editing.block.from, first.to)
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(opening)?.[1]
    const endFence = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(last.text)?.[1]
    const closing =
      first.number < last.number &&
      (editing.block.kind === 'math'
        ? (/^ {0,3}\$\$/.test(opening) && /^ {0,3}\$\$[\t ]*$/.test(last.text)) ||
          (/^ {0,3}\\\[/.test(opening) && /^ {0,3}\\\][\t ]*$/.test(last.text))
        : !!fence && !!endFence && fence[0] === endFence[0] && endFence.length >= fence.length)
    const bodyEnd = closing ? last.from - 1 : editing.block.to
    if (selection.head !== bodyEnd) return null
    const after = state.doc.sliceString(editing.to, Math.min(state.doc.length, editing.to + 2))
    const insert = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    return state.update({
      ...(insert ? { changes: { from: editing.to, insert } } : {}),
      effects: editLiveBlock.of(null),
      selection: { anchor: editing.to + 2 },
      userEvent: 'input.type',
      scrollIntoView: true,
    })
  }
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
          key: 'Escape',
          run(view) {
            if (view.compositionStarted) return false
            const transaction = finishBlockTransaction(view.state)
            if (!transaction) return false
            view.dispatch(transaction)
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
