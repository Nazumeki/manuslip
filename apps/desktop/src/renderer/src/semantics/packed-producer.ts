import { parserVersion, semanticLimits, sourceHash } from '@manuslip/core'
import { type RenderOptions, rendererVersion } from '@manuslip/renderer'
import { finishPackedCleanup } from '../../../../../../packages/core/src/packing-cleanup'
import {
  type PackedRequest,
  readPackedRequest,
} from '../../../../../../packages/core/src/packing-exchange'
import { PackedPublisher } from '../../../../../../packages/core/src/packing-publisher'
import type { PackedResource } from '../../../../../../packages/core/src/packing-resources'
import {
  PackedSession,
  type PackedSessionLimits,
} from '../../../../../../packages/core/src/packing-session'
import {
  identityKeys,
  PackedSource,
  sameIdentity,
} from '../../../../../../packages/core/src/packing-source'
import { newPackedToken } from '../../../../../../packages/core/src/packing-token'
import {
  type PackedWireMessage,
  packedWireVersion,
  readPackedWire,
} from '../../../../../../packages/core/src/packing-wire'
import { PackedWork } from '../../../../../../packages/core/src/packing-work'
import { UnsupportedSemanticDependencies } from '../../../../../../packages/core/src/semantic-dependencies'
import {
  buildProducerDependencies,
  type ProducerDependencies,
} from './packed-producer-dependencies'
import {
  encodeProducerFragment,
  type FragmentEncoding,
  type FragmentPhase,
} from './packed-producer-fragment'
import { encodeProducerFull } from './packed-producer-full'
import { isPreparedProducerSource, type PreparedProducerSource } from './packed-producer-source'
import { absoluteNow, parseRequest } from './protocol'

type Offer = Exclude<PackedWireMessage, { kind: 'resync' }>
type Phase = 'idle' | 'parse' | 'render' | 'prepare' | 'offered' | 'disposed' | FragmentPhase
const encodingLimits = { working: 32 * 1024 * 1024, nodes: 800000, depth: 512 }
const capacityError = (error: unknown) =>
  error instanceof Error &&
  !error.message.startsWith('Invalid ') &&
  /limit|scope|capacity/.test(error.message)

/** Experimental application producer. Full results stream compiled blocks into an owned
 * document, then render/assemble from packed readers. Native parser allocation still needs
 * admission/calibration. This coordinator is not enabled by the ordinary worker.
 * One cooperative offer may be pending; only a transferred, exact ACK commits its base.
 */
export class PackedSemanticProducer {
  readonly #owner: PackedSession
  readonly #publisher: PackedPublisher
  readonly #limits: PackedSessionLimits
  #dependencies: ProducerDependencies | undefined
  #pendingDependencies: ProducerDependencies | undefined
  #replaceDependencies = false
  #cacheEvictions = 0
  #work: PackedWork<Offer> | undefined
  #cacheWork: PackedWork<boolean> | undefined
  #phase: Phase = 'idle'
  #activeTime: (() => number) | undefined

