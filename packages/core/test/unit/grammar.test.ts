import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it, vi } from 'vitest'
import { remarkDefinitionList } from '../../src/definition-list'
import { remarkExtendedInline } from '../../src/extended-markdown'
import { finishPackedSteps } from '../../src/packing-work'
import {
  markdownGrammarSteps,
  markdownProcessor,
  needsGfm,
  parseMarkdown,
  parseMarkdownWithGrammar,
} from '../../src/parse'
import examples from '../fixtures/commonmark-0.31.2/spec.json'

function sameGrammar(source: string, syntax: 'manuslip' | 'commonmark') {
  const gfm = syntax === 'manuslip' && needsGfm(source)
  const selected = finishPackedSteps(markdownGrammarSteps(source, syntax))
  expect(selected?.gfm).toBe(gfm)
  expect(selected?.processor).toBe(markdownProcessor(source, syntax, gfm))
  return selected
}

describe.each(['manuslip', 'commonmark'] as const)('cooperative %s grammar selection', (syntax) => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))(
    'preserves the exact frozen processor and tree for guard combination %i',
    (mask) => {
      const candidates = [
        'a@example.invalid',
        'Header\n:---\nCell',
        'wWw.example.invalid',
        'HtTpS://example.invalid',
      ]
      const source = ['~Writing~', ...candidates.filter((_, index) => mask & (1 << index))].join(
        '\n\n',
      )
      expect(sameGrammar(source, syntax)?.processor.parse(source)).toEqual(
        parseMarkdown(source, syntax).root,
      )
    },
  )

  it.each([
    'www.',
    'WwW.',
    'http://',
    'HtTpS://',
    ':-',
    '-:',
    '&',
    '\\',
    '@',
    '|',
    '~',
    '[',
    ']',
    ':',
  ])('preserves %j at every overlapping slice boundary', (candidate) => {
    for (const boundary of [4089, 8178])
      for (let split = 0; split <= candidate.length; split++) {
        const source = `${'x'.repeat(boundary - split)}${candidate}${'x'.repeat(4097)}`
        sameGrammar(source, syntax)
      }
  })

  it('preserves native ignore-case, Unicode, entities and broken-prefix behavior', () => {
    for (const spelling of [
      '',
      '\ufeff',
      '\ud800',
      '\udfff',
      '😀',
      'www\u0000.',
      'www\ud800.',
      'www\udfff.',
      'httpſ://',
      'httK://',
      'ｗｗｗ.',
      'www．',
      'HTTPs://',
      'hTtP://',
      'wWw.',
      'www&#46;',
      'http&#58;//',
      'www\\.',
      'https\\://',
      'www\n.',
      'https:\r\n//',
    ])
      sameGrammar(`${'x'.repeat(4087)}${spelling}${'界😀'.repeat(1400)}`, syntax)
  })
})

it.each([4088, 4089, 4090, 8178])(
  'bounds native classifier inputs for %i UTF-16 source units',
  (length) => {
    const source = 'x'.repeat(length)
    const work = markdownGrammarSteps(source, 'manuslip')
    const slice = String.prototype.slice,
      test = RegExp.prototype.test
    const slices: [number | undefined, number | undefined][] = [],
      inputs: number[] = []
    let active = false,
      pauses = 0
    const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start?: number,
      end?: number,
    ) {
      if (active && this === source) slices.push([start, end])
      return slice.call(this, start, end)
    })
    const testSpy = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (
      this: RegExp,
      value: string,
    ) {
      if (active) inputs.push(value.length)
      return test.call(this, value)
    })
    try {
      while (true) {
        const before = slices.length
        active = true
        const step = work.next()
        active = false
        expect(slices.length - before).toBeLessThanOrEqual(1)
        if (step.done) {
          expect(step.value?.gfm).toBe(false)
          expect(step.value?.processor).toBe(markdownProcessor(source, 'manuslip', false))
          break
        }
        pauses++
      }
      expect(slices.length).toBe(Math.ceil(length / 4089))
      expect(pauses).toBe(Math.floor(length / 4089))
      for (let index = 0; index < slices.length; index++)
        expect(slices[index]).toEqual([
          Math.max(0, index * 4089 - 7),
          Math.min(length, (index + 1) * 4089),
        ])
      expect(inputs.length).toBe(slices.length * 6)
      expect(Math.max(...inputs)).toBeLessThanOrEqual(4096)
    } finally {
      active = false
      work.return()
      sliceSpy.mockRestore()
      testSpy.mockRestore()
    }
  },
)

