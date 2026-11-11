import type { Root as HastRoot } from 'hast'
import type { Definition, FootnoteDefinition, Nodes, Parents, Root, RootContent } from 'mdast'
import { type State, toHast } from 'mdast-util-to-hast'
import type { ProjectionChildren, RenderOptions, RenderProjection } from './index'
import { projectChildren } from './projection-children'
import { projectionConversionSteps } from './projection-conversion-steps'
import { projectHast, projectionOptions } from './projection-engine'
import { scopeTableCells } from './projection-table-context'

export type ProjectionDefinition = Definition | FootnoteDefinition

export interface ProjectionAdmission {
  node(state: State, node: Nodes, parent: Parents | undefined): void
  nodeSteps?(state: State, node: Nodes, parent: Parents | undefined): Generator<void> | void
  footer(state: State): void
  conversion?(bytes: number): void
}
export interface ProjectionConversion {
  root: Root
  hast: HastRoot
  started: number
  visible: boolean
}

function conversion(root: Root, converted: ReturnType<State['one']>, started: number) {
  const hast: HastRoot = {
    type: 'root',
    children: converted === undefined ? [] : Array.isArray(converted) ? converted : [converted],
  }
  if (hast.children.length > 1) throw new Error('Unsupported sequenced root output')
  return { root, hast, started, visible: hast.children.length === 1 }
}

/** Caller-admitted native context and one block at a time. Public handler State preserves
 * global first definitions, footnote order and repeated-call counters between blocks.
 * This class does not own a packed capture, perform admission or bound native call time.
 */
export class ProjectionSequence {
  #state: State | undefined
  #context: Root | undefined
  #admission: ProjectionAdmission | undefined
  #nativeOne: State['one'] | undefined
  #converting = false
  readonly #options: RenderOptions
  #children: ProjectionChildren | undefined
  constructor(
    context: readonly ProjectionDefinition[],
    options: RenderOptions,
    children?: ProjectionChildren,
  ) {
    this.#children = children
    this.#options = Object.freeze({
      rawHtml: options.rawHtml,
      footnotesLabel: options.footnotesLabel,
      footnoteBackLabel: options.footnoteBackLabel,
    })
    this.#context = { type: 'root', children: [...context] }
    let captured: State | undefined
    toHast(
      this.#context,
      projectionOptions(this.#options, {
        root(state) {
          scopeTableCells(state)
          captured = state
          return []
        },
      }),
    )
    if (!captured) throw new Error('Missing public projection state')
    this.#state = captured
    const state = captured
    if (children) projectChildren(state, children)
    const one = state.one
    this.#nativeOne = one
    state.one = (node, parent) => {
      this.#admission?.node(state, node, parent)
      return one(node, parent)
    }
  }
  /** Internal allocation hooks run before the pinned public handler allocates output. */
  admit(admission: ProjectionAdmission): void {
    if (!this.#state || this.#admission) throw new Error('Projection admission unavailable')
    this.#admission = admission
  }
  convert(node: RootContent): ProjectionConversion {
    const state = this.#state
    if (!state) throw new Error('Projection sequence closed')
    if (this.#converting) throw new Error('Projection conversion already active')
    try {
      const started = performance.now()
      const root: Root = { type: 'root', children: [node] }
      // Pinned root-content handlers produce one positioned node or omit the block.
      // Reject custom data/handlers that would require a different span protocol.
      return conversion(root, state.one(node, root), started)
    } catch (error) {
      this.close()
      throw error
    }
  }
  /** Internal conversion under a caller-owned task. Child preparation yields between
   * native handlers. Scratch requires its own admission; substitution callbacks and the
   * complete native footer retain the synchronous APIs. Abandoning active work closes
   * the sequence so partially updated footnote counters cannot be reused.
   */
  *convertSteps(
    node: RootContent,
    limits: { nodes: number; depth: number },
  ): Generator<void, ProjectionConversion> {
    const state = this.#state
    const invoke = this.#nativeOne
    if (!state || !invoke) throw new Error('Projection sequence closed')
    if (this.#converting) throw new Error('Projection conversion already active')
    if (this.#children) throw new Error('Cooperative projection substitutions are unsupported')
    this.#converting = true
    let complete = false
    try {
      const started = performance.now()
      const root: Root = { type: 'root', children: [node] }
      const converted = yield* projectionConversionSteps(
        state,
        node,
        root,
        { ...limits },
        invoke,
        (node, parent) => {
          const admission = this.#admission
          if (admission?.nodeSteps) return admission.nodeSteps(state, node, parent)
          admission?.node(state, node, parent)
        },
        (bytes) => {
          if (this.#admission && !this.#admission.conversion)
            throw new Error('Missing projection conversion admission')
          this.#admission?.conversion?.(bytes)
        },
        () => {
          if (this.#state !== state) throw new Error('Projection sequence closed')
        },
      )
      const result = conversion(root, converted, started)
      complete = true
      return result
    } catch (error) {
      this.close()
      throw error
    } finally {
      this.#converting = false
      if (!complete) this.close()
    }
  }
  render(node: RootContent): { projection: RenderProjection; visible: boolean } {
    try {
      const { root, hast, started, visible } = this.convert(node)
      return {
        projection: projectHast(root, hast, this.#options, undefined, undefined, started),
        visible,
      }
    } catch (error) {
      this.close()
      throw error
    }
  }
  finishConversion(): ProjectionConversion {
    const shared = this.#state
    const context = this.#context
    if (!shared || !context) throw new Error('Projection sequence closed')
    if (this.#converting) throw new Error('Projection conversion already active')
    const started = performance.now()
    try {
      const admission = this.#admission
      const children = this.#children
      admission?.footer(shared)
      // A fresh public root handler supplies the accumulated state. toHast generates
      // its footer once, including definitions/calls discovered while rendering notes.
      const hast = toHast(
        context,
        projectionOptions(this.#options, {
          root(state) {
            scopeTableCells(state)
            if (children) projectChildren(state, children)
            state.definitionById.clear()
            state.footnoteById.clear()
            for (const [key, value] of shared.definitionById) state.definitionById.set(key, value)
            for (const [key, value] of shared.footnoteById) state.footnoteById.set(key, value)
            for (const key of shared.footnoteOrder) state.footnoteOrder.push(key)
            for (const [key, value] of shared.footnoteCounts) state.footnoteCounts.set(key, value)
            const one = state.one
            state.one = (node, parent) => {
              admission?.node(state, node, parent)
              return one(node, parent)
            }
            return []
          },
        }),
      )
      if (hast.type !== 'root') throw new Error('Invalid sequenced footer')
      return { root: context, hast, started, visible: hast.children.length > 0 }
    } finally {
      this.close()
    }
  }
  finish(): RenderProjection {
    const { root, hast, started } = this.finishConversion()
    return projectHast(root, hast, this.#options, undefined, undefined, started)
  }
  close(): void {
    this.#state = undefined
    this.#context = undefined
    this.#admission = undefined
    this.#nativeOne = undefined
    this.#converting = false
    this.#children = undefined
  }
}
