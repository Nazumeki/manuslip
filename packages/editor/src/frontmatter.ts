import { Facet, StateField, type Text } from '@codemirror/state'
import { defaultMarkdownPlugins } from '@manuslip/core/conventions'

/** Matches the desktop Typora convention independently of the semantic worker. */
export const yamlFrontmatter = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? defaultMarkdownPlugins.typora,
})

function metadataEnd(doc: Text, yaml: boolean): number {
  const fence = doc.line(1).text.match(/^(---|\+\+\+)[\t ]*$/)?.[1]
  if (!fence || (fence === '---' && !yaml) || doc.lines < 2) return 0
  let offset = doc.line(1).to + 1
  for (const line of doc.iterLines(2)) {
    const closing = line.replace(/[\t ]+$/, '')
    if (closing === fence || (fence === '---' && closing === '...')) return offset + line.length
    offset += line.length + 1
  }
  // An unclosed opening fence is ordinary Markdown, matching the semantic parser.
  return 0
}

/** Keep metadata literal in live mode without copying the document or styling its contents. */
export const frontmatterEnd = StateField.define<number>({
  create: (state) => metadataEnd(state.doc, state.facet(yamlFrontmatter)),
  update: (end, transaction) => {
    const yaml = transaction.state.facet(yamlFrontmatter)
    if (yaml !== transaction.startState.facet(yamlFrontmatter))
      return metadataEnd(transaction.newDoc, yaml)
    if (!transaction.docChanged) return end
    if (end && !transaction.changes.touchesRange(0, end)) return end
    return metadataEnd(transaction.newDoc, yaml)
  },
})
