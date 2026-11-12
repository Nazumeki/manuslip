import { EditorSelection, EditorState } from '@codemirror/state'
import { parseMarkdown } from '@manuslip/core'
import { renderMarkdown } from '@manuslip/renderer'
import { describe, expect, it } from 'vitest'
import examples from '../../../core/test/fixtures/commonmark-0.31.2/spec.json'
import { blockDecorations } from '../../src/live-blocks'
import {
  inlineProjection,
  isComposing,
  type LiveOptions,
  liveModel,
  setLiveModel,
} from '../../src/live-model'

const options: LiveOptions = {
  sourceLabel: () => 'Select source',
  taskLabel: () => 'Task',
  openLink: () => {},
  render: () => {},
}

function fixture(source: string) {
  const field = blockDecorations(options)
  let state = EditorState.create({ doc: source, extensions: [liveModel, isComposing, field] })
  const blocks = renderMarkdown(parseMarkdown(state.doc.toString(), 'commonmark').root, {
    rawHtml: false,
    footnotesLabel: 'Footnotes',
    footnoteBackLabel: 'Back',
  }).blocks.map((block, index) => ({ ...block, id: String(index), lines: 1 }))
  state = state.update({ effects: setLiveModel.of({ blocks }) }).state
  return { state, field, blocks }
}

describe('CommonMark semantic blocks in Live Preview', () => {
  it.each(examples)('$example: $section', ({ markdown, example }) => {
    const { state, field, blocks } = fixture(markdown)
    const ranges: { from: number; to: number }[] = []
    for (const cursor = state.field(field).visible.iter(); cursor.value; cursor.next())
      ranges.push({ from: cursor.from, to: cursor.to })
    for (const block of blocks.filter((block) => !inlineProjection(block.kind)))
      expect(
        ranges.some((range) => range.from <= block.from && range.to >= block.to),
        `Missing ${block.kind} projection for ${JSON.stringify(markdown.slice(block.from, block.to))}`,
        // These CommonMark examples end at EOF without a matching fence. Reading
        // still renders them; Live Preview deliberately retains their editable source.
      ).toBe(
        !(
          block.kind === 'code' &&
          ([126, 127, 137, 139].includes(example) || (example === 237 && block.from > 6))
        ),
      )
    expect(state.doc.toString()).toBe(markdown)
  })

  it.each(['```', '```js\nbody', '````\nbody\n```', '~~~\nbody\n```'])(
    'keeps an unfinished fence editable: %s',
    (source) => {
      const { state, field } = fixture(source)
      expect(state.field(field).visible.size).toBe(0)
      expect(state.doc.toString()).toBe(source)
    },
  )

  it.each(['    code', '\tcode', '  ```js\n  code\n  ```', '   ~~~\n   code\n   ~~~'])(
    'reveals indentation selections and restores the complete code widget: %s',
    (source) => {
      const { state, field } = fixture(source)
      expect(state.field(field).visible.size).toBe(1)
      expect(state.field(field).visible.iter().from).toBe(0)
      const selected = state.update({ selection: EditorSelection.single(0, 1) }).state
      expect(selected.field(field).visible.size).toBe(0)
      const collapsed = selected.update({ selection: EditorSelection.single(1) }).state
      expect(collapsed.field(field).visible.size).toBe(1)
      expect(collapsed.doc.toString()).toBe(source)
    },
  )

  it('does not replace unrelated text beside a block', () => {
    const field = blockDecorations(options)
    const state = EditorState.create({
      doc: 'before code\ncode after',
      extensions: [liveModel, isComposing, field],
    }).update({
      effects: setLiveModel.of({
        blocks: [
          { id: 'prefix', from: 7, to: 11 },
          { id: 'suffix', from: 12, to: 16 },
        ].map((block) => ({
          ...block,
          kind: 'code',
          html: '<pre>code</pre>',
          value: 'code',
          lines: 1,
        })),
      }),
    }).state
    expect(state.field(field).visible.size).toBe(0)
  })
})
