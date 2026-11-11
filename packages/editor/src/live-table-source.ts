import type { EditorState, Transaction, TransactionSpec } from '@codemirror/state'
import { tableEditLimits } from '@manuslip/core'
import { utf8Bytes } from '@manuslip/core/text'
import type { LiveBlock } from './live-model'

export interface LiveCell {
  row: number
  column: number
  from: number
  to: number
  prefix?: string
  suffix?: string
}

export function tableCellInput(transaction: Transaction): Transaction | readonly TransactionSpec[] {
  if (!transaction.docChanged) return transaction
  const previousLength = transaction.startState.doc.length
  // Normalization can grow a cell (each unescaped pipe adds a backslash).
  // Reject the entire edit against its final source size, while still letting
  // an existing oversized cell recover through smaller edits.
  if (
    transaction.newDoc.length > tableEditLimits.cellUnits &&
    transaction.newDoc.length >= previousLength
  )
    return []
  const text = transaction.newDoc.toString()
  const changes: { from: number; to: number; insert: string }[] = []
  let length = text.length
  let slashes = 0
  for (let at = 0; at < text.length; at++) {
    const character = text[at]
    if (character === '|' && slashes % 2 === 0) {
      changes.push({ from: at, to: at, insert: '\\' })
      length++
    }
    if (character === '\n') changes.push({ from: at, to: at + 1, insert: ' ' })
    slashes = character === '\\' ? slashes + 1 : 0
  }
  if (length > tableEditLimits.cellUnits && length >= previousLength) return []
  return changes.length ? [transaction, { changes, sequential: true }] : transaction
}

/** Insert below an authored row, preserving container indentation and alignment. */
export function tableRowInsertion(state: EditorState, block: LiveBlock, row: number) {
  if (state.readOnly || !Number.isInteger(row) || row < 0) return null
  const cells = tableSourceCells(state, block)
  const columns = cells[0]?.length ?? 0
  const current = cells[row]?.[0]
  if (
    !current ||
    !columns ||
    columns > tableEditLimits.columns ||
    cells.length >= tableEditLimits.rows ||
    (cells.length + 1) * columns > tableEditLimits.cells
  )
    return null
  const first = state.doc.lineAt(block.from).number
  const separator = state.doc.line(first + 1)
  const line = row === 0 ? separator : state.doc.lineAt(current.from)
  const prefix = /^[\t >]*/.exec(separator.text)?.[0] ?? ''
  const insert = `\n${prefix}|${'  |'.repeat(columns)}`
  if (
    utf8Bytes(state.doc.sliceString(block.from, block.to)) + utf8Bytes(insert) >
    tableEditLimits.sourceBytes
  )
    return null
  return { from: line.to, insert }
}

/** Split at Markdown table separators, never at an escaped pipe. Keep absolute
 * ranges so a cell edit changes only its authored source, including empty cells.
 */
export function tableSourceCells(state: EditorState, block: LiveBlock): LiveCell[][] {
  const first = state.doc.lineAt(block.from).number
  const last = state.doc.lineAt(Math.min(block.to, state.doc.length)).number
  const rows: LiveCell[][] = []
  for (let number = first; number <= last; number++) {
    if (number === first + 1) continue
    const line = state.doc.line(number)
    const text = line.text
    const edges: number[] = []
    let slashes = 0
    for (let at = 0; at < text.length; at++) {
      const character = text[at]
      if (character === '|' && slashes % 2 === 0) edges.push(at)
      slashes = character === '\\' ? slashes + 1 : 0
    }
    const leading = /^[\t >]*\|/.test(text)
    const trailing = edges.at(-1) === text.trimEnd().length - 1
    const bounds = [
      leading ? (edges.shift() ?? -1) + 1 : text.search(/\S|$/),
      ...edges.map((at) => at + 1),
    ]
    if (!trailing) bounds.push(text.length + 1)
    const cells: LiveCell[] = []
    for (let column = 0; column < bounds.length - 1; column++) {
      const start = bounds[column] ?? 0
      const end = Math.max(start, (bounds[column + 1] ?? text.length + 1) - 1)
      const raw = text.slice(start, end)
      const padding = raw.match(/^[\t ]*/)?.[0].length ?? 0
      // An empty authored cell still has left and right padding. Put its
      // insertion point between them rather than after all of its spaces.
      const from = start + (padding === raw.length ? Math.ceil(padding / 2) : padding)
      const to = Math.max(from, end - (raw.match(/[\t ]*$/)?.[0].length ?? 0))
      cells.push({ row: rows.length, column, from: line.from + from, to: line.from + to })
    }
    const authored = cells.length
    const count = rows[0]?.length ?? authored
    while (cells.length < count) {
      const from = line.from + text.trimEnd().length
      cells.push({
        row: rows.length,
        column: cells.length,
        from,
        to: from,
        prefix: `${trailing ? ' ' : ' | '}${' | '.repeat(cells.length - authored)}`,
        suffix: ' |',
      })
    }
    rows.push(cells)
  }
  return rows
}
