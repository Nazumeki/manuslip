import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, type EditorState, type SelectionRange } from '@codemirror/state'
import { type EditorView, keymap } from '@codemirror/view'
import { frontmatterEnd } from './frontmatter'
import { inlineFormatTransaction } from './markdown-inline-format'

export { inlineFormatTransaction } from './markdown-inline-format'

function moveSelection(range: SelectionRange, offset: number, from = 0, to = Infinity) {
  const move = (position: number) => Math.max(from, Math.min(to, position + offset))
  return EditorSelection.range(move(range.anchor), move(range.head))
}

/** A code-block command owns whole lines, while retaining the original caret or selection. */
export function codeBlockTransaction(state: EditorState) {
  if (state.readOnly || state.selection.ranges.length !== 1) return null
  const range = state.selection.main
  if (range.from < (state.field(frontmatterEnd, false) ?? 0)) return null
  const tree = ensureSyntaxTree(state, range.to, 20)
  if (!tree) return null
  for (let node = tree.resolveInner(range.from, 1); node; ) {
    if (
      node.name === 'FencedCode' &&
      node.to >= range.to &&
      node.getChildren('CodeMark').length === 2
    ) {
      const first = state.doc.lineAt(node.from),
        last = state.doc.lineAt(node.to)
      const body = state.doc.line(Math.min(last.number, first.number + 1))
      const code = node.getChild('CodeText')
      const closing = node.getChildren('CodeMark').at(-1)
      const continuation = state.sliceDoc(last.from, closing?.from ?? last.from)
      const bodyFrom =
        code && state.doc.lineAt(code.from).number === body.number
          ? code.from
          : /^[ \t>]*$/.test(body.text)
            ? body.to
            : body.from + (body.text.startsWith(continuation) ? continuation.length : 0)
      const changes = state.changes(
        body.number === last.number
          ? { from: node.from, to: last.to }
          : [
              { from: node.from, to: bodyFrom },
              { from: last.from - 1, to: last.to },
            ],
      )
      return state.update({
        changes,
        selection: state.selection.map(changes),
        annotations: isolateHistory.of('full'),
        userEvent: 'input.format',
        scrollIntoView: true,
      })
    }
    if (!node.parent) break
    node = node.parent
  }
  const first = state.doc.lineAt(range.from)
  const last = state.doc.lineAt(
    range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to,
  )
  const body = state.sliceDoc(first.from, last.to)
  let fenceLength = 3
  for (const match of body.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1)
  const fence = '`'.repeat(fenceLength)
  const before = first.number > 1 && state.doc.line(first.number - 1).text.trim() ? '\n' : ''
  const after =
    last.number < state.doc.lines && state.doc.line(last.number + 1).text.trim() ? '\n' : ''
  const opening = `${before}${fence}\n`
  return state.update({
    changes: { from: first.from, to: last.to, insert: `${opening}${body}\n${fence}${after}` },
    selection: moveSelection(
      range,
      opening.length,
      first.from + opening.length,
      last.to + opening.length,
    ),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.format',
    scrollIntoView: true,
  })
}

function format(view: EditorView, transaction: () => ReturnType<typeof codeBlockTransaction>) {
  if (view.compositionStarted) return false
  const update = transaction()
  if (update) {
    view.dispatch(update)
    view.dispatch({ selection: view.state.selection })
  }
  // Consume formatting shortcuts even in contexts where formatting is unavailable.
  return true
}

export function markdownFormatting(codeBlocks = true) {
  const code = (view: EditorView) =>
    format(view, () => (codeBlocks ? codeBlockTransaction(view.state) : null))
  return keymap.of([
    {
      key: 'Mod-b',
      run: (view) => format(view, () => inlineFormatTransaction(view.state, 'bold')),
    },
    {
      key: 'Mod-i',
      run: (view) => format(view, () => inlineFormatTransaction(view.state, 'italic')),
    },
    { key: 'Mod-Shift-k', run: code },
    { mac: 'Cmd-Alt-c', run: code },
  ])
}
