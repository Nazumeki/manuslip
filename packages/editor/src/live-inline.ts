import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { semanticLimits } from '@manuslip/core'
import { decodeString } from 'micromark-util-decode-string'
import { optMarkdown } from './conventions'
import { unclosedCodeFence } from './fenced-code'
import { frontmatterEnd } from './frontmatter'
import { RenderedWidget } from './live-blocks'
import { caretTouches, editingBlock } from './live-editing'
import { alignInlineMathPreview } from './live-inline-math'
import {
  inlineProjection,
  isComposing,
  type LiveBlock,
  type LiveOptions,
  liveModel,
  proseProjection,
} from './live-model'
import { selectionTouches } from './live-selection'

const touches = (state: EditorState, from: number, to: number): boolean =>
  selectionTouches(state.selection, from, to)

const inlineFormats: Record<string, { class: string; tagName: string; marker: string }> = {
  StrongEmphasis: { class: 'cm-live-strong', tagName: 'strong', marker: 'EmphasisMark' },
  Emphasis: { class: 'cm-live-emphasis', tagName: 'em', marker: 'EmphasisMark' },
  Strikethrough: { class: 'cm-live-strike', tagName: 'del', marker: 'StrikethroughMark' },
  InlineCode: { class: 'cm-live-code', tagName: 'code', marker: 'CodeMark' },
}

function formatCaret(state: EditorState, node: SyntaxNode): boolean {
  for (let current: SyntaxNode | null = node; current; current = current.parent)
    if (inlineFormats[current.name] && caretTouches(state, current.from, current.to)) return true
  return false
}

const taskLifetimes = new WeakMap<HTMLElement, AbortController>()

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    private readonly label: string,
    private readonly readOnly: boolean,
  ) {
    super()
  }
  override eq(other: TaskWidget): boolean {
    return (
      this.checked === other.checked &&
      this.label === other.label &&
      this.readOnly === other.readOnly
    )
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('label')
    wrapper.className = 'cm-live-task'
    wrapper.setAttribute('contenteditable', 'false')
    const lifetime = new AbortController()
    taskLifetimes.set(wrapper, lifetime)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.addEventListener(
      'change',
      () => {
        const from = view.posAtDOM(wrapper)
        if (!view.state.readOnly && /^\[[ xX]\]$/.test(view.state.doc.sliceString(from, from + 3)))
          view.dispatch({
            changes: { from: from + 1, to: from + 2, insert: checkbox.checked ? 'x' : ' ' },
            userEvent: 'input',
          })
      },
      { signal: lifetime.signal },
    )
    wrapper.append(checkbox)
    this.updateDOM(wrapper)
    return wrapper
  }
  override updateDOM(dom: HTMLElement): boolean {
    const checkbox = dom.querySelector('input')
    if (!checkbox) return false
    checkbox.checked = this.checked
    checkbox.disabled = this.readOnly
    checkbox.setAttribute('aria-label', this.label)
    return true
  }
  override destroy(dom: HTMLElement): void {
    taskLifetimes.get(dom)?.abort()
    taskLifetimes.delete(dom)
  }
}

class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-live-bullet'
    span.textContent = '•'
    return span
  }
}

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly preview = false,
  ) {
    super()
  }
  override eq(other: TextWidget): boolean {
    return (
      this.constructor === other.constructor &&
      this.text === other.text &&
      this.preview === other.preview
    )
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    // Entity output is text, including decoded angle brackets; never parse it as HTML.
    span.textContent = this.text
    if (this.preview) {
      span.className = 'cm-live-source-glyph'
      span.setAttribute('aria-hidden', 'true')
    }
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

class EmojiWidget extends TextWidget {
  constructor(
    text: string,
    readonly source: string,
    preview = false,
  ) {
    super(text, preview)
  }
  override eq(other: EmojiWidget): boolean {
    return super.eq(other) && this.source === other.source
  }
  override toDOM(): HTMLElement {
    const span = super.toDOM()
    span.classList.add('md-emoji')
    span.title = this.source
    return span
  }
}

class RuleWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-live-rule'
    span.setAttribute('role', 'separator')
    return span
  }
  override ignoreEvent(): boolean {
    return false
  }
}

interface InlineState {
  decorations: DecorationSet
  atomic: DecorationSet
}

