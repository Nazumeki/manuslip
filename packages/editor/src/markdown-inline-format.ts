import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { frontmatterEnd } from './frontmatter'

interface Span {
  from: number
  to: number
}
interface Style extends Span {
  marks: Span[]
}
interface Segment extends Span {
  remove: boolean
}
interface Block extends Span {
  styles: Style[]
  regions: Span[]
  marks: Span[]
  selected: Segment[]
}

function merge(spans: readonly Span[]): Span[] {
  const result: Span[] = []
  for (const span of [...spans].sort((a, b) => a.from - b.from || b.to - a.to)) {
    const previous = result.at(-1)
    if (previous && previous.to >= span.from) previous.to = Math.max(previous.to, span.to)
    else result.push({ from: span.from, to: span.to })
  }
  return result
}

/** Find the first overlapping interval in a sorted, disjoint set. */
function firstEndingAfter(spans: readonly Span[], at: number) {
  let from = 0,
    to = spans.length
  while (from < to) {
    const middle = (from + to) >>> 1
    if ((spans[middle]?.to ?? 0) <= at) from = middle + 1
    else to = middle
  }
  return from
}

function subtract(span: Span, removed: readonly Span[]): Span[] {
  const result: Span[] = []
  let from = span.from
  for (let index = firstEndingAfter(removed, from); index < removed.length; index++) {
    const cut = removed[index]
    if (!cut || cut.from >= span.to) break
    if (cut.from > from) result.push({ from, to: cut.from })
    from = Math.max(from, cut.to)
  }
  if (from < span.to) result.push({ from, to: span.to })
  return result
}

function trim(state: EditorState, span: Span, marks: readonly Span[] = []): Span {
  let { from, to } = span
  for (;;) {
    const start = from,
      end = to
    const opening = marks[firstEndingAfter(marks, from)]
    if (opening && opening.from <= from) from = Math.min(to, opening.to)
    const closing = marks[firstEndingAfter(marks, to - 1)]
    if (closing && closing.from < to) to = Math.max(from, closing.from)
    const text = state.sliceDoc(from, to)
    from += /^\s*/.exec(text)?.[0].length ?? 0
    to = Math.max(from, to - (/\s*$/.exec(text)?.[0].length ?? 0))
    if (from === start && to === end) return { from, to }
  }
}

function hasContent(state: EditorState, span: Span, marks: readonly Span[]) {
  return subtract(span, marks).some((piece) => /\S/.test(state.sliceDoc(piece.from, piece.to)))
}

function contentBounds(state: EditorState, node: SyntaxNode): Span {
  let from = node.from,
    to = node.to
  const marks = node.getChildren('HeaderMark')
  if (node.name.startsWith('SetextHeading') && marks[0])
    to = state.doc.lineAt(marks[0].from).from - 1
  else {
    if (marks[0]?.from === from) from = marks[0].to
    const last = marks.at(-1)
    if (last && last.from > from && last.to === to) to = last.from
  }
  return trim(state, { from, to })
}

function protectedRange(node: SyntaxNode, range: SelectionRange) {
  for (let current: SyntaxNode | null = node; current; current = current.parent)
    if (
      ['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'FrontmatterContent'].includes(
        current.name,
      ) &&
      current.to >= range.to
    )
      return true
  return false
}

