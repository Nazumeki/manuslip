import { type EditorState, type Range, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { editingBlock } from './live-editing'
import { activateRendered } from './live-interactions'
import { preserveProseLineBreaks } from './live-line-breaks'
import {
  blockSourceRange,
  inlineProjection,
  isComposing,
  type LiveBlock,
  type LiveOptions,
  liveModel,
  proseProjection,
} from './live-model'
import { proseNavigation, revealProse } from './live-navigation'
import { hasEditingPreview, previewIsDocked } from './live-preview-layout'
import {
  blockAtPreview,
  cancelPreviewPointer,
  capturePreviewPointer,
  completesPreviewPointer,
  releasePreviewPointer,
} from './live-preview-position'
import { rangeTouches } from './live-selection'
import { LiveTable } from './live-table'
import { taskCheckboxes } from './live-task-changes'
import { mountTaskControls } from './live-tasks'

// CodeMirror can hand the same DOM to a newer equivalent widget object. Its lifetime
// belongs to that DOM, so whichever widget finally destroys it must close the renderer.
const widgetLifetimes = new WeakMap<
  HTMLElement,
  { controller: AbortController; widget: RenderedWidget; table?: LiveTable }
>()

export class RenderedWidget extends WidgetType {
  constructor(
    readonly block: LiveBlock,
    private readonly options: LiveOptions,
    readonly inline = false,
    private readonly readOnly = false,
    private readonly preview = false,
  ) {
    super()
  }
  override eq(other: RenderedWidget): boolean {
    return (
      this.block.id === other.block.id &&
      this.block.kind === other.block.kind &&
      (this.block.kind !== 'table' ||
        (this.block.from === other.block.from && this.block.to === other.block.to)) &&
      this.block.html === other.block.html &&
      this.block.syntax === other.block.syntax &&
      this.block.value === other.block.value &&
      this.block.placement === other.block.placement &&
      this.block.listStart === other.block.listStart &&
      this.inline === other.inline &&
      this.readOnly === other.readOnly &&
      this.preview === other.preview &&
      this.options === other.options
    )
  }
  override toDOM(view: EditorView): HTMLElement {
    const container = document.createElement(this.inline ? 'span' : 'div')
    container.className = this.inline
      ? 'cm-live-inline-widget'
      : `cm-live-block cm-live-${this.block.kind}`
    container.dataset.occurrence = this.block.id
    container.dataset.kind = this.block.kind
    if (this.preview) container.classList.add('cm-live-edit-preview')
    if (this.block.placement) container.dataset.placement = this.block.placement
    container.setAttribute('contenteditable', 'false')
    const lifetime = new AbortController()
    widgetLifetimes.set(container, { controller: lifetime, widget: this })
    const content = document.createElement(
      this.inline ? 'span' : this.block.kind === 'footnoteDefinition' ? 'ol' : 'div',
    )
    content.className = 'cm-live-rendered'
    if (!this.preview && (this.block.kind === 'math' || this.block.kind === 'inlineMath')) {
      content.setAttribute('aria-description', this.options.sourceLabel())
      content.setAttribute('aria-keyshortcuts', 'Enter Space')
    }
    if (this.block.kind === 'footnoteDefinition') content.classList.add('markdown-footnote-list')
    if (this.block.kind === 'footnoteDefinition' && this.block.listStart)
      content.setAttribute('start', String(this.block.listStart))
    container.append(content)
    if (!this.preview && this.block.kind !== 'table') {
      container.addEventListener(
        'pointerdown',
        (event) => {
          if (
            event instanceof PointerEvent &&
            event.isPrimary &&
            event.button === 0 &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !view.composing &&
            !view.state.field(isComposing) &&
            event.target instanceof Element &&
            (!proseProjection(this.block.kind) ||
              Boolean(event.target.closest('[role="math"], [data-render-kind="diagram"]'))) &&
            !event.target.closest('button, input, select, textarea, a[href]')
          )
            capturePreviewPointer(view, container, event)
        },
        { signal: lifetime.signal },
      )
      container.addEventListener(
        'pointermove',
        (event) => {
          if (event instanceof PointerEvent) releasePreviewPointer(container, event)
        },
        { signal: lifetime.signal },
      )
      for (const event of ['pointercancel', 'lostpointercapture'])
        container.addEventListener(event, () => cancelPreviewPointer(container), {
          signal: lifetime.signal,
        })
      container.addEventListener(
        'pointerup',
        (event) => {
          if (
            !(event instanceof PointerEvent) ||
            view.compositionStarted ||
            view.state.field(isComposing) ||
            !completesPreviewPointer(container, event)
          )
            return
          event.preventDefault()
          event.stopPropagation()
          activateRendered(view, container, event)
        },
        { signal: lifetime.signal },
      )
    }
    container.addEventListener(
      'mousedown',
      (event) => {
        if (
          event instanceof MouseEvent &&
          event.button === 0 &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !view.compositionStarted &&
          !view.state.field(isComposing) &&
          (this.preview ||
            (!proseProjection(this.block.kind) && this.block.kind !== 'table') ||
            (event.target instanceof Element &&
              Boolean(event.target.closest('[role="math"], [data-render-kind="diagram"]')))) &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              'button, input, select, textarea, label, a[data-footnote-ref], a[data-footnote-backref], .markdown-toc a[href]',
            )
          )
        ) {
          event.preventDefault()
          event.stopPropagation()
        }
      },
      { signal: lifetime.signal },
    )
    if (
      !this.inline &&
      !this.preview &&
      this.block.kind !== 'math' &&
      (!proseProjection(this.block.kind) || this.block.kind === 'footnoteDefinition')
    ) {
      container.tabIndex = 0
      container.setAttribute('aria-description', this.options.sourceLabel())
      container.setAttribute(
        'aria-keyshortcuts',
        this.block.kind === 'table' ? 'Enter F2' : 'Enter',
      )
    }
    container.addEventListener(
      'keydown',
      (event) => {
        if (
          !(event instanceof KeyboardEvent) ||
          (event.target !== container &&
            !(
              event.target instanceof HTMLElement &&
              event.target.matches('[role="math"], [data-render-kind="diagram"]')
            )) ||
          this.block.kind === 'table' ||
          view.composing ||
          view.state.field(isComposing)
        )
          return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          activateRendered(view, container, event)
        }
      },
      { signal: lifetime.signal },
    )
    const openLink = this.options.openLink
    container.addEventListener(
      'click',
      (event) => {
        if (
          event.defaultPrevented ||
          !view.dom.contains(container) ||
          view.composing ||
          view.state.field(isComposing) ||
          !(event.target instanceof Element) ||
          event.target.closest(
            'button, input, select, textarea, label, .cm-live-cell-active .cm-editor',
          )
        )
          return
        const anchor = event.target.closest('a[href]')
        if (
          anchor &&
          event instanceof MouseEvent &&
          (event.ctrlKey ||
            event.metaKey ||
            anchor.closest('.markdown-toc') ||
            anchor.hasAttribute('data-footnote-ref') ||
            anchor.hasAttribute('data-footnote-backref'))
        ) {
          event.preventDefault()
          const block = blockAtPreview(view, container)
          const links = [...content.querySelectorAll('a[href]')]
          const index = links.indexOf(anchor)
          if (block && index >= 0)
            openLink(anchor.getAttribute('href') || '', { block, index, count: links.length })
        } else if (
          event instanceof MouseEvent &&
          event.button === 0 &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          this.block.kind !== 'table' &&
          !event.target.matches('.render-table-scroll, [data-math-scroll]')
        ) {
          event.preventDefault()
          activateRendered(view, container, event)
        }
      },
      { signal: lifetime.signal },
    )
    try {
      if (this.block.kind === 'table') {
        const table = new LiveTable(
          container,
          content,
          view,
          this.block,
          this.options,
          lifetime.signal,
        )
        const mounted = widgetLifetimes.get(container)
        if (mounted) mounted.table = table
      } else
        this.options.render(content, this.block, lifetime.signal, () => {
          if (!lifetime.signal.aborted) view.requestMeasure()
        })
      if (proseProjection(this.block.kind)) preserveProseLineBreaks(content)
      if (proseProjection(this.block.kind))
        for (const diagram of content.querySelectorAll<HTMLElement>(
          '[data-render-kind="diagram"]',
        )) {
          diagram.tabIndex = 0
          diagram.setAttribute('aria-description', this.options.sourceLabel())
          diagram.setAttribute('aria-keyshortcuts', 'Enter Space')
        }
      if (proseProjection(this.block.kind))
        mountTaskControls(content, this.block, view, this.options.taskLabel(), lifetime.signal)
    } catch (error) {
      widgetLifetimes.delete(container)
      lifetime.abort()
      throw error
    }
    return container
  }
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const mounted = widgetLifetimes.get(dom)
    const previous = mounted?.widget
    if (mounted?.table && previous?.options === this.options && this.block.kind === 'table') {
      dom.dataset.occurrence = this.block.id
      mounted.widget = this
      mounted.table.update(this.block)
      return true
    }
    if (
      !mounted ||
      !previous ||
      !proseProjection(this.block.kind) ||
      previous.block.kind !== this.block.kind ||
      previous.block.from !== this.block.from ||
      previous.block.to !== this.block.to ||
      previous.block.value !== this.block.value ||
      previous.block.syntax !== this.block.syntax ||
      previous.inline !== this.inline ||
      previous.options !== this.options
    )
      return false
    const oldTasks = taskCheckboxes(previous.block.html)
    const nextTasks = taskCheckboxes(this.block.html)
    if (!nextTasks.checked.length || oldTasks.html !== nextTasks.html) return false
    const inputs = dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    if (inputs.length !== nextTasks.checked.length) return false
    inputs.forEach((input, index) => {
      input.checked = nextTasks.checked[index] ?? false
      input.disabled = view.state.readOnly
      input.setAttribute('aria-label', this.options.taskLabel())
    })
    dom.dataset.occurrence = this.block.id
    mounted.widget = this
    return true
  }
  override get estimatedHeight(): number {
    return this.inline ? -1 : Math.max(48, Math.min(720, this.block.lines * 24 + 24))
  }
  override ignoreEvent(event: Event): boolean {
    if (!(event.target instanceof Element)) return false
    const control = event.target.closest('button, input, select, textarea, label')
    // Cell editors own input and composition. The parent editor still owns their
    // source and history; it must not interpret the same native event a second time.
    return (
      Boolean(event.target.closest('.cm-live-table :is(th, td)')) ||
      Boolean(control?.closest('.cm-live-block, .cm-live-inline-widget')) ||
      (event instanceof KeyboardEvent && Boolean(event.target.closest('[tabindex]'))) ||
      Boolean(
        event.target.closest(
          'a[data-footnote-ref], a[data-footnote-backref], .markdown-toc a[href]',
        ),
      ) ||
      (event instanceof MouseEvent &&
        Boolean(event.target.closest('a[href]')) &&
        (event.ctrlKey || event.metaKey))
    )
  }
  override destroy(dom: HTMLElement): void {
    const lifetime = widgetLifetimes.get(dom)
    widgetLifetimes.delete(dom)
    lifetime?.controller.abort()
  }
}

