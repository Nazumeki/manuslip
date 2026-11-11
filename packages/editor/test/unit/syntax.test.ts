import { ensureSyntaxTree } from '@codemirror/language'
import { parseMarkdown } from '@manuslip/core'
import { describe, expect, it } from 'vitest'
import { frontmatterEnd, yamlFrontmatter } from '../../src/frontmatter'
import {
  Compartment,
  createSourceState,
  EditorSelection,
  selectionInCode,
  undo,
} from '../../src/index'
import { editorSyntax, maxEditorInlineLength } from '../../src/syntax'

describe('bounded editor inline syntax', () => {
  it.each(['---', '+++', '--- \t', '+++ \t'])(
    'accepts a one-line metadata opener %j before Enter and after deleting its body',
    (opening) => {
      let state = createSourceState('', { extensions: [yamlFrontmatter.of(true)] })
      for (const character of opening) {
        state = state.update({ changes: { from: state.doc.length, insert: character } }).state
        expect(state.field(frontmatterEnd)).toBe(0)
      }
      expect(state.doc.toString()).toBe(opening)
      const closing = opening.trim()
      state = state.update({
        changes: { from: state.doc.length, insert: `\ntitle: value\n${closing}` },
      }).state
      expect(state.field(frontmatterEnd)).toBe(state.doc.length)
      state = state.update({ changes: { from: opening.length, to: state.doc.length } }).state
      expect(state.field(frontmatterEnd)).toBe(0)
      expect(state.doc.toString()).toBe(opening)
      expect(
        createSourceState(opening, { extensions: [yamlFrontmatter.of(true)] }).field(
          frontmatterEnd,
        ),
      ).toBe(0)
    },
  )
  it('keeps closed frontmatter literal and recognizes edits that close or remove it', () => {
    for (const [opening, closing] of [
      ['---', '---'],
      ['---', '...'],
      ['+++', '+++'],
    ]) {
      const source = `${opening}\ntitle: **literal**\n${closing}\n\n# Actual heading`
      let state = createSourceState(source, { extensions: [yamlFrontmatter.of(true)] })
      const end = source.indexOf('\n\n')
      expect(state.field(frontmatterEnd)).toBe(end)
      state = state.update({ changes: { from: state.doc.length, insert: '\nAfter' } }).state
      expect(state.field(frontmatterEnd)).toBe(end)
      state = state.update({ changes: { from: end - 3, to: end } }).state
      expect(state.field(frontmatterEnd)).toBe(0)
      state = state.update({ changes: { from: end - 3, insert: closing } }).state
      expect(state.field(frontmatterEnd)).toBe(end)
    }
    expect(
      createSourceState('---\nUnclosed **Markdown**', {
        extensions: [yamlFrontmatter.of(true)],
      }).field(frontmatterEnd),
    ).toBe(0)
    expect(
      createSourceState('Paragraph\n\n---\ntitle: **Markdown**\n---', {
        extensions: [yamlFrontmatter.of(true)],
      }).field(frontmatterEnd),
    ).toBe(0)
  })
  it('updates YAML interpretation on configuration changes without changing source or undo', () => {
    const source = '---\ntitle: **literal**\n---\n\n# Actual heading'
    const configuration = new Compartment()
    let state = createSourceState(source, {
      extensions: [configuration.of(yamlFrontmatter.of(false))],
    })
    const end = source.indexOf('\n\n')
    expect(state.field(frontmatterEnd)).toBe(0)
    state = state.update({ changes: { from: state.doc.length, insert: '\nAfter' } }).state
    for (const enabled of [true, false, true]) {
      state = state.update({
        effects: configuration.reconfigure(yamlFrontmatter.of(enabled)),
      }).state
      expect(state.field(frontmatterEnd)).toBe(enabled ? end : 0)
      expect(state.doc.toString()).toBe(`${source}\nAfter`)
    }
    expect(undo({ state, dispatch: (transaction) => (state = transaction.state) })).toBe(true)
    expect(state.doc.toString()).toBe(source)
    expect(state.field(frontmatterEnd)).toBe(end)
  })
  it('recognizes TOML with YAML disabled by default', () => {
    expect(createSourceState('---\ntitle: **literal**\n---').field(frontmatterEnd)).toBe(0)
    const source = '+++\ntitle = "**literal**"\n+++'
    expect(createSourceState(source).field(frontmatterEnd)).toBe(source.length)
  })
  it.each(
    ['\n', '\r\n'].flatMap((newline) => ['---', '...'].map((closing) => ({ newline, closing }))),
  )(
    'isolates YAML strings from following Markdown: $closing with $newline',
    ({ newline, closing }) => {
      const source = [
        '--- \t',
        'title: "**literal**"',
        'summary: |',
        '  ```',
        '  <div>',
        `${closing} \t`,
        '# Actual heading',
        '',
        '**Body** and `code`.',
      ].join(newline)
      const state = createSourceState(source, { extensions: [yamlFrontmatter.of(true)] })
      const tree = ensureSyntaxTree(state, state.doc.length, 100)
      expect(tree).not.toBeNull()
      const nodes: { name: string; from: number; to: number }[] = []
      tree?.iterate({ enter: ({ name, from, to }) => void nodes.push({ name, from, to }) })
      const text = state.doc.toString()
      expect(
        nodes.filter((node) => node.name === 'ATXHeading1').map((node) => node.from),
        tree?.toString(),
      ).toEqual([text.indexOf('# Actual heading')])
      expect(
        nodes.filter((node) => node.name === 'StrongEmphasis').map((node) => node.from),
      ).toEqual([text.indexOf('**Body**')])
      expect(nodes.some((node) => node.name === 'InlineCode')).toBe(true)
      expect(nodes.some((node) => node.name === 'FencedCode' || node.name === 'HTMLBlock')).toBe(
        false,
      )
    },
  )
  it('keeps non-ASCII fence suffixes literal, matching semantic front matter', () => {
    const source = '---\ntitle: **Markdown**\n---\u00a0\n\n# Heading'
    const state = createSourceState(source, { extensions: [yamlFrontmatter.of(true)] })
    expect(state.field(frontmatterEnd)).toBe(0)
  })
  it.each(['---\n---', '---\ntitle: Test\n---', '---\n---\n'])(
    'parses metadata with an empty body: %j',
    (source) => {
      const state = createSourceState(source, { extensions: [yamlFrontmatter.of(true)] })
      const tree = ensureSyntaxTree(state, state.doc.length, 100)
      expect(tree).not.toBeNull()
      expect(tree?.length).toBe(state.doc.length)
      expect(tree?.toString()).not.toMatch(/HorizontalRule|SetextHeading/)
    },
  )
  it('updates YAML and body syntax through edits and undo', () => {
    const source = '---\nsummary: |\n  ```\n---\n# Heading\n\n**Body**'
    let state = createSourceState(source, { extensions: [yamlFrontmatter.of(true)] })
    const parsed = () => ensureSyntaxTree(state, state.doc.length, 100)?.toString()
    expect(parsed()).toContain('ATXHeading1')
    state = state.update({ changes: { from: state.doc.length, insert: ' and `code`' } }).state
    expect(parsed()).toContain('InlineCode')
    state = state.update({
      changes: { from: source.indexOf('summary:'), insert: 'title: Test\n' },
    }).state
    expect(parsed()).toContain('ATXHeading1')
    expect(parsed()).toContain('InlineCode')
    const edited = state.doc.toString()
    const closing = state.doc.line(5)
    state = state.update({ changes: { from: closing.from, to: closing.to } }).state
    expect(parsed()).toContain('FencedCode')
    expect(parsed()).not.toContain('ATXHeading1')
    expect(undo({ state, dispatch: (transaction) => (state = transaction.state) })).toBe(true)
    expect(state.doc.toString()).toBe(edited)
    expect(parsed()).toContain('ATXHeading1')
    expect(parsed()).toContain('StrongEmphasis')
  })
  it('retains ordinary inline parsing and surrounding block structure', () => {
    const source = `# Heading\n\n${'x'.repeat(maxEditorInlineLength)} **large**\n\n**ordinary** and \`code\`\n`
    const tree = editorSyntax.language.parser.parse(source)
    const paragraph = tree.topNode.getChildren('Paragraph')
    expect(tree.topNode.getChild('ATXHeading1')).not.toBeNull()
    expect(paragraph).toHaveLength(2)
    expect(paragraph[0]?.getChild('UnparsedInline')?.to).toBe(source.indexOf('\n\n**ordinary**'))
    expect(paragraph[0]?.getChild('StrongEmphasis')).toBeNull()
    expect(paragraph[1]?.getChild('StrongEmphasis')).not.toBeNull()
    expect(paragraph[1]?.getChild('InlineCode')).not.toBeNull()
  })

  it('treats unknown inline context conservatively for image paste and preserves edits', () => {
    const source = `${'x'.repeat(maxEditorInlineLength)} \`image paste must stay text\``
    let state = createSourceState(source)
    state = state.update({ selection: EditorSelection.cursor(source.length - 2) }).state
    expect(selectionInCode(state)).toBe(true)
    state = state.update({ changes: { from: source.length, insert: ' appended' } }).state
    expect(state.doc.toString()).toBe(`${source} appended`)
    const small = createSourceState('ordinary paragraph')
    expect(selectionInCode(small)).toBe(false)
  })

  it('retains full semantic inline structure beyond the editor syntax limit', () => {
    const source = `${'x'.repeat(maxEditorInlineLength)} **strong** and \`code\` and [link][r]\n\n[r]: https://example.invalid/`
    const document = parseMarkdown(source)
    const paragraph = document.root.children[0]
    if (paragraph?.type !== 'paragraph') throw new Error('Missing semantic paragraph')
    expect(paragraph.children.map((node) => node.type)).toEqual([
      'text',
      'strong',
      'text',
      'inlineCode',
      'text',
      'linkReference',
    ])
    expect(document.root.children[1]?.type).toBe('definition')
    expect(document.counts.characters).toBe([...source].length)
  })
})