it.each(['before', 'return', 'throw'] as const)(
  'revokes private grammar work through %s',
  (phase) => {
    const source = 'plain words '.repeat(1024)
    const work = markdownGrammarSteps(source, 'manuslip')
    const slice = String.prototype.slice
    let calls = 0
    const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start?: number,
      end?: number,
    ) {
      if (this === source) calls++
      return slice.call(this, start, end)
    })
    try {
      if (phase !== 'before') expect(work.next().done).toBe(false)
      if (phase === 'throw') {
        const failure = new Error('cancel grammar selection')
        expect(() => work.throw(failure)).toThrow(failure)
      } else work.return()
      expect(work.next()).toEqual({ done: true, value: undefined })
      expect(calls).toBe(phase === 'before' ? 0 : 1)
    } finally {
      work.return()
      spy.mockRestore()
    }
  },
)

it('stops scanning when all guards are enabled and skips CommonMark scanning', () => {
  const source = `&${'plain words '.repeat(1024)}`
  const slice = String.prototype.slice
  let calls = 0
  const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
    this: string,
    start?: number,
    end?: number,
  ) {
    if (this === source) calls++
    return slice.call(this, start, end)
  })
  try {
    sameGrammar(source, 'commonmark')
    expect(calls).toBe(0)
    sameGrammar(source, 'manuslip')
    expect(calls).toBe(1)
  } finally {
    spy.mockRestore()
  }
})

it('closes a classifier after a bounded slice fails', () => {
  const source = 'plain words '.repeat(1024)
  const work = markdownGrammarSteps(source, 'manuslip')
  const slice = String.prototype.slice
  const failure = new Error('classification slice failed')
  let calls = 0
  const spy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
    this: string,
    start?: number,
    end?: number,
  ) {
    if (this === source && ++calls === 2) throw failure
    return slice.call(this, start, end)
  })
  try {
    expect(work.next().done).toBe(false)
    expect(() => work.next()).toThrow(failure)
    expect(work.next()).toEqual({ done: true, value: undefined })
    expect(calls).toBe(2)
  } finally {
    work.return()
    spy.mockRestore()
  }
})

it('keeps interleaved classification independent when one input is cancelled', () => {
  const leftSource = 'plain words '.repeat(1024)
  const rightSource = `${'x'.repeat(8175)}https://example.invalid`
  const left = markdownGrammarSteps(leftSource, 'manuslip')
  const right = markdownGrammarSteps(rightSource, 'manuslip')
  try {
    expect(left.next().done).toBe(false)
    expect(right.next().done).toBe(false)
    expect(left.next().done).toBe(false)
    left.return()
    const selected = finishPackedSteps(right)
    expect(selected?.gfm).toBe(needsGfm(rightSource))
    expect(selected?.processor).toBe(markdownProcessor(rightSource, 'manuslip', true))
    expect(left.next()).toEqual({ done: true, value: undefined })
  } finally {
    left.return()
    right.return()
  }
})

const full = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkMath)
  .use(remarkExtendedInline)
  .use(remarkDefinitionList)
  .freeze()

