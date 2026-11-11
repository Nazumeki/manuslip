import { type Nodes as MarkdownNode, plainText, type Root, semanticLimits } from '@manuslip/core'
import type { Element, Root as HastRoot, Nodes } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { defListHastHandlers } from 'mdast-util-definition-list'
import { defaultHandlers, type Handlers, type Options, toHast } from 'mdast-util-to-hast'
import { conventionHandlers, refreshTableOfContents } from './convention-handlers'
import { diagramSyntax } from './diagram'
import { extendedInlineHandlers } from './extended-inline'
import {
  type ProjectionChildren,
  type ProjectionDescription,
  type RenderedBlock,
  type RenderOptions,
  type RenderProjection,
  rendererVersion,
} from './index'
import { projectChildren } from './projection-children'
import { indexProjectionDefinitions } from './projection-definitions'
import { inTableCell, scopeTableCells } from './projection-table-context'
import { localImagePath, safeImage, safeLink } from './urls'

const widgetKinds = new Set([
  'defList',
  'footnoteReference',
  'footnoteDefinition',
  'table',
  'code',
  'math',
  'inlineMath',
  'image',
  'imageReference',
  'link',
  'linkReference',
  'html',
  'subscript',
  'superscript',
  'emoji',
])

export function isProjectionWidgetType(
  type: string,
  units = 0,
  lines = 1,
  ordered = false,
): boolean {
  return (
    widgetKinds.has(type) ||
    // Subsequent source markers do not determine an ordered list's rendered numbers.
    (type === 'list' && ordered) ||
    ((type === 'paragraph' || type === 'heading') && units > semanticLimits.editorInlineUnits) ||
    (type === 'heading' && lines > 2) ||
    // A multiline code span requires its enclosing paragraph's normalized HTML.
    (type === 'inlineCode' && lines > 1)
  )
}

// Most prose stays directly editable through Lezer decorations. Project an outer
// container only when that path cannot represent its complete semantic contents.
function projectionUnits(node: MarkdownNode): number {
  if (
    (node.type === 'paragraph' || node.type === 'heading') &&
    node.children.every(
      (child) =>
        child.type === 'text' &&
        child.position &&
        child.value.length ===
          (child.position.end.offset ?? 0) - (child.position.start.offset ?? 0),
    )
  )
    return 0
  return (node.position?.end.offset ?? 0) - (node.position?.start.offset ?? 0)
}

function compositeProjection(node: MarkdownNode): boolean {
  if (!['paragraph', 'heading', 'blockquote', 'list'].includes(node.type)) return false
  const structured = node.type === 'blockquote' || node.type === 'list'
  const pending: MarkdownNode[] = 'children' in node ? [...node.children] : []
  while (pending.length) {
    const child = pending.pop()
    if (!child) continue
    if (
      child.type === 'html' ||
      (child.type === 'list' && child.ordered) ||
      (child.type === 'inlineCode' &&
        child.position &&
        child.position.end.line > child.position.start.line) ||
      (structured &&
        ['code', 'table', 'math', 'defList', 'footnoteDefinition'].includes(child.type)) ||
      (isProjectionWidgetType(
        child.type,
        projectionUnits(child),
        (child.position?.end.line ?? 1) - (child.position?.start.line ?? 1) + 1,
      ) &&
        (child.type === 'paragraph' || child.type === 'heading'))
    )
      return true
    if ('children' in child) pending.push(...child.children)
  }
  return false
}

