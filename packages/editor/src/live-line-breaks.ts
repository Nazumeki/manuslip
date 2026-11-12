const blockElements = new Set([
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'UL',
])

function structural(node: ChildNode | null): boolean {
  return node instanceof Element && blockElements.has(node.tagName)
}

/** Preserve prose whitespace in owned widget DOM without changing reading/export HTML. */
export function preserveProseWhitespace(container: HTMLElement): void {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!/[\r\n]|[ \t]{2,}/.test(node.textContent ?? '')) continue
    const parent = node.parentElement
    if (!parent || parent.closest('pre, code, svg, math, [role="math"]')) continue
    if (!parent.closest('p, h1, h2, h3, h4, h5, h6, li, dt, dd, a')) continue
    // Serializers also put newlines between block elements; those are not prose.
    if (
      !(node.textContent ?? '').trim() &&
      (structural(node.previousSibling) || structural(node.nextSibling))
    )
      continue
    texts.push(node as Text)
  }
  for (const text of texts) {
    // An explicit hard break already accounts for the following serialized newline.
    let value =
      text.previousSibling?.nodeName === 'BR' ? text.data.replace(/^(?:\r\n|\r|\n)/, '') : text.data
    if (structural(text.previousSibling)) value = value.replace(/^(?:\r\n|\r|\n)/, '')
    if (structural(text.nextSibling)) value = value.replace(/(?:\r\n|\r|\n)$/, '')
    const fragment = container.ownerDocument.createDocumentFragment()
    for (const [index, line] of value.split(/\r\n|\r|\n/).entries()) {
      if (index) {
        const br = container.ownerDocument.createElement('br')
        br.dataset.sourceBreak = ''
        fragment.append(br)
      }
      if (/[ \t]{2,}/.test(line)) {
        const prose = container.ownerDocument.createElement('span')
        prose.className = 'cm-live-prose-text'
        prose.textContent = line
        fragment.append(prose)
      } else fragment.append(container.ownerDocument.createTextNode(line))
    }
    text.replaceWith(fragment)
  }
}
