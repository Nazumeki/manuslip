import { EditorSelection, EditorState } from '@codemirror/state'
import { expect, it } from 'vitest'
import { createSourceState, undo } from '../../src/index'
import { liveEditing } from '../../src/live-editing'
import { composingEffect, isComposing, liveModel } from '../../src/live-model'
import { paragraphBelowDocument } from '../../src/live-tail-click'

function state(source: string) {
  return createSourceState(source, { extensions: [liveModel, liveEditing, isComposing] })
}

it.each(['```\nbody\n```', '~~~\nbody\n~~~', '+++\ntitle = "Text"\n+++', 'Paragraph'])(
  'creates one paragraph below %s and reuses it',
  (source) => {
    const result = paragraphBelowDocument(state(source))
    expect(result?.newDoc.toString()).toBe(`${source}\n\n`)
    expect(result?.newSelection.main.head).toBe(source.length + 2)
    if (!result) throw new Error('Expected paragraph')
    expect(paragraphBelowDocument(result.state)?.docChanged).toBe(false)
    let current = result.state
    expect(
      undo({
        get state() {
          return current
        },
        dispatch(tr) {
          current = tr.state
        },
      }),
    ).toBe(true)
    expect(current.doc.toString()).toBe(source)
  },
)

it.each(['', 'Text\n\n', '```\nx\n```\n\n'])('reuses existing empty space in %s', (source) => {
  const result = paragraphBelowDocument(state(source))
  expect(result?.docChanged).toBe(false)
  expect(result?.newSelection.main.head).toBe(source.length)
})

it.each(['```', '```\nbody', '```\nbody\n\n', '````\nx\n```'])(
  'does not pretend to exit an unclosed fence: %s',
  (source) => {
    expect(paragraphBelowDocument(state(source))).toBeNull()
  },
)

it.each(['Text\n', 'Text\n    ', 'Text\n\n    ', 'Text\n\n\t'])(
  'starts a separate paragraph without inheriting trailing indentation: %j',
  (source) => {
    const transaction = paragraphBelowDocument(state(source))
    if (!transaction) throw new Error('Expected paragraph')
    const typed = transaction.state.update(transaction.state.replaceSelection('After'))
    expect(typed.newDoc.toString()).toBe(`Text\n\nAfter${source.match(/[\t ]*$/)?.[0]}`)
    expect(paragraphBelowDocument(transaction.state)?.docChanged).toBe(false)
  },
)

it('collapses a plain-click selection without replacing selected text', () => {
  const selected = state('text').update({ selection: EditorSelection.single(0, 2) }).state
  const transaction = paragraphBelowDocument(selected)
  expect(transaction?.newDoc.toString()).toBe('text\n\n')
  expect(transaction?.newSelection.main.head).toBe(6)
})

it('leaves composition and read-only documents alone', () => {
  const source = state('text')
  expect(
    paragraphBelowDocument(source.update({ effects: composingEffect.of(true) }).state),
  ).toBeNull()
  expect(
    paragraphBelowDocument(
      createSourceState('text', { extensions: [EditorState.readOnly.of(true)] }),
    ),
  ).toBeNull()
})
