import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { createSourceState } from '../../src/index'
import { editingBlock, editLiveBlock, liveEditing } from '../../src/live-editing'
import { inputSession, liveInput } from '../../src/live-input'
import {
  composingEffect,
  isComposing,
  type LiveBlock,
  liveModel,
  setLiveModel,
} from '../../src/live-model'
import { punctuationTransaction } from '../../src/punctuation'

function fixture(kind: string) {
  const doc = kind === 'html' ? '<div>Text</div>' : '"Text"...'
  const block: LiveBlock = {
    id: 'projected',
    kind,
    from: 0,
    to: doc.length,
    html: '',
    value: '',
    lines: 1,
  }
  const state = EditorState.create({
    doc,
    extensions: [liveModel, isComposing, liveEditing],
  }).update({ effects: setLiveModel.of({ blocks: [block] }) }).state
  return { state, block }
}

it.each(['paragraph', 'html', 'table', 'footnoteDefinition', 'link'])(
  'gives native input at either %s boundary a source session without changing text or selection',
  (kind) => {
    const { state, block } = fixture(kind)
    for (const at of [0, state.doc.length]) {
      const moved = state.update({ selection: { anchor: at } }).state
      const session = inputSession(moved, at)
      expect(session).toMatchObject({ from: 0, to: block.to, block, source: true })
      const revealed = moved.update({ effects: editLiveBlock.of(session) }).state
      expect(revealed.doc).toBe(moved.doc)
      expect(revealed.selection).toBe(moved.selection)
      expect(inputSession(revealed, at)).toBeNull()
      expect(editingBlock(revealed)?.source).toBe(true)
    }
  },
)

it('does not interrupt an IME, a selection replacement or a read-only document', () => {
  const { state } = fixture('paragraph')
  expect(inputSession(state.update({ effects: composingEffect.of(true) }).state, 0)).toBeNull()
  expect(inputSession(state.update({ selection: { anchor: 0, head: 2 } }).state, 0)).toBeNull()
  const readOnly = EditorState.create({
    extensions: [liveModel, isComposing, EditorState.readOnly.of(true)],
  })
  expect(inputSession(readOnly, 0)).toBeNull()
})

it('keeps an accepted input caret editable when a delayed projection arrives', () => {
  const { block } = fixture('html')
  let state = EditorState.create({
    doc: '<div>text',
    extensions: [liveModel, liveEditing, isComposing, liveInput],
  })
  state = state.update({
    changes: { from: state.doc.length, insert: 'Q' },
    selection: { anchor: state.doc.length + 1 },
    userEvent: 'input.type',
  }).state
  const projected = { ...block, to: state.doc.length }
  const ready = state.update({ effects: setLiveModel.of({ blocks: [projected] }) }).state
  expect(editingBlock(ready)?.block).toBe(projected)
  expect(ready.doc).toBe(state.doc)
  expect(ready.selection).toBe(state.selection)
})

it('keeps a skipped generated closer editable through the next semantic publication', () => {
  let state = createSourceState('', {
    extensions: [liveModel, liveEditing, isComposing, liveInput],
  })
  const opening = punctuationTransaction(state, '<')
  if (!opening) throw new Error('Expected an angle pair')
  state = opening.state.update({
    changes: { from: 1, insert: 'section' },
    selection: { anchor: 8 },
    userEvent: 'input.type',
  }).state
  const skip = punctuationTransaction(state, '>')
  if (!skip) throw new Error('Expected a generated closer')
  expect(skip.docChanged).toBe(false)
  const block: LiveBlock = {
    id: 'html',
    kind: 'html',
    from: 0,
    to: 9,
    html: '',
    value: '',
    lines: 1,
  }
  const ready = skip.state.update({ effects: setLiveModel.of({ blocks: [block] }) }).state
  expect(editingBlock(ready)?.block).toBe(block)
  expect(ready.selection.main.head).toBe(9)
  expect(ready.doc.toString()).toBe('<section>')
})

it('does not reveal an initial projection or reclaim a caret moved away from the last input', () => {
  const { block } = fixture('html')
  const state = EditorState.create({
    doc: '<div>text\n\nAfter',
    extensions: [liveModel, liveEditing, isComposing, liveInput],
  })
  expect(
    editingBlock(state.update({ effects: setLiveModel.of({ blocks: [block] }) }).state),
  ).toBeNull()
  const typed = state.update({
    changes: { from: 0, insert: 'Q' },
    selection: { anchor: 1 },
    userEvent: 'input.type',
  }).state
  const moved = typed.update({ selection: { anchor: typed.doc.length } }).state
  expect(
    editingBlock(moved.update({ effects: setLiveModel.of({ blocks: [block] }) }).state),
  ).toBeNull()
})
