import { EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { latexMarkdown } from '../../src/conventions'
import { frontmatterEnd, yamlFrontmatter } from '../../src/frontmatter'
import { createSourceState, redo, undo } from '../../src/index'
import { editingBlock, editLiveBlock, liveEditing } from '../../src/live-editing'
import { dismissEmptyBlock, finishBlockTransaction } from '../../src/live-interactions'
import {
  composingEffect,
  isComposing,
  type LiveBlock,
  liveModel,
  setLiveModel,
} from '../../src/live-model'
import { blockOpeningTransaction, paragraphBreakTransaction } from '../../src/markdown-input'
import { sourceSyntax } from '../../src/syntax'

function tail(source: string, extensions: Extension = []) {
  return EditorState.create({
    doc: source,
    selection: { anchor: source.length },
    extensions: [frontmatterEnd, sourceSyntax, extensions],
  })
}

describe('Live prose paragraph entry', () => {
  it.each([
    ['**alpha beta**', 7, 8, '**alpha**\n\n**beta**', 13],
    ['**alpha beta**', 7, 7, '**alpha**\n\n**beta**', 13],
    ['**alpha beta**', 8, 8, '**alpha**\n\n**beta**', 13],
    ['***alpha  beta***', 9, 9, '***alpha***\n\n***beta***', 16],
    ['**alpha\nbeta**', 7, 7, '**alpha**\n\n**beta**', 13],
    ['**alpha\nbeta**', 8, 8, '**alpha**\n\n**beta**', 13],
    ['***alpha beta***', 8, 9, '***alpha***\n\n***beta***', 16],
    ['**alpha**', 2, 2, '\n\n**alpha**', 4],
    ['**alpha**', 7, 7, '**alpha**\n\n', 11],
    ['__alpha beta__', 7, 8, '__alpha__\n\n__beta__', 13],
  ] as const)('keeps emphasis valid when splitting %s', (source, anchor, head, expected, caret) => {
    const state = tail(source).update({ selection: { anchor, head } }).state
    const result = paragraphBreakTransaction(state)
    expect(result?.newDoc.toString()).toBe(expected)
    expect(result?.newSelection.main.head).toBe(caret)
  })

  it('splits ordinary prose with a blank line and replaces selected prose', () => {
    expect(paragraphBreakTransaction(tail('alpha'))?.newDoc.toString()).toBe('alpha\n\n')
    const state = tail('alpha beta').update({ selection: { anchor: 5, head: 6 } }).state
    const paragraph = paragraphBreakTransaction(state)
    expect(paragraph?.newDoc.toString()).toBe('alpha\n\nbeta')
    expect(paragraph?.newSelection.main.head).toBe(7)
  })

  it.each(['- alpha', '3. alpha', '> alpha', '    alpha', '```\nalpha', '<div>\nalpha', '# alpha'])(
    'leaves structural input to its existing command: %s',
    (source) => expect(paragraphBreakTransaction(tail(source))).toBeNull(),
  )

  it('does not split metadata, read-only prose, or an active composition', () => {
    expect(
      paragraphBreakTransaction(tail('---\ntitle: alpha\n---', yamlFrontmatter.of(true))),
    ).toBeNull()
    expect(paragraphBreakTransaction(tail('alpha', EditorState.readOnly.of(true)))).toBeNull()
    const composing = tail('alpha', isComposing).update({ effects: composingEffect.of(true) }).state
    expect(paragraphBreakTransaction(composing)).toBeNull()
  })
})

describe('Live block entry', () => {
  it.each(['```js', '~~~', '$$', '+++', '---'])(
    'places the caret inside %s before existing prose and preserves that prose',
    (opener) => {
      const source = `${opener}\nAfter`
      const state = createSourceState(source, {
        extensions: [
          latexMarkdown.of(true),
          yamlFrontmatter.of(true),
          liveModel,
          liveEditing,
          isComposing,
        ],
      }).update({ selection: { anchor: opener.length } }).state
      const result = blockOpeningTransaction(state)
      const closer = opener === '```js' ? '```' : opener
      expect(result?.newDoc.toString()).toBe(`${opener}\n\n${closer}\n\nAfter`)
      expect(result?.newSelection.main.head).toBe(opener.length + 1)
      if (!result) throw new Error('Expected completion')
      const typed = result.state.update(result.state.replaceSelection('inside')).state
      expect(typed.doc.toString()).toBe(`${opener}\ninside\n${closer}\n\nAfter`)
      expect(finishBlockTransaction(result.state, true)?.newSelection.main.head).toBe(
        opener.length + closer.length + 4,
      )
      if (opener !== '+++' && opener !== '---') expect(editingBlock(result.state)).not.toBeNull()
    },
  )

  it('isolates completion from typing in undo and redo', () => {
    let state = createSourceState('')
    state = state.update({
      changes: { from: 0, insert: '```' },
      selection: { anchor: 3 },
      userEvent: 'input.type',
    }).state
    const completed = blockOpeningTransaction(state)
    if (!completed) throw new Error('Expected completion')
    state = completed.state
    state = state.update({ selection: state.selection }).state
    const target = {
      get state() {
        return state
      },
      dispatch(transaction: import('@codemirror/state').Transaction) {
        state = transaction.state
      },
    }
    expect(undo(target)).toBe(true)
    expect(state.doc.toString()).toBe('```')
    expect(state.selection.main.head).toBe(3)
    expect(redo(target)).toBe(true)
    expect(state.doc.toString()).toBe('```\n\n```')
    expect(state.selection.main.head).toBe(4)
  })

  it.each(['```', '  ~~~', '$$', '+++', '---'])(
    'lets Backspace dismiss an empty completed %s block',
    (opener) => {
      const state = createSourceState(opener, {
        extensions: [yamlFrontmatter.of(true), liveModel, liveEditing, isComposing],
      }).update({ selection: { anchor: opener.length } }).state
      const completed = blockOpeningTransaction(state)
      if (!completed) throw new Error('Expected completion')
      const dismissed = dismissEmptyBlock(completed.state)
      expect(dismissed?.newDoc.toString()).toBe(opener)
      expect(dismissed?.newSelection.main.head).toBe(opener.length)
      const typed = completed.state.update(completed.state.replaceSelection('keep')).state
      expect(dismissEmptyBlock(typed)).toBeNull()
    },
  )

  it.each([
    '```js\nbody\n```',
    '  ```js\nbody\n  ```',
    '   ~~~\nbody\n   ~~~',
    '$$\nx\n$$',
    '+++\ntitle = "x"\n+++',
  ])('does not duplicate an existing closer when Enter is pressed on %s', (source) => {
    const state = createSourceState(source).update({
      selection: { anchor: source.indexOf('\n') },
    }).state
    expect(blockOpeningTransaction(state)).toBeNull()
  })
  it('completes TOML metadata independently of the YAML switch', () => {
    expect(blockOpeningTransaction(tail('+++', yamlFrontmatter.of(false)))?.newDoc.toString()).toBe(
      '+++\n\n+++',
    )
  })
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

  it('does not pretend to exit an unclosed code fence at EOF', () => {
    const state = editing('```\ntext', 'code')
    const atEnd = state.update({ selection: { anchor: state.doc.length } }).state
    expect(finishBlockTransaction(atEnd, true)).toBeNull()
  })

  it.each(['````js\ntext\n`````', '~~~js\ntext\n~~~~'])(
    'accepts a longer matching closing fence: %s',
    (source) =>
      expect(finishBlockTransaction(editing(source, 'code'), true)?.newDoc.toString()).toBe(
        `${source}\n\n`,
      ),
  )

  it.each(['math', 'code', 'diagram'])(
    'finishes %s from its body and creates a following paragraph',
    (kind) => {
      const source = kind === 'math' ? '$$\nx\n$$' : '```\nx\n```'
      const state = editing(source, kind)
      const transaction = finishBlockTransaction(state, true)
      expect(transaction?.newDoc.toString()).toBe(`${source}\n\n`)
      expect(transaction?.newSelection.main.head).toBe(source.length + 2)
      if (!transaction) throw new Error('Expected completion')
      expect(editingBlock(transaction.state)).toBeNull()
      expect(
        finishBlockTransaction(
          state.update({ selection: { anchor: source.indexOf('\n') + 1 } }).state,
          true,
        )?.newDoc.toString(),
      ).toBe(`${source}\n\n`)
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
