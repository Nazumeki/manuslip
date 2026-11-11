import type { ElementContent } from 'hast'
import type { Nodes, Parents } from 'mdast'
import { defListHastHandlers } from 'mdast-util-definition-list'
import { defaultHandlers, type State } from 'mdast-util-to-hast'
import { conventionHandlers } from './convention-handlers'
import { extendedInlineHandlers } from './extended-inline'
import { withTableCell } from './projection-table-context'

type Result = ReturnType<State['one']>
interface Children {
  node: Nodes
  depth: number
  input: readonly Nodes[]
  results: Result[]
  values: ElementContent[]
  at: number
}
interface Frame {
  node: Nodes
  parent: Parents | undefined
  depth: number
  children: Children[]
  at: number
}
const batch = 16
const parents = new Set([
  'defList',
  'defListTerm',
  'defListDescription',
  'root',
  'blockquote',
  'delete',
  'emphasis',
  'heading',
  'link',
  'linkReference',
  'list',
  'listItem',
  'paragraph',
  'strong',
  'subscript',
  'superscript',
  'table',
  'tableCell',
  'math',
  'inlineMath',
])

/** Internal conversion of validated, stable parser nodes. Native handlers still create
 * every result. Their child conversion is prepared in source order, then supplied through
 * State.all. Native all() applies its exact hard-break trimming in groups of at most 17
 * children, including the preceding sibling at a group boundary. No handler is replayed.
 * Every native handler, wrap/applyData operation and scalar allocation remains atomic.
 * Caller admits scratch before allocation and closes this generator with its sequence.
 */
