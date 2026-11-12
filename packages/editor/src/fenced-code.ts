import type { EditorState } from '@codemirror/state'

/** CommonMark accepts EOF as a fence end; editing must keep that unfinished
 * source visible until the author supplies a real matching closing fence. */
export function unclosedCodeFence(state: EditorState, from: number, to: number): boolean {
  const first = state.doc.lineAt(from)
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(state.sliceDoc(from, first.to))?.[1]
  if (!opening) return false
  // Nested projections retain their container prefix on subsequent lines.
  // Their enclosing paragraph/list owns rendering and source boundaries.
  if (!/^ {0,3}$/.test(state.sliceDoc(first.from, from))) return false
  const last = state.doc.lineAt(to)
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(last.text)?.[1]
  return (
    first.number === last.number ||
    !closing ||
    closing[0] !== opening[0] ||
    closing.length < opening.length
  )
}
