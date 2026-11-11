import { describe, expect, it } from 'vitest'
import { defaultMarkdownPlugins } from '../../src/conventions'
import { parseDocumentMarkdown } from '../../src/document-markdown'
import { plainText } from '../../src/semantic-description'

describe('document conventions', () => {
  it.each(['$ x$', '$x $', '$x$1', '$x\\$', '$\tx$'])(
    'keeps invalid Typora single-dollar boundaries literal: %j',
    (source) =>
      expect(
        parseDocumentMarkdown(source).blocks.some((block) => block.kind === 'inlineMath'),
      ).toBe(false),
  )
  it.each(['$x$', '$a\\$b$', '$x + y$', '$x\ny$', '$\\frac{1}{2}$'])(
    'preserves complete Typora inline math and its source range: %j',
    (source) => {
      const document = parseDocumentMarkdown(source)
      expect(document.blocks.find((block) => block.kind === 'inlineMath')).toMatchObject({
        from: 0,
        to: source.length,
      })
    },
  )
  it.each(['H~long\\ text~', 'x^long\\ text^'])(
    'renders escaped script spaces without changing source positions: %j',
    (source) => {
      const document = parseDocumentMarkdown(source)
      expect(plainText(document.root)).toBe(`${source[0]}long text`)
      expect(
        document.blocks.some((block) => block.kind === 'subscript' || block.kind === 'superscript'),
      ).toBe(true)
      expect(document.counts.characters).toBe([...source].length)
    },
  )
  it('enables the requested plugins by default', () => {
    expect(defaultMarkdownPlugins).toEqual({
      opt: true,
      latex: true,
      mermaid: true,
      github: false,
      typora: false,
    })
  })
  it('keeps basic extensions independent of optional plugins', () => {
    const source =
      '| A | B |\n| :- | -: |\n| one | two |\n\n- [x] Done\n\n~~gone~~ H~2~O x^2^ [^n]\n\n[^n]: Note'
    const document = parseDocumentMarkdown(source, {
      opt: false,
      latex: false,
      mermaid: false,
      github: false,
      typora: false,
    })
    for (const kind of [
      'table',
      'list',
      'footnoteDefinition',
      'footnoteReference',
      'subscript',
      'superscript',
    ])
      expect(
        document.blocks.some((block) => block.kind === kind),
        kind,
      ).toBe(true)
    expect(JSON.stringify(document.root)).not.toContain('"type":"delete"')
    expect(plainText(document.root)).toContain('~~gone~~')
  })
  it('toggles highlight and strikethrough together without changing code or scripts', () => {
    const source = '==**marked**== ~~**gone**~~ H~2~O x^2^ `~~code~~ ==code==` \\~~literal~~'
    for (const opt of [false, true, false, true]) {
      const document = parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, opt })
      const root = JSON.stringify(document.root)
      expect(root.includes('"type":"delete"')).toBe(opt)
      expect(root.includes('"hName":"mark"')).toBe(opt)
      expect(document.blocks.some((block) => block.kind === 'subscript')).toBe(true)
      expect(document.blocks.some((block) => block.kind === 'superscript')).toBe(true)
      expect(plainText(document.root)).toContain('~~code~~ ==code==')
      expect(plainText(document.root)).toContain('~~literal~~')
      expect(document.counts.characters).toBe([...source].length)
    }
  })
  it.each([
    ['&quot;Hello&quot; &apos;world&apos;', '“Hello” ‘world’'],
    ['\\"Hello\\"', '“Hello”'],
    ['Wait . . .', 'Wait …'],
    ['Hello -- world', 'Hello — world'],
  ])(
    'keeps smart punctuation after plain prose without reusing its processor: %j',
    (source, text) => {
      for (let index = 0; index < 2; index++) {
        expect(plainText(parseDocumentMarkdown('Plain prose.').root)).toBe('Plain prose.')
        expect(plainText(parseDocumentMarkdown(source).root)).toBe(text)
      }
    },
  )
  it.each(
    ['\n', '\r\n'].flatMap((newline) => ['---', '...'].map((closing) => ({ newline, closing }))),
  )(
    'recognizes YAML metadata only with Typora enabled: $closing with $newline',
    ({ newline, closing }) => {
      const metadata = [
        '---',
        'title: "**literal** -- ..."',
        'tags: [writing, reading]',
        'summary: |',
        '  ==Highlight== $x^2$ [TOC]',
        closing,
      ].join(newline)
      const source = `${metadata}${newline}${newline}# Actual heading${newline}${newline}Body.`
      // Alternate configurations to catch processor reuse across Typora toggles.
      for (const typora of [false, true, false, true]) {
        const document = parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, typora })
        const node = document.root.children[0]
        expect(node?.type).toBe(typora ? 'yaml' : 'thematicBreak')
        expect(document.blocks.some((block) => block.kind === 'yaml')).toBe(typora)
        if (typora) {
          expect(node?.type === 'yaml' && node.value).toBe(
            metadata.split(newline).slice(1, -1).join(newline),
          )
          expect(node?.position?.end.offset).toBe(metadata.length)
          expect(document.outline.map((heading) => heading.text)).toEqual(['Actual heading'])
          expect(document.counts.words).toBe(3)
        }
      }
    },
  )
  it.each([
    { closing: '...', later: '---' },
    { closing: '---', later: '...' },
  ])('ends YAML at the first $closing before a later $later', ({ closing, later }) => {
    const header = `--- \t\ntitle: Test\n${closing} \t`
    const source = `${header}\n# Heading\n\nBody\n\n${later}`
    const document = parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, typora: true })
    const metadata = document.root.children[0]
    expect(metadata?.type).toBe('yaml')
    expect(metadata?.type === 'yaml' && metadata.value).toBe('title: Test')
    expect(metadata?.position?.end.offset).toBe(header.length)
    expect(document.outline.map((heading) => heading.text)).toEqual(['Heading'])
    expect(plainText(document.root)).toContain('Body')
  })
  it('retains TOML metadata independently of the Typora plugin', () => {
    const source = '+++\ntitle = "**literal**"\n+++\n\n# Heading'
    for (const typora of [false, true, false]) {
      const document = parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, typora })
      expect(document.root.children[0]?.type).toBe('toml')
      expect(document.outline.map((heading) => heading.text)).toEqual(['Heading'])
    }
  })
  it.each([
    '---\nUnclosed **Markdown**',
    'Paragraph\n\n---\ntitle: **Markdown**\n---',
    '> ---\n> title: **Markdown**\n> ---',
    '```yaml\n---\ntitle: **Markdown**\n---\n```',
  ])('keeps non-metadata fences as ordinary Markdown: %j', (source) => {
    const document = parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, typora: true })
    expect(document.blocks.some((block) => block.kind === 'yaml')).toBe(false)
  })
  it('applies smart punctuation to prose while preserving code, math and destinations', () => {
    const document = parseDocumentMarkdown(
      '"Hello" -- isn\'t it... `"code" --` $x--y$ [link](https://example.invalid/a--b)',
    )
    expect(plainText(document.root)).toContain('“Hello” — isn’t it…')
    expect(JSON.stringify(document.root)).toContain('https://example.invalid/a--b')
    expect(JSON.stringify(document.root)).toContain('x--y')
    expect(JSON.stringify(document.root)).toContain('\\"code\\" --')
  })
  it('uses semantic heading attributes and deterministic anchors', () => {
    const document = parseDocumentMarkdown(
      '# Hello {#greeting .wide}\n\n## Hello\n\n## Hello\n\nTitle {.subtitle}\n---',
    )
    const headings = document.root.children.filter((node) => node.type === 'heading')
    expect(document.outline.map((heading) => heading.text)).toEqual([
      'Hello',
      'Hello',
      'Hello',
      'Title',
    ])
    expect(headings[0]?.data?.hProperties).toEqual({ id: 'greeting', className: ['wide'] })
    expect(headings[1]?.data?.hProperties?.id).toBe('hello')
    expect(headings[2]?.data?.hProperties?.id).toBe('hello-1')
  })
  it('reserves later explicit IDs and suffixes duplicate anchors without collisions', () => {
    const document = parseDocumentMarkdown(
      '# Hello\n\n# Later {#hello}\n\n# Duplicate {#hello}\n\n# Hello\n\n# Hello {#hello-2}',
    )
    expect(document.outline.map((heading) => heading.id)).toEqual([
      'hello-1',
      'hello',
      'hello-3',
      'hello-4',
      'hello-2',
    ])
  })
  it('leaves literal autolinks off until GitHub is enabled', () => {
    const source =
      'https://example.invalid/a_(b). www.example.invalid user@example.invalid <https://example.invalid>'
    expect(
      parseDocumentMarkdown(source).blocks.filter((block) => block.kind === 'link'),
    ).toHaveLength(1)
    expect(
      parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, github: true }).blocks.filter(
        (block) => block.kind === 'link',
      ),
    ).toHaveLength(4)
  })
  it('parses nested highlights without changing code or escaped markers', () => {
    const source = '==**bold** and `a==b`== \\==literal== `==code==`\n\n~~~\n==fenced==\n~~~'
    const root = parseDocumentMarkdown(source).root
    const first = root.children[0]
    expect(first?.type === 'paragraph' && first.children[0]?.data?.hName).toBe('mark')
    expect(plainText(root)).toContain('bold and a==b ==literal== ==code==')
    expect(root.children[1]?.type === 'code' && root.children[1].value).toBe('==fenced==')
  })
  it('handles multiline highlights and literal unmatched or overlong markers', () => {
    const root = parseDocumentMarkdown(
      '==first\nsecond==\n\n===literal===\n\n== unfinished\n\n==open',
    ).root
    const first = root.children[0]
    expect(first?.type === 'paragraph' && first.children[0]?.data?.hName).toBe('mark')
    expect(plainText(root)).toContain('first\nsecond')
    expect(plainText(root)).toContain('===literal===')
    expect(plainText(root)).toContain('== unfinished')
    expect(plainText(root)).toContain('==open')
  })
  it('keeps multiline bracket math literal inside nested containers and code', () => {
    const document = parseDocumentMarkdown(
      '> \\[\n> a + b\n> \\]\n\n- \\(x + y\\)\n\n`\\(literal\\)`\n\n\\\\(escaped\\\\)',
    )
    const quote = document.root.children[0]
    expect(
      quote?.type === 'blockquote' &&
        quote.children[0]?.type === 'math' &&
        quote.children[0].value.trim(),
    ).toBe('a + b')
    expect(document.blocks.filter((block) => block.kind === 'inlineMath')).toHaveLength(1)
    expect(plainText(document.root)).toContain('\\(literal\\)')
  })
  it.each(['$x^2$', '\\(x^2\\)', '\\[x^2\\]', '$$\nx^2\n$$', '```math\nx^2\n```'])(
    'recognizes math notation %s',
    (source) => {
      expect(
        parseDocumentMarkdown(source).blocks.some((block) =>
          ['math', 'inlineMath'].includes(block.kind),
        ),
      ).toBe(true)
      expect(
        parseDocumentMarkdown(source, { ...defaultMarkdownPlugins, latex: false }).blocks.some(
          (block) => ['math', 'inlineMath'].includes(block.kind),
        ),
      ).toBe(false)
    },
  )
})
