import { parseMarkdown } from '@manuslip/core'
import { describe, expect, it } from 'vitest'
import { renderMarkdown, safeImage, safeLink } from '../../src/index'
import { localImagePath } from '../../src/urls'

const options = { rawHtml: false, footnotesLabel: 'Footnotes', footnoteBackLabel: 'Back' }
describe('shared rendering policy', () => {
  it.each(['**a<br />b**', '*a<br>b*', '[a<br />b](https://example.test)', '**a*<br />*b**'])(
    'renders a safe break inside formatted table content: %s',
    (cell) => {
      const source = `| Header |\n| -- |\n| ${cell} |\n\n**outside<br />text**`
      const output = renderMarkdown(parseMarkdown(source).root, options)
      expect(output.html.match(/<br>/g)).toHaveLength(1)
      expect(output.html).toContain('outside&#x3C;br />text')
    },
  )

  it('keeps attributed breaks literal even inside formatted table content', () => {
    const source = '| Header |\n| -- |\n| **a<br onclick="alert(1)">b** |'
    const output = renderMarkdown(parseMarkdown(source).root, options)
    expect(output.html).not.toContain('<br')
    expect(output.html).toContain('&#x3C;br')
  })

  it('renders table line breaks safely while keeping other HTML literal', () => {
    const source = '| Header |\n| -- |\n| a<br />b<br>c<img src="https://example.test/x"> |'
    const output = renderMarkdown(parseMarkdown(source).root, options)
    expect(output.html).toContain('a<br>b<br>c')
    expect(output.html).toContain('&#x3C;img')
    expect(output.html).not.toContain('<img')
    expect(renderMarkdown(parseMarkdown('a<br>b').root, options).html).toContain('&#x3C;br>')
  })
  it('projects ordered lists with semantic numbering, both delimiters and nested contents', () => {
    const source =
      '3. first\n1. second\n9. third\n\n0) zero\n0) one\n\n- Outer\n\n  7. nested\n  1. next'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    const lists = result.blocks.filter((block) => block.kind === 'list')
    expect(lists[0]?.html).toBe(
      '<ol start="3">\n<li>first</li>\n<li>second</li>\n<li>third</li>\n</ol>',
    )
    expect(lists[1]?.html).toBe('<ol start="0">\n<li>zero</li>\n<li>one</li>\n</ol>')
    expect(lists[2]?.html).toContain('<ul>\n<li>\n<p>Outer</p>\n<ol start="7">')
    expect(source.slice(lists[0]?.from, lists[0]?.to)).toBe('3. first\n1. second\n9. third')
    expect(
      renderMarkdown(parseMarkdown('> 3. first\n> 1. second').root, options).blocks[0]?.kind,
    ).toBe('blockquote')
  })
  it('projects multiline code spans and headings with CommonMark whitespace normalization', () => {
    const source = 'Heading first\nsecond\n======\n\nCode ` first\nsecond ` after.'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    expect(result.blocks.find((block) => block.kind === 'heading')?.html).toBe(
      '<h1>Heading first\nsecond</h1>',
    )
    expect(result.blocks.find((block) => block.kind === 'paragraph')?.html).toBe(
      '<p>Code <code>first second</code> after.</p>',
    )
  })
  it('projects complete long paragraphs without dropping formatting or code literals', () => {
    const source = `${'word '.repeat(7000)}**strong** and \`literal &amp;\``
    const result = renderMarkdown(parseMarkdown(source).root, options)
    const paragraph = result.blocks.find((block) => block.kind === 'paragraph')
    expect(paragraph).toMatchObject({ from: 0, to: source.length, value: '' })
    expect(paragraph?.html).toContain('<strong>strong</strong>')
    expect(paragraph?.html).toContain('<code>literal &#x26;amp;</code>')
    expect(renderMarkdown(parseMarkdown('ordinary **text**').root, options).blocks).toEqual([])
    expect(renderMarkdown(parseMarkdown('plain '.repeat(7000)).root, options).blocks).toEqual([])
  })
  it('projects containers whose nested code and tables require semantic rendering', () => {
    const source =
      '> ```js\n> const quoted = 1\n> ```\n\n- Item\n\n    ```text\n    nested\n    ```'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    expect(
      result.blocks
        .filter((block) => ['blockquote', 'list'].includes(block.kind))
        .map((block) => block.html),
    ).toEqual([expect.stringContaining('<blockquote>'), expect.stringContaining('<li>')])
    expect(renderMarkdown(parseMarkdown('> Plain\n\n- [ ] Task').root, options).blocks).toEqual([])
  })
  it('projects positioned footnote calls and rich definitions with document numbering', () => {
    const source = 'First[^a] and again[^a].\n\n[^a]: A **rich** note with $x$.'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    const calls = result.blocks.filter((block) => block.kind === 'footnoteReference')
    expect(calls).toHaveLength(2)
    expect(
      calls.every(
        (block) => block.html.includes('data-footnote-ref') && block.html.includes('>1</a>'),
      ),
    ).toBe(true)
    const note = result.blocks.find((block) => block.kind === 'footnoteDefinition')
    expect(note?.html).toContain('<strong>rich</strong>')
    expect(source.slice(note?.from, note?.to)).toBe('[^a]: A **rich** note with $x$.')
  })
  it('projects inline HTML with its enclosing paragraph and the selected HTML policy', () => {
    const root = parseMarkdown('Text <mark>highlight</mark>.').root
    const off = renderMarkdown(root, options).blocks.find((block) => block.kind === 'paragraph')
    const on = renderMarkdown(root, { ...options, rawHtml: true }).blocks.find(
      (block) => block.kind === 'paragraph',
    )
    expect(off?.html).toContain('&#x3C;mark>')
    expect(on?.html).toBe('<p>Text <mark>highlight</mark>.</p>')
  })
  it('projects resolved links with formatted labels and the same URL policy as reading', () => {
    const source =
      '[**Guide**](https://example.invalid/guide "Title") [relative](guide.md) [reference][manual] <https://example.invalid/auto> [unsafe](javascript:bad) [missing][unknown]\n\n[manual]: https://example.invalid/manual'
    const rendered = renderMarkdown(parseMarkdown(source).root, options)
    const links = rendered.blocks.filter((block) => block.kind === 'link')
    expect(links.map((block) => source.slice(block.from, block.to))).toEqual([
      '[**Guide**](https://example.invalid/guide "Title")',
      '[relative](guide.md)',
      '[reference][manual]',
      '<https://example.invalid/auto>',
      '[unsafe](javascript:bad)',
    ])
    expect(links.map((block) => block.html)).toEqual([
      '<a href="https://example.invalid/guide" title="Title"><strong>Guide</strong></a>',
      '<a>relative</a>',
      '<a href="https://example.invalid/manual">reference</a>',
      '<a href="https://example.invalid/auto">https://example.invalid/auto</a>',
      '<a>unsafe</a>',
    ])
  })
  it('renders definition terms and rich descriptions through the shared safe policy', () => {
    const source =
      'Term *界* :smile:\n: First **description**.\n\n    Second with ~2~ and [link](javascript:bad).\n\nNext\n: Last.\n'
    const rendered = renderMarkdown(parseMarkdown(source).root, options)
    expect(rendered.html).toContain('<dl>')
    expect(rendered.html).toContain('<dt>Term <em>界</em>')
    expect(rendered.html).toContain('<dd>')
    expect(rendered.html).toContain('<strong>description</strong>')
    expect(rendered.html).toContain('Second with <sub>2</sub> and <a>link</a>')
    expect(rendered.html).not.toContain('javascript:')
    const definition = rendered.blocks.find((block) => block.kind === 'defList')
    expect(source.slice(definition?.from, definition?.to)).toBe(source)
  })
  it('renders positioned scripts and offline emoji with literal code, URLs and safe HTML', () => {
    const source =
      'H~2~O x^**2**^ ~a^b^:smile:~ :+1: `:smile: ^x^` [docs](https://example.test/:smile:) ^<img/src=x/onerror=bad>^'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    expect(result.html).toContain('H<sub>2</sub>O x<sup><strong>2</strong></sup>')
    expect(result.html).toContain(
      '<sub>a<sup>b</sup><span class="md-emoji" title=":smile:">😄</span></sub>',
    )
    expect(result.html).toContain('<span class="md-emoji" title=":+1:">👍</span>')
    expect(result.html).toContain('<code>:smile: ^x^</code>')
    expect(result.html).toContain('href="https://example.test/:smile:"')
    expect(result.html).toContain('<sup>&#x3C;img/src=x/onerror=bad></sup>')
    expect(result.html).not.toContain('<img')
    const widgets = result.blocks.filter((block) =>
      ['subscript', 'superscript', 'emoji'].includes(block.kind),
    )
    expect(widgets.map((block) => source.slice(block.from, block.to))).toEqual([
      '~2~',
      '^**2**^',
      '~a^b^:smile:~',
      '^b^',
      ':smile:',
      ':+1:',
      '^<img/src=x/onerror=bad>^',
    ])
  })
  it('projects Mermaid fences with original source ranges while ordinary code stays code', () => {
    const source = '# Start\n\n```MeRmAiD\nflowchart LR\nA-->B\n```\n\n```js\nconst x = 1\n```'
    const result = renderMarkdown(parseMarkdown(source).root, options)
    const diagram = result.blocks.find((block) => block.kind === 'diagram')
    expect(diagram?.value).toBe('flowchart LR\nA-->B')
    expect(diagram?.html).toContain('language-MeRmAiD')
    expect(source.slice(diagram?.from, diagram?.to)).toBe('```MeRmAiD\nflowchart LR\nA-->B\n```')
    expect(result.blocks.filter((block) => block.kind === 'code')).toHaveLength(1)
  })
  it('projects relative image references without emitting a browser source URL', () => {
    const result = renderMarkdown(
      parseMarkdown('![Local](assets/a%20b.png)\n\n![Shared](../shared.png)').root,
      options,
    )
    expect(result.html).toContain('data-local-image="assets/a%20b.png"')
    expect(result.html).toContain('data-local-image="../shared.png"')
    expect(result.html).not.toContain('src=')
  })
  it.each([
    'C:/secret.png',
    'a.png:secret',
    '//server/a.png',
    '/root/a.png',
    'file:///a.png',
    '%2Fsecret.png',
    'assets%5Csecret.png',
    'a%00.png',
    '%invalid',
  ])('rejects non-relative asset reference %s', (reference) => {
    expect(localImagePath(reference)).toBeNull()
  })
  it('decodes a local reference once and leaves containment to the authorized reader', () => {
    expect(localImagePath('../images/%E5%9B%BE%20%231.png#fragment')).toBe('../images/图 #1.png')
    expect(localImagePath('%252e%252e/a.png')).toBe('%2e%2e/a.png')
  })
  it('renders GFM tables and global references through the complete root', () => {
    const source =
      '| Key | Value |\n| --- | --- |\n| [label][ref] | **bold** |\n\n[ref]: https://example.com/path\n'
    const output = renderMarkdown(parseMarkdown(source).root, options)
    expect(output.html).toContain('<table>')
    expect(output.html).toContain('href="https://example.com/path"')
    expect(output.blocks[0]?.html).toContain('href="https://example.com/path"')
    const changed = renderMarkdown(
      parseMarkdown(source.replace('example.com/path', 'example.com/changed')).root,
      options,
    )
    expect(changed.blocks[0]?.html).toContain('example.com/changed')
    expect(changed.blocks[0]?.html).not.toContain('example.com/path')
  })
  it('escapes raw HTML by default and requires sanitization even when opted in', () => {
    const root = parseMarkdown('<script>alert(1)</script>\n\nText <em>raw</em>').root
    const escaped = renderMarkdown(root, options).html
    expect(escaped).not.toContain('<script>')
    expect(escaped).toContain('&#x3C;script>')
    expect(renderMarkdown(root, { ...options, rawHtml: true }).html).toContain('<script>')
  })
  it('never emits ambient remote-image requests or executable link schemes', () => {
    const root = parseMarkdown(
      '![remote](https://example.com/image.png)\n\n[bad](javascript:alert%281%29)\n\n[local](file:///secret)',
    ).root
    const html = renderMarkdown(root, options).html
    expect(html).toContain('data-remote-image="https://example.com/image.png"')
    expect(html).not.toContain('src="https:')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="file:')
  })
  it.each([
    'javascript:alert(1)',
    'file:///secret',
    'vbscript:test',
    'http://example.com',
    'https://user:password@example.com',
    '//example.com',
    '/etc/passwd',
  ])('blocks unsafe URL %s', (value) => {
    expect(safeLink(value)).toBeNull()
    expect(safeImage(value)).toBeNull()
  })
  it('permits HTTPS links and bounded raster data images, never executable SVG data', () => {
    expect(safeLink('https://example.com')).toBe('https://example.com/')
    expect(safeLink('#note')).toBe('#note')
    expect(safeImage('data:image/png;base64,YQ==')).toBe('data:image/png;base64,YQ==')
    expect(safeImage('data:image/svg+xml,<svg onload="alert(1)"/>')).toBeNull()
  })
})
