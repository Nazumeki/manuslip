import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { latexMarkdown } from './conventions'
import { yamlFrontmatter } from './frontmatter'

/** Finish an existing block-opening gesture in Live Preview. Source mode keeps
 * literal fence entry. Only an empty tail is eligible, so existing text or a
 * closing fence can never be duplicated or absorbed by this command.
 */
export function blockOpeningTransaction(state: EditorState) {
  const selection = state.selection.main
  if (state.readOnly || state.selection.ranges.length !== 1 || !selection.empty) return null
  const line = state.doc.lineAt(selection.head)
  if (selection.head !== line.to || line.to !== state.doc.length) return null
  if (!syntaxTreeAvailable(state, line.to)) return null
  // A closing fence (or a fence-looking line in code) is not another opener.
  let node = syntaxTree(state).resolveInner(line.from, 1)
  for (;;) {
    if (node.name === 'HTMLBlock' || node.name === 'CommentBlock') return null
    if (node.name === 'FencedCode' && node.from < line.from) return null
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
    closing = '$$'
  }
  if (
    !closing &&
    line.number === 1 &&
    state.facet(yamlFrontmatter) &&
    /^---[ \t]*$/.test(line.text)
  )
    closing = '---'
  if (!closing) return null
  return state.update({
    changes: { from: selection.head, insert: `\n\n${closing}` },
    selection: { anchor: selection.head + 1 },
    userEvent: 'input.type',
    scrollIntoView: true,
  })
}

export const liveMarkdownInput = Prec.high(
  keymap.of([
    {
      key: 'Enter',
      run(view) {
        if (view.compositionStarted) return false
        const transaction = blockOpeningTransaction(view.state)
        if (!transaction) return false
        view.dispatch(transaction)
        return true
      },
    },
  ]),
)
