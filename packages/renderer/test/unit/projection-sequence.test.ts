import type { Nodes, Root } from 'mdast'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../../core/src/parse'
import examples from '../../../core/test/fixtures/commonmark-0.31.2/spec.json'
import { type RenderedBlock, type RenderOptions, renderMarkdown } from '../../src/index'
import { projectHast } from '../../src/projection-engine'
import { renderProjectionLayout } from '../../src/projection-layout'
import { type ProjectionDefinition, ProjectionSequence } from '../../src/projection-sequence'

const options: RenderOptions = {
  rawHtml: false,
  footnotesLabel: 'Notes 世界',
  footnoteBackLabel: 'Back 返回',
}

it.each([false, true])(
  'preserves formatted table breaks through sequenced conversion (%s)',
  (cooperative) => {
    check(
      '| A |\n| -- |\n| **a<br />b** and [x<br>y](https://example.test) |\n\n**outside<br>text**',
      'manuslip',
      options,
      cooperative,
    )
  },
)
// Independent native input preparation for tests; packed context collection is separate.
function context(root: Root): ProjectionDefinition[] {
  const definitions: ProjectionDefinition[] = []
  const pending: Nodes[] = [...root.children].reverse()
  while (pending.length) {
    const node = pending.pop()
    if (!node) break
    if (node.type === 'definition' || node.type === 'footnoteDefinition') definitions.push(node)
    else if ('children' in node) pending.push(...[...node.children].reverse())
  }
  return definitions
}
function finish<T>(work: Generator<void, T>): T {
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
function check(
  text: string,
  syntax: 'commonmark' | 'manuslip' = 'manuslip',
  render = options,
  cooperative = false,
) {
  const document = parseMarkdown(text, syntax)
  const expected = renderProjectionLayout(document.root, render, 8 * 1024 * 1024)
  const unchanged = structuredClone(document.root)
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(document.root)
  const sequence = new ProjectionSequence(context(document.root), render)
  const html: string[] = []
  const blocks = new Map<string, RenderedBlock>()
  const spans: { from: number; to: number; visible: boolean }[] = []
  let at = 0
  let visible = false
  try {
    for (const node of document.root.children) {
      const converted = cooperative
        ? finish(sequence.convertSteps(node, { nodes: 800000, depth: 512 }))
        : undefined
      const chunk = converted
        ? {
            visible: converted.visible,
            projection: projectHast(
              converted.root,
              converted.hast,
              render,
              undefined,
              undefined,
              converted.started,
            ),
          }
        : sequence.render(node)
      if (chunk.visible) {
        if (visible) {
          html.push('\n')
          at++
        }
        const from = at
        html.push(chunk.projection.html)
        at += chunk.projection.html.length
        spans.push({ from, to: at, visible: true })
        visible = true
      } else spans.push({ from: at, to: at, visible: false })
      for (const block of chunk.projection.blocks) blocks.set(`${block.from}:${block.to}`, block)
    }
    const bodyEnd = at
    const footer = sequence.finish()
    html.push(footer.html)
    at += footer.html.length
    for (const block of footer.blocks) blocks.set(`${block.from}:${block.to}`, block)
    expect(html.join('')).toBe(expected.projection.html)
    expect([...blocks.values()].sort((a, b) => a.from - b.from || b.to - a.to)).toEqual(
      expected.projection.blocks,
    )
    expect({ blocks: spans, bodyEnd, htmlLength: at }).toEqual(expected.layout)
    expect(document.root).toEqual(unchanged)
    expect(() =>
      sequence.render(document.root.children[0] ?? { type: 'paragraph', children: [] }),
    ).toThrow('closed')
    expect(() => sequence.finish()).toThrow('closed')
  } finally {
    sequence.close()
  }
}

describe('public-state sequenced projection rendering', () => {
  it.each(['commonmark', 'manuslip'] as const)(
    'matches complete HTML, widgets and layout for every CommonMark fixture in %s',
    (syntax) => {
      for (const example of examples) check(example.markdown, syntax)
    },
  )
  it.each(['commonmark', 'manuslip'] as const)(
    'cooperative conversion matches complete CommonMark HTML, widgets and layout in %s',
    (syntax) => {
      for (const example of examples) check(example.markdown, syntax, options, true)
    },
  )
  const fixtures = [
    '```seq\r\nparticipant 用户 as U\r\nU->Service: 你好\r\n```\r\n\r\n```FLOW\r\na=>start: 开始\r\nb=>end: 完成\r\na->b\r\n```\r\n',
    'Term *界* :smile:\r\n: First **description**.\r\n\r\n    | A | B |\r\n    | - | - |\r\n    | : one | ^2^ |\r\n\r\nNext\r\n: Last [link][r].\r\n\r\n[r]: /target\r\n',
    'H~2~O x^**2**^ ~a^b^:smile:~ :+1:\r\n\r\n| A | B |\r\n| - | - |\r\n| ^界^ | :heart: |\r\n\r\nNote[^x].\r\n\r\n[^x]: ~note~ :smile:\r\n',
    '',
    '\ufeff',
    '\ufeff# title\r\n\r\nparagraph\r\n',
    '---\nheading: hidden\n---\n\n[r]: /first\n\n[a][r]\n\n[r]: /second\n\n![b][r]\n',
    '> [r]: /nested\n>\n> definition\n\n[a][r]\n\n[r]: /later\n',
    '[^x]: first note\n\n[^x]: duplicate note\n\nOne[^x].\n\nTwo[^x].\n',
    '[^unused]: ```mermaid\n    graph TD; A-->B\n    ```\n\nText only\n',
    'First[^a].\n\nSecond[^b] and again[^a].\n\n[^a]: A with [^c]\n\n[^b]: B with [^c] and [^a]\n\n[^c]: C with [^a]\n',
    'a[^x]\n\n[^x]: note\n\n    > [r]: /inside-note\n    >\n    > $x$ and ![a][r]\n\n[a][r]\n',
    'Repeated[^x] once\n\n---\n\nRepeated[^x] twice\n\n[^x]: nested **text** and <i>html</i>\n\n    ~~~MeRmAiD\n    graph TD; A-->B\n    ~~~\n',
    '| ![a](https://example.com/a.png) |\n| - |\n| $x$ |\n\n$$\ny^2\n$$\n',
    '- [x] task\n- [ ] task\n\n> > ```ts\n> > const x = 1\n> > ```\n',
    '<script>alert(1)</script>\n\n[a](javascript:alert(1)) ![](../../local.png) <i>x</i>\n',
    `# ${'界😀\ud800\udfff'.repeat(1000)}\n\nend\n`,
  ]
  it.each([false, true])(
    'preserves global definition and footnote semantics with rawHtml=%s',
    (rawHtml) => {
      for (const text of fixtures) check(text, 'manuslip', { ...options, rawHtml })
    },
  )
  it.each([false, true])(
    'cooperative conversion preserves definitions, notes, input and policy with rawHtml=%s',
    (rawHtml) => {
      for (const text of fixtures) check(text, 'manuslip', { ...options, rawHtml }, true)
    },
  )
  it('freezes request options before a sequence starts', () => {
    const render = { ...options }
    const root = parseMarkdown('raw <i>text</i>[^a]\n\n[^a]: note\n').root
    const expected = renderMarkdown(root, render)
    const sequence = new ProjectionSequence(context(root), render)
    render.rawHtml = true
    render.footnotesLabel = 'Changed'
    let html = ''
    let visible = false
    try {
      for (const node of root.children) {
        const chunk = sequence.render(node)
        if (chunk.visible) {
          html += `${visible ? '\n' : ''}${chunk.projection.html}`
          visible = true
        }
      }
      html += sequence.finish().html
      expect(html).toBe(expected.html)
    } finally {
      sequence.close()
    }
  })
  it('closes an abandoned sequence and rejects further conversion', () => {
    const sequence = new ProjectionSequence([], options)
    sequence.close()
    sequence.close()
    expect(() => sequence.render({ type: 'paragraph', children: [] })).toThrow('closed')
    expect(() => sequence.finish()).toThrow('closed')
  })
  it('closes after conversion failure instead of reusing partially updated counters', () => {
    const sequence = new ProjectionSequence([], options)
    const node: Root['children'][number] = { type: 'paragraph', children: [] }
    Object.defineProperty(node, 'children', {
      get() {
        throw new Error('Invalid input')
      },
    })
    expect(() => sequence.render(node)).toThrow('Invalid input')
    expect(() => sequence.finish()).toThrow('closed')
    expect(() => sequence.render({ type: 'paragraph', children: [] })).toThrow('closed')
  })
})

describe('cooperative native projection conversion ownership', () => {
  const limits = { nodes: 800000, depth: 512 }
  const paragraph = (): Root['children'][number] => ({
    type: 'paragraph',
    children: Array.from({ length: 200 }, (_, index) => ({
      type: 'strong',
      children: [{ type: 'text', value: `word ${index}` }],
    })),
  })
  it('retains the native admission order and bounds each resumed group', () => {
    const node = paragraph()
    const traces: string[][] = [[], []]
    let calls = 0,
      scratch = 0
    const sequences = traces.map((trace, index) => {
      const sequence = new ProjectionSequence([], options)
      sequence.admit({
        node(_state, node, parent) {
          trace.push(`${node.type}/${parent?.type}`)
          if (index) calls++
        },
        footer() {},
        conversion(bytes) {
          scratch += bytes
        },
      })
      return sequence
    })
    const native = sequences[0],
      cooperative = sequences[1]
    if (!native || !cooperative) throw new Error('Missing sequences')
    try {
      const expected = native.convert(node)
      const work = cooperative.convertSteps(node, limits)
      let yields = 0
      for (;;) {
        const before = calls
        const next = work.next()
        expect(calls - before).toBeLessThanOrEqual(16)
        if (next.done) {
          expect(next.value.hast).toEqual(expected.hast)
          break
        }
        yields++
      }
      expect(yields).toBeGreaterThan(10)
      expect(scratch).toBeGreaterThan(0)
      expect(traces[1]).toEqual(traces[0])
    } finally {
      for (const sequence of sequences) sequence.close()
    }
  })
  it('uses native hard-break trimming across a child-group boundary', () => {
    const node: Root['children'][number] = {
      type: 'paragraph',
      children: [
        ...Array.from({ length: 15 }, () => ({ type: 'inlineCode' as const, value: 'x' })),
        { type: 'break' },
        { type: 'text', value: ' \t  tail' },
        { type: 'break' },
        { type: 'link', url: '/safe', children: [{ type: 'text', value: '\t link' }] },
      ],
    }
    const native = new ProjectionSequence([], options),
      cooperative = new ProjectionSequence([], options)
    try {
      expect(finish(cooperative.convertSteps(node, limits)).hast).toEqual(native.convert(node).hast)
    } finally {
      native.close()
      cooperative.close()
    }
  })
  it('admits expanded native child results before flattening them', () => {
    const node: Root['children'][number] = {
      type: 'paragraph',
      children: [
        {
          type: 'linkReference',
          identifier: 'missing',
          referenceType: 'full',
          children: Array.from({ length: 48 }, () => ({ type: 'inlineCode', value: 'x' })),
        },
      ],
    }
    const sequence = new ProjectionSequence([], options)
    let leaves = 0
    sequence.admit({
      node(_state, child) {
        if (child.type === 'inlineCode') leaves++
      },
      footer() {},
      conversion(bytes) {
        // Small groups fit, but combining the unresolved reference needs more slots.
        if (leaves === 48 && bytes > 512) throw new Error('expanded scratch denied')
      },
    })
    expect(() => finish(sequence.convertSteps(node, limits))).toThrow('expanded scratch denied')
    expect(() => sequence.finish()).toThrow('closed')
    const native = new ProjectionSequence([], options)
    const cooperative = new ProjectionSequence([], options)
    try {
      expect(finish(cooperative.convertSteps(node, limits)).hast).toEqual(native.convert(node).hast)
    } finally {
      native.close()
      cooperative.close()
    }
  })
  it('ignores dropped table cells before their footnote calls can change state', () => {
    const root: Root = {
      type: 'root',
      children: [
        {
          type: 'table',
          align: ['left'],
          children: [
            {
              type: 'tableRow',
              children: [
                { type: 'tableCell', children: [{ type: 'text', value: 'shown' }] },
                {
                  type: 'tableCell',
                  children: [{ type: 'footnoteReference', identifier: 'a', label: 'a' }],
                },
              ],
            },
          ],
        },
        {
          type: 'footnoteDefinition',
          identifier: 'a',
          label: 'a',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: 'unused note' }] }],
        },
      ],
    }
    const native = new ProjectionSequence(context(root), options)
    const cooperative = new ProjectionSequence(context(root), options)
    try {
      for (const node of root.children)
        expect(finish(cooperative.convertSteps(node, limits)).hast).toEqual(
          native.convert(node).hast,
        )
      expect(cooperative.finish().html).toBe(native.finish().html)
    } finally {
      native.close()
      cooperative.close()
    }
  })
  it('converts repeated node objects per occurrence with independent footnote counters', () => {
    const reference = { type: 'footnoteReference' as const, identifier: 'a', label: 'a' }
    const node: Root['children'][number] = { type: 'paragraph', children: [reference, reference] }
    const definition: ProjectionDefinition = {
      type: 'footnoteDefinition',
      identifier: 'a',
      label: 'a',
      children: [],
    }
    const native = new ProjectionSequence([definition], options)
    const cooperative = new ProjectionSequence([definition], options)
    try {
      expect(finish(cooperative.convertSteps(node, limits)).hast).toEqual(native.convert(node).hast)
      expect(cooperative.finish().html).toBe(native.finish().html)
    } finally {
      native.close()
      cooperative.close()
    }
  })
  it.each(['return', 'throw'] as const)('closes a suspended conversion on %s', (method) => {
    const sequence = new ProjectionSequence([], options)
    const work = sequence.convertSteps(paragraph(), limits)
    expect(work.next().done).toBe(false)
    if (method === 'return') work.return(undefined as never)
    else expect(() => work.throw(new Error('cancel conversion'))).toThrow('cancel conversion')
    expect(() => sequence.finish()).toThrow('closed')
    expect(() => sequence.convert(paragraph())).toThrow('closed')
  })
  it('rejects parallel conversion and footer work while suspended', () => {
    const sequence = new ProjectionSequence([], options)
    const work = sequence.convertSteps(paragraph(), limits)
    try {
      expect(work.next().done).toBe(false)
      expect(() => sequence.convert(paragraph())).toThrow('already active')
      expect(() => sequence.finishConversion()).toThrow('already active')
      expect(() => sequence.convertSteps(paragraph(), limits).next()).toThrow('already active')
    } finally {
      work.return(undefined as never)
      sequence.close()
    }
  })
  it('rejects resumption after sequence revocation', () => {
    const sequence = new ProjectionSequence([], options)
    const work = sequence.convertSteps(paragraph(), limits)
    expect(work.next().done).toBe(false)
    sequence.close()
    expect(() => work.next()).toThrow('closed')
  })
  it('observes revocation inside a native allocation hook', () => {
    const sequence = new ProjectionSequence([], options)
    sequence.admit({
      node() {
        sequence.close()
      },
      footer() {},
      conversion() {},
    })
    expect(() => sequence.convertSteps(paragraph(), limits).next()).toThrow('closed')
    expect(() => sequence.finish()).toThrow('closed')
  })
  it.each(['close', 'throw'] as const)('stops at a leaf allocation hook on %s', (action) => {
    const sequence = new ProjectionSequence([], options)
    const visited: string[] = []
    sequence.admit({
      node(_state, node) {
        visited.push(node.type)
        if (node.type === 'text') {
          if (action === 'close') sequence.close()
          else throw new Error('leaf allocation denied')
        }
      },
      footer() {},
      conversion() {},
    })
    const node: Root['children'][number] = {
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', value: 'first' }] },
        { type: 'text', value: 'later' },
      ],
    }
    expect(() => finish(sequence.convertSteps(node, limits))).toThrow(
      action === 'close' ? 'closed' : 'leaf allocation denied',
    )
    expect(visited).toEqual(['paragraph', 'strong', 'text'])
    expect(() => sequence.finish()).toThrow('closed')
  })
  it.each(['missing', 'denied'] as const)('fails closed on %s scratch admission', (kind) => {
    const sequence = new ProjectionSequence([], options)
    sequence.admit({
      node() {},
      footer() {},
      ...(kind === 'denied'
        ? {
            conversion() {
              throw new Error('scratch denied')
            },
          }
        : {}),
    })
    expect(() => sequence.convertSteps(paragraph(), limits).next()).toThrow(
      kind === 'missing' ? 'Missing projection conversion admission' : 'scratch denied',
    )
    expect(() => sequence.finish()).toThrow('closed')
  })
  it.each([
    { nodes: 1, depth: 512 },
    { nodes: 800000, depth: 1 },
  ])('enforces complete conversion limits %j', (limit) => {
    const sequence = new ProjectionSequence([], options)
    expect(() => finish(sequence.convertSteps(paragraph(), limit))).toThrow('node/depth limit')
    expect(() => sequence.finish()).toThrow('closed')
  })
  it('leaves an unstarted returned task free of sequence changes', () => {
    const sequence = new ProjectionSequence([], options)
    sequence.convertSteps(paragraph(), limits).return(undefined as never)
    expect(() => sequence.convert(paragraph())).not.toThrow()
    sequence.close()
  })
  it('keeps substituted Reading conversion on its original synchronous path', () => {
    const sequence = new ProjectionSequence([], options, () => [
      { type: 'text', value: 'translated' },
    ])
    expect(() => sequence.convertSteps(paragraph(), limits).next()).toThrow('substitutions')
    expect(sequence.render({ type: 'paragraph', children: [] }).projection.html).toContain(
      'translated',
    )
    sequence.close()
  })
})
