import {
  defaultKeymap,
  history,
  historyKeymap,
  insertNewline,
  insertTab,
} from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { bracketMatching, ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view'
import { utf8Bytes } from '@manuslip/core/text'
import { frontmatterEnd } from './frontmatter'
import { sourceHighlightStyle } from './highlight'
import { changedByteLength, documentBytes, limitRejected, maxDocumentBytes } from './limits'
import { defaultEditorPreferences, type EditorPreferences } from './preferences'
import { punctuationInput, punctuationNewline } from './punctuation'
import { textSelection } from './selection'
import { sourceSyntax } from './syntax'

export { isolateHistory, redo, selectAll, undo } from '@codemirror/commands'
export { getSearchQuery, openSearchPanel, SearchQuery } from '@codemirror/search'
export {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  StateEffect,
  Text,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
export { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

export function selectionInCode(state: EditorState): boolean {
  return state.selection.ranges.some((range) => {
    const tree = ensureSyntaxTree(state, range.to, 20)
    if (!tree) return true
    let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(range.from, 1)
    for (; node; node = node.parent) {
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'UnparsedInline'].includes(node.name))
        return true
    }
    return false
  })
}
export { highlightCode } from './code-widget'
export { latexMarkdown, optMarkdown } from './conventions'
export { activeEmbeddedEditor } from './embedded-editor'
export { yamlFrontmatter } from './frontmatter'
export { SourceInputSynchronization } from './input-synchronization'
export { documentBytes, limitRejected, maxDocumentBytes } from './limits'
export * from './live'
export { punctuationAction } from './punctuation'
export interface SourceEditorOptions {
  extensions?: Extension[]
  display?: Extension
  label?: string
  onSave?: () => void
  onSaveAs?: () => void
  onUpdate?: (update: ViewUpdate) => void
  onComposition?: (composing: boolean) => void
  onMode?: (mode: 'source' | 'live') => void
}

/** Display changes reconfigure a compartment without replacing the document or its history. */
export function sourceDisplay(
  preferences: EditorPreferences = defaultEditorPreferences,
): Extension {
  return [
    preferences.lineNumbers ? lineNumbers() : [],
    preferences.wrapLines ? EditorView.lineWrapping : [],
    EditorState.tabSize.of(preferences.tabSize),
  ]
}

function sourceExtensions(options: SourceEditorOptions): Extension[] {
  return [
    ...(options.extensions || []),
    options.display ?? sourceDisplay(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    textSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    syntaxHighlighting(sourceHighlightStyle, { fallback: true }),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    sourceSyntax,
    punctuationInput,
    frontmatterEnd,
    documentBytes,
    EditorState.transactionFilter.of((transaction) => {
      if (
        !transaction.docChanged ||
        changedByteLength(transaction, transaction.startState.field(documentBytes)) <=
          maxDocumentBytes
      )
        return transaction
      return { effects: limitRejected.of(null) }
    }),
    keymap.of([
      {
        key: 'Mod-1',
        run: () => {
          options.onMode?.('source')
          return true
        },
      },
      {
        key: 'Mod-2',
        run: () => {
          options.onMode?.('live')
          return true
        },
      },
      {
        key: 'Mod-s',
        run: () => {
          options.onSave?.()
          return true
        },
      },
      {
        key: 'Mod-Shift-s',
        run: () => {
          options.onSaveAs?.()
          return true
        },
      },
      {
        key: 'Enter',
        run: (view) => {
          if (view.compositionStarted) return false
          const transaction = punctuationNewline(view.state)
          if (transaction) {
            view.dispatch(transaction)
            return true
          }
          return insertNewlineContinueMarkup(view) || insertNewline(view)
        },
      },
      { key: 'Tab', run: insertTab },
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => options.onUpdate?.(update)),
    EditorView.domEventHandlers({
      compositionstart: () => {
        options.onComposition?.(true)
        return false
      },
      compositionend: (_event, view) => {
        queueMicrotask(() => {
          if (!view.compositionStarted) options.onComposition?.(false)
        })
        return false
      },
    }),
    EditorView.contentAttributes.of({
      'aria-label': options.label || 'Markdown source',
      tabindex: '0',
      spellcheck: 'false',
    }),
    EditorView.theme({
      '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--paper)' },
      '.cm-content': {
        fontFamily:
          '"Manuslip CJK", ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace',
        fontSize: '15px',
        lineHeight: '1.75',
        padding: '24px 0',
        caretColor: 'var(--text)',
      },
      '.cm-line': { padding: '0 24px 0 12px' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' },
      '.cm-gutters': {
        backgroundColor: 'var(--surface)',
        color: 'var(--muted)',
        border: 'none',
        paddingInline: '8px',
      },
      '.cm-activeLine': { backgroundColor: 'var(--surface)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
      '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
      '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
      '.cm-textfield': {
        backgroundColor: 'var(--paper)',
        color: 'var(--text)',
        borderColor: 'var(--border)',
      },
      '.cm-button': {
        backgroundImage: 'none',
        backgroundColor: 'var(--paper)',
        color: 'var(--text)',
      },
      '&:has(.cm-search)': { height: 'auto', minHeight: '100%' },
      '&:has(.cm-search) .cm-scroller': { height: '160px', flex: '1 0 160px' },
      '.cm-panel.cm-search': {
        padding: '8px 16px',
        paddingInlineEnd: '64px',
        fontSize: '14px',
        '& input, & button, & label': { margin: '4px 8px 4px 0' },
        '& .cm-textfield': {
          font: 'inherit',
          minHeight: '40px',
          width: 'min(100%, 20ch)',
          padding: '8px 10px',
          border: '1px solid var(--input-border)',
          borderRadius: '6px',
        },
        '& .cm-textfield::placeholder': { color: 'var(--muted)', opacity: '1' },
        '& .cm-button': {
          font: 'inherit',
          minHeight: '40px',
          padding: '6px 12px',
          border: '1px solid var(--border)',
          borderRadius: '6px',
        },
        '& label': {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          minHeight: '40px',
          verticalAlign: 'middle',
          fontSize: '13px',
          whiteSpace: 'nowrap',
        },
        '& input[type=checkbox]': {
          margin: '0',
          width: '16px',
          height: '16px',
          accentColor: 'var(--accent)',
        },
        '& [name=close]': {
          top: 'auto',
          right: 'auto',
          insetBlockStart: '12px',
          insetInlineEnd: '12px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '40px',
          minHeight: '40px',
          margin: '0',
          padding: '0',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          fontSize: '20px',
          backgroundColor: 'var(--paper)',
        },
      },
    }),
  ]
}

export function createSourceState(text: string, options: SourceEditorOptions = {}): EditorState {
  if (utf8Bytes(text) > maxDocumentBytes) throw new Error('Document exceeds editing limit')
  return EditorState.create({ doc: text, extensions: sourceExtensions(options) })
}

export type EditorScrollSnapshot = ReturnType<EditorView['scrollSnapshot']>
export function mountSourceEditor(
  parent: HTMLElement,
  state: EditorState,
  scrollTo?: EditorScrollSnapshot,
): EditorView {
  return new EditorView({ parent, state, scrollTo })
}
