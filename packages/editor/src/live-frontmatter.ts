import { type EditorState, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { frontmatterEnd } from './frontmatter'

function fences(state: EditorState): DecorationSet {
  const end = state.field(frontmatterEnd)
  if (!end) return Decoration.none
  if (state.selection.ranges.some((range) => range.from <= end)) return Decoration.none
  const opening = state.doc.line(1)
  const closing = state.doc.lineAt(end)
  // Metadata text stays in CodeMirror. Only its source delimiters are hidden,
  // including their line breaks, which requires decorations from a state field.
  // Leave the following line's decorations outside each replacement boundary.
  return Decoration.set([
    Decoration.replace({ block: true, inclusiveEnd: false }).range(0, opening.to + 1),
    Decoration.replace({ block: true, inclusiveEnd: false }).range(
      closing.from,
      Math.min(end + 1, state.doc.length),
    ),
  ])
}

export const frontmatterDecorations = StateField.define<DecorationSet>({
  create: fences,
  update: (previous, transaction) =>
    transaction.docChanged ||
    transaction.selection ||
    transaction.startState.field(frontmatterEnd) !== transaction.state.field(frontmatterEnd)
      ? fences(transaction.state)
      : previous,
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
})
