import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { latexMarkdown } from '../../src/conventions'
import { frontmatterEnd, yamlFrontmatter } from '../../src/frontmatter'
import { createSourceState } from '../../src/index'
import { editingBlock, editLiveBlock, liveEditing } from '../../src/live-editing'
import { finishBlockTransaction } from '../../src/live-interactions'
import {
  composingEffect,
  isComposing,
  type LiveBlock,
  liveModel,
  setLiveModel,
} from '../../src/live-model'
import { blockOpeningTransaction } from '../../src/markdown-input'
import { sourceSyntax } from '../../src/syntax'

function tail(source: string, extensions: Extension = []) {
  return EditorState.create({
    doc: source,
    selection: { anchor: source.length },
    extensions: [frontmatterEnd, sourceSyntax, extensions],
  })
}

describe('Live block entry', () => {
  it('leaves a closing fence beyond syntax coverage to ordinary Enter', () => {
    const source = `${'Paragraph **text**.\n\n'.repeat(1000)}\`\`\`js\ntext\n\`\`\``
    expect(blockOpeningTransaction(tail(source))).toBeNull()
  })

  it.each(['<div>\n```js', '<!--\n~~~', '<script>\n```', '<div>\n$$'])(
    'keeps a fence-looking HTML line literal: %s',
    (source) => expect(blockOpeningTransaction(tail(source, latexMarkdown.of(true)))).toBeNull(),
  )

  it.each(['```', '```typescript', '~~~~python'])(
    'opens %s with one empty editable body',
    (opening) => {
      const state = createSourceState(opening).update({
        selection: { anchor: opening.length },
      }).state
      const transaction = blockOpeningTransaction(state)
      expect(transaction?.newDoc.toString()).toBe(`${opening}\n\n${opening.match(/^[`~]+/)?.[0]}`)
      expect(transaction?.newSelection.main.head).toBe(opening.length + 1)
    },
  )

  it.each(['```\nbody\n```', '```\n$$', '$$\nx\n$$'])(
    'keeps an existing closer or code content literal: %s',
    (source) => {
      const state = createSourceState(source).update({ selection: { anchor: source.length } }).state
      expect(blockOpeningTransaction(state)).toBeNull()
    },
  )

  it('respects LaTeX and YAML switches and refuses selection replacement or read-only edits', () => {
    for (const [source, facet] of [
      ['$$', latexMarkdown],
      ['---', yamlFrontmatter],
    ] as const) {
      const enabled = tail(source, facet.of(true))
      expect(blockOpeningTransaction(enabled)?.newDoc.toString()).toBe(`${source}\n\n${source}`)
      expect(blockOpeningTransaction(tail(source, facet.of(false)))).toBeNull()
      expect(
        blockOpeningTransaction(tail(source, [facet.of(true), EditorState.readOnly.of(true)])),
      ).toBeNull()
      expect(
        blockOpeningTransaction(
          enabled.update({ selection: { anchor: 0, head: source.length } }).state,
        ),
      ).toBeNull()
    }
    expect(blockOpeningTransaction(tail('```\nexisting'))).toBeNull()
    expect(blockOpeningTransaction(tail('Before\n---', yamlFrontmatter.of(true)))).toBeNull()
  })
})

describe('explicit block completion', () => {
  function editing(source: string, kind = 'math', after = '') {
    const block: LiveBlock = {
      id: 'block',
      kind,
      from: 0,
      to: source.length,
      html: '',
      value: 'x',
      lines: 3,
    }
    const state = EditorState.create({
      doc: source + after,
      extensions: [liveModel, liveEditing, isComposing],
    })
    return state.update({
      selection: { anchor: source.lastIndexOf('\n') },
      effects: [
        setLiveModel.of({ blocks: [block] }),
        editLiveBlock.of({ from: 0, to: source.length, block }),
      ],
    }).state
  }

  it.each(['````\ntext\n```', '```\ntext\n~~~', '~~~\ntext\n```', '```\ntext\n    ```'])(
    'does not finish before a fence-looking body line: %s',
    (source) => expect(finishBlockTransaction(editing(source, 'code'), true)).toBeNull(),
  )

  it.each(['````js\ntext\n`````', '~~~js\ntext\n~~~~'])(
    'accepts a longer matching closing fence: %s',
    (source) =>
      expect(finishBlockTransaction(editing(source, 'code'), true)?.newDoc.toString()).toBe(
        `${source}\n\n`,
      ),
  )

  it.each(['math', 'code', 'diagram'])(
    'finishes %s only at the body end, and creates a following paragraph',
    (kind) => {
      const source = kind === 'math' ? '$$\nx\n$$' : '```\nx\n```'
      const state = editing(source, kind)
      const transaction = finishBlockTransaction(state, true)
      expect(transaction?.newDoc.toString()).toBe(`${source}\n\n`)
      expect(transaction?.newSelection.main.head).toBe(source.length + 2)
      if (!transaction) throw new Error('Expected completion')
      expect(editingBlock(transaction.state)).toBeNull()
      expect(
        finishBlockTransaction(state.update({ selection: { anchor: 3 } }).state, true),
      ).toBeNull()
    },
  )

  it('reuses following paragraph spacing and preserves source on Escape', () => {
    const source = '$$\nx\n$$'
    const state = editing(source, 'math', '\n\nAfter')
    expect(finishBlockTransaction(state, true)?.docChanged).toBe(false)
    expect(finishBlockTransaction(state, true)?.newSelection.main.head).toBe(source.length + 2)
    expect(finishBlockTransaction(state)?.docChanged).toBe(false)
    expect(
      finishBlockTransaction(state.update({ effects: composingEffect.of(true) }).state, true),
    ).toBeNull()
  })
})
