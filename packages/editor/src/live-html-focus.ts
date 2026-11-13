import type { EditorSelection, EditorState } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { editingBlock } from './live-editing'
import { blockAtPreview } from './live-preview-position'

/** Escape can precede both the semantic replacement and its viewport layout. */
export const htmlOutputFocus = ViewPlugin.fromClass(
  class {
    private pending:
      | { doc: EditorState['doc']; selection: EditorSelection; from: number }
      | undefined

    constructor(private readonly view: EditorView) {}

    request(from: number): void {
      this.pending = { doc: this.view.state.doc, selection: this.view.state.selection, from }
      this.measure()
    }

    update(update: ViewUpdate): void {
      const pending = this.pending
      if (!pending) return
      if (
        update.docChanged ||
        !update.state.selection.eq(pending.selection) ||
        editingBlock(update.state) ||
        (update.focusChanged && !this.view.hasFocus)
      ) {
        this.pending = undefined
        return
      }
      this.measure()
    }

    private measure(): void {
      const pending = this.pending
      if (!pending) return
      this.view.requestMeasure({
        key: this,
        read: () =>
          [...this.view.dom.querySelectorAll<HTMLElement>('.cm-live-html')].find(
            (element) => blockAtPreview(this.view, element)?.from === pending.from,
          ),
        write: (output) => {
          if (this.pending !== pending) return
          if (
            !this.view.hasFocus ||
            this.view.state.doc !== pending.doc ||
            !this.view.state.selection.eq(pending.selection)
          ) {
            this.pending = undefined
            return
          }
          if (!output?.isConnected) return
          this.pending = undefined
          output.focus({ preventScroll: true })
          output.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        },
      })
    }

    destroy(): void {
      this.pending = undefined
    }
  },
)
