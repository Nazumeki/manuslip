import { messageSize, semanticLimits } from '@manuslip/core'
import type { RenderOptions } from '@manuslip/renderer'
import type { PackedCapture } from '../../../../../../packages/core/src/packing-capture'
import type { PackedSnapshotCertificate } from '../../../../../../packages/renderer/src/packed-snapshot-certificate'
import { type SemanticFailureReason, semanticFailureMetric, semanticMetric } from './metrics'
import type { PackedSemanticResult, PackedSnapshot, PackedWorkerPort } from './packed-port'
import { absoluteNow, type ParseRequest, parseResponse, type Snapshot } from './protocol'

export interface WorkerPort {
  readonly kind?: 'native'
  onMessage(listener: (value: unknown) => void): void
  onFailure(listener: (reason?: SemanticFailureReason) => void): void
  post(request: ParseRequest): void
  terminate(): void
}
export type SemanticWorkerPort = WorkerPort | PackedWorkerPort
export type SemanticEvent =
  | { kind: 'pending' }
  | {
      kind: 'error'
      code: 'semantic-limit' | 'semantic-parse' | 'semantic-worker'
      paused: boolean
    }
  | {
      kind: 'snapshot'
      sequence: number
      revision: number
      snapshot: Snapshot
      requestSentAt: number
      freshnessMs: number
      transportOutMs: number
      applyStarted: number
    }
  | {
      kind: 'packed-snapshot'
      sequence: number
      revision: number
      snapshot: PackedSnapshot
      /** Borrowed during notification; queued consumers must retain independently. */
      capture: PackedCapture
      certificate: PackedSnapshotCertificate
      requestSentAt: number
      freshnessMs: number
      transportOutMs: number
      applyStarted: number
    }
interface Consumer {
  id: string
  generation: number
  revision: number
  intent: number
  notify: (event: SemanticEvent) => void
}
interface Pending {
  owner: Consumer
  revision: number
  intent: number
  source: () => string
  options: RenderOptions
  editedAt: number
  eligible: boolean
}
interface Running {
  pending: Pending
  request: ParseRequest
}
export interface SemanticConnection {
  request(
    revision: number,
    source: () => string,
    options: RenderOptions,
    completion?: boolean,
  ): void
  retry(): void
  warm(): void
  dispose(): void
}

/** One running parse and one newest pending request per window. No editable document lives here. */
export class SemanticService {
  private active: Consumer | null = null
  private pending: Pending | null = null
  private running: Running | null = null
  private worker: SemanticWorkerPort | null = null
  private sequence = 0
  private generation = 0
  private failures: number[] = []
  private paused = false
  private disposed = false
  private idle: ReturnType<typeof setTimeout> | null = null
  private maximum: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private latest: Pending | null = null

  constructor(private readonly createWorker: () => SemanticWorkerPort) {}

  connect(id: string, notify: Consumer['notify']): SemanticConnection {
    const owner: Consumer = { id, generation: ++this.generation, revision: -1, intent: 0, notify }
    this.active = owner
    return {
      request: (revision, source, options, completion = false) => {
        if (this.disposed || this.active !== owner) return
        owner.revision = revision
        const pending: Pending = {
          owner,
          revision,
          intent: ++owner.intent,
          source,
          options,
          editedAt: absoluteNow(),
          eligible: false,
        }
        this.latest = pending
        if (this.paused) {
          notify({ kind: 'error', code: 'semantic-worker', paused: true })
          return
        }
        this.pending = pending
        notify({ kind: 'pending' })
        if (this.idle) clearTimeout(this.idle)
        this.idle = setTimeout(() => this.publish(), completion ? 16 : semanticLimits.debounce)
        this.maximum ??= setTimeout(() => this.publish(), semanticLimits.maxDelay)
      },
      retry: () => {
        if (this.active !== owner || this.disposed) return
        this.paused = false
        this.failures = []
        if (this.latest?.owner === owner) {
          this.pending = { ...this.latest, eligible: true }
          owner.notify({ kind: 'pending' })
          this.start()
        }
      },
      warm: () => {
        if (this.disposed || this.active !== owner || this.running || this.pending) return
        if (this.worker?.kind === 'packed') this.worker.warm()
      },
      dispose: () => {
        if (this.active === owner) this.active = null
        if (this.pending?.owner === owner) {
          this.pending = null
          this.clearSchedule()
        }
        if (this.latest?.owner === owner) this.latest = null
      },
    }
  }

