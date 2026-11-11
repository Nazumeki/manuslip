import { EditorSelection, EditorState, Prec, StateField } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { editingBlock, editLiveBlock, type LiveEditing, sourceRange } from './live-editing'
import { isComposing, liveModel, setLiveModel } from './live-model'

const inputCaret = StateField.define<number | null>({
  create: () => null,
  update(caret, transaction) {
    if (transaction.docChanged || (transaction.selection && transaction.isUserEvent('input'))) {
      const input = ['input', 'delete', 'undo', 'redo'].some((event) =>
        transaction.isUserEvent(event),
      )
      return input && transaction.newSelection.main.empty
        ? transaction.newSelection.main.head
        : null
    }
    return transaction.selection && transaction.newSelection.main.head !== caret ? null : caret
  },
})

/** A source caret at a replacement boundary has no editable DOM of its own.
 * Reveal that source before native input; never synthesize text from a key.
 */
export function inputSession(state: EditorState, at: number): LiveEditing | null {
  if (state.readOnly || state.field(isComposing) || !state.selection.main.empty) return null
  const current = editingBlock(state)
  if (current && at >= current.from && at <= current.to) return null
  for (const block of state.field(liveModel)?.blocks ?? []) {
    if (block.kind === 'emoji' || block.from > at || block.to < at) continue
    const range = sourceRange(state, block)
    if (at >= range.from && at <= range.to) return { ...range, block, source: true }
  }
  return null
}

function prepare(view: EditorView, event: Event): void {
  // A nested table cell owns its own input and composition lifecycle.
  if (
    view.compositionStarted ||
    !(event.target instanceof Element) ||
    event.target.closest('.cm-content') !== view.contentDOM
  )
    return
  const session = inputSession(view.state, view.state.selection.main.head)
  if (session) view.dispatch({ effects: editLiveBlock.of(session) })
}

function boundary(view: EditorView, end: boolean): boolean {
  if (view.compositionStarted) return false
  const at = end ? view.state.doc.length : 0
  const session = inputSession(view.state, at)
  if (!session) return false
  view.dispatch({
    selection: EditorSelection.cursor(at, end ? 1 : -1),
    effects: editLiveBlock.of(session),
    scrollIntoView: true,
    userEvent: 'select',
  })
  return true
}

export const liveInput = Prec.high([
  inputCaret,
  EditorState.transactionExtender.of((transaction) => {
    if (!transaction.effects.some((effect) => effect.is(setLiveModel) && effect.value !== null))
      return null
    const caret = transaction.state.field(inputCaret)
    if (caret === null) return null
    const session = inputSession(transaction.state, caret)
    return session ? { effects: editLiveBlock.of(session) } : null
  }),
  keymap.of([
    { key: 'Mod-Home', mac: 'Cmd-ArrowUp', run: (view) => boundary(view, false) },
    { key: 'Mod-End', mac: 'Cmd-ArrowDown', run: (view) => boundary(view, true) },
  ]),
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (
        (event.key.length === 1 &&
          ((!event.ctrlKey && !event.metaKey) || event.getModifierState('AltGraph'))) ||
        ['Backspace', 'Delete', 'Enter', 'Tab', 'Process'].includes(event.key) ||
        event.keyCode === 229
      )
        prepare(view, event)
      return false
    },
    beforeinput(event, view) {
      if (event.inputType.startsWith('insert') || event.inputType.startsWith('delete'))
        prepare(view, event)
      return false
    },
    compositionstart(event, view) {
      prepare(view, event)
      return false
    },
    paste(event, view) {
      prepare(view, event)
      return false
    },
    cut(event, view) {
      prepare(view, event)
      return false
    },
  }),
])