function inline(view: EditorView, options: LiveOptions): InlineState {
  const state = view.state
  const editing = editingBlock(state)
  const metadataEnd = state.field(frontmatterEnd)
  const decorations: Range<Decoration>[] = []
  if (editing?.block.kind === 'inlineMath')
    decorations.push(
      Decoration.mark({ class: 'cm-live-inline-math-source' }).range(
        editing.block.from,
        editing.block.to,
      ),
    )
  // Style the original editable lines. Metadata never needs an atomic widget or
  // source-reveal action, and remains stable during composition and selection.
  if (metadataEnd) {
    const closing = state.doc.lineAt(metadataEnd).number
    let lastLine = 0
    for (const visible of view.visibleRanges) {
      if (visible.from > metadataEnd) break
      const first = Math.max(2, lastLine + 1, state.doc.lineAt(visible.from).number)
      const last = Math.min(closing - 1, state.doc.lineAt(Math.min(metadataEnd, visible.to)).number)
      for (let number = first; number <= last; number++) {
        const line = state.doc.line(number)
        const edge = `${number === 2 ? ' cm-live-frontmatter-start' : ''}${number === closing - 1 ? ' cm-live-frontmatter-end' : ''}`
        decorations.push(Decoration.line({ class: `cm-live-frontmatter${edge}` }).range(line.from))
      }
      lastLine = last
    }
  }
  if (view.composing || state.field(isComposing))
    return { decorations: Decoration.set(decorations, true), atomic: Decoration.none }
  const hidden: { from: number; to: number }[] = []
  const replace = (from: number, to: number): void => {
    // View plugins must never replace a line break.
    if (
      from < to &&
      state.doc.lineAt(from).number === state.doc.lineAt(to).number &&
      !selectionTouches(state.selection, from, to)
    )
      hidden.push({ from, to })
  }
  let math = 0
  const model = state.field(liveModel)
  const blocks = [...(model?.blocks || [])]
  if (editing && !blocks.some((block) => block.id === editing.block.id)) blocks.push(editing.block)
  blocks.sort((a, b) => a.from - b.from || b.to - a.to)
  // Semantic prose widgets own their descendants. Revealing them shows the complete
  // raw source, including syntax that Lezer cannot represent or safely parse inline.
  const sourceBlocks: LiveBlock[] = []
  for (const block of blocks)
    if (
      proseProjection(block.kind) &&
      !(
        editing &&
        editing.from >= block.from &&
        editing.to <= block.to &&
        block.kind !== 'defList'
      ) &&
      block.from >= (sourceBlocks.at(-1)?.to ?? 0)
    )
      sourceBlocks.push(block)
  const inSourceBlock = (from: number, to: number): boolean => {
    let low = 0,
      high = sourceBlocks.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((sourceBlocks[middle]?.from ?? Infinity) <= from) low = middle + 1
      else high = middle
    }
    const block = sourceBlocks[low - 1]
    return Boolean(block && from >= block.from && to <= block.to)
  }
  const covered: { from: number; to: number }[] = []
  const seen = new Set<string>()
  // Projections are source-sorted. Find the first range in O(log n), then visit viewport nodes.
  const startAt = (position: number): number => {
    let low = 0
    let high = blocks.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if ((blocks[middle]?.from ?? Infinity) < position) low = middle + 1
      else high = middle
    }
    return Math.max(0, low - 1)
  }
  for (const visible of view.visibleRanges) {
    for (let index = startAt(visible.from); index < blocks.length; index++) {
      const block = blocks[index]
      if (!block || block.from > visible.to) break
      if (
        seen.has(block.id) ||
        inSourceBlock(block.from, block.to) ||
        !inlineProjection(block.kind) ||
        block.to < visible.from ||
        block.from > visible.to ||
        touches(state, block.from, block.to) ||
        state.doc.lineAt(block.from).number !== state.doc.lineAt(block.to).number
      )
        continue
      // A revealed table/code block stays entirely source-editable.
      const ancestor = syntaxTree(state).resolveInner(block.from, 1)
      let parent = ancestor.parent
      let structured = false
      while (parent) {
        if (['Table', 'FencedCode', 'CodeBlock', 'HTMLBlock'].includes(parent.name)) {
          structured = true
          break
        }
        parent = parent.parent
      }
      if (structured) continue
      if (block.kind === 'inlineMath' && ++math > semanticLimits.viewportMath) continue
      // An outer widget already renders its nested links, scripts, images and emoji.
      if (block.from < (covered[covered.length - 1]?.to ?? 0)) continue
      seen.add(block.id)
      if (
        editing &&
        editing.from <= block.from &&
        editing.to >= block.to &&
        block.kind !== 'emoji' &&
        (editing.block.placement === 'after-document' ||
          (editing.from === block.from && editing.to === block.to))
      )
        continue
      covered.push({ from: block.from, to: block.to })
      const emoji = block.kind === 'emoji'
      const widget = emoji
        ? new EmojiWidget(
            block.value,
            state.doc.sliceString(block.from, block.to),
            caretTouches(state, block.from, block.to),
          )
        : new RenderedWidget(block, options, true)
      if (emoji && caretTouches(state, block.from, block.to)) {
        decorations.push(
          Decoration.widget({ widget, side: -1 }).range(block.from),
          Decoration.mark({ class: 'cm-live-source-hint' }).range(block.from, block.to),
        )
        continue
      }
      decorations.push(Decoration.replace({ widget }).range(block.from, block.to))
    }
    syntaxTree(state).iterate({
      from: visible.from,
      to: visible.to,
      enter: (node) => {
        const name = node.name
        // Exposed TeX is literal source. Markdown escapes, links and emphasis must
        // not replace its delimiters or tokens underneath the native selection.
        if (
          editing &&
          (editing.block.kind === 'inlineMath' || editing.block.kind === 'math') &&
          node.from >= editing.block.from &&
          node.to <= editing.block.to
        )
          return false
        if (node.to <= metadataEnd) return false
        if (inSourceBlock(node.from, node.to)) return false
        if (['FencedCode', 'CodeBlock'].includes(name)) {
          if (name === 'FencedCode' && unclosedCodeFence(state, node.from, node.to)) return false
          if (touches(state, node.from, node.to)) {
            const end = Math.min(node.to, visible.to)
            for (
              let line = state.doc.lineAt(Math.max(node.from, visible.from));
              line.from <= end;
            ) {
              decorations.push(Decoration.line({ class: 'cm-live-source-code' }).range(line.from))
              if (line.number === state.doc.lines) break
              line = state.doc.line(line.number + 1)
            }
          }
          return false
        }
        if (name === 'Table') {
          if (touches(state, node.from, node.to)) {
            const first = state.doc.lineAt(Math.max(node.from, visible.from)).number
            const last = state.doc.lineAt(Math.min(node.to, visible.to)).number
            for (let number = first; number <= last; number++)
              decorations.push(
                Decoration.line({ class: 'cm-live-source-table' }).range(
                  state.doc.line(number).from,
                ),
              )
          }
          return false
        }
        if (name === 'HTMLBlock') return false
        if (covered.some((range) => node.from >= range.from && node.to <= range.to)) return false
        if (name === 'LinkReference') {
          const last = state.doc.lineAt(Math.min(node.to, visible.to)).number
          for (
            let number = state.doc.lineAt(Math.max(node.from, visible.from)).number;
            number <= last;
            number++
          )
            decorations.push(
              Decoration.line({ class: 'cm-live-reference-definition' }).range(
                state.doc.line(number).from,
              ),
            )
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            const className =
              child.name === 'LinkLabel'
                ? 'cm-live-reference-label'
                : child.name === 'URL'
                  ? 'cm-live-reference-url'
                  : 'cm-live-reference-punctuation'
            decorations.push(Decoration.mark({ class: className }).range(child.from, child.to))
            if (child.name === 'LinkLabel' && child.to - child.from > 2) {
              decorations.push(
                Decoration.mark({ class: 'cm-live-reference-punctuation' }).range(
                  child.from,
                  child.from + 1,
                ),
                Decoration.mark({ class: 'cm-live-reference-punctuation' }).range(
                  child.to - 1,
                  child.to,
                ),
              )
            }
          }
          return false
        }
        if (/^(ATX|Setext)Heading[1-6]$/.test(name)) {
          const anchor = model?.anchors?.find((anchor) => anchor.from === node.from)?.id
          decorations.push(
            Decoration.line({
              class: `cm-live-heading cm-live-heading-${name.slice(-1)}`,
              ...(anchor
                ? {
                    attributes: {
                      id: anchor.startsWith('user-content-') ? anchor : `user-content-${anchor}`,
                    },
                  }
                : {}),
            }).range(state.doc.lineAt(node.from).from),
          )
        }
        if (name === 'Blockquote') {
          const last = state.doc.lineAt(Math.min(node.to, visible.to)).number
          for (
            let number = state.doc.lineAt(Math.max(node.from, visible.from)).number;
            number <= last;
            number++
          )
            decorations.push(
              Decoration.line({ class: 'cm-live-quote' }).range(state.doc.line(number).from),
            )
        }
        if (name === 'Escape' && !selectionTouches(state.selection, node.from, node.to)) {
          if (caretTouches(state, node.from, node.to))
            decorations.push(
              Decoration.widget({
                widget: new TextWidget(state.doc.sliceString(node.from + 1, node.to), true),
                side: -1,
              }).range(node.from),
              Decoration.mark({ class: 'cm-live-source-hint' }).range(node.from, node.to),
            )
          else replace(node.from, node.from + 1)
        }
        if (name === 'HardBreak')
          replace(node.from, Math.min(node.to, state.doc.lineAt(node.from).to))
        if (name === 'Entity' && !selectionTouches(state.selection, node.from, node.to)) {
          const value = decodeString(state.doc.sliceString(node.from, node.to))
          if (caretTouches(state, node.from, node.to))
            decorations.push(
              Decoration.widget({ widget: new TextWidget(value, true), side: -1 }).range(node.from),
              Decoration.mark({ class: 'cm-live-source-hint' }).range(node.from, node.to),
            )
          else
            decorations.push(
              Decoration.replace({ widget: new TextWidget(value) }).range(node.from, node.to),
            )
        }
        if (
          name === 'HorizontalRule' &&
          !selectionTouches(state.selection, node.from, node.to) &&
          !caretTouches(state, node.from, node.to)
        )
          decorations.push(
            Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to),
          )
        const format =
          name === 'Strikethrough' && !state.facet(optMarkdown) ? undefined : inlineFormats[name]
        if (format) {
          const markers = node.node.getChildren(format.marker)
          const opening = markers[0],
            closing = markers.at(-1)
          if (opening && closing && opening !== closing) {
            let from = opening.to,
              to = closing.from
            // The caret exposes paired punctuation without removing the type style.
            if (name === 'InlineCode') {
              const value = state.doc.sliceString(from, to)
              if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) {
                from++
                to--
              }
            }
            if (
              !selectionTouches(state.selection, node.from, node.to) &&
              !formatCaret(state, node.node)
            ) {
              replace(opening.from, from)
              replace(to, closing.to)
            }
            if (from < to)
              decorations.push(
                Decoration.mark({ class: format.class, tagName: format.tagName }).range(from, to),
              )
          }
        }
        if (name === 'HeaderMark') {
          const parent = node.node.parent
          if (
            parent &&
            !selectionTouches(state.selection, parent.from, parent.to) &&
            !caretTouches(state, parent.from, parent.to)
          ) {
            let from = node.from,
              to = node.to
            const line = state.doc.lineAt(from)
            if (parent.name.startsWith('ATXHeading') && from === parent.from)
              to += state.doc.sliceString(to, line.to).match(/^[ \t]*/)?.[0].length ?? 0
            else from -= state.doc.sliceString(line.from, from).match(/[ \t]*$/)?.[0].length ?? 0
            replace(from, to)
          }
        }
        if (name === 'ListMark' || name === 'QuoteMark') {
          const parent = node.node.parent
          if (
            parent &&
            (selectionTouches(state.selection, parent.from, parent.to) ||
              caretTouches(state, parent.from, parent.to))
          )
            return false
          if (name === 'QuoteMark')
            replace(
              node.from,
              node.to + (state.doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0),
            )
          else if (
            /^[-+*]$/.test(state.doc.sliceString(node.from, node.to)) &&
            !selectionTouches(state.selection, node.from, node.to)
          ) {
            const task = node.node.parent?.getChild('Task')
            if (task?.getChild('TaskMarker')) replace(node.from, task.from)
            else
              decorations.push(
                Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
              )
          }
        }
        if (
          name === 'TaskMarker' &&
          !selectionTouches(
            state.selection,
            node.node.parent?.from ?? node.from,
            node.node.parent?.to ?? node.to,
          )
        )
          decorations.push(
            Decoration.replace({
              widget: new TaskWidget(
                state.doc.sliceString(node.from + 1, node.from + 2).toLowerCase() === 'x',
                options.taskLabel(),
                state.readOnly,
              ),
            }).range(node.from, node.to),
          )
      },
    })
  }
  // Adjacent markers/URLs can be joined; overlapping replacements must never reach CodeMirror.
  hidden.sort((a, b) => a.from - b.from || a.to - b.to)
  const merged: typeof hidden = []
  for (const range of hidden) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  const replacements = merged.map((range) => Decoration.replace({}).range(range.from, range.to))
  const atomic = Decoration.set(
    [
      ...replacements,
      ...decorations.filter((range) => range.from < range.to && range.value.spec.widget),
    ],
    true,
  )
  decorations.push(...replacements)
  return { decorations: Decoration.set(decorations, true), atomic }
}

export function inlineDecorations(options: LiveOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      atomic: DecorationSet
      constructor(view: EditorView) {
        const result = inline(view, options)
        this.decorations = result.decorations
        this.atomic = result.atomic
        alignInlineMathPreview(view)
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.geometryChanged ||
          update.viewportChanged ||
          editingBlock(update.startState) !== editingBlock(update.state)
        )
          alignInlineMathPreview(update.view)
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some((transaction) => transaction.effects.length) ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          const result = inline(update.view, options)
          this.decorations = result.decorations
          this.atomic = result.atomic
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic || Decoration.none),
    },
  )
}
