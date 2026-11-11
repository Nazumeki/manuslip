import type { State } from 'mdast-util-to-hast'

const cells = new WeakSet<State>()

export function inTableCell(state: State): boolean {
  return cells.has(state)
}

/** Scope the safe inline-break policy without changing immutable Markdown nodes. */
export function withTableCell<T>(state: State, run: () => T): T {
  const nested = cells.has(state)
  cells.add(state)
  try {
    return run()
  } finally {
    if (!nested) cells.delete(state)
  }
}

export function scopeTableCells(state: State): void {
  const all = state.all
  // The native table-row handler calls all(cell), bypassing cell handlers.
  state.all = (node) =>
    node.type === 'tableCell' ? withTableCell(state, () => all(node)) : all(node)
}