export function describeProjectionNode(node: MarkdownNode, options?: RenderOptions) {
  if (node.type === 'inlineCode') return undefined
  const from = node.position?.start.offset
  const to = node.position?.end.offset
  if (from === undefined || to === undefined) return undefined
  const lines = (node.position?.end.line ?? 1) - (node.position?.start.line ?? 1) + 1
  if (
    !isProjectionWidgetType(
      node.type,
      projectionUnits(node),
      lines,
      node.type === 'list' && !!node.ordered,
    ) &&
    !compositeProjection(node) &&
    !(
      node.data?.manuslipProjection &&
      ['paragraph', 'heading', 'blockquote', 'list', 'defList'].includes(node.type)
    )
  )
    return undefined
  const syntax =
    node.type === 'code' && options?.plugins?.mermaid !== false
      ? diagramSyntax(node.lang)
      : undefined
  return {
    key: `${from}:${to}`,
    description: {
      kind:
        node.type === 'imageReference'
          ? 'image'
          : node.type === 'linkReference'
            ? 'link'
            : syntax
              ? 'diagram'
              : (node.type as RenderedBlock['kind']),
      value: 'value' in node ? node.value : '',
      ...(node.type === 'footnoteDefinition' && node.data?.manuslipInlineFootnote
        ? { placement: 'after-document' as const }
        : {}),
      ...(syntax && syntax !== 'mermaid' ? { syntax } : {}),
    },
  }
}

export function applyProjectionPolicy(element: Element, listStart?: number): void {
  // Pair note references with a semantic footer so HTML consumers can resolve them.
  if (element.tagName === 'section' && Object.hasOwn(element.properties, 'dataFootnotes'))
    element.properties.role = 'doc-endnotes'
  if (element.tagName === 'a' && Object.hasOwn(element.properties, 'dataFootnoteBackref'))
    element.properties.role = 'doc-backlink'
  // Each live definition has its own list wrapper. Preserve the footer's ordinal
  // in standard HTML so every rendering path keeps its first-reference number.
  if (
    listStart &&
    element.tagName === 'li' &&
    typeof element.properties.id === 'string' &&
    element.properties.id.startsWith('user-content-fn-')
  )
    element.properties.value = String(listStart)
  if (element.tagName === 'a' && typeof element.properties.href === 'string') {
    const safe = safeLink(element.properties.href)
    if (safe) element.properties.href = safe
    else delete element.properties.href
  }
  if (element.tagName === 'img' && typeof element.properties.src === 'string') {
    const safe = safeImage(element.properties.src)
    if (safe) element.properties.src = safe
    else {
      const remote = safeLink(element.properties.src)
      if (remote?.startsWith('https:')) element.properties.dataRemoteImage = remote
      else if (localImagePath(element.properties.src))
        element.properties.dataLocalImage = element.properties.src
      delete element.properties.src
    }
    element.properties.loading = 'lazy'
    element.properties.referrerPolicy = 'no-referrer'
  }
}

/** Shared public toHast policy for full and sequenced rendering. */
export function projectionOptions(options: RenderOptions, handlers: Handlers = {}): Options {
  return {
    allowDangerousHtml: options.rawHtml,
    footnoteLabel: options.footnotesLabel,
    footnoteBackLabel: (index, reference) =>
      `${options.footnoteBackLabel} ${index + 1}${reference > 1 ? `-${reference}` : ''}`,
    footnoteBackContent: (_index, reference) => [
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['markdown-icon', 'markdown-icon-backref'], ariaHidden: 'true' },
        children: [],
      },
      ...(reference > 1
        ? [
            {
              type: 'element' as const,
              tagName: 'sup',
              properties: {},
              children: [{ type: 'text' as const, value: String(reference) }],
            },
          ]
        : []),
    ],
    handlers: {
      ...defListHastHandlers,
      ...extendedInlineHandlers,
      ...conventionHandlers,
      ...handlers,
      html: (state, node: Extract<Root['children'][number], { type: 'html' }>) => {
        // A table cell uses a safe Markdown line break for Shift+Enter even
        // when general HTML rendering is disabled.
        if (inTableCell(state) && /^<br\s*\/?\s*>$/i.test(node.value)) {
          const result = { type: 'element' as const, tagName: 'br', properties: {}, children: [] }
          state.patch(node, result)
          return result
        }
        const result = options.rawHtml
          ? { type: 'raw' as const, value: node.value }
          : { type: 'text' as const, value: node.value }
        state.patch(node, result)
        return result
      },
    },
  }
}

