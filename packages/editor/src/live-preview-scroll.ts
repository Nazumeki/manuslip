import type { Extension, SelectionRange } from '@codemirror/state'
import { EditorView, runScopeHandlers, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { RenderedWidget } from './live-blocks'
import { editingBlock, editLiveBlock } from './live-editing'
import { isComposing, type LiveOptions } from './live-model'
import { dockLivePreview, hasEditingPreview, previewIsDocked } from './live-preview-layout'

interface Span {
  top: number
  bottom: number
}

/** The smallest movement that reveals a complete editing context. An oversized
 * context must not displace the caret just to reveal its other end.
 */
export function previewScrollDelta(viewport: Span, context: Span): number | undefined {
  const margin = Math.min(16, (viewport.bottom - viewport.top) / 4)
  const top = viewport.top + margin,
    bottom = viewport.bottom - margin
  if (bottom <= top || context.bottom - context.top > bottom - top) return
  if (context.top < top) return context.top - top
  if (context.bottom > bottom) return context.bottom - bottom
  return 0
}

function measureContext(view: EditorView): number | 'dock' | undefined {
  const editing = editingBlock(view.state)
  if (
    !editing ||
    !hasEditingPreview(editing.block, view.state) ||
    view.compositionStarted ||
    view.state.field(isComposing)
  )
    return
  const scroller = view.scrollDOM
  const bounds = scroller.getBoundingClientRect()
  const window = view.dom.ownerDocument.defaultView
  if (!window || !scroller.clientHeight) return
  const visual = window.visualViewport
  const viewport = {
    top: Math.max(bounds.top + scroller.clientTop * view.scaleY, visual?.offsetTop ?? 0),
    bottom: Math.min(
      bounds.top + (scroller.clientTop + scroller.clientHeight) * view.scaleY,
      (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight),
    ),
  }
  if (previewIsDocked(view.state)) {
    const caret = view.coordsAtPos(view.state.selection.main.head)
    const delta = caret ? previewScrollDelta(viewport, caret) : undefined
    return delta === undefined ? undefined : delta / view.scaleY
  }
  const end =
    editing.block.kind === 'inlineMath' ? view.state.doc.lineAt(editing.to).to : editing.to
  // Line blocks include the after-source widget even outside the mounted DOM.
  // Use CodeMirror's height map rather than scanning all source lines or forcing
  // the preview into a second, temporary viewport to measure it.
  const context = {
    top:
      (editing.block.kind === 'inlineMath' ? view.coordsAtPos(editing.from, 1)?.top : undefined) ??
      view.documentTop + view.lineBlockAt(editing.from).top,
    bottom: view.documentTop + view.lineBlockAt(end).bottom,
  }
  let delta = previewScrollDelta(viewport, context)
  if (delta === undefined) {
    const caret = view.coordsAtPos(view.state.selection.main.head)
    if (caret) delta = previewScrollDelta(viewport, { top: caret.top, bottom: context.bottom })
  }
  // A preview outside the virtualized viewport may not even have a DOM yet.
  // Scrolling cannot reveal both ends of this span. Change the layout instead
  // of giving up, estimating a destination, or scrolling the caret away.
  if (delta === undefined && viewport.bottom > viewport.top + 32) return 'dock'
  return delta === undefined ? undefined : delta / view.scaleY
}

export function livePreviewScroll(options: LiveOptions): Extension {
  const previewScroll = ViewPlugin.fromClass(
    class {
      following = false
      alive = true
      private panel: HTMLElement | undefined
      private preview: { widget: RenderedWidget; dom: HTMLElement } | undefined
      private pendingDock = false
      private pendingRender = false
      private readonly controller = new AbortController()
      constructor(view: EditorView) {
        const stop = () => {
          this.following = false
        }
        const options = { signal: this.controller.signal, passive: true }
        view.scrollDOM.addEventListener('wheel', stop, options)
        view.scrollDOM.addEventListener('touchstart', stop, options)
        view.scrollDOM.addEventListener(
          'pointerdown',
          (event) => {
            if (event.target === view.scrollDOM) stop()
          },
          options,
        )
        this.synchronize(view)
      }
      update(update: ViewUpdate): void {
        if (
          !editingBlock(update.state) ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(editLiveBlock)),
          )
        )
          this.following = false
        else if (update.selectionSet && !update.view.compositionStarted) this.following = true
        this.synchronize(update.view)
        if (this.following && (update.geometryChanged || update.docChanged || update.selectionSet))
          this.request(update.view)
      }
      private synchronize(view: EditorView): void {
        const editing = editingBlock(view.state)
        if (!editing || !previewIsDocked(view.state)) {
          this.clear()
          return
        }
        const widget = new RenderedWidget(editing.block, options, false, view.state.readOnly, true)
        if (this.preview?.widget.eq(widget)) return
        if (this.pendingRender) return
        this.pendingRender = true
        // Let CodeMirror destroy the former in-document widget first. Rendering
        // both concurrently can exhaust the worker/markup allowance and leave
        // the new preview in a permanent resource-limit state.
        queueMicrotask(() => {
          this.pendingRender = false
          const editing = editingBlock(view.state)
          if (!this.alive || !editing || !previewIsDocked(view.state)) return
          this.render(
            view,
            new RenderedWidget(editing.block, options, false, view.state.readOnly, true),
          )
        })
      }
      private render(view: EditorView, widget: RenderedWidget): void {
        if (this.preview?.widget.eq(widget)) return
        if (this.preview) this.preview.widget.destroy(this.preview.dom)
        this.preview = undefined
        const dom = widget.toDOM(view)
        if (!this.panel) {
          this.panel = view.dom.ownerDocument.createElement('div')
          this.panel.className = 'cm-live-preview-panel'
          this.panel.setAttribute('contenteditable', 'false')
          this.panel.tabIndex = 0
          this.panel.setAttribute('role', 'group')
          this.panel.setAttribute('aria-label', options.previewLabel?.() ?? 'Preview')
          this.panel.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && runScopeHandlers(view, event, 'editor')) {
              event.preventDefault()
              event.stopPropagation()
              view.focus()
            }
          })
          view.dom.append(this.panel)
        }
        this.preview = { widget, dom }
        this.panel.replaceChildren(dom)
        view.requestMeasure()
      }
      private clear(): void {
        if (this.preview) this.preview.widget.destroy(this.preview.dom)
        this.preview = undefined
        this.panel?.remove()
        this.panel = undefined
      }
      request(view: EditorView): void {
        view.requestMeasure({
          key: this,
          read: () => ({
            state: view.state,
            delta: this.alive && this.following ? measureContext(view) : undefined,
          }),
          write: ({ state, delta }) => {
            if (!this.alive || !this.following || view.state !== state) return
            if (delta === 'dock') {
              if (this.pendingDock) return
              this.pendingDock = true
              // State cannot change during CodeMirror's measure/write cycle. Guard
              // the queued layout change against composition and a newer session.
              queueMicrotask(() => {
                this.pendingDock = false
                const editing = editingBlock(view.state)
                if (!this.alive || !this.following || view.state !== state || !editing) return
                view.dispatch({
                  effects: [
                    dockLivePreview.of(editing),
                    EditorView.scrollIntoView(view.state.selection.main),
                  ],
                })
              })
            } else if (delta !== undefined && Math.abs(delta) > 0.5)
              view.scrollDOM.scrollTop += delta
          },
        })
      }
      destroy(): void {
        this.alive = false
        this.controller.abort()
        this.clear()
      }
    },
  )

  function revealContext(view: EditorView, range: SelectionRange, options: { y: string }): boolean {
    const editing = editingBlock(view.state)
    const plugin = view.plugin(previewScroll)
    if (!plugin) return false
    plugin.following = Boolean(
      editing &&
        range.from >= editing.from &&
        range.to <= editing.to &&
        hasEditingPreview(editing.block, view.state) &&
        options.y === 'nearest',
    )
    if (plugin.following) plugin.request(view)
    // Retain native horizontal scrolling and caret visibility for oversized blocks.
    return false
  }

  return [
    previewScroll,
    EditorView.scrollHandler.of(revealContext),
    EditorView.baseTheme({
      '.cm-live-preview-panel': {
        flex: '0 0 auto',
        minHeight: '0',
        maxHeight: '40%',
        overflow: 'auto',
        overscrollBehavior: 'contain',
      },
      '.cm-live-preview-panel .cm-live-edit-preview': { margin: '0' },
    }),
  ]
}