export function* projectionConversionSteps(
  state: State,
  node: Nodes,
  parent: Parents | undefined,
  limits: { nodes: number; depth: number },
  invoke: State['one'],
  enter: (node: Nodes, parent: Parents | undefined) => Generator<void> | void,
  scratch: (bytes: number) => void,
  assertOpen: () => void,
): Generator<void, Result> {
  if (
    !Number.isSafeInteger(limits.nodes) ||
    limits.nodes < 1 ||
    !Number.isSafeInteger(limits.depth) ||
    limits.depth < 1 ||
    limits.depth > 512 ||
    state.options.passThrough?.length ||
    state.options.unknownHandler
  )
    throw new Error('Invalid cooperative projection conversion')
  for (const [type, handler] of Object.entries(state.handlers)) {
    if (
      type !== 'root' &&
      type !== 'html' &&
      handler !== defaultHandlers[type as keyof typeof defaultHandlers] &&
      handler !== extendedInlineHandlers[type as keyof typeof extendedInlineHandlers] &&
      handler !== conventionHandlers[type as keyof typeof conventionHandlers] &&
      handler !== defListHastHandlers[type as keyof typeof defListHastHandlers]
    )
      throw new Error('Unsupported cooperative projection handler')
  }
  const nativeOne = state.one,
    nativeAll = state.all
  const frames: Frame[] = []
  let visited = 0,
    progress = 0
  const advance = () => ++progress >= batch
  const admit = (node: Nodes, parent: Parents | undefined, depth: number) => {
    assertOpen()
    if (++visited > limits.nodes || depth > limits.depth)
      throw new Error('Projection conversion node/depth limit')
    const work = enter(node, parent)
    assertOpen()
    if (
      !Object.hasOwn(defaultHandlers, node.type) &&
      !Object.hasOwn(extendedInlineHandlers, node.type) &&
      !Object.hasOwn(defListHastHandlers, node.type) &&
      node.type !== 'math' &&
      node.type !== 'inlineMath'
    )
      throw new Error('Unsupported cooperative projection node')
    return work
  }
  const rejectOne: State['one'] = () => {
    throw new Error('Unexpected recursive projection handler')
  }
  const rejectAll: State['all'] = () => {
    throw new Error('Unexpected projection child request')
  }
  // A leaf has no child result requests. Keep its original admission and native
  // handler, without allocating a frame or revisiting it in the traversal loop.
  const leaf = (node: Nodes, parent: Parents | undefined): Result => {
    scratch(512)
    assertOpen()
    state.one = rejectOne
    state.all = rejectAll
    try {
      const value =
        node.type === 'html' &&
        (parent?.type === 'tableCell' || frames.some((frame) => frame.node.type === 'tableRow'))
          ? withTableCell(state, () => invoke(node, parent))
          : invoke(node, parent)
      assertOpen()
      return value
    } finally {
      state.one = nativeOne
      state.all = nativeAll
    }
  }
  const push = (node: Nodes, parent: Parents | undefined, depth: number) => {
    const count =
      node.type === 'tableRow'
        ? Math.min(
            node.children.length,
            parent?.type === 'table' && parent.align ? parent.align.length : node.children.length,
          )
        : Number(parents.has(node.type))
    let references = 0
    if (node.type === 'tableRow') {
      for (let index = 0; index < count; index++)
        references += node.children[index]?.children.length ?? 0
    } else if (count && 'children' in node) references = node.children.length
    // Frames, child request objects/arrays and per-occurrence result references.
    scratch(512 + count * 512 + references * 32)
    assertOpen()
    const children: Children[] = []
    const add = (input: Nodes, depth: number) => {
      const nodes = 'children' in input ? input.children : []
      children.push({ node: input, depth, input: nodes, results: [], values: [], at: 0 })
    }
    if (node.type === 'tableRow') {
      for (let index = 0; index < count; index++) {
        const cell = node.children[index]
        if (cell) add(cell, depth + 1)
      }
    } else if (count) add(node, depth)
    frames.push({ node, parent, depth, children, at: 0 })
  }
  try {
    const admission = admit(node, parent, 1)
    if (admission) {
      for (const step of admission) {
        assertOpen()
        progress = 0
        yield step
        assertOpen()
      }
      assertOpen()
    }
    if (!parents.has(node.type) && node.type !== 'tableRow') return leaf(node, parent)
    push(node, parent, 1)
    while (frames.length) {
      assertOpen()
      if (advance()) {
        progress = 0
        yield
        assertOpen()
      }
      const frame = frames[frames.length - 1]
      if (!frame) throw new Error('Missing projection conversion frame')
      const children = frame.children[frame.at]
      if (children) {
        const child = children.input[children.at]
        if (child) {
          const admission = admit(child, children.node as Parents, children.depth + 1)
          if (admission) {
            for (const step of admission) {
              assertOpen()
              progress = 0
              yield step
              assertOpen()
            }
            assertOpen()
          }
          if (parents.has(child.type) || child.type === 'tableRow')
            push(child, children.node as Parents, children.depth + 1)
          else {
            children.results.push(leaf(child, children.node as Parents))
            children.at++
          }
          continue
        }
        for (let start = 0; start < children.input.length; start += batch) {
          assertOpen()
          const end = Math.min(start + batch, children.input.length)
          let slots = 0
          for (let index = start; index < end; index++) {
            const result = children.results[index]
            slots += result === undefined ? 0 : Array.isArray(result) ? result.length : 1
          }
          // Native handlers can return arrays (for example unresolved references).
          // Admit both the temporary native group and persistent flattened slots.
          scratch(128 + slots * 16)
          assertOpen()
          const from = start ? start - 1 : start
          const input = children.input.slice(from, end)
          let at = from
          state.one = (node) => {
            if (node !== children.input[at]) throw new Error('Projection child order changed')
            const result = at < start ? undefined : children.results[at]
            at++
            return result
          }
          let values: ElementContent[]
          try {
            values = nativeAll({ ...children.node, children: input } as Nodes)
          } finally {
            state.one = nativeOne
          }
          assertOpen()
          if (at !== end) throw new Error('Incomplete native child conversion')
          for (const value of values) {
            children.values.push(value)
            if (advance()) {
              progress = 0
              yield
              assertOpen()
            }
          }
          if (input.length >= batch || advance()) {
            progress = 0
            yield
            assertOpen()
          }
        }
        children.results.length = 0
        frame.at++
        continue
      }
      let requested = 0
      state.one = rejectOne
      state.all = (node) => {
        const children = frame.children[requested++]
        if (!children || children.node !== node)
          throw new Error('Unexpected projection child request')
        return children.values
      }
      let value: Result
      try {
        value = invoke(frame.node, frame.parent)
      } finally {
        state.one = nativeOne
        state.all = nativeAll
      }
      assertOpen()
      if (frame.children.slice(requested).some((children) => children.input.length))
        throw new Error('Unused projection child conversion')
      frames.pop()
      const enclosing = frames[frames.length - 1]
      if (!enclosing) return value
      const target = enclosing.children[enclosing.at]
      if (!target) throw new Error('Missing projection child owner')
      target.results.push(value)
      target.at++
    }
    throw new Error('Missing projection conversion result')
  } finally {
    state.one = nativeOne
    state.all = nativeAll
    frames.length = 0
  }
}