  private clearSchedule(): void {
    if (this.idle) clearTimeout(this.idle)
    if (this.maximum) clearTimeout(this.maximum)
    this.idle = this.maximum = null
  }
  private publish(): void {
    this.clearSchedule()
    if (this.pending) this.pending.eligible = true
    this.start()
  }
  private start(): void {
    if (this.disposed || this.paused || this.running || !this.pending?.eligible) return
    const pending = this.pending
    this.pending = null
    if (this.active !== pending.owner) return
    const prepareStarted = performance.now()
    const request: ParseRequest = {
      kind: 'parse',
      sequence: ++this.sequence,
      generation: pending.owner.generation,
      documentId: pending.owner.id,
      revision: pending.revision,
      source: pending.source(),
      options: pending.options,
      sentAt: absoluteNow(),
    }
    const running = { pending, request }
    this.running = running
    let failure: SemanticFailureReason = 'worker-create'
    try {
      if (!this.worker) {
        const worker = this.createWorker()
        this.worker = worker
        failure = 'worker-listener'
        if (worker.kind === 'packed')
          worker.onResult((value) => {
            if (this.worker === worker) this.receivedPacked(value)
          })
        else
          worker.onMessage((value) => {
            if (this.worker === worker) this.received(value)
          })
        worker.onFailure((reason) => {
          if (this.worker === worker) this.failed(reason ?? 'worker-failure')
        })
      }
      // Synchronous failure notification can already have started a replacement.
      // This call must neither post its stale request nor fail that replacement.
      if (this.running !== running) return
      // Only a port that independently sizes the complete request may defer this guard.
      // Native and older ports retain the complete JSON cap before any message is posted.
      if (
        !(this.worker.kind === 'packed' && this.worker.postRequestCooperative) &&
        messageSize(request) > semanticLimits.messageBytes
      ) {
        this.running = null
        pending.owner.notify({ kind: 'error', code: 'semantic-limit', paused: false })
        this.start()
        return
      }
      this.watchdog = setTimeout(() => this.failed('watchdog'), semanticLimits.watchdog)
      failure = 'worker-post'
      if (this.worker.kind === 'packed' && this.worker.postRequestCooperative)
        this.worker.postRequestCooperative(request)
      else if (this.worker.kind === 'packed' && this.worker.postCooperative)
        this.worker.postCooperative(request)
      else this.worker.post(request)
      semanticMetric('semantic-request', prepareStarted, { bytes: request.source.length * 2 })
    } catch {
      if (this.running === running) this.failed(failure)
    }
  }

  private receivedPacked(response: PackedSemanticResult): void {
    const running = this.running
    if (!running) return
    try {
      const request = running.request
      if (
        response.sequence !== request.sequence ||
        response.generation !== request.generation ||
        response.documentId !== request.documentId ||
        response.revision !== request.revision
      )
        throw new Error('Packed service result mismatch')
      if (this.watchdog) clearTimeout(this.watchdog)
      this.watchdog = null
      this.running = null
      if (
        this.active === running.pending.owner &&
        running.pending.owner.revision === response.revision &&
        running.pending.owner.intent === running.pending.intent
      ) {
        if (response.kind === 'error')
          running.pending.owner.notify({ kind: 'error', code: response.code, paused: false })
        else
          running.pending.owner.notify({
            kind: 'packed-snapshot',
            sequence: request.sequence,
            revision: response.revision,
            snapshot: response.snapshot,
            capture: response.capture,
            certificate: response.certificate,
            requestSentAt: request.sentAt,
            freshnessMs: absoluteNow() - running.pending.editedAt,
            transportOutMs: Math.max(0, absoluteNow() - response.sentAt),
            applyStarted: performance.now(),
          })
      }
      this.start()
    } catch {
      // Validation still owns this running request. After acceptance, a consumer may
      // throw after synchronously starting newer work; that work keeps its Worker.
      if (this.running === running) this.failed('packed-result')
      else this.start()
    }
  }

  private received(value: unknown): void {
    const arrivedAt = absoluteNow()
    const running = this.running
    if (!running) return
    try {
      const validateStarted = performance.now()
      const response = parseResponse(value, running.request)
      semanticMetric('semantic-validate', validateStarted)
      if (this.watchdog) clearTimeout(this.watchdog)
      this.watchdog = null
      this.running = null
      if (
        this.active === running.pending.owner &&
        running.pending.owner.revision === response.revision &&
        running.pending.owner.intent === running.pending.intent
      ) {
        if (response.kind === 'error')
          running.pending.owner.notify({ kind: 'error', code: response.code, paused: false })
        else
          running.pending.owner.notify({
            kind: 'snapshot',
            sequence: running.request.sequence,
            revision: response.revision,
            snapshot: response.snapshot,
            requestSentAt: running.request.sentAt,
            freshnessMs: absoluteNow() - running.pending.editedAt,
            transportOutMs: Math.max(0, arrivedAt - response.sentAt),
            applyStarted: performance.now(),
          })
      }
      this.start()
    } catch {
      if (this.running === running) this.failed('native-response')
      else this.start()
    }
  }

  private failed(reason: SemanticFailureReason): void {
    semanticFailureMetric(
      reason,
      this.running ? Math.max(0, absoluteNow() - this.running.request.sentAt) : null,
      this.worker !== null,
    )
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    this.worker?.terminate()
    this.worker = null
    this.running = null
    if (this.disposed) return
    const latest = this.latest
    if (!latest || this.active !== latest.owner) {
      this.start()
      return
    }
    const now = Date.now()
    this.failures = this.failures.filter((time) => time > now - semanticLimits.restartWindow)
    if (this.failures.length >= semanticLimits.restarts) {
      this.paused = true
      this.pending = null
      this.clearSchedule()
      latest.owner.notify({ kind: 'error', code: 'semantic-worker', paused: true })
      return
    }
    this.failures.push(now)
    this.pending = { ...latest, eligible: true }
    this.clearSchedule()
    latest.owner.notify({ kind: 'pending' })
    this.start()
  }

  dispose(): void {
    this.disposed = true
    this.clearSchedule()
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
    this.worker?.terminate()
    this.worker = null
    this.active = null
    this.pending = this.running = this.latest = null
  }
}
