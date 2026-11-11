import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { editingBlock, editLiveBlock, liveEditing } from '../../src/live-editing'
import { type LiveBlock, liveModel, setLiveModel } from '../../src/live-model'

function fixture() {
  const source = '```mermaid\ngraph LR\nA-->B\n```'
  const block: LiveBlock = {
    id: 'old',
    from: 0,
    to: source.length,
    kind: 'diagram',
    value: 'graph LR\nA-->B',
    html: '',
    lines: 4,
  }
  let state = EditorState.create({
    doc: `${source}\n\nAfter`,
    extensions: [liveModel, liveEditing],
  })
  state = state.update({
    effects: [
      setLiveModel.of({ blocks: [block] }),
      editLiveBlock.of({ from: 0, to: block.to, block }),
    ],
    selection: { anchor: 12 },
  }).state
  return { state, block }
}

it('preserves an editing session and maps its caret range while semantic output is pending', () => {
  const { state, block } = fixture()
  const next = state.update({
    changes: { from: 14, insert: ' 新しい' },
    selection: { anchor: 18 },
  }).state
  expect(next.field(liveModel)).toBeNull()
  expect(editingBlock(next)?.to).toBe(block.to + 4)
  const updated = { ...block, id: 'new', to: block.to + 4, value: 'updated' }
  const refreshed = next.update({ effects: setLiveModel.of({ blocks: [updated] }) }).state
  expect(editingBlock(refreshed)?.block).toBe(updated)
  expect(refreshed.selection.main.head).toBe(18)
})

it('closes source explicitly or when the caret leaves, and releases fully replaced source', () => {
  const { state } = fixture()
  expect(editingBlock(state.update({ effects: editLiveBlock.of(null) }).state)).toBeNull()
  expect(editingBlock(state.update({ selection: { anchor: state.doc.length } }).state)).toBeNull()
  expect(
    editingBlock(
      state.update({ changes: { from: 0, to: state.doc.length, insert: 'Replacement' } }).state,
    ),
  ).toBeNull()
})

it('keeps the source editor open when changing a diagram fence to an ordinary code language', () => {
  const { state, block } = fixture()
  const next = state.update({
    changes: { from: 3, to: 10, insert: 'js' },
    selection: { anchor: 5 },
  }).state
  const code = { ...block, kind: 'code', to: block.to - 5, id: 'code', value: 'graph LR\nA-->B' }
  const refreshed = next.update({ effects: setLiveModel.of({ blocks: [code] }) }).state
  expect(editingBlock(refreshed)?.block).toBe(code)
  expect(refreshed.selection.main.empty).toBe(true)
  expect(refreshed.selection.main.head).toBe(5)
})

it('preserves raw table input ownership through typing and semantic refresh', () => {
  const original = fixture()
  const block = { ...original.block, kind: 'table' }
  const state = original.state.update({
    effects: [
      setLiveModel.of({ blocks: [block] }),
      editLiveBlock.of({ from: 0, to: block.to, block, source: true }),
    ],
  }).state
  const typed = state.update({ changes: { from: 14, insert: 'Q' } }).state
  expect(editingBlock(typed)?.source).toBe(true)
  const refreshed = typed.update({
    effects: setLiveModel.of({ blocks: [{ ...block, to: block.to + 1 }] }),
  }).state
  expect(editingBlock(refreshed)?.source).toBe(true)
})

it('keeps inline math ownership exact when refreshed on a whitespace-padded source line', () => {
  const block: LiveBlock = {
    id: 'math',
    from: 2,
    to: 7,
    kind: 'inlineMath',
    value: 'x^2',
    html: '',
    lines: 1,
  }
  let state = EditorState.create({
    doc: '  $x^2$  \n\nAfter',
    extensions: [liveModel, liveEditing],
  })
  state = state.update({
    effects: [setLiveModel.of({ blocks: [block] }), editLiveBlock.of({ from: 2, to: 7, block })],
    selection: { anchor: 4 },
  }).state
  const refreshed = state.update({
    effects: setLiveModel.of({ blocks: [{ ...block, id: 'refreshed' }] }),
  }).state
  expect(editingBlock(refreshed)).toMatchObject({ from: 2, to: 7 })
  expect(refreshed.selection.main.head).toBe(4)
})

it('does not rescan semantic blocks during caret movement or unrelated effects', () => {
  const { state, block } = fixture()
  let scans = 0
  const blocks = new Proxy([block], {
    get(target, key, receiver) {
      if (key === 'find') scans++
      return Reflect.get(target, key, receiver)
    },
  })
  const ready = state.update({ effects: setLiveModel.of({ blocks }) }).state
  scans = 0
  const moved = ready.update({ selection: { anchor: 13 } }).state
  const unchanged = moved.update({}).state
  expect(scans).toBe(0)
  expect(editingBlock(unchanged)).toBe(editingBlock(ready))
})