interface BlockState {
  all: DecorationSet
  visible: DecorationSet
  byId: ReadonlyMap<string, Range<Decoration>>
  selected: ReadonlySet<string>
}

function active(state: EditorState, all: DecorationSet): Set<string> {
  const selected = new Set<string>()
  const editing = editingBlock(state)
  for (const selection of state.selection.ranges)
    all.between(selection.from, selection.to, (start, end, decoration) => {
      if (
        !decoration.spec.virtual &&
        !(
          editing?.block.kind === 'table' &&
          !editing.source &&
          start === editing.from &&
          end === editing.to
        ) &&
        rangeTouches(selection, start, end)
      )
        selected.add(decoration.spec.occurrence as string)
    })
  return selected
}

function build(state: EditorState, options: LiveOptions): BlockState {
  const ranges: Range<Decoration>[] = []
  const byId = new Map<string, Range<Decoration>>()
  let renderedEnd = 0
  let footer = 0
  const editing = editingBlock(state)
  const blocks = [...(state.field(liveModel)?.blocks || [])]
  if (
    editing &&
    !blocks.some((block) => block.kind === editing.block.kind && block.from === editing.block.from)
  )
    blocks.push(editing.block)
  blocks.sort((a, b) => a.from - b.from || b.to - a.to)
  for (const block of blocks) {
    if (
      block.kind === 'footnoteDefinition' &&
      block.placement === 'after-document' &&
      block.from > 0 &&
      block.from < block.to &&
      block.to <= state.doc.length
    ) {
      const range = Decoration.widget({
        block: true,
        side: ++footer,
        widget: new RenderedWidget(block, options),
        occurrence: block.id,
        virtual: true,
      }).range(state.doc.length)
      ranges.push(range)
      byId.set(block.id, range)
      continue
    }
    // Outer widgets own their descendants, including links inside tables and definitions.
    if (
      block.from < renderedEnd ||
      block.from < 0 ||
      block.from >= block.to ||
      block.to > state.doc.length
    )
      continue
    const startLine = state.doc.lineAt(block.from)
    const endLine = state.doc.lineAt(block.to)
    // Replacing line breaks requires a state field, even for an inline widget.
    const inline = inlineProjection(block.kind) && startLine.number !== endLine.number
    const source = inline ? { from: block.from, to: block.to } : blockSourceRange(state, block)
    if (
      !source ||
      source.from < renderedEnd ||
      (!inline &&
        !proseProjection(block.kind) &&
        !['table', 'code', 'diagram', 'math', 'html'].includes(block.kind))
    )
      continue
    if (
      editing &&
      ((block.from === editing.block.from && block.kind === editing.block.kind) ||
        (proseProjection(block.kind) && editing.from >= block.from && editing.to <= block.to)) &&
      (block.kind !== 'table' || editing.source)
    ) {
      renderedEnd = source.to
      continue
    }
    const range = Decoration.replace({
      block: !inline,
      widget: new RenderedWidget(
        block,
        options,
        inline,
        state.readOnly && block.html.includes('type="checkbox"'),
      ),
      occurrence: block.id,
    }).range(source.from, source.to)
    ranges.push(range)
    renderedEnd = source.to
    byId.set(block.id, range)
  }
  // A projected paragraph/list may own the active block's DOM. Editing source
  // and its companion belong to the session, independently of that outer widget.
  if (editing && ['code', 'diagram', 'math', 'html'].includes(editing.block.kind)) {
    const first = state.doc.lineAt(editing.from).number
    const last = state.doc.lineAt(editing.to).number
    for (let number = first; number <= last; number++)
      ranges.push(
        Decoration.line({
          class: `cm-live-edit-source${number === first ? ' cm-live-edit-start' : ''}${number === last ? ' cm-live-edit-end' : ''}`,
          virtual: true,
        }).range(state.doc.line(number).from),
      )
  }
  if (editing && hasEditingPreview(editing.block) && !previewIsDocked(state))
    ranges.push(
      Decoration.widget({
        block: true,
        side: 1,
        widget: new RenderedWidget(editing.block, options, false, state.readOnly, true),
        virtual: true,
      }).range(state.doc.lineAt(editing.to).to),
    )
  const all = Decoration.set(ranges, true)
  const selected = active(state, all)
  return {
    all,
    visible: state.field(isComposing)
      ? Decoration.none
      : all.update({
          filter: (_from, _to, decoration) => !selected.has(decoration.spec.occurrence as string),
        }),
    byId,
    selected,
  }
}

