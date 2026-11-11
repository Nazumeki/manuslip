import { type Nodes, type Root, tableEditLimits } from '@manuslip/core'
import { utf8Bytes } from '@manuslip/core/text'

export { tableEditLimits }
export type TableAlignment = 'left' | 'center' | 'right' | null
export interface TableDraft {
  rows: string[][]
  align: TableAlignment[]
}
export interface TableTarget {
  from: number
  to: number
  source: string
  firstPrefix: string
  continuationPrefix: string
  newline: string
  draft: TableDraft
}
const fail = (code = 'table-unsupported'): never => {
  throw new Error(code)
}
function offsets(node: Nodes): { from: number; to: number } {
  const from = node.position?.start.offset,
    to = node.position?.end.offset
  if (from === undefined || to === undefined || from < 0 || to < from) return fail()
  return { from, to }
}
function lineStart(source: string, offset: number): number {
  return Math.max(source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)) + 1
}
function unescapedFinalPipe(value: string): boolean {
  if (!value.endsWith('|')) return false
  let slashes = 0
  for (let at = value.length - 2; at >= 0 && value[at] === '\\'; at--) slashes++
  return slashes % 2 === 0
}
function trimCell(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, '')
}
function rawCell(source: string, cell: Nodes, last: boolean): string {
  const range = offsets(cell)
  let raw = trimCell(source.slice(range.from, range.to))
  if (raw.startsWith('|')) raw = trimCell(raw.slice(1))
  if (last && unescapedFinalPipe(raw)) raw = trimCell(raw.slice(0, -1))
  return raw
}
export function validateTableDraft(draft: TableDraft): void {
  const columns = draft.align.length
  if (
    columns < 1 ||
    columns > tableEditLimits.columns ||
    draft.rows.length < 1 ||
    draft.rows.length > tableEditLimits.rows ||
    columns * draft.rows.length > tableEditLimits.cells
  )
    fail('table-limit')
  if (draft.align.some((value) => ![null, 'left', 'center', 'right'].includes(value))) fail()
  for (const row of draft.rows) {
    if (row.length !== columns) fail()
    for (const cell of row)
      if (cell.length > tableEditLimits.cellUnits || /[\r\n]/u.test(cell) || cell.includes('\0'))
        fail('table-limit')
  }
}
export function readTableAt(root: Root, source: string, at: number): TableTarget {
  const pending: Nodes[] = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node) break
    const range = node.position ? offsets(node) : null
    if (range && (at < range.from || at > range.to)) continue
    if (node.type !== 'table') {
      if ('children' in node)
        for (const child of node.children) {
          const childRange = child.position ? offsets(child) : null
          if (!childRange || (at >= childRange.from && at <= childRange.to)) pending.push(child)
        }
      continue
    }
    if (!range) return fail()
    const from = lineStart(source, range.from),
      to = range.to
    if (to - from > tableEditLimits.sourceBytes) fail('table-limit')
    const original = source.slice(from, to)
    if (utf8Bytes(original) > tableEditLimits.sourceBytes) fail('table-limit')
    const firstPrefix = source.slice(from, range.from)
    const lines = original.split(/\r\n|\r|\n/u)
    const continuationPrefix = lines[1]?.match(/^[ \t>]*/u)?.[0] ?? fail()
    const columns = node.align?.length ?? node.children[0]?.children.length ?? 0
    if (
      columns < 1 ||
      columns > tableEditLimits.columns ||
      node.children.length > tableEditLimits.rows ||
      columns * node.children.length > tableEditLimits.cells
    )
      fail('table-limit')
    const rows = node.children.map((row, index) => {
      const rowRange = offsets(row)
      const prefix = source.slice(lineStart(source, rowRange.from), rowRange.from)
      if (
        prefix !== (index === 0 ? firstPrefix : continuationPrefix) ||
        row.children.length > columns
      )
        fail()
      const cells = row.children.map((cell, column) =>
        rawCell(source, cell, column === row.children.length - 1),
      )
      while (cells.length < columns) cells.push('')
      return cells
    })
    if (lines.length !== rows.length + 1) fail()
    const draft: TableDraft = {
      rows,
      align: Array.from({ length: columns }, (_, index) => node.align?.[index] ?? null),
    }
    validateTableDraft(draft)
    return {
      from,
      to,
      source: original,
      firstPrefix,
      continuationPrefix,
      newline: original.match(/\r\n|\r|\n/u)?.[0] ?? '\n',
      draft,
    }
  }
  return fail('table-not-found')
}
function escapePipes(value: string): string {
  let output = '',
    slashes = 0
  for (const character of trimCell(value)) {
    if (character === '|' && slashes % 2 === 0) output += '\\'
    output += character
    slashes = character === '\\' ? slashes + 1 : 0
  }
  return output
}
export function serializeTable(target: TableTarget, draft: TableDraft): string {
  validateTableDraft(draft)
  if (
    draft.align.length === target.draft.align.length &&
    draft.rows.length === target.draft.rows.length &&
    draft.align.every((value, index) => value === target.draft.align[index]) &&
    draft.rows.every((cells, row) =>
      cells.every((value, column) => value === target.draft.rows[row]?.[column]),
    )
  )
    return target.source
  const lines: string[] = []
  let bytes = 0
  const row = (cells: string[], prefix: string): void => {
    const values = cells.map(escapePipes)
    const cost =
      utf8Bytes(prefix) +
      4 +
      Math.max(0, values.length - 1) * 3 +
      values.reduce((sum, value) => sum + utf8Bytes(value), 0) +
      (lines.length ? utf8Bytes(target.newline) : 0)
    if (bytes + cost > tableEditLimits.outputBytes) fail('table-limit')
    bytes += cost
    lines.push(`${prefix}| ${values.join(' | ')} |`)
  }
  const header = draft.rows[0] ?? fail()
  const delimiters = draft.align.map((value) =>
    value === 'left' ? ':---' : value === 'right' ? '---:' : value === 'center' ? ':---:' : '---',
  )
  row(header, target.firstPrefix)
  row(delimiters, target.continuationPrefix)
  for (let index = 1; index < draft.rows.length; index++) {
    const cells = draft.rows[index]
    if (cells) row(cells, target.continuationPrefix)
  }
  return lines.join(target.newline)
}