describe('whole-root grammar selection equals the complete Manuslip grammar', () => {
  for (const example of examples)
    it(`CommonMark input ${example.example}: ${example.section}`, () => {
      expect(parseMarkdown(example.markdown).root).toEqual(full.parse(example.markdown))
    })

  it.each([
    'H~2~O ^界^ :smile: :unknown_name: ~~deleted~~\r\n\r\n| ^A^ | B |\r\n| - | - |\r\n| ~a^b^~ | :+1: |\r\n',
    '# Heading\n\nA paragraph with **emphasis** and `code`.\n\nSecond paragraph.',
    '- first\n  - nested\n\n1. ordered\n2. second\n',
    '> - quoted list\n>\n>     code\n',
    '---\ntitle: plain\n---\n\n$x$\n\n$$\nx^2\n$$\n',
    '+++\ntitle = "plain"\n+++\n\n中文 日本語 العربية עברית 😀',
    'a@example.com HTTP://example.com https://example.com WWW.example.com www.example.com',
    'a&#64;example.com http&#x3a;//example.com www\\.example.com',
    '~~strike~~ ~single~\n\n- [x] task\n- [ ] open\n',
    '| a | b |\n| - | - |\n| x | y |\n',
    'a | b\n- | -\nx | y\n',
    'Read [link][r] and note[^one].\n\n[r]: https://example.com/\n\n[^one]: body\n',
    'Escaped \\[ and entities &amp; &lbrack; &#124; &#126;\n',
    '\ufeff# BOM\r\n\r\nplain\r\n\r\n- list\r\n',
    '> Quote [late][r].\n\nOutside continues.\n\n> Next quote.\n\n[r]: /target\n',
    '> - first\n>\n>   continued\n\nOutside.\n\n- second\n\n  spread\n',
    '| a | b |\n| - | - |\n| x | y |\n\nAfter table\n\n> www.example.invalid\n',
    'First[^n] and again[^n].\n\n> Quoted[^m].\n\n[^n]: note\n\n[^m]: another\n',
    '> 😀\r\n\r\n\tcode\r\n\r\n# Tail\r\n',
    '> $x$ **strong**\n\n---\n\n$$\ny^2\n$$\n\n[r]: /last\n',
  ])('preserves extension/plain syntax, properties and exact positions: %s', (source) => {
    expect(parseMarkdown(source).root).toEqual(full.parse(source))
  })

  it('reselects the full grammar as edits introduce and remove document-wide syntax', () => {
    let source = '# Writing\n\nPlain prose.\n\n- a list\n'
    for (const edit of [
      (text: string) => text.replace('Plain prose.', 'Contact a@example.com and [reference][r].'),
      (text: string) => `${text}\n[r]: https://example.invalid/\n`,
      (text: string) => text.replace('- a list', '- [x] a task'),
      () => '# Plain again\n\nAn ordinary paragraph.\n\n- a list\n',
    ]) {
      source = edit(source)
      expect(parseMarkdown(source).root).toEqual(full.parse(source))
    }
  })

  it('preserves guarded GFM constructs, email spellings and processor isolation across edits', () => {
    const safe = [
      '> Prose **strong** `private` [label][r].\n\n[r]: https://example.invalid/\n',
      '| Header | Value |\n| :--- | ---: |\n| [a](https://example.invalid/) | ~strike~ |\n',
      '- [x] Closed\n- [ ] Open[^n]\n\n[^n]: Footnote with https://example.invalid/.\n',
      'www.example.invalid/a_(b) and HTTP://example.invalid/ then [link][r].\n\n[r]: /target\n',
      'Header\n:---\nCell\n',
    ]
    const email = [
      'a@example.invalid',
      'a&#64;example.invalid',
      'a&#x40;example.invalid',
      'a&commat;example.invalid',
      'a\\@example.invalid',
      '[a@b.invalid](mailto:a@b.invalid)',
      '<a@example.invalid>',
      '`a@example.invalid`',
      'a＠example.invalid',
    ]
    // Alternation also catches accidental mutation of remark-gfm's shared construct map.
    for (const base of safe)
      for (const spelling of email) {
        for (const source of [base, `${base}\n${spelling}\n`, base])
          expect(parseMarkdown(source).root).toEqual(full.parse(source))
      }
  })

  describe('seeded combinations of guarded syntax', () => {
    const pieces = [
      'Prose',
      '**strong**',
      '_emphasis_',
      '~strike~',
      '`code`',
      '[label][ref]',
      '[label](https://example.invalid/path)',
      'https://example.invalid/a_(b)',
      'www.example.invalid/',
      '[^n]',
      'a@example.invalid',
      'a&#64;example.invalid',
      'a\\@example.invalid',
      '😀中文',
      '\r\n',
      '\t',
      '\u0000',
    ]
    let seed = 0x741ecb
    const random = (size: number) => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % size
    }
    const sources = Array.from({ length: 400 }, (_, attempt) => {
      const prose = Array.from({ length: 12 }, () => pieces[random(pieces.length)]).join(' ')
      const body = attempt % 3 === 0 ? `> ${prose}` : attempt % 3 === 1 ? `- [x] ${prose}` : prose
      return `${body}\n\n[ref]: https://example.invalid/\n\n[^n]: Footnote.\n`
    })
    // Keep all 400 deterministic comparisons, with independent time budgets and
    // failure locations for each batch on slower shared runners.
    it.each(Array.from({ length: 20 }, (_, batch) => batch))(
      'matches full GFM trees and positions in batch %i',
      (batch) => {
        for (const [index, source] of sources.slice(batch * 20, (batch + 1) * 20).entries()) {
          expect(parseMarkdown(source).root, `guarded combination ${batch * 20 + index}`).toEqual(
            full.parse(source),
          )
        }
      },
    )
  })

  it('preserves complete trees while edits independently introduce and remove literal autolinks', () => {
    const constructs = [
      'a@example.invalid',
      'Header\n:---:\nCell',
      'wWw.example.invalid/a_(b)',
      'HtTpS://example.invalid/a_(b)',
    ]
    const sources = Array.from({ length: 16 }, (_, mask) =>
      [
        '~Writing with words where hypothetical prefixes fail~',
        ...constructs.filter((_, index) => mask & (1 << index)),
        '> Read [late][r].\n\n[r]: /target',
      ].join('\n\n'),
    )
    for (const source of [...sources, ...sources.toReversed(), ...sources]) {
      const expected = full.parse(source)
      expect(parseMarkdown(source).root).toEqual(expected)
      expect(parseMarkdownWithGrammar(source, 'manuslip', true).root).toEqual(expected)
    }
  })

  it.each([
    'Writing with words where https and www are ordinary prose.',
    'www.example.invalid HTTP://example.invalid HTTPS://example.invalid',
    'wWw.example.invalid and hTtPs://example.invalid/a_(b).',
    'www&#46;example.invalid http&#58;//example.invalid',
    'w&#119;w.example.invalid h&#116;tp://example.invalid',
    'www\\.example.invalid https\\://example.invalid',
    'www.\nexample.invalid and https:\n//example.invalid',
    '`www.example.invalid` **https**://example.invalid',
    '[www.example.invalid](https://example.invalid) ![https://example.invalid](/image)',
    '😀www.example.invalid العربية https://example.invalid 中文',
    '> www.example.invalid\r\n>\r\n> https://example.invalid/\r\n',
    'www\u0000.example.invalid https\u0000://example.invalid',
  ])('matches literal and decoded autolinks under explicit fragment grammar: %s', (source) => {
    expect(parseMarkdownWithGrammar(source, 'manuslip', true).root).toEqual(full.parse(source))
  })

  it('preserves pipe-free aligned tables and every delimiter boundary in containers', () => {
    const delimiters = [
      ':---',
      '---:',
      ':---:',
      ':-',
      '-:',
      ':-:',
      '---',
      '- - -',
      ': ---',
      '--- :',
      ':\t---',
      '---\t:',
      '| --- |',
      '--- | ---',
      ':--- | ---:',
      '\\:---',
      '&#58;---',
      '---&#58;',
      '：---',
      '---：',
      '\u0000:---',
    ]
    const containers = [
      (body: string) => body,
      (body: string) => body.replace(/^/gm, '> '),
      (body: string) => `- item\n\n${body.replace(/^/gm, '  ')}`,
      (body: string) => body.replace(/^/gm, '> > > '),
    ]
    for (const delimiter of delimiters)
      for (const wrap of containers) {
        for (const ending of ['\n', '\r', '\r\n']) {
          const source = `${wrap(`Header\n${delimiter}\nCell`)}\n\n[r]: /target\n`.replaceAll(
            '\n',
            ending,
          )
          const expected = full.parse(source)
          expect(parseMarkdown(source).root, delimiter).toEqual(expected)
          // Fragment parsing can request GFM even when its own source lacks markers.
          expect(parseMarkdownWithGrammar(source, 'manuslip', true).root, delimiter).toEqual(
            expected,
          )
        }
      }
    for (const delimiter of [':-', '-:', ':-:']) {
      const source = `Header\n${delimiter}\nCell\n`
      expect(full.parse(source).children[0]?.type).toBe('table')
      expect(parseMarkdown(source).root).toEqual(full.parse(source))
    }
  })
})