export function blockDecorations(options: LiveOptions): StateField<BlockState> {
  return StateField.define<BlockState>({
    create: (state) => build(state, options),
    update: (previous, transaction) => {
      if (
        transaction.startState.field(liveModel) !== transaction.state.field(liveModel) ||
        transaction.startState.field(isComposing) !== transaction.state.field(isComposing) ||
        editingBlock(transaction.startState) !== editingBlock(transaction.state) ||
        previewIsDocked(transaction.startState) !== previewIsDocked(transaction.state) ||
        transaction.startState.readOnly !== transaction.state.readOnly
      )
        return build(transaction.state, options)
      const reveal = transaction.effects.flatMap((effect) =>
        effect.is(revealProse) ? effect.value : [],
      )
      const hasReveal = transaction.effects.some((effect) => effect.is(revealProse))
      if ((!transaction.selection && !hasReveal) || transaction.state.field(isComposing))
        return previous
      const selected = active(transaction.state, previous.all)
      for (const id of reveal) selected.add(id)
      const add: Range<Decoration>[] = []
      const remove = new Set<string>()
      let from = Infinity,
        to = -Infinity
      for (const id of previous.selected)
        if (!selected.has(id)) {
          const range = previous.byId.get(id)
          if (range) add.push(range)
        }
      for (const id of selected)
        if (!previous.selected.has(id)) {
          const range = previous.byId.get(id)
          if (range) {
            remove.add(id)
            from = Math.min(from, range.from)
            to = Math.max(to, range.to)
          }
        }
      if (!add.length && !remove.size) return previous
      // Selecting many lines changes the range set once, regardless of block count.
      const visible = previous.visible.update({
        add,
        sort: true,
        ...(remove.size
          ? {
              filterFrom: from,
              filterTo: to,
              filter: (_from: number, _to: number, decoration: Decoration) =>
                !remove.has(decoration.spec.occurrence as string),
            }
          : {}),
      })
      return { ...previous, selected, visible }
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.visible),
      EditorView.atomicRanges.of((view) => view.state.field(field).visible),
      proseNavigation(field),
    ],
  })
}
