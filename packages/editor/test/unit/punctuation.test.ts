import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createSourceState, redo, undo } from '../../src/index'
import {
  punctuationAction,
  punctuationBackspace,
  punctuationInput,
  punctuationNewline,
  punctuationTransaction,
} from '../../src/punctuation'

function type(state: EditorState, text: string) {
  return (
    punctuationTransaction(state, text) ??
    state.update(state.replaceSelection(text), { userEvent: 'input.type' })
  ).state
}

describe('Zed punctuation ownership', () => {
  it.each(['```', '***', '"', ')', ']', '}'])(
    'replaces selected punctuation %s instead of surrounding it',
    (source) => {
      const state = createSourceState(source).update({
        selection: { anchor: 0, head: source.length },
      }).state
      expect(type(state, '`').doc.toString()).toBe('`')
      expect(type(state, '(').doc.toString()).toBe('(')
    },
  )
  it.each(['()', '[]', '{}', '<>'])(
    'allows replacing and deleting the generated closer in %s',
    (pair) => {
      const generated = type(createSourceState(''), pair.charAt(0))
      const selected = generated.update({ selection: { anchor: 1, head: 2 } }).state
      const replaced = type(selected, '!')
      expect(replaced.doc.toString()).toBe(`${pair[0]}!`)
      const deleted = generated.update({ changes: { from: 1, to: 2 } }).state
      expect(type(deleted, pair.charAt(1)).doc.toString()).toBe(pair)
      expect(type(replaced, pair.charAt(1)).doc.toString()).toBe(`${pair[0]}!${pair[1]}`)
    },
  )
  it('opens a generated bracket body on Enter and preserves its closer ownership', () => {
    const state = type(createSourceState('  ').update({ selection: { anchor: 2 } }).state, '{')
    const expanded = punctuationNewline(state)
    expect(expanded?.newDoc.toString()).toBe('  {\n    \n  }')
    expect(expanded?.newSelection.main.head).toBe(8)
    expect(expanded?.annotation(punctuationAction)?.expanded).toBe(1)
    const authored = createSourceState('{}').update({ selection: { anchor: 1 } }).state
    expect(punctuationNewline(authored)).toBeNull()
  })
  it('uses code language pairs and keeps an existing string closer literal', () => {
    const code = (source: string) =>
      EditorState.create({
        doc: source,
        selection: { anchor: source.length },
        extensions: [
          punctuationInput,
          EditorState.languageData.of(() => [
            { closeBrackets: { brackets: ['(', '[', '{', '"', "'", '`'] } },
          ]),
        ],
      })
    expect(type(code('const value = '), '"').doc.toString()).toBe('const value = ""')
    expect(punctuationTransaction(code('const value = "a '), '"')).toBeNull()
    expect(punctuationTransaction(code('const value = "a" '), '"')?.newDoc.toString()).toBe(
      'const value = "a" ""',
    )
    expect(punctuationTransaction(code('name'), '"')).toBeNull()
    expect(punctuationTransaction(code(''), '<')).toBeNull()
  })
  it.each(['()', '[]', '{}', '<>'])('pairs %s and skips only its generated closer', (pair) => {
    const state = type(createSourceState(''), pair.charAt(0))
    expect(state.doc.toString()).toBe(pair)
    expect(state.selection.main.head).toBe(1)
    const skip = punctuationTransaction(state, pair.charAt(1))
    if (!skip) throw new Error('Expected a generated closer')
    expect(skip.docChanged).toBe(false)
    expect(skip.newSelection.main.head).toBe(2)
    expect(skip.annotation(punctuationAction)?.skipped).toBe(1)
    expect(punctuationBackspace(state)?.newDoc.toString()).toBe('')
    const authored = createSourceState(pair).update({ selection: { anchor: 1 } }).state
    expect(punctuationTransaction(authored, pair.charAt(1))).toBeNull()
    expect(punctuationBackspace(authored)).toBeNull()
  })

  it.each(['"', "'", '`', '*', '~', '_', '=', '^', '$'])(
    'keeps empty-caret Markdown %s literal',
    (marker) => {
      expect(type(createSourceState(''), marker).doc.toString()).toBe(marker)
    },
  )

  it.each(['()', '[]', '{}', '<>', '""', "''", '``', '**', '~~'])(
    'surrounds a reversed selection with %s without losing its direction',
    (pair) => {
      const state = createSourceState('word').update({ selection: { anchor: 4, head: 0 } }).state
      const next = type(state, pair.charAt(0))
      expect(next.doc.toString()).toBe(`${pair[0]}word${pair[1]}`)
      expect(next.selection.main.anchor).toBe(5)
      expect(next.selection.main.head).toBe(1)
    },
  )

  it('handles mixed carets and selections in one admitted edit', () => {
    const state = createSourceState('word x').update({
      selection: EditorSelection.create([EditorSelection.range(4, 0), EditorSelection.cursor(6)]),
    }).state
    const next = type(state, '(')
    expect(next.doc.toString()).toBe('(word) x()')
    expect(next.selection.ranges.map((range) => [range.anchor, range.head])).toEqual([
      [5, 1],
      [9, 9],
    ])
    expect(punctuationBackspace(next)?.newDoc.toString()).toBe('() x')
  })

  it('respects following text, escapes and the Markdown punctuation boundary', () => {
    for (const source of ['word', '\\']) {
      const state = createSourceState(source).update({
        selection: { anchor: source === '\\' ? 1 : 0 },
      }).state
      expect(punctuationTransaction(state, '(')).toBeNull()
    }
    for (const next of ';:.,=}])> \n') {
      const state = createSourceState(next)
      expect(type(state, '(').doc.toString()).toBe(`()${next}`)
    }
  })

  it('maps ownership across edits inside the pair and releases it when the caret leaves', () => {
    let state = type(createSourceState(''), '(')
    state = type(state, 'abc')
    expect(state.doc.toString()).toBe('(abc)')
    expect(punctuationTransaction(state, ')')?.docChanged).toBe(false)
    state = state.update({ selection: { anchor: 0 } }).state
    state = state.update({ selection: { anchor: 4 } }).state
    expect(punctuationTransaction(state, ')')).toBeNull()
  })

  it('deletes an owned pair and another caret grapheme in the same transaction', () => {
    let state = type(createSourceState('😀 ').update({ selection: { anchor: 3 } }).state, '(')
    state = state.update({
      selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(4)]),
    }).state
    expect(punctuationBackspace(state)?.newDoc.toString()).toBe(' ')
  })

  it('keeps generated pairs atomic in undo/redo and ignores read-only input', () => {
    let state = type(createSourceState(''), '(')
    const target = {
      get state() {
        return state
      },
      dispatch(transaction: import('@codemirror/state').Transaction) {
        state = transaction.state
      },
    }
    expect(undo(target)).toBe(true)
    expect(state.doc.toString()).toBe('')
    expect(redo(target)).toBe(true)
    expect(state.doc.toString()).toBe('()')
    const locked = createSourceState('', { extensions: [EditorState.readOnly.of(true)] })
    expect(punctuationTransaction(locked, '(')).toBeNull()
    expect(punctuationBackspace(locked)).toBeNull()
  })
})
