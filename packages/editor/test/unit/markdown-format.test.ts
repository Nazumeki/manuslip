import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createSourceState, redo, undo } from '../../src/index'
import { codeBlockTransaction, inlineFormatTransaction } from '../../src/markdown-format'

function select(source: string, anchor = 0, head = source.length) {
  return createSourceState(source).update({ selection: { anchor, head } }).state
}

describe('Markdown formatting', () => {
  it('formats separate paragraphs and list content without absorbing their block markers', () => {
    const source = 'alpha\n\nbeta'
    const formatted = inlineFormatTransaction(select(source), 'bold')
    expect(formatted?.newDoc.toString()).toBe('**alpha**\n\n**beta**')
    if (!formatted) throw new Error('Expected formatting')
    expect(inlineFormatTransaction(formatted.state, 'bold')?.newDoc.toString()).toBe(source)
    expect(inlineFormatTransaction(select('- alpha\n- beta'), 'italic')?.newDoc.toString()).toBe(
      '- *alpha*\n- *beta*',
    )
  })

  it('limits removal to the selected part of an enclosing style', () => {
    expect(inlineFormatTransaction(select('**alpha beta**', 2, 7), 'bold')?.newDoc.toString()).toBe(
      'alpha **beta**',
    )
    expect(
      inlineFormatTransaction(select('**alpha beta gamma**', 8, 12), 'bold')?.newDoc.toString(),
    ).toBe('**alpha** beta **gamma**')
  })

  it('merges existing formatting when extending it across a mixed selection', () => {
    expect(
      inlineFormatTransaction(select('**one** two **three**'), 'bold')?.newDoc.toString(),
    ).toBe('**one two three**')
    expect(inlineFormatTransaction(select('__alpha__'), 'bold')?.newDoc.toString()).toBe('alpha')
    expect(
      inlineFormatTransaction(select('# alpha #\n\nbeta\n----'), 'bold')?.newDoc.toString(),
    ).toBe('# **alpha** #\n\n**beta**\n----')
  })

  it('removes many independent spans without retaining or duplicating delimiters', () => {
    const words = Array.from({ length: 1000 }, (_, index) => `word${index}`)
    expect(
      inlineFormatTransaction(
        select(words.map((word) => `**${word}**`).join(' ')),
        'bold',
      )?.newDoc.toString(),
    ).toBe(words.join(' '))
  })

  it('does not change code that is included in a larger prose selection', () => {
    const source = 'alpha\n\n```\ncode\n```\n\nbeta'
    expect(inlineFormatTransaction(select(source), 'bold')?.newDoc.toString()).toBe(
      '**alpha**\n\n```\ncode\n```\n\n**beta**',
    )
  })
  it.each(['bold', 'italic'] as const)(
    'toggles %s with a backward selection and one undo step',
    (format) => {
      let state = select('alpha', 5, 0)
      const command = () => {
        const transaction = inlineFormatTransaction(state, format)
        if (!transaction) throw new Error('Expected formatting')
        state = transaction.state
      }
      const history = {
        get state() {
          return state
        },
        dispatch(transaction: Transaction) {
          state = transaction.state
        },
      }
      command()
      const formatted = state.doc.toString()
      expect(formatted).toBe(format === 'bold' ? '**alpha**' : '*alpha*')
      expect(state.selection.main.anchor).toBeGreaterThan(state.selection.main.head)
      expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe('alpha')
      command()
      expect(state.doc.toString()).toBe('alpha')
      expect(undo(history)).toBe(true)
      expect(state.doc.toString()).toBe(formatted)
      expect(redo(history)).toBe(true)
      expect(state.doc.toString()).toBe('alpha')
    },
  )

  it('keeps nested emphasis and code literal while toggling the enclosing style', () => {
    expect(inlineFormatTransaction(select('***alpha***', 3, 8), 'italic')?.newDoc.toString()).toBe(
      '**alpha**',
    )
    expect(inlineFormatTransaction(select('***alpha***', 3, 8), 'bold')?.newDoc.toString()).toBe(
      '*alpha*',
    )
    expect(inlineFormatTransaction(select('**alpha**', 4, 4), 'bold')?.newSelection.main.head).toBe(
      2,
    )
    for (const [source, position] of [
      ['`code`', 3],
      ['```\ncode\n```', 6],
      ['    code', 6],
    ] as const) {
      expect(inlineFormatTransaction(select(source, position, position), 'bold')?.docChanged).toBe(
        false,
      )
    }
  })

  it('places an empty caret inside markers and keeps selected whitespace outside them', () => {
    const empty = inlineFormatTransaction(select('', 0, 0), 'bold')
    expect(empty?.newDoc.toString()).toBe('****')
    expect(empty?.newSelection.main.head).toBe(2)
    if (!empty) throw new Error('Expected empty formatting')
    expect(inlineFormatTransaction(empty.state, 'bold')?.newDoc.toString()).toBe('')
    const padded = inlineFormatTransaction(select(' alpha '), 'bold')
    expect(padded?.newDoc.toString()).toBe(' **alpha** ')
    expect(padded?.newSelection.main.from).toBe(3)
    expect(padded?.newSelection.main.to).toBe(8)
    expect(inlineFormatTransaction(select('   '), 'italic')?.docChanged).toBe(false)
  })

  it('formats multiple selections and removes shared enclosing markers only once', () => {
    const state = createSourceState('one two').update({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]),
    }).state
    expect(inlineFormatTransaction(state, 'bold')?.newDoc.toString()).toBe('**one** **two**')
    const shared = createSourceState('**one two**').update({
      selection: EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(7)]),
    }).state
    const plain = inlineFormatTransaction(shared, 'bold')
    expect(plain?.newDoc.toString()).toBe('one two')
    expect(plain?.newSelection.ranges.map((range) => range.head)).toEqual([1, 5])
  })
})

