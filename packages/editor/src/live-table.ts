import { defaultKeymap, isolateHistory, redo, undo } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import {
  type ChangeDesc,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state'
import { drawSelection, EditorView, keymap, runScopeHandlers, ViewPlugin } from '@codemirror/view'
import { registerEmbeddedEditor } from './embedded-editor'
import { cellHighlightStyle, codeHighlightStyle } from './highlight'
import { SourceInputSynchronization } from './input-synchronization'
import { activateLiveBlock, editingBlock, editLiveBlock } from './live-editing'
import { isComposing, type LiveBlock, type LiveOptions } from './live-model'
import { renderedTextHit, sourcePositionAtText } from './live-position'
import {
  type LiveCell,
  tableCellInput,
  tableRowInsertion,
  tableSourceCells,
} from './live-table-source'
import { markdownFormatting } from './markdown-format'
import { punctuationAction, punctuationInput } from './punctuation'
import { sourceSyntax } from './syntax'

const activeTables = new WeakMap<EditorView, LiveTable>()

export const tableEditing = ViewPlugin.define(() => ({
  update(update) {
    const active = activeTables.get(update.view)
    if (update.docChanged) active?.map(update.changes)
    if (
      update.docChanged ||
      update.selectionSet ||
      update.transactions.some((tr) => tr.effects.length)
    )
      queueMicrotask(() => active?.synchronize())
  },
}))

/** A table keeps its semantic layout. Only the focused cell owns a small editor;
 * every change is committed immediately to the authoritative document's history.
 */
export class LiveTable {
  private editor: EditorView | null = null
  private cell: LiveCell | null = null
  private cellContent: DocumentFragment | undefined
  private sourceCells: { doc: EditorState['doc']; block: LiveBlock; rows: LiveCell[][] } | undefined
  private renderLifetime = new AbortController()
  private unregister: (() => void) | undefined
  private syncing = false
  private pendingRender = false
  private readonly editable = new Compartment()

  constructor(
    private readonly container: HTMLElement,
    private readonly content: HTMLElement,
    private readonly view: EditorView,
    private block: LiveBlock,
    private readonly options: LiveOptions,
    private readonly signal: AbortSignal,
  ) {
    this.render()
    container.addEventListener(
      'mousedown',
      (event) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          this.editor?.compositionStarted ||
          this.view.compositionStarted ||
          this.view.state.field(isComposing) ||
          this.view.state.readOnly
        )
          return
        const cell =
          event.target instanceof Element ? event.target.closest<HTMLElement>('th, td') : null
        if (
          !cell ||
          !container.contains(cell) ||
          (event.target instanceof Element &&
            event.target.closest(
              '.cm-live-cell-active .cm-editor, button, input, a[data-footnote-ref], a[data-footnote-backref]',
            ))
        )
          return
        event.preventDefault()
        event.stopPropagation()
        this.open(Number(cell.dataset.row), Number(cell.dataset.column), event)
      },
      { signal },
    )
    signal.addEventListener('abort', () => this.destroy(), { once: true })
  }

  update(block: LiveBlock): void {
    const changed = this.block.html !== block.html
    this.block = block
    queueMicrotask(() => {
      if (this.signal.aborted) return
      if (changed) this.pendingRender = true
      this.synchronize()
    })
  }

  private render(): void {
    this.pendingRender = false
    const focused = this.editor?.hasFocus
    const dom = this.editor?.dom
    const scrollLeft = this.content.querySelector('.render-table-scroll')?.scrollLeft ?? 0
    const table = this.content.querySelector('table')
    const layout = dom && table ? this.tableLayout(table) : undefined
    if (dom) dom.remove()
    this.cellContent = undefined
    this.renderLifetime.abort()
    this.renderLifetime = new AbortController()
    this.options.render(this.content, this.block, this.renderLifetime.signal, () =>
      this.view.requestMeasure(),
    )
    for (const [row, element] of [...this.content.querySelectorAll('tr')].entries())
      for (const [column, cell] of [...element.querySelectorAll<HTMLElement>('th, td')].entries()) {
        cell.dataset.row = String(row)
        cell.dataset.column = String(column)
        cell.tabIndex = 0
      }
    if (dom && this.cell) {
      const target = this.element(this.cell.row, this.cell.column)
      if (target) {
        this.lockColumns(target, layout)
        this.mountCell(target, dom)
        if (focused) this.editor?.focus()
      }
    }
    const scroll = this.content.querySelector('.render-table-scroll')
    if (scroll) scroll.scrollLeft = scrollLeft
    this.container.addEventListener('keydown', this.keydown, { signal: this.signal })
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (
      !(event.target instanceof HTMLElement) ||
      this.view.state.readOnly ||
      this.view.composing ||
      this.view.state.field(isComposing)
    )
      return
    if (event.target === this.container) {
      if (event.key === 'F2' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        this.focusFirstCell()
      }
      return
    }
    if (!event.target.matches('th, td')) return
    if (event.key !== 'Enter' && event.key !== 'F2') return
    event.preventDefault()
    event.stopPropagation()
    this.open(Number(event.target.dataset.row), Number(event.target.dataset.column))
  }

  private element(row: number, column: number): HTMLElement | null {
    return this.content.querySelector(`[data-row="${row}"][data-column="${column}"]`)
  }

  focusFirstCell(): void {
    if (!this.view.state.readOnly) this.open(0, 0)
  }

  private cells(): LiveCell[][] {
    const block = editingBlock(this.view.state)?.block
    const current = block?.kind === 'table' && block.from === this.block.from ? block : this.block
    if (this.sourceCells?.doc !== this.view.state.doc || this.sourceCells.block !== current)
      this.sourceCells = {
        doc: this.view.state.doc,
        block: current,
        rows: tableSourceCells(this.view.state, current),
      }
    return this.sourceCells.rows
  }

  private open(row: number, column: number, event?: MouseEvent): void {
    const cell = this.cells()[row]?.[column]
    if (!cell) return
    if (this.editor && this.cell?.row === row && this.cell.column === column) {
      if (event) {
        const bounds = this.editor.contentDOM.getBoundingClientRect()
        const position = this.editor.posAtCoords({
          x: event.clientX,
          y: Math.max(bounds.top + 1, Math.min(bounds.bottom - 1, event.clientY)),
        })
        if (position !== null) this.editor.dispatch({ selection: { anchor: position } })
      }
      this.editor.focus()
      return
    }
    const target = this.element(row, column)
    if (!target) return
    const text = this.view.state.doc.sliceString(cell.from, cell.to)
    const hit = event && renderedTextHit(target, event, text)
    const at = (hit && sourcePositionAtText(text, hit, 'table')) ?? 0
    const current = editingBlock(this.view.state)?.block
    activateLiveBlock(
      this.view,
      current?.kind === 'table' && current.from === this.block.from ? current : this.block,
      cell.from + at,
      { focus: false, scrollIntoView: false },
    )
    this.closeCell(true)
    this.cell = cell
    this.lockColumns(target)
    this.cellContent = document.createDocumentFragment()
    this.cellContent.append(...target.childNodes)
    target.classList.add('cm-live-cell-active')
    activeTables.set(this.view, this)
    const label = `${this.options.sourceLabel()} · ${row + 1}:${column + 1}`
    const inner = new EditorView({
      parent: target,
      state: EditorState.create({
        doc: text,
        selection: { anchor: at },
        extensions: [
          sourceSyntax,
          punctuationInput,
          markdownFormatting(false),
          syntaxHighlighting(codeHighlightStyle),
          syntaxHighlighting(cellHighlightStyle),
          drawSelection(),
          EditorView.lineWrapping,
          this.editable.of(EditorState.readOnly.of(this.view.state.readOnly)),
          EditorView.contentAttributes.of({
            'aria-label': label,
            spellcheck: 'false',
            'data-table-cell-editor': 'true',
          }),
          EditorState.transactionFilter.of(tableCellInput),
          keymap.of([
            { key: 'Mod-z', run: () => undo(this.view) },
            { key: 'Mod-Shift-z', run: () => redo(this.view) },
            { key: 'Mod-y', run: () => redo(this.view) },
            { key: 'Tab', run: () => this.move(1, true) },
            { key: 'Shift-Tab', run: () => this.move(-1) },
            { key: 'Enter', run: () => this.enter() },
            {
              key: 'Shift-Enter',
              run: (view) => {
                if (view.compositionStarted || view.state.readOnly) return false
                view.dispatch(view.state.replaceSelection('<br />'), { userEvent: 'input.type' })
                return true
              },
            },
            { key: 'Mod-Enter', run: () => this.enter(true) },
            {
              key: 'Escape',
              run: () => {
                this.finish()
                return true
              },
            },
            ...defaultKeymap,
          ]),
          EditorView.domEventHandlers({
            compositionend: () => {
              this.view.requestMeasure({
                read: () => undefined,
                write: () => queueMicrotask(() => this.synchronize()),
              })
              return false
            },
            keydown: (event) => {
              // Document shortcuts keep their existing handlers and save barriers.
              if (
                (event.ctrlKey || event.metaKey) &&
                ['s', '1', '2', 'f'].includes(event.key.toLowerCase())
              )
                return runScopeHandlers(this.view, event, 'editor')
              return false
            },
          }),
          EditorView.updateListener.of((update) => {
            if (this.syncing || !this.cell || (!update.docChanged && !update.selectionSet)) return
            const current = this.cell
            if (this.view.state.readOnly) return
            const changes: { from: number; to: number; insert: string }[] = []
            update.changes.iterChanges((from, to, _nextFrom, _nextTo, inserted) => {
              changes.push({
                from: current.from + from,
                to: current.from + to,
                insert: inserted.toString(),
              })
            })
            const selection = update.state.selection.main
            const padding = update.docChanged && current.prefix ? current.prefix.length : 0
            this.view.dispatch({
              ...(changes.length
                ? {
                    changes: current.prefix
                      ? {
                          from: current.from,
                          to: current.to,
                          insert:
                            current.prefix + update.state.doc.toString() + (current.suffix ?? ''),
                        }
                      : changes,
                  }
                : {}),
              selection: {
                anchor: current.from + padding + selection.anchor,
                head: current.from + padding + selection.head,
              },
              // Only the cell owns the native pointer selection. Forwarding
              // select.pointer makes CodeMirror move DOM focus into the parent.
              userEvent: update.docChanged
                ? (update.transactions
                    .find((tr) => tr.annotation(Transaction.userEvent))
                    ?.annotation(Transaction.userEvent) ?? 'input')
                : 'select',
              annotations: update.transactions.flatMap((transaction) => {
                const action = transaction.annotation(punctuationAction)
                const isolation = transaction.annotation(isolateHistory)
                return [
                  ...(action ? [punctuationAction.of(action)] : []),
                  ...(isolation ? [isolateHistory.of(isolation)] : []),
                ]
              }),
            })
            if (padding)
              this.cell = {
                row: current.row,
                column: current.column,
                from: current.from + padding,
                to: current.from + padding + update.state.doc.length,
              }
          }),
        ],
      }),
    })
    this.editor = inner
    this.unregister = registerEmbeddedEditor(
      this.view,
      inner,
      new SourceInputSynchronization(inner),
    )
    if (!event) inner.dispatch({ scrollIntoView: true })
    inner.focus()
  }

  private tableLayout(table: HTMLTableElement): { width: number; columns: number[] } {
    return {
      width: table.getBoundingClientRect().width,
      columns: [...(table.rows[0]?.cells ?? [])].map((cell) => cell.getBoundingClientRect().width),
    }
  }

  private lockColumns(target: HTMLElement, layout?: { width: number; columns: number[] }): void {
    const table = target.closest('table')
    if (!table || table.querySelector('colgroup[data-live-columns]')) return
    const measured = layout ?? this.tableLayout(table)
    const columns = document.createElement('colgroup')
    columns.dataset.liveColumns = 'true'
    for (const width of measured.columns) {
      const column = document.createElement('col')
      column.style.width = `${width}px`
      columns.append(column)
    }
    table.style.width = `${measured.width}px`
    table.style.tableLayout = 'fixed'
    table.prepend(columns)
  }

  private mountCell(target: HTMLElement, dom: HTMLElement): void {
    this.cellContent = document.createDocumentFragment()
    this.cellContent.append(...target.childNodes)
    target.replaceChildren(dom)
    target.classList.add('cm-live-cell-active')
  }

  map(changes: ChangeDesc): void {
    if (this.cell)
      this.cell = {
        ...this.cell,
        from: changes.mapPos(this.cell.from, -1),
        to: changes.mapPos(this.cell.to, 1),
      }
  }

  synchronize(): void {
    if (this.signal.aborted) return
    if (this.editor?.compositionStarted) return
    if (this.pendingRender) {
      this.pendingRender = false
      this.render()
    }
    if (!this.editor || !this.cell) return
    const editing = editingBlock(this.view.state)
    if (editing?.block.kind !== 'table' || editing.block.from !== this.block.from) {
      this.closeCell()
      this.render()
      return
    }
    if (this.editor.compositionStarted) return
    const parsed = this.cells()[this.cell.row]?.[this.cell.column]
    if (!parsed) {
      this.finish()
      return
    }
    if (this.cell.prefix || parsed.prefix) this.cell = parsed
    const cell = this.cell
    const text = this.view.state.doc.sliceString(cell.from, cell.to)
    const main = this.view.state.selection.main
    const selection = EditorSelection.single(
      Math.max(0, Math.min(text.length, main.anchor - cell.from)),
      Math.max(0, Math.min(text.length, main.head - cell.from)),
    )
    const changed = text !== this.editor.state.doc.toString()
    const editableChanged = this.editor.state.readOnly !== this.view.state.readOnly
    if (!changed && !editableChanged && this.editor.state.selection.eq(selection)) return
    this.syncing = true
    try {
      this.editor.dispatch({
        // This mirrors already accepted parent source, including undo restoring
        // a legacy oversized cell. Admission/normalization applies to child input.
        filter: false,
        ...(changed
          ? { changes: { from: 0, to: this.editor.state.doc.length, insert: text } }
          : {}),
        selection,
        ...(editableChanged
          ? {
              effects: this.editable.reconfigure(EditorState.readOnly.of(this.view.state.readOnly)),
            }
          : {}),
      })
    } finally {
      this.syncing = false
    }
  }

  private enter(addRow = false): boolean {
    if (!this.editor || this.editor.compositionStarted || this.view.state.readOnly) return false
    if (addRow) return this.insertRow(undefined, true)
    const selected = !this.editor.state.selection.main.empty
    if (selected)
      this.editor.dispatch(this.editor.state.replaceSelection(''), {
        userEvent: 'delete.selection',
      })
    return this.move(this.cells()[0]?.length ?? 1, false, !selected)
  }

  private move(delta: number, append = false, select = true): boolean {
    if (!this.cell || this.editor?.compositionStarted || this.view.state.readOnly) return false
    const cells = this.cells()
    const columns = cells[0]?.length ?? 1
    const at = this.cell.row * columns + this.cell.column + delta
    const next = at < 0 ? undefined : cells[Math.floor(at / columns)]?.[at % columns]
    if (next) {
      this.open(next.row, next.column)
      if (select && this.editor)
        this.editor.dispatch({ selection: { anchor: 0, head: this.editor.state.doc.length } })
    } else if (append && delta > 0) this.insertRow(0)
    else this.finish(delta < 0)
    return true
  }

  private insertRow(column = this.cell?.column ?? 0, removeSelection = false): boolean {
    if (!this.cell || this.editor?.compositionStarted || this.view.state.readOnly) return false
    const block = editingBlock(this.view.state)?.block ?? this.block
    const change = tableRowInsertion(this.view.state, block, this.cell.row)
    if (!change) return true
    const table = this.content.querySelector('table')
    if (!table) return true
    const row = this.cell.row + 1
    const columns = this.cells()[0]?.length ?? 0
    const previous = this.view.state.doc
    const selected = removeSelection ? this.editor?.state.selection.main : undefined
    const changes =
      selected && !selected.empty
        ? [
            { from: this.cell.from + selected.from, to: this.cell.from + selected.to, insert: '' },
            change,
          ]
        : change
    this.view.dispatch({
      changes,
      userEvent: 'input.table',
      annotations: isolateHistory.of('full'),
    })
    if (this.view.state.doc === previous) return true
    this.closeCell(true)
    const element = table.ownerDocument.createElement('tr')
    for (let column = 0; column < columns; column++)
      element.append(table.ownerDocument.createElement('td'))
    const body = table.tBodies[0] ?? table.createTBody()
    body.insertBefore(element, table.rows[row] ?? null)
    for (const [index, element] of [...table.rows].entries())
      for (const [column, cell] of [...element.cells].entries()) {
        cell.dataset.row = String(index)
        cell.dataset.column = String(column)
        cell.tabIndex = 0
      }
    this.open(row, column)
    return true
  }

  private finish(backward = false): void {
    const scroll = this.content.querySelector('.render-table-scroll')
    const left = scroll?.scrollLeft ?? 0
    const editing = editingBlock(this.view.state)
    const edge = backward ? (editing?.from ?? this.block.from) : (editing?.to ?? this.block.to)
    // A replacement block has no native text caret. Use its neighboring line,
    // so the browser cannot reinterpret a boundary caret on the opposite side.
    const at = Math.max(0, Math.min(this.view.state.doc.length, edge + (backward ? -1 : 1)))
    this.view.dispatch({
      effects: editLiveBlock.of(null),
      selection: EditorSelection.create([EditorSelection.cursor(at, backward ? -1 : 1)]),
    })
    this.view.focus()
    if (scroll) scroll.scrollLeft = left
  }

  private destroy(): void {
    this.renderLifetime.abort()
    this.closeCell()
  }

  private closeCell(keepCells = false): void {
    const scroll = this.content.querySelector('.render-table-scroll')
    const left = scroll?.scrollLeft ?? 0
    if (!keepCells) this.sourceCells = undefined
    const target = this.cell && this.element(this.cell.row, this.cell.column)
    if (target && this.cellContent) {
      target.replaceChildren(this.cellContent)
      target.classList.remove('cm-live-cell-active')
    }
    this.cellContent = undefined
    this.editor?.destroy()
    this.unregister?.()
    this.editor = null
    this.cell = null
    // Restoring native cell contents can reset an ancestor's scroll position.
    if (scroll) scroll.scrollLeft = left
    if (activeTables.get(this.view) === this) activeTables.delete(this.view)
  }
}
