import { isolateHistory } from '@codemirror/commands'
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { closedBlockAt } from './block-boundaries'
import { unclosedCodeFence } from './fenced-code'
import { editingBlock, editLiveBlock } from './live-editing'
import { isComposing, liveModel } from './live-model'

/** Blank space below the document becomes a paragraph only when requested. */
export function paragraphBelowDocument(state: EditorState) {
  if (state.readOnly || state.field(isComposing, false) || state.selection.ranges.length !== 1)
    return null
  let last = state.doc.line(state.doc.lines)
  while (last.number > 1 && /^[\t ]*$/.test(last.text)) last = state.doc.line(last.number - 1)
  const editing = editingBlock(state)?.block
  const block =
    state
      .field(liveModel, false)
      ?.blocks.find((block) => block.to === last.to && block.placement !== 'after-document') ??
    (editing?.to === last.to ? editing : undefined)
  if (
    block &&
    ['code', 'diagram'].includes(block.kind) &&
    unclosedCodeFence(state, block.from, block.to)
  )
    return null
  for (let node = syntaxTree(state).resolveInner(last.to, -1); node; ) {
    if (node.name === 'FencedCode' && unclosedCodeFence(state, node.from, node.to)) return null
    if (!node.parent) break
    node = node.parent
  }
  if (!syntaxTreeAvailable(state, last.to) && !block && !closedBlockAt(state, last.to)) return null
  const tail = state.doc.line(state.doc.lines)
  // A paragraph needs a blank separator, even when the file already ends in
  // one newline. Keep authored whitespace, but place typing before indentation.
  const at = /^[\t ]*$/.test(tail.text) ? tail.from : tail.to
  const missing = /^[\t ]*$/.test(last.text) ? 0 : Math.max(0, 2 - (tail.number - last.number))
  const insert = '\n'.repeat(missing)
  return state.update({
    ...(insert ? { changes: { from: at, insert } } : {}),
    selection: { anchor: at + insert.length },
    effects: editLiveBlock.of(null),
    annotations: isolateHistory.of('full'),
    userEvent: insert ? 'input' : 'select.pointer',
    scrollIntoView: true,
  })
}

export const liveTailClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      view.compositionStarted ||
      (event.target !== view.contentDOM && event.target !== view.scrollDOM)
    )
      return false
    const bounds = view.scrollDOM.getBoundingClientRect()
    // Ignore scrollbars, rendered widgets, and clicks beside existing text.
    if (
      event.clientX < bounds.left ||
      event.clientX >= bounds.left + view.scrollDOM.clientWidth ||
      event.clientY >= bounds.top + view.scrollDOM.clientHeight ||
      event.clientY <= view.documentTop + view.lineBlockAt(view.state.doc.length).bottom
    )
      return false
    const transaction = paragraphBelowDocument(view.state)
    if (!transaction) return false
    event.preventDefault()
    view.dispatch(transaction)
    view.focus()
    return true
  },
})
