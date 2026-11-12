import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { frontmatterEnd } from './frontmatter'
import { editingBlock } from './live-editing'

/** Source boundaries, available even before the semantic worker publishes. */
export function closedBlockAt(state: EditorState, at: number) {
  const metadata = state.field(frontmatterEnd, false) ?? 0
  let from: number | undefined
  let to: number | undefined
  if (metadata && at <= metadata) {
    from = 0
    to = metadata
  } else if (syntaxTreeAvailable(state, at)) {
    for (let node = syntaxTree(state).resolveInner(at, -1); node; ) {
      if (node.name === 'FencedCode') {
        from = node.from
        to = node.to
        break
      }
      if (!node.parent) break
      node = node.parent
    }
  }
  if (from === undefined || to === undefined) {
    const editing = editingBlock(state)
    if (!editing || !['code', 'diagram', 'math'].includes(editing.block.kind)) return null
    from = editing.block.from
    to = editing.block.to
  }
  if (at < from || at > to) return null
  const first = state.doc.lineAt(from)
  const last = state.doc.lineAt(to)
  if (first.number === last.number) return null
  const opening = state.sliceDoc(from, first.to)
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(opening)?.[1]
  const endFence = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(last.text)?.[1]
  const closed =
    metadata === to && from === 0
      ? true
      : fence
        ? !!endFence && fence[0] === endFence[0] && endFence.length >= fence.length
        : (/^ {0,3}\$\$[\t ]*$/.test(opening) && /^ {0,3}\$\$[\t ]*$/.test(last.text)) ||
          (/^ {0,3}\\\[[\t ]*$/.test(opening) && /^ {0,3}\\\][\t ]*$/.test(last.text))
  if (!closed) return null
  return { from, to: last.to, bodyFrom: first.to + 1, bodyTo: last.from - 1 }
}