  constructor(limits: PackedSessionLimits, activeTime?: () => number) {
    if (activeTime !== undefined && typeof activeTime !== 'function')
      throw new Error('Invalid packed producer active clock')
    if (limits.retained > semanticLimits.workerCacheBytes)
      throw new Error('Packed producer exceeds worker cache limit')
    this.#owner = new PackedSession(limits)
    this.#limits = Object.freeze({ ...limits })
    this.#publisher = new PackedPublisher(this.#owner)
    this.#activeTime = activeTime
  }
  get stats() {
    return Object.freeze({
      ...this.#owner.stats,
      phase: this.#phase,
      cacheEvictions: this.#cacheEvictions,
      dependencyCache: this.#dependencies !== undefined,
    })
  }
  /** Independent immutable capture for consumers; it retains its ordinary session charge. */
  capture() {
    return this.#owner.capture()
  }
  /** Trusted application control metadata shares the producer's existing session cap. */
  retain(resource: { resources(): Iterable<PackedResource> }) {
    return this.#owner.retain(resource)
  }
  /** Optional idle acceleration over the exact acknowledged current revision. It never
   * commits data or acknowledges a pending offer. Supersession cancels partial construction.
   */
  cacheSteps(): PackedWork<boolean> {
    if (this.#phase !== 'idle' || this.#work || this.#cacheWork)
      throw new Error('Packed producer cache requires idle acknowledged data')
    const capture = this.#owner.capture()
    const producer = this
    let child: PackedWork<ProducerDependencies> | undefined
    let work: PackedWork<boolean>
    work = new PackedWork(
      (function* () {
        if (producer.#dependencies?.index.sourceResource === capture.sourceResource) return true
        producer.#phase = 'dependencies'
        try {
          child = buildProducerDependencies(producer.#owner, producer.#limits, capture)
          const built = yield* child
          if (!built) throw new Error('Incomplete producer dependency cache')
          producer.#dependencies?.hold.release()
          producer.#dependencies = built
          return true
        } catch (error) {
          if (error instanceof UnsupportedSemanticDependencies || capacityError(error)) return false
          throw error
        }
      })(),
      () => {
        try {
          child?.return()
        } finally {
          capture.release()
          if (producer.#cacheWork === work) {
            producer.#cacheWork = undefined
            if (producer.#phase !== 'disposed') producer.#phase = 'idle'
          }
        }
      },
    )
    this.#cacheWork = work
    return work
  }
  prepare(input: unknown, exchange: unknown): PackedWork<Offer> {
    if (this.#phase === 'disposed') throw new Error('Packed producer disposed')
    const request = parseRequest(input)
    // Copy only validated fields. A suspended task must not observe caller mutations.
    const options: RenderOptions = Object.freeze({
      rawHtml: request.options.rawHtml,
      footnotesLabel: request.options.footnotesLabel,
      footnoteBackLabel: request.options.footnoteBackLabel,
    })
    const source = new PackedSource(
      {
        generation: request.generation,
        documentId: request.documentId,
        revision: request.revision,
        sourceHash: sourceHash(request.source),
        parserVersion: `${parserVersion}/manuslip`,
        rendererVersion,
        options: JSON.stringify(options),
      },
      request.source,
    )
    const checked = readPackedRequest(exchange, source.identity)
    if (checked.value.sequence !== request.sequence)
      throw new Error('Packed producer sequence mismatch')
    const transportInMs = Math.max(0, absoluteNow() - request.sentAt)
    return this.#prepare(source, options, checked, transportInMs, false)
  }
  /** Only the completed private source factory authorizes this entry. Admission precedes
   * revoking an existing offer, so a rejected candidate cannot destroy that offer.
   */
  preparePrepared(prepared: PreparedProducerSource): PackedWork<Offer> {
    if (this.#phase === 'disposed') throw new Error('Packed producer disposed')
    if (!isPreparedProducerSource(prepared)) throw new Error('Invalid prepared producer source')
    return this.#prepare(
      prepared.source,
      prepared.request.options,
      prepared.checked,
      prepared.transportInMs,
      true,
    )
  }
  #prepare(
    source: PackedSource,
    options: RenderOptions,
    checked: ReturnType<typeof readPackedRequest>,
    transportInMs: number,
    admitBeforeCancel: boolean,
  ): PackedWork<Offer> {
    if (!admitBeforeCancel) this.cancel()
    let current = false
    if (this.#owner.stats.current) {
      const capture = this.#owner.capture()
      try {
        if (
          sameIdentity(capture.identity, source.identity) &&
          capture.sourceResource.text === source.text
        ) {
          source = capture.sourceResource
          current = true
        }
      } finally {
        capture.release()
      }
    }
    // The queued handle owns its normalized request/source too, before native work starts.
    // Source resources union with a current/prepared revision when they are identical.
    const metadata = this.#owner.retain({
      resources: () => [
        { key: checked, bytes: checked.retainedBytes + 4096 },
        { key: source, bytes: source.retainedBytes },
      ],
    })
    if (admitBeforeCancel) {
      try {
        this.cancel()
      } catch (error) {
        metadata.release()
        throw error
      }
    }
    const producer = this
    let completed = false
    let child: PackedWork<unknown> | undefined
    let work: PackedWork<Offer>
    work = new PackedWork(
      (function* () {
        if (current) {
          producer.#phase = 'prepare'
          const resync = new PackedWork(producer.#resync(checked.value, source), () => {})
          child = resync
          try {
            const message = yield* resync
            if (!message) throw new Error('Incomplete packed resync')
            completed = true
            producer.#phase = 'offered'
            return message
          } catch (error) {
            if (!capacityError(error)) throw error
            // A large overlay plus its complete outgoing encoding may not coexist.
            // Evict the optional committed cache and recompute a full result; explicit
            // old consumer captures stay valid and charged, and may still deny admission.
            producer.#publisher.reset()
            producer.#owner.evict()
            producer.#cacheEvictions++
            yield
          }
        }
        let incremental = true
        while (true) {
          let base = incremental ? producer.#publisher.base(checked.value, source) : undefined
          if (
            base &&
            (source.identity.revision <= base.identity.revision ||
              identityKeys.some(
                (key) =>
                  key !== 'revision' &&
                  key !== 'sourceHash' &&
                  source.identity[key] !== base?.identity[key],
              ))
          )
            base = undefined
          try {
            const ticket = producer.#owner.beginPrepared(source)
            let fragment: FragmentEncoding | undefined
            if (base) {
              const local = encodeProducerFragment(
                producer.#owner,
                producer.#limits,
                base,
                source,
                options,
                producer.#dependencies,
                (phase) => {
                  producer.#phase = phase
                },
                producer.#activeTime,
              )
              child = local
              fragment = yield* local
              if (fragment) producer.#pendingDependencies = fragment.dependencies
              else base = undefined
            }
            let encoded: { payload: ArrayBuffer; serializeMs: number } | undefined = fragment
            if (!encoded) {
              producer.#phase = 'parse'
              const native = encodeProducerFull(
                producer.#owner,
                ticket,
                source,
                options,
                encodingLimits,
                producer.#limits.staging,
                (phase) => {
                  producer.#phase = phase
                },
                producer.#activeTime,
              )
              child = native
              encoded = yield* native
            }
            if (!encoded) throw new Error('Incomplete packed producer encoding')
            const { payload, serializeMs } = encoded
            const started = producer.#activeTime?.() ?? performance.now()
            const wire = readPackedWire(
              {
                protocol: packedWireVersion,
                ...(base && fragment
                  ? {
                      kind: 'delta',
                      base: base.identity,
                      baseToken: checked.value.base?.token,
                      operations: fragment.operations,
                    }
                  : { kind: 'full' }),
                sequence: checked.value.sequence,
                requestToken: checked.value.requestToken,
                resultToken: newPackedToken(),
                result: source.identity,
                sentAt: absoluteNow(),
                payload,
                metadata: { cached: false, transportInMs, serializeMs: 0 },
              },
              {
                sequence: checked.value.sequence,
                result: source.identity,
                requestToken: checked.value.requestToken,
              },
            )
            // Admit the two buffers before the copy. Exchange this temporary reservation
            // synchronously for prepareFullSteps' input and outgoing reservation below.
            const reservation = producer.#owner.retain({
              resources: () => [
                { key: payload, bytes: payload.byteLength * 2 + wire.retainedBytes + 8192 },
              ],
            })
            let input: ArrayBuffer
            try {
              input = payload.slice(0)
            } finally {
              reservation.release()
            }
            producer.#phase = 'prepare'
            const preparation =
              base && fragment
                ? producer.#owner.prepareDeltaSteps(
                    ticket,
                    {
                      base: base.identity,
                      baseSource: base.text,
                      result: source.identity,
                      payload: input,
                      operations: fragment.operations,
                    },
                    wire.bytes + wire.retainedBytes + 8192,
                  )
                : producer.#owner.prepareFullSteps(
                    ticket,
                    source.identity,
                    input,
                    wire.bytes + wire.retainedBytes + 8192,
                  )
            child = preparation
            const prepared = yield* preparation
            if (!prepared) throw new Error('Incomplete packed producer preparation')
            const message = producer.#publisher.offer(checked.value, source, prepared, {
              ...wire.message,
              sentAt: absoluteNow(),
              metadata: {
                cached: false,
                transportInMs,
                serializeMs:
                  serializeMs + (producer.#activeTime?.() ?? performance.now()) - started,
              },
            })
            if (message.kind === 'resync') throw new Error('Unexpected packed producer resync')
            completed = true
            producer.#replaceDependencies = true
            producer.#phase = 'offered'
            return message
          } catch (error) {
            if (!capacityError(error)) throw error
            if (!base && !producer.#owner.stats.current) throw error
            // An optional delta may outgrow the union of current/cached/pending data.
            // Drop its candidate and retry a complete result under the same fixed caps.
            child?.return()
            producer.#pendingDependencies?.hold.release()
            producer.#pendingDependencies = undefined
            producer.#dependencies?.hold.release()
            producer.#dependencies = undefined
            if (base) producer.#owner.invalidate()
            else {
              // A complete replacement may also outgrow coexistence with the cache.
              // Its immutable source is queued independently; release only cache
              // ownership and retry once without that base, keeping consumer captures.
              producer.#publisher.reset()
              producer.#owner.evict()
              producer.#cacheEvictions++
            }
            incremental = false
            yield
          }
        }
      })(),
      () => {
        finishPackedCleanup([
          () => {
            child?.return()
          },
          () => {
            if (completed) return
            const pending = producer.#pendingDependencies
            producer.#pendingDependencies = undefined
            finishPackedCleanup([
              () => pending?.hold.release(),
              () => {
                producer.#publisher.cancel()
              },
              () => producer.#owner.invalidate(),
              () => {
                if (producer.#phase !== 'disposed') producer.#phase = 'idle'
              },
            ])
          },
          () => metadata.release(),
          () => {
            if (producer.#work === work) producer.#work = undefined
          },
        ])
      },
    )
    this.#work = work
    return work
  }
  *#resync(request: PackedRequest, source: PackedSource): Generator<void, Offer | undefined> {
    while (true) {
      try {
        return yield* this.#publisher.offerCurrentSteps(request, source, {
          bytes: semanticLimits.messageBytes - 1024,
          // Leave bounded control/footprint space in the same session staging ledger.
          workspace: Math.max(
            0,
            Math.min(this.#limits.staging, semanticLimits.messageBytes) - 65536,
          ),
          nodes: encodingLimits.nodes,
          depth: 128,
        })
      } catch (error) {
        if (!this.#dependencies || !capacityError(error)) throw error
        // Dependency acceleration is optional. Release it before retrying serialization;
        // preserve the committed result, accepted receipt and independent old captures.
        this.#dependencies.hold.release()
        this.#dependencies = undefined
        yield
      }
    }
  }
  acknowledge(value: unknown): void {
    this.#publisher.acknowledge(value)
    if (this.#replaceDependencies) {
      this.#dependencies?.hold.release()
      this.#dependencies = this.#pendingDependencies
      this.#pendingDependencies = undefined
      this.#replaceDependencies = false
    }
    this.#phase = 'idle'
  }
  cancel(): void {
    if (this.#phase === 'disposed') return
    finishPackedCleanup([
      () => {
        this.#cacheWork?.return()
      },
      () => {
        this.#work?.return()
      },
      () => {
        this.#publisher.cancel()
      },
      () => this.#owner.invalidate(),
      () => {
        const pending = this.#pendingDependencies
        this.#pendingDependencies = undefined
        pending?.hold.release()
      },
      () => {
        this.#replaceDependencies = false
        this.#phase = 'idle'
      },
    ])
  }
  dispose(): void {
    if (this.#phase === 'disposed') return
    finishPackedCleanup([
      () => this.cancel(),
      () => {
        const dependencies = this.#dependencies
        this.#dependencies = undefined
        dependencies?.hold.release()
      },
      () => this.#publisher.dispose(),
      () => this.#owner.dispose(),
      () => {
        this.#activeTime = undefined
        this.#phase = 'disposed'
      },
    ])
  }
}
