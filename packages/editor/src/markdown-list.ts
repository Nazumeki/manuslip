import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { type ChangeSpec, countColumn, type EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { frontmatterEnd } from './frontmatter'

function listItem(node: SyntaxNode): SyntaxNode | null {
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock'].includes(current.name)) return null
    if (current.name === 'ListItem') return current
  }
  return null
}

function markerWidth(state: EditorState, item: SyntaxNode) {
  // A task checkbox belongs to the content; only the list marker sets nesting depth.
  const at = item.getChild('ListMark')?.from ?? item.from
  const marker = /^(?:[-+*]|\d+[.)])([ \t]+)/.exec(state.sliceDoc(at, state.doc.lineAt(at).to))?.[0]
  const line = state.doc.lineAt(at)
  const prefix = state.sliceDoc(line.from, at)
  // Markdown's tab stops are four columns, independently of the source display preference.
  return marker ? countColumn(prefix + marker, 4) - countColumn(prefix, 4) : 2
}

function previousItem(item: SyntaxNode): SyntaxNode | null {
  for (let sibling = item.prevSibling; sibling; sibling = sibling.prevSibling)
    if (sibling.name === 'ListItem') return sibling
  return null
}

function itemIndent(state: EditorState, item: SyntaxNode, outdent: boolean) {
  const parent = item.parent?.parent
  if (outdent && parent?.name === 'ListItem') {
    const column = (node: SyntaxNode) => {
      const at = node.getChild('ListMark')?.from ?? node.from
      return countColumn(state.sliceDoc(state.doc.lineAt(at).from, at), 4)
    }
    return Math.max(1, column(item) - column(parent))
  }
  return markerWidth(state, outdent ? item : (previousItem(item) ?? item))
}

function quoteEnd(text: string) {
  return /^(?:[ \t]*>[ \t]?)+/.exec(text)?.[0].length ?? 0
}

/** Move complete list items, including their continuation lines and descendants. */
export function listIndentTransaction(state: EditorState, outdent = false) {
  if (state.readOnly) return null
  const tree = ensureSyntaxTree(state, state.selection.ranges.at(-1)?.to ?? 0, 20)
  if (!tree) return null
  const items = new Map<number, SyntaxNode>()
  for (const range of state.selection.ranges) {
    if (range.from < (state.field(frontmatterEnd, false) ?? 0)) return null
    const first = state.doc.lineAt(range.from)
    const last = state.doc.lineAt(
      range.to > range.from && state.doc.lineAt(range.to).from === range.to
        ? range.to - 1
        : range.to,
    )
    for (let number = first.number; number <= last.number; number++) {
      const line = state.doc.line(number)
      if (!line.text.trim()) continue
      const marker = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])(?=[ \t]|$)/.exec(line.text)
      const at = Math.min(
        line.to,
        line.from + (marker?.[0].length ?? Math.max(0, line.text.search(/\S/))) + 1,
      )
      const item = listItem(tree.resolveInner(Math.max(at, Math.min(line.to, range.from)), -1))
      if (!item) return null
      items.set(item.from, item)
      // An item already owns all its continuation lines, fences and descendants.
      number = state.doc.lineAt(item.to).number
    }
  }
  if (!items.size) return null
  const changes: ChangeSpec[] = []
  let end = -1
  for (const item of [...items.values()].sort((a, b) => a.from - b.from)) {
    if (item.from < end) continue
    end = item.to
    const width = itemIndent(state, item, outdent)
    const marker = item.getChild('ListMark')?.from ?? item.from
    const first = state.doc.lineAt(marker)
    const firstPrefix = state.sliceDoc(first.from, marker)
    const quote = firstPrefix.lastIndexOf('>')
    const protectedPrefix = quote < 0 ? 0 : quote + 1 + (firstPrefix[quote + 1] === ' ' ? 1 : 0)
    const firstIndent = firstPrefix.slice(protectedPrefix)
    // A same-line outer list/quote marker is structural, never removable indentation.
    if (outdent && (!firstIndent || /\S/.test(firstIndent))) continue
    for (let number = first.number; number <= state.doc.lineAt(item.to).number; number++) {
      const line = state.doc.line(number)
      if (/^[ \t>]*$/.test(line.text)) continue
      const prefix = number === first.number ? protectedPrefix : quoteEnd(line.text)
      const indent = /^[ \t]*/.exec(line.text.slice(prefix))?.[0] ?? ''
      const from = line.from + prefix
      if (!outdent) {
        // Appending spaces after authored tabs adds the intended number of columns.
        const at = number === first.number ? marker : from + indent.length
        changes.push({ from: at, insert: ' '.repeat(width) })
      } else if (indent) {
        const column = countColumn(line.text.slice(0, prefix), 4)
        const columns = countColumn(line.text.slice(0, prefix + indent.length), 4) - column
        changes.push({
          from,
          to: from + indent.length,
          insert: ' '.repeat(Math.max(0, columns - width)),
        })
      }
    }
  }
  return state.update({
    changes,
    annotations: isolateHistory.of('full'),
    userEvent: 'input.indent',
    scrollIntoView: true,
  })
}
