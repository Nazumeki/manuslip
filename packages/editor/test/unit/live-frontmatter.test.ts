import { expect, it } from 'vitest'
import { createSourceState } from '../../src/index'
import { yamlFrontmatter } from '../../src/frontmatter'
import { frontmatterDecorations } from '../../src/live-frontmatter'

it.each(['---', '+++'])('reveals both %s delimiters when editing metadata', (marker) => {
  const source = `${marker}\ntitle: text\n${marker}\n\nAfter`
  const state = createSourceState(source, {
    extensions: [yamlFrontmatter.of(true), frontmatterDecorations],
  })
  expect(state.field(frontmatterDecorations).size).toBe(0)
  const outside = state.update({ selection: { anchor: source.length } }).state
  expect(outside.field(frontmatterDecorations).size).toBe(2)
  for (const anchor of [0, 5, source.lastIndexOf(marker)]) {
    const editing = outside.update({ selection: { anchor } }).state
    expect(editing.field(frontmatterDecorations).size).toBe(0)
    expect(editing.doc.toString()).toBe(source)
  }
})
