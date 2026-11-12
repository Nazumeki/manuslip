import { EditorSelection } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { createSourceState } from '../../src/index'
import { listIndentTransaction } from '../../src/markdown-list'

function select(source: string, anchor = source.length, head = anchor) {
  return createSourceState(source).update({ selection: { anchor, head } }).state
}

describe('list indentation', () => {
  it('indents a selected loose list without replacing content or adding blank-line spaces', () => {
    const source = '- one\n\n- two'
    const indented = listIndentTransaction(select(source, 0, source.length))
    expect(indented?.newDoc.toString()).toBe('  - one\n\n  - two')
    if (!indented) throw new Error('Expected list indentation')
    expect(listIndentTransaction(indented.state, true)?.newDoc.toString()).toBe(source)
  })

  it('moves selected items with fenced descendants', () => {
    const source = '- before\n- parent\n  ```\n  code\n  ```\n- after'
    const indented = listIndentTransaction(select(source, 9, source.indexOf('\n- after')))
    expect(indented?.newDoc.toString()).toBe(
      '- before\n  - parent\n    ```\n    code\n    ```\n- after',
    )
  })

  it('moves the child list inside an outer list and quote', () => {
    const source = '- > - parent\n  > - child'
    expect(listIndentTransaction(select(source))?.newDoc.toString()).toBe(
      '- > - parent\n  >   - child',
    )
  })
  it.each([
    ['- parent\n- child', '- parent\n  - child'],
    ['-\tparent\n- child', '-\tparent\n    - child'],
    ['10. parent\n11. child', '10. parent\n    11. child'],
    ['- [x] parent\n- [ ] child', '- [x] parent\n  - [ ] child'],
    ['> - parent\n> - child', '> - parent\n>   - child'],
  ])('nests and restores the item at the text caret: %s', (source, nested) => {
    const indented = listIndentTransaction(select(source))
    expect(indented?.newDoc.toString()).toBe(nested)
    if (!indented) throw new Error('Expected list indentation')
    expect(indented.newSelection.main.head).toBe(nested.length)
    expect(listIndentTransaction(indented.state, true)?.newDoc.toString()).toBe(source)
  })

  it('moves descendants and continuation lines with the parent item, exactly once', () => {
    const source = '- before\n- parent\n  continuation\n  - child\n- after'
    const state = select(source, 9, source.indexOf('\n- after'))
    const indented = listIndentTransaction(state)
    expect(indented?.newDoc.toString()).toBe(
      '- before\n  - parent\n    continuation\n    - child\n- after',
    )
    if (!indented) throw new Error('Expected list indentation')
    expect(listIndentTransaction(indented.state, true)?.newDoc.toString()).toBe(source)
  })

  it('outdents standalone indentation and preserves top-level markers', () => {
    expect(listIndentTransaction(select('  - alpha'), true)?.newDoc.toString()).toBe('- alpha')
    expect(listIndentTransaction(select('- alpha'), true)?.docChanged).toBe(false)
  })

  it('indents selected quoted lines while excluding a following line at the selection boundary', () => {
    const source = '> - one\n> - two\n> - three'
    expect(listIndentTransaction(select(source, 0, 16))?.newDoc.toString()).toBe(
      '>   - one\n>   - two\n> - three',
    )
  })

  it('preserves multiple carets and leaves code and prose to their own Tab behavior', () => {
    const source = '- parent\n- one\n- two'
    const state = createSourceState(source).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(14),
        EditorSelection.cursor(source.length),
      ]),
    }).state
    const indented = listIndentTransaction(state)
    expect(indented?.newDoc.toString()).toBe('- parent\n  - one\n  - two')
    expect(indented?.newSelection.ranges.map((range) => range.head)).toEqual([
      16,
      source.length + 4,
    ])
    for (const source of ['plain', '```\n- code\n```', '    - code'])
      expect(listIndentTransaction(select(source))).toBeNull()
  })
})