export function projectWithHandlers(
  root: Root,
  options: RenderOptions,
  exportSlot?: (element: Element, description: ProjectionDescription) => void,
  decorate?: (tree: HastRoot) => void,
  handlers: Handlers = {},
  children?: ProjectionChildren,
  serialize?: (tree: HastRoot) => string,
): RenderProjection {
  const started = performance.now()
  const configured = { ...handlers }
  const bootstrap: Root = { type: 'root', children: [] }
  const rootHandler = configured.root ?? defaultHandlers.root
  // Bootstrap public State on an empty root, then index and render the original root.
  // The converter still owns handlers, references, footnote calls and its final footer.
  // @ts-expect-error: the public default root handler has the same special return type.
  configured.root = (state, node, parent) => {
    scopeTableCells(state)
    if (node === bootstrap) indexProjectionDefinitions(root, state)
    // state.all covers table cells (compiled by tableRow) and footer definitions too.
    if (children) projectChildren(state, children)
    return rootHandler(state, node === bootstrap ? root : node, parent)
  }
  const hast = toHast(bootstrap, projectionOptions(options, configured))
  if (hast.type !== 'root') throw new Error('Invalid semantic root')
  return projectHast(root, hast, options, exportSlot, decorate, started, serialize)
}

/** Apply the same URL/widget/serialization policy to a caller-admitted HAST fragment. */
export function projectHast(
  root: Root,
  hast: HastRoot,
  options: RenderOptions,
  exportSlot?: (element: Element, description: ProjectionDescription) => void,
  decorate?: (tree: HastRoot) => void,
  started = performance.now(),
  serialize?: (tree: HastRoot) => string,
): RenderProjection {
  const blocks = new Map<string, RenderedBlock>()
  const descriptions = new Map<string, ProjectionDescription>()
  const inlineFootnotes = root.children.some(
    (node) => node.type === 'footnoteDefinition' && node.data?.manuslipInlineFootnote,
  )
  const headingLabels = new Map<string, string>()
  const pending: MarkdownNode[] = [...root.children]
  while (pending.length) {
    const node = pending.pop()
    if (!node) break
    if ('children' in node) for (const child of node.children) pending.push(child)
    if (node.type === 'heading' && typeof node.data?.hProperties?.id === 'string')
      headingLabels.set(node.data.hProperties.id, plainText(node))
    const described = describeProjectionNode(node, options)
    if (described) descriptions.set(described.key, described.description)
  }
  const visit = (node: Nodes, listStart?: number): void => {
    if (node.type === 'element') {
      refreshTableOfContents(node, headingLabels)
      applyProjectionPolicy(node, listStart)
    }
    if ('children' in node) {
      let ordinal = 0
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'li') ordinal++
        visit(child, node.type === 'element' && node.tagName === 'ol' ? ordinal : undefined)
      }
    }
    const from = node.position?.start.offset
    const to = node.position?.end.offset
    const description =
      from === undefined || to === undefined ? undefined : descriptions.get(`${from}:${to}`)
    // The outer element wins (pre rather than code), with whole-document reference resolution.
    if (description && from !== undefined && to !== undefined) {
      if (node.type === 'element') exportSlot?.(node, description)
      const block = {
        ...description,
        ...(inlineFootnotes && description.kind === 'footnoteDefinition' && listStart
          ? { listStart }
          : {}),
        from,
        to,
        html: toHtml(node, { allowDangerousHtml: options.rawHtml }),
      }
      blocks.set(`${from}:${to}`, block)
    }
  }
  visit(hast)
  decorate?.(hast)
  return {
    html: serialize ? serialize(hast) : toHtml(hast, { allowDangerousHtml: options.rawHtml }),
    blocks: [...blocks.values()].sort((a, b) => a.from - b.from || b.to - a.to),
    renderMs: performance.now() - started,
    rendererVersion,
  }
}
