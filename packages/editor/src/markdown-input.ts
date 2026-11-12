import { isolateHistory } from '@codemirror/commands'
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { EditorSelection, type EditorState, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { closedBlockAt } from './block-boundaries'
import { latexMarkdown } from './conventions'
import { frontmatterEnd, yamlFrontmatter } from './frontmatter'
import { editLiveBlock, liveEditing } from './live-editing'
import { isComposing } from './live-model'
import { punctuationNewline } from './punctuation'

function splitEmphasis(state: EditorState, node: SyntaxNode, at: number, side: -1 | 1) {
  let position = at,
    marks = ''
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (!['Emphasis', 'StrongEmphasis'].includes(current.name)) continue
    const [opening, closing] = current.getChildren('EmphasisMark')
    if (!opening || !closing || at < opening.to || at > closing.from) continue
    let content =
      side < 0 ? state.sliceDoc(opening.to, position) : state.sliceDoc(position, closing.from)
    // Whitespace cannot sit directly inside an emphasis delimiter. The paragraph
    // boundary replaces adjoining whitespace when splitting a style.
    const padding = (side < 0 ? /\s+$/ : /^\s+/).exec(content)?.[0].length ?? 0
    position += side * padding
    content =
      side < 0 ? state.sliceDoc(opening.to, position) : state.sliceDoc(position, closing.from)
    if (content.trim())
      marks =
        side < 0
          ? marks + state.sliceDoc(closing.from, closing.to)
          : state.sliceDoc(opening.from, opening.to) + marks
    // Avoid leaving empty emphasis at the beginning or end of a paragraph.
    else position = side < 0 ? opening.from : closing.to
  }
  return { position, marks }
}

/** Live prose uses blank-line paragraph boundaries; Source retains literal newlines. */
export function paragraphBreakTransaction(state: EditorState) {
  if (state.readOnly || state.field(isComposing, false)) return null
  const tree = ensureSyntaxTree(state, state.selection.ranges.at(-1)?.to ?? 0, 20)
  if (!tree) return null
  for (const range of state.selection.ranges) {
    for (const at of [range.from, range.to]) {
      if (at < (state.field(frontmatterEnd, false) ?? 0) || closedBlockAt(state, at)) return null
      let paragraph = false
      for (let node = tree.resolveInner(at, at === state.doc.lineAt(at).from ? 1 : -1); node; ) {
        if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'ListItem', 'Blockquote'].includes(node.name))
          return null
        if (node.name === 'Paragraph') paragraph = true
        if (!node.parent) break
        node = node.parent
      }
      if (!paragraph) return null
    }
  }
  return state.update(
    state.changeByRange((range) => {
      const before = splitEmphasis(state, tree.resolveInner(range.from, 1), range.from, -1)
      const after = splitEmphasis(state, tree.resolveInner(range.to, -1), range.to, 1)
      const insert = `${before.marks}\n\n${after.marks}`
      return {
        changes: { from: before.position, to: after.position, insert },
        range: EditorSelection.cursor(before.position + insert.length),
      }
    }),
    {
      annotations: isolateHistory.of('full'),
      userEvent: 'input.type',
      scrollIntoView: true,
    },
  )
}

/** Finish an existing block-opening gesture in Live Preview. Source mode keeps
 * literal fence entry. Existing content is kept outside the completed block.
 */
export function blockOpeningTransaction(state: EditorState) {
  const selection = state.selection.main
  if (state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return null
  const line = state.doc.lineAt(selection.head)
  if (selection.head !== line.to) return null
  if (line.from < (state.field(frontmatterEnd, false) ?? 0)) return null
  const markAt = line.from + (/^ */.exec(line.text)?.[0].length ?? 0)
  const mark = syntaxTree(state).resolveInner(markAt, 1)
  // Lazy code-language loading does not invalidate an explicit Markdown opener.
  // A genuinely unparsed prefix has no such node and must remain literal.
  if (
    !syntaxTreeAvailable(state, line.to) &&
    !(
      mark.name === 'CodeMark' &&
      mark.from === markAt &&
      mark.parent?.name === 'FencedCode' &&
      mark.parent.from === markAt
    )
  )
    return null
  // A closing fence (or a fence-looking line in code) is not another opener.
  let node = mark
  for (;;) {
    if (['HTMLBlock', 'CommentBlock', 'CodeBlock', 'ListItem', 'Blockquote'].includes(node.name))
      return null
    if (node.name === 'FencedCode') {
      if (node.from < line.from) return null
      // An authored closer is never duplicated or moved by completion.
      if (node.getChildren('CodeMark').length > 1) return null
    }
    if (!node.parent) break
    node = node.parent
  }
  const fence = /^( {0,3})(`{3,}|~{3,})([^`\r\n]*)$/.exec(line.text)
  let closing = fence ? `${fence[1]}${fence[2]}` : undefined
  if (!closing && state.facet(latexMarkdown) && /^ {0,3}\$\$[ \t]*$/.test(line.text)) {
    let inside = false
    for (const previous of state.doc.iterLines(1, line.number))
      if (/^ {0,3}\$\$[ \t]*$/.test(previous)) inside = !inside
    if (inside) return null
    if (line.number < state.doc.lines)
      for (const following of state.doc.iterLines(line.number + 1))
        if (/^ {0,3}\$\$[ \t]*$/.test(following)) return null
    closing = '$$'
  }
  if (
    !closing &&
    line.number === 1 &&
    ((state.facet(yamlFrontmatter) && /^---[ \t]*$/.test(line.text)) ||
      /^\+\+\+[ \t]*$/.test(line.text))
  )
    closing = line.text.trimEnd()
  if (!closing) return null
  const body = fence?.[1] ?? ''
  const insert = `\n${body}\n${closing}`
  const suffix = state.sliceDoc(line.to, Math.min(state.doc.length, line.to + 2))
  const separator = suffix && !suffix.startsWith('\n\n') ? '\n' : ''
  const kind = fence ? 'code' : closing === '$$' ? 'math' : null
  const to = line.to + insert.length
  return state.update({
    changes: { from: selection.head, insert: insert + separator },
    selection: { anchor: selection.head + 1 + body.length },
    effects:
      kind && state.field(liveEditing, false) !== undefined
        ? editLiveBlock.of({
            from: line.from,
            to,
            block: {
              id: `input:${line.from}`,
              from: fence ? markAt : line.from,
              to,
              kind,
              html: '',
              value: '',
              lines: 3,
            },
          })
        : [],
    annotations: isolateHistory.of('full'),
    userEvent: 'input.type',
    scrollIntoView: true,
  })
}

export const liveMarkdownInput = Prec.high([
  keymap.of([
    {
      key: 'Enter',
      run(view) {
        if (view.compositionStarted) return false
        const transaction =
          blockOpeningTransaction(view.state) ??
          punctuationNewline(view.state) ??
          paragraphBreakTransaction(view.state)
        if (!transaction) return false
        view.dispatch(transaction)
        // Record the interior caret in native selection history. Otherwise redo
        // derives it from the insertion length and lands after the closing fence.
        view.dispatch({ selection: view.state.selection })
        return true
      },
    },
  ]),
])
