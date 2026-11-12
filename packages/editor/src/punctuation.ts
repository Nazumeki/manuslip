import { indentUnit } from '@codemirror/language'
import {
  Annotation,
  EditorSelection,
  type EditorState,
  findClusterBreak,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

interface Pair {
  from: number
  to: number
  open: string
  close: string
}

interface PunctuationAction {
  paired: number
  surrounded: number
  skipped: number
  removed: number
  expanded: number
}

export const punctuationAction = Annotation.define<PunctuationAction>()
const rememberPairs = StateEffect.define<readonly Pair[]>({
  map: (pairs, changes) =>
    pairs.map((pair) => ({
      ...pair,
      from: changes.mapPos(pair.from, -1),
      to: changes.mapPos(pair.to, 1),
    })),
})

const ownedPairs = StateField.define<readonly Pair[]>({
  create: () => [],
  update(pairs, transaction) {
    if (transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return []
    const mapped: Pair[] = []
    for (const pair of pairs) {
      let damaged = false
      transaction.changes.iterChangedRanges((from, to) => {
        if ((from < pair.from && to > pair.from - 1) || (from < pair.to + 1 && to > pair.to))
          damaged = true
      })
      if (!damaged)
        mapped.push({
          ...pair,
          from: transaction.changes.mapPos(pair.from, -1),
          to: transaction.changes.mapPos(pair.to, 1),
        })
    }
    for (const effect of transaction.effects)
      if (effect.is(rememberPairs)) mapped.push(...effect.value)
    return mapped.filter((pair) =>
      transaction.newSelection.ranges.some(
        (range) => range.empty && range.head >= pair.from && range.head <= pair.to,
      ),
    )
  },
})

// Zed's Markdown rules: close brackets, surround quotes/backticks/*/~, and
// leave ordinary prose punctuation literal. Language data supplies code pairs.
const markdownPairs = new Map([
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['*', '*'],
  ['~', '~'],
])
const before = ';:.,=}])>'
const delimiters = new Set([...markdownPairs].flat())

function configuration(state: EditorState, at: number) {
  const language = state.languageDataAt<{ brackets?: string[] }>('closeBrackets', at)[0]
  const brackets = language?.brackets
  return {
    pairs: brackets
      ? new Map(brackets.map((open) => [open, markdownPairs.get(open) ?? open]))
      : markdownPairs,
    closes: (open: string) => (brackets ? brackets.includes(open) : '([{<'.includes(open)),
  }
}

function escaped(state: EditorState, at: number): boolean {
  let slashes = 0
  while (at > 0 && state.sliceDoc(at - 1, at) === '\\') {
    slashes++
    at--
  }
  return slashes % 2 === 1
}

function symmetricOpening(state: EditorState, at: number, marker: string): boolean {
  const line = state.doc.lineAt(at)
  let count = 0
  let isEscaped = false
  for (const chunk of state.doc.iterRange(line.from, at))
    for (const character of chunk) {
      if (!isEscaped && character === marker) count++
      isEscaped = !isEscaped && character === '\\'
    }
  return count % 2 === 0
}

/** Native text input only. Each selection can pair, surround, skip or insert
 * independently, with all changes admitted by the editor's normal filters.
 */
export function punctuationTransaction(state: EditorState, text: string) {
  if (state.readOnly || text.length !== 1) return null
  const pairs = state.field(ownedPairs, false) ?? []
  const action: PunctuationAction = {
    paired: 0,
    surrounded: 0,
    skipped: 0,
    removed: 0,
    expanded: 0,
  }
  const changes = state.changeByRange((range) => {
    const config = configuration(state, range.head)
    const close = config.pairs.get(text)
    // Replacing a selected delimiter must not wrap it in yet more delimiters.
    // Keep surround-selection for content, including repeated emphasis gestures.
    const replacingDelimiter =
      !range.empty &&
      [...state.sliceDoc(range.from, range.to)].every((char) => delimiters.has(char))
    if (!range.empty && close && !replacingDelimiter) {
      action.surrounded++
      return {
        changes: [
          { from: range.from, insert: text },
          { from: range.to, insert: close },
        ],
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      }
    }
    if (range.empty) {
      const owned = pairs.find((pair) => pair.to === range.head && pair.close === text)
      if (owned && state.sliceDoc(range.head, range.head + 1) === text) {
        action.skipped++
        return { range: EditorSelection.cursor(range.head + 1) }
      }
      const next = state.sliceDoc(range.head, range.head + 1)
      const previous = state.sliceDoc(Math.max(0, range.head - 1), range.head)
      if (
        close &&
        config.closes(text) &&
        !escaped(state, range.head) &&
        (!next || /\s/u.test(next) || before.includes(next)) &&
        (text !== close ||
          (!/[\p{L}\p{N}_]/u.test(previous) && symmetricOpening(state, range.head, text)))
      ) {
        action.paired++
        return {
          changes: { from: range.head, insert: text + close },
          range: EditorSelection.cursor(range.head + 1),
          effects: rememberPairs.of([
            { from: range.head + 1, to: range.head + 1, open: text, close },
          ]),
        }
      }
    }
    return {
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + 1),
    }
  })
  return action.paired || action.surrounded || action.skipped
    ? state.update(changes, {
        userEvent: 'input.type',
        annotations: punctuationAction.of(action),
        scrollIntoView: true,
      })
    : null
}

export function punctuationBackspace(state: EditorState) {
  if (state.readOnly) return null
  const pairs = state.field(ownedPairs, false) ?? []
  const action: PunctuationAction = {
    paired: 0,
    surrounded: 0,
    skipped: 0,
    removed: 0,
    expanded: 0,
  }
  const changes = state.changeByRange((range) => {
    const pair =
      range.empty && pairs.find((pair) => pair.from === range.head && pair.to === range.head)
    if (pair && state.sliceDoc(range.head - 1, range.head + 1) === pair.open + pair.close) {
      action.removed++
      return {
        changes: { from: range.head - 1, to: range.head + 1 },
        range: EditorSelection.cursor(range.head - 1),
      }
    }
    const line = state.doc.lineAt(range.from)
    const from = !range.empty
      ? range.from
      : range.from === line.from
        ? Math.max(0, range.from - 1)
        : line.from + findClusterBreak(line.text, range.from - line.from, false)
    return { changes: { from, to: range.to }, range: EditorSelection.cursor(from) }
  })
  return action.removed
    ? state.update(changes, {
        userEvent: 'delete.backward',
        annotations: punctuationAction.of(action),
        scrollIntoView: true,
      })
    : null
}

/** Zed's newline-enabled pairs open an indented body in one history entry. */
export function punctuationNewline(state: EditorState) {
  if (state.readOnly) return null
  const pairs = state.field(ownedPairs, false) ?? []
  const action: PunctuationAction = {
    paired: 0,
    surrounded: 0,
    skipped: 0,
    removed: 0,
    expanded: 0,
  }
  const changes = state.changeByRange((range) => {
    const pair =
      range.empty &&
      pairs.find(
        (pair) => pair.from === range.head && pair.to === range.head && pair.open !== pair.close,
      )
    const line = state.doc.lineAt(range.from)
    const base = /^[\t ]*/.exec(line.text)?.[0] ?? ''
    if (pair) {
      action.expanded++
      const body = base + state.facet(indentUnit)
      return {
        changes: { from: range.head, insert: `\n${body}\n${base}` },
        range: EditorSelection.cursor(range.head + 1 + body.length),
      }
    }
    return {
      changes: { from: range.from, to: range.to, insert: `\n${base}` },
      range: EditorSelection.cursor(range.from + 1 + base.length),
    }
  })
  return action.expanded
    ? state.update(changes, {
        userEvent: 'input.type',
        annotations: punctuationAction.of(action),
        scrollIntoView: true,
      })
    : null
}

export const punctuationInput = [
  ownedPairs,
  EditorView.inputHandler.of((view, from, to, text) => {
    if (
      view.compositionStarted ||
      from !== view.state.selection.main.from ||
      to !== view.state.selection.main.to
    )
      return false
    const transaction = punctuationTransaction(view.state, text)
    if (!transaction) return false
    view.dispatch(transaction)
    return true
  }),
  keymap.of([
    {
      key: 'Backspace',
      run(view) {
        if (view.compositionStarted) return false
        const transaction = punctuationBackspace(view.state)
        if (!transaction) return false
        view.dispatch(transaction)
        return true
      },
    },
  ]),
]
