import { utf8Bytes } from '@manuslip/core/text'
import { diagramLimits } from '@manuslip/renderer/diagram'
import { diagramSourceLocator } from '@manuslip/renderer/diagram-source'
import { restoreLegacyLabelFragments } from '@manuslip/renderer/legacy-diagram'
import createDOMPurify from 'dompurify'

const presentation = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-opacity',
  'stroke-opacity',
  'opacity',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'color',
]
/** Freeze Mermaid's own CSS into an inert SVG without style blocks or foreign HTML. */
export function flattenDiagram(
  markup: string,
  legacyFlowchart = false,
  source?: string,
  nodes?: ReadonlyMap<string, string>,
): string {
  if (utf8Bytes(markup) > diagramLimits.svg) throw new Error('diagram-limit')
  const purifier = createDOMPurify(window)
  const fragment = purifier.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: false },
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: [
      'foreignObject',
      'image',
      'a',
      'animate',
      'animateMotion',
      'animateTransform',
      'set',
      'script',
      'iframe',
    ],
  })
  const svg = fragment.querySelector('svg')
  if (!svg) throw new Error('diagram-render')
  const elements = [...svg.querySelectorAll('*')]
  if (
    elements.length > diagramLimits.elements ||
    svg.querySelectorAll(
      '.node, .actor, .actor-bottom, .task, .slice, .stateGroup, .classGroup, .entityBox, .mindmap-node',
    ).length > diagramLimits.nodes
  )
    throw new Error('diagram-limit')
  // Mermaid's inline max-width is removed with its CSS below. Keep the natural
  // viewport dimensions so a narrow diagram is not enlarged to fill the editor.
  const viewport = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  if (
    viewport?.length === 4 &&
    viewport.every(Number.isFinite) &&
    (viewport[2] ?? 0) > 0 &&
    (viewport[3] ?? 0) > 0
  ) {
    svg.setAttribute('width', String(viewport[2]))
    svg.setAttribute('height', String(viewport[3]))
  }
  if (legacyFlowchart) {
    for (const label of svg.querySelectorAll('text, title, desc')) {
      if (label.parentElement?.closest('text, title, desc')) continue
      const text = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
      const nodes: Node[] = []
      for (let node = text.nextNode(); node; node = text.nextNode()) nodes.push(node)
      const restored = restoreLegacyLabelFragments(nodes.map((node) => node.textContent ?? ''))
      for (const [index, node] of nodes.entries()) node.textContent = restored[index] ?? ''
    }
  }
  if (source) {
    const locate = diagramSourceLocator(source)
    for (const text of svg.querySelectorAll('text')) {
      const node = text.closest('.node')
      const id = node && nodes?.get(node.id)
      const range = locate(text.textContent ?? '', id ?? undefined)
      if (!range) continue
      for (const element of node ? [text, node] : [text]) {
        element.setAttribute('data-source-from', String(range.from))
        element.setAttribute('data-source-to', String(range.to))
      }
    }
  }
  const container = document.querySelector('#diagrams')
  if (!container) throw new Error('diagram-render')
  container.replaceChildren(svg)
  for (const element of [svg, ...elements]) {
    if (element.tagName.toLowerCase() === 'style') continue
    const computed = getComputedStyle(element)
    for (const attribute of presentation) {
      const value = computed.getPropertyValue(attribute).trim()
      if (
        value &&
        value.length <= 256 &&
        !/[<>\\;{}]/.test(value) &&
        !/url\s*\(|@|expression/i.test(value)
      )
        element.setAttribute(attribute, value)
    }
    for (const attribute of ['marker-start', 'marker-mid', 'marker-end']) {
      const marker = computed.getPropertyValue(attribute).match(/#([a-z0-9_-]+)["']?\)$/i)?.[1]
      if (marker) element.setAttribute(attribute, `url(#${marker})`)
    }
  }
  for (const element of [svg, ...elements]) {
    element.removeAttribute('style')
    element.removeAttribute('class')
  }
  for (const style of svg.querySelectorAll('style')) style.remove()
  return svg.outerHTML
}