/** Toggle actual Markdown text spans, preserving block syntax and unselected emphasis. */
export function inlineFormatTransaction(state: EditorState, format: 'bold' | 'italic') {
  if (state.readOnly) return null
  const ranges = state.selection.ranges
  const tree = ensureSyntaxTree(state, ranges.at(-1)?.to ?? 0, 20)
  if (!tree) return null
  const marker = format === 'bold' ? '**' : '*'
  const styleName = format === 'bold' ? 'StrongEmphasis' : 'Emphasis'
  const metadata = state.field(frontmatterEnd, false) ?? 0
  const blocks: Block[] = []
  tree.iterate({
    from: ranges[0]?.from ?? 0,
    to: ranges.at(-1)?.to ?? 0,
    enter(ref) {
      if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'FrontmatterContent'].includes(ref.name))
        return false
      if (ref.from < metadata || !/^(?:Paragraph|ATXHeading\d|SetextHeading\d)$/.test(ref.name))
        return
      const node = ref.node
      const block: Block = {
        ...contentBounds(state, node),
        styles: [],
        regions: [],
        marks: [],
        selected: [],
      }
      tree.iterate({
        from: node.from,
        to: node.to,
        enter(child) {
          if (child.name === 'InlineCode') return false
          if (['EmphasisMark', 'QuoteMark'].includes(child.name))
            block.marks.push({ from: child.from, to: child.to })
          if (child.name === styleName) {
            const marks = child.node.getChildren('EmphasisMark')
            if (marks.length === 2) block.styles.push({ from: child.from, to: child.to, marks })
          }
        },
      })
      block.marks = merge(block.marks)
      block.regions = merge(block.styles)
      blocks.push(block)
      return false
    },
  })
  const deletions: Span[] = []
  const insertions = new Map<number, string>()
  const empty = new Set<number>()
  const selection = ranges.map((range) => {
    if (range.from < metadata || protectedRange(tree.resolveInner(range.from, 1), range))
      return range
    if (range.empty) {
      const from = range.head - marker.length,
        to = range.head + marker.length
      if (from >= 0 && to <= state.doc.length && state.sliceDoc(from, to) === marker + marker) {
        deletions.push({ from, to })
        return range
      }
      const block = blocks.find((block) => block.from <= range.head && block.to >= range.head)
      const style = block?.styles.findLast(
        (style) => style.from < range.head && style.to > range.head,
      )
      if (style) block?.selected.push({ from: style.from, to: style.to, remove: true })
      else {
        insertions.set(range.head, marker + marker)
        empty.add(range.head)
      }
      return range
    }
    const selected: Span[] = []
    for (const block of blocks) {
      if (block.to <= range.from || block.from >= range.to) continue
      const span = trim(state, {
        from: Math.max(range.from, block.from),
        to: Math.min(range.to, block.to),
      })
      if (span.from >= span.to || !hasContent(state, span, block.marks)) continue
      block.selected.push({ ...span, remove: false })
      selected.push(span)
    }
    if (!selected.length) return range
    const from = selected[0]?.from ?? range.from,
      to = selected.at(-1)?.to ?? range.to
    return EditorSelection.range(
      range.anchor <= range.head ? from : to,
      range.anchor <= range.head ? to : from,
    )
  })
  const remove = blocks.every((block) =>
    block.selected.every(
      (span) =>
        span.remove ||
        subtract(span, block.regions).every((gap) => !hasContent(state, gap, block.marks)),
    ),
  )
  for (const block of blocks) {
    if (!block.selected.length) continue
    const selected = merge(block.selected)
    const regions = block.regions.filter((region) => {
      const span = selected[firstEndingAfter(selected, region.from - 1)]
      return span && span.from <= region.to
    })
    const marks = merge(
      block.styles
        .filter((style) => {
          const region = regions[firstEndingAfter(regions, style.from)]
          return region && region.from <= style.from && region.to >= style.to
        })
        .flatMap((style) => style.marks),
    )
    deletions.push(...marks)
    const removed = merge(block.selected.filter((span) => span.remove || remove))
    const added = block.selected.filter((span) => !span.remove && !remove)
    const remaining = regions.flatMap((region) => subtract(region, removed))
    for (const region of merge([...remaining, ...added])) {
      const span = trim(state, region, marks)
      if (span.from >= span.to || !hasContent(state, span, block.marks)) continue
      for (const at of [span.from, span.to]) insertions.set(at, (insertions.get(at) ?? '') + marker)
    }
  }
  const edits: ChangeSpec[] = merge(deletions).map((span) => {
    const insert = insertions.get(span.from) ?? ''
    insertions.delete(span.from)
    return { ...span, insert }
  })
  for (const [from, insert] of insertions) edits.push({ from, insert })
  const changes = state.changes(edits)
  return state.update({
    changes,
    selection: EditorSelection.create(
      selection.map((range) =>
        empty.has(range.head) && range.empty
          ? EditorSelection.cursor(changes.mapPos(range.head, -1) + marker.length)
          : range.map(changes),
      ),
      state.selection.mainIndex,
    ),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.format',
    scrollIntoView: true,
  })
}
