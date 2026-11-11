import type { Nodes } from 'mdast'
import type { Extension } from 'mdast-util-from-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkSmartypants from 'remark-smartypants'
import { unified } from 'unified'
import { SemanticLimitError, semanticLimits, utf8Bytes } from './contracts'
import { defaultMarkdownPlugins, type MarkdownPlugins, markdownPluginNames } from './conventions'
import { remarkDefinitionList } from './definition-list'
import { remarkDocumentHtml, removeDisclosureMarkup } from './document-html'
import { applyDocumentConventions, markDocumentProjections } from './document-transforms'
import { remarkExtendedInline } from './extended-markdown'
import { remarkHighlight } from './highlight'
import { normalizeInlineFootnotes, remarkInlineFootnotes } from './inline-footnotes'
import { remarkInlineMath } from './inline-math'
import { remarkLatexDelimiters } from './latex-delimiters'
import { compileMarkdownRoot } from './markdown-compile'
import { describeMarkdownRoot } from './parse'

function createProcessor(plugins: MarkdownPlugins, yamlClose: '---' | '...', smartypants: boolean) {
  const processor = unified()
    .data('settings', { _manuslipEventSpans: true })
    .use(remarkParse)
    .use(remarkGfm, { singleTilde: false })
    .use(
      remarkFrontmatter,
      plugins.typora
        ? [{ type: 'yaml', fence: { open: '---', close: yamlClose } }, 'toml']
        : ['toml'],
    )
    .use(remarkExtendedInline)
    .use(remarkInlineFootnotes)
    .use(remarkDocumentHtml)
    .use(remarkDefinitionList)
  if (plugins.latex) processor.use(remarkMath).use(remarkInlineMath).use(remarkLatexDelimiters)
  if (plugins.opt) processor.use(remarkHighlight)
  else
    processor.use(function () {
      const data = this.data()
      data.micromarkExtensions ??= []
      data.micromarkExtensions.push({ disable: { null: ['strikethrough'] } })
    })
  if (!plugins.github)
    processor.use(function () {
      const data = this.data()
      // GFM packages base extensions together with autolink literals. Keep ordinary
      // CommonMark <URI> autolinks; only the GitHub literal constructs are optional.
      data.micromarkExtensions = data.micromarkExtensions?.map((extension) => ({
        ...extension,
        ...(extension.text
          ? {
              text: Object.fromEntries(
                Object.entries(extension.text).map(([code, value]) => [
                  code,
                  (Array.isArray(value) ? value : value ? [value] : []).filter(
                    (construct) =>
                      !['emailAutolink', 'wwwAutolink', 'protocolAutolink'].includes(
                        construct.name ?? '',
                      ),
                  ),
                ]),
              ),
            }
          : {}),
      }))
      const withoutAutolinks = (extension: Extension | Extension[]): Extension | Extension[] =>
        Array.isArray(extension)
          ? (extension.map(withoutAutolinks) as Extension[])
          : { ...extension, transforms: undefined }
      data.fromMarkdownExtensions = data.fromMarkdownExtensions?.map(withoutAutolinks)
    })
  if (smartypants) processor.use(remarkSmartypants)
  return processor.freeze()
}

const processors = new Map<number, ReturnType<typeof createProcessor>>()

function yamlClosingFence(source: string): '---' | '...' {
  const opening = /^---[\t ]*(?:\r\n?|\n)/.exec(source)
  if (!opening) return '---'
  // Select the first terminator, so a later thematic break cannot swallow prose
  // following a YAML document-end marker. Source and all offsets stay untouched.
  const fence = /^(---|\.\.\.)[\t ]*\r?$/gm
  fence.lastIndex = opening[0].length
  return fence.exec(source)?.[1] === '...' ? '...' : '---'
}

/** Desktop convention policy. The lower-level parseMarkdown API retains the fixed
 * canonical grammar used by the experimental compiler and its differential proofs.
 */
export function parseDocumentMarkdown(
  source: string,
  plugins: MarkdownPlugins = defaultMarkdownPlugins,
) {
  if (utf8Bytes(source) > semanticLimits.previewBytes)
    throw new SemanticLimitError('Document exceeds Live Preview size limit')
  const started = performance.now()
  const yamlClose = plugins.typora ? yamlClosingFence(source) : '---'
  // Retext tokenizes the complete prose even when no punctuation can change.
  // Keep entities and escapes conservative: they can decode into punctuation.
  const smartypants = /["'`&\\]|--|\.\s*\.\s*\./.test(source)
  const key =
    Number(plugins.opt) +
    2 * Number(plugins.latex) +
    4 * Number(plugins.github) +
    8 * Number(plugins.typora) +
    16 * Number(yamlClose === '...') +
    32 * Number(smartypants)
  let processor = processors.get(key)
  if (!processor) {
    processor = createProcessor(plugins, yamlClose, smartypants)
    processors.set(key, processor)
  }
  const root = compileMarkdownRoot(source, { processor, gfm: true, autolinks: plugins.github })
  removeDisclosureMarkup(root)
  normalizeInlineFootnotes(root)
  applyDocumentConventions(root, source, plugins)
  // Snapshot text values so transformed typography gets a semantic Live widget,
  // while all unaffected prose remains directly editable.
  const values = new Map<Nodes, string>()
  const pending: Nodes[] = [root]
  while (pending.length) {
    const node = pending.pop()
    if (!node) continue
    if (node.type === 'text') values.set(node, node.value)
    if ('children' in node) pending.push(...node.children)
  }
  processor.runSync(root)
  for (const [node, value] of values)
    if (node.type === 'text' && node.data?.manuslipLiteralHtml) node.value = value
  for (const [node, value] of values)
    if (node.type === 'text' && node.value !== value)
      node.data = { ...node.data, manuslipProjection: true }
  markDocumentProjections(root)
  const document = describeMarkdownRoot(
    root,
    source,
    `document-v5/${markdownPluginNames.map((name) => Number(plugins[name])).join('')}`,
    started,
    performance.now(),
  )
  // Inline definitions live at the root footer; editor identities still follow source order.
  document.blocks.sort((a, b) => a.from - b.from || b.to - a.to)
  return document
}