describe('code-block shortcut', () => {
  it.each([
    ['- ```\n  alpha\n  ```', '- alpha'],
    ['> - ```\n>   alpha\n>   ```', '> - alpha'],
    ['> ```\n> alpha\n> ```', '> alpha'],
  ])('retains its Markdown container when removing a fence: %s', (source, expected) => {
    const position = source.indexOf('alpha') + 2
    const plain = codeBlockTransaction(select(source, position, position))
    expect(plain?.newDoc.toString()).toBe(expected)
    expect(plain?.newSelection.main.head).toBe(expected.indexOf('alpha') + 2)
  })
  it('wraps whole lines and keeps the caret inside the body', () => {
    const transaction = codeBlockTransaction(select('before\nalpha\nafter', 10, 10))
    expect(transaction?.newDoc.toString()).toBe('before\n\n```\nalpha\n```\n\nafter')
    expect(transaction?.newSelection.main.head).toBe(15)
    expect(codeBlockTransaction(select('', 0, 0))?.newSelection.main.head).toBe(4)
  })

  it('excludes a following unselected line and preserves backward selections', () => {
    const transaction = codeBlockTransaction(select('one\ntwo\nthree', 8, 0))
    expect(transaction?.newDoc.toString()).toBe('```\none\ntwo\n```\n\nthree')
    expect(transaction?.newSelection.main.anchor).toBeGreaterThan(
      transaction?.newSelection.main.head ?? 0,
    )
  })

  it('chooses a fence longer than existing backticks and unwraps an authored code block', () => {
    const source = 'one\n```\ntwo'
    expect(codeBlockTransaction(select(source))?.newDoc.toString()).toBe(
      `\`\`\`\`\n${source}\n\`\`\`\``,
    )
    const plain = codeBlockTransaction(select('~~~text\nalpha\nbeta\n~~~~', 10, 15))
    expect(plain?.newDoc.toString()).toBe('alpha\nbeta')
    expect(plain?.newSelection.main.from).toBe(2)
    expect(plain?.newSelection.main.to).toBe(7)
  })

  it('leaves read-only content untouched', () => {
    const state = EditorState.create({ doc: 'alpha', extensions: EditorState.readOnly.of(true) })
    expect(codeBlockTransaction(state)).toBeNull()
    expect(inlineFormatTransaction(state, 'bold')).toBeNull()
  })
})
