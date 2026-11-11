import { EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { tableCellInput, tableRowInsertion, tableSourceCells } from '../../src/live-table-source'

function table(text: string) {
  const state = EditorState.create({ doc: `Before\n\n${text}\n\nAfter` })
  const block = {
    from: 8,
    to: 8 + text.length,
    kind: 'table',
    id: 'table',
    html: '',
    value: '',
    lines: 3,
  }
  const cells = tableSourceCells(state, block)
  return {
    state,
    block,
    cells,
    text: cells.map((row) => row.map((cell) => state.doc.sliceString(cell.from, cell.to))),
  }
}

it('inserts below the header separator or a body row without rewriting existing source', () => {
  const result = table('| A | B |\n| :-- | --: |\n| x | y |\n| z | q |')
  for (const row of [0, 1, 2]) {
    const change = tableRowInsertion(result.state, result.block, row)
    if (!change) throw new Error('Expected row insertion')
    const next = result.state.update({ changes: change }).state
    const text = tableSourceCells(next, {
      ...result.block,
      to: result.block.to + change.insert.length,
    }).map((cells) => cells.map((cell) => next.doc.sliceString(cell.from, cell.to)))
    const expected = [...result.text]
    expected.splice(row + 1, 0, ['', ''])
    expect(text).toEqual(expected)
    expect(next.doc.toString()).toContain('| :-- | --: |')
    expect(next.doc.toString()).toMatch(/^Before\n\n[\s\S]*\n\nAfter$/)
  }
})

it('preserves blockquote indentation and refuses oversized or read-only row creation', () => {
  const result = table('> | A |\n> | -- |\n> | x |')
  expect(tableRowInsertion(result.state, result.block, 1)?.insert).toBe('\n> |  |')
  const full = table(`| A |\n| -- |\n${'| x |\n'.repeat(199).trimEnd()}`)
  expect(tableRowInsertion(full.state, full.block, 199)).toBeNull()
  const readonly = EditorState.create({
    doc: result.state.doc,
    extensions: EditorState.readOnly.of(true),
  })
  expect(tableRowInsertion(readonly, result.block, 0)).toBeNull()
  expect(tableRowInsertion(result.state, result.block, -1)).toBeNull()
})

it('places typed content between an empty cell’s existing padding', () => {
  const result = table('| A |\n| -- |\n|  |')
  const cell = result.cells[1]?.[0]
  if (!cell) throw new Error('Missing empty cell')
  const next = result.state.update({
    changes: { from: cell.from, to: cell.to, insert: 'new' },
  }).state
  expect(next.doc.toString()).toBe('Before\n\n| A |\n| -- |\n| new |\n\nAfter')
})

it('keeps pasted pipes and line breaks inside their cell and maps the caret through escaping', () => {
  const state = EditorState.create({ extensions: EditorState.transactionFilter.of(tableCellInput) })
  const next = state.update({
    changes: { from: 0, insert: 'a | b\nc \\| d' },
    selection: { anchor: 5 },
  }).state
  expect(next.doc.toString()).toBe('a \\| b c \\| d')
  expect(next.selection.main.head).toBe(6)
})

it('applies the cell limit to normalized source and rejects an overflowing edit atomically', () => {
  const state = EditorState.create({ extensions: EditorState.transactionFilter.of(tableCellInput) })
  const full = state.update({ changes: { from: 0, insert: '|'.repeat(2048) } }).state
  expect(full.doc.toString()).toBe('\\|'.repeat(2048))
  const rejected = full.update({
    changes: { from: 0, insert: '|' },
    selection: { anchor: 1 },
  }).state
  expect(rejected.doc).toBe(full.doc)
  expect(rejected.selection).toBe(full.selection)
  expect(state.update({ changes: { from: 0, insert: '|'.repeat(2049) } }).docChanged).toBe(false)
})

it('allows an existing oversized cell to shrink but prevents growth above the limit', () => {
  const state = EditorState.create({
    doc: '\\|'.repeat(3000),
    extensions: EditorState.transactionFilter.of(tableCellInput),
  })
  const smaller = state.update({ changes: { from: 0, to: 2 } }).state
  expect(smaller.doc.length).toBe(5998)
  expect(smaller.update({ changes: { from: 0, insert: 'a' } }).docChanged).toBe(false)
  const recovered = smaller.update({ changes: { from: 0, to: 1902 } }).state
  expect(recovered.doc.length).toBe(4096)
  expect(recovered.update({ changes: { from: 0, to: 2, insert: '|' } }).state.doc.length).toBe(4096)
})

it('finds authored cell ranges without consuming alignment, spaces, escapes or neighboring text', () => {
  const result = table('| Name | Detail |\n| :-- | --: |\n| a \\| b | **中文** |')
  expect(result.text).toEqual([
    ['Name', 'Detail'],
    ['a \\| b', '**中文**'],
  ])
  const cell = result.cells[1]?.[1]
  if (!cell) throw new Error('Missing cell')
  const next = result.state.update({
    changes: { from: cell.from, to: cell.to, insert: '*Changed*' },
  }).state
  expect(next.doc.toString()).toBe(
    'Before\n\n| Name | Detail |\n| :-- | --: |\n| a \\| b | *Changed* |\n\nAfter',
  )
})

it('supports omitted outer pipes, empty cells and even backslashes before a separator', () => {
  expect(table('Name | Detail | Last\n-- | -- | --\na\\\\ | | c').text).toEqual([
    ['Name', 'Detail', 'Last'],
    ['a\\\\', '', 'c'],
  ])
})

it('gives padded, unauthored cells insertion ranges without rewriting the table on focus', () => {
  const result = table('| First | Second | Third |\n| -- | -- | -- |\n| Sparse |')
  expect(result.text[1]).toEqual(['Sparse', '', ''])
  const cell = result.cells[1]?.[2]
  if (!cell) throw new Error('Missing padded cell')
  const next = result.state.update({
    changes: { from: cell.from, to: cell.to, insert: `${cell.prefix}New${cell.suffix}` },
  }).state
  expect(next.doc.toString()).toBe(
    'Before\n\n| First | Second | Third |\n| -- | -- | -- |\n| Sparse |  | New |\n\nAfter',
  )
})
