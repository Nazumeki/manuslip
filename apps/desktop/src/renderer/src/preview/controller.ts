import {
  defaultMarkdownPlugins,
  type Heading,
  type MarkdownPlugins,
  markdownPluginNames,
  semanticLimits,
} from '@manuslip/core'
import {
  Compartment,
  composingEffect,
  type EditorState,
  type EditorView,
  type Extension,
  isComposing,
  type LiveLink,
  type LiveModel,
  type LiveOptions,
  latexMarkdown,
  liveModel,
  livePreview,
  navigateLiveAnchor,
  OccurrenceTracker,
  optMarkdown,
  setLiveModel,
  type Transaction,
  type TransactionSpec,
  yamlFrontmatter,
} from '@manuslip/editor'
import type { RenderOptions } from '@manuslip/renderer'
import type { PackedCapture } from '../../../../../../packages/core/src/packing-capture'
import { PackedSession } from '../../../../../../packages/core/src/packing-session'
import { PackedWork } from '../../../../../../packages/core/src/packing-work'
import type { PackedSnapshotCertificate } from '../../../../../../packages/renderer/src/packed-snapshot-certificate'
import type { AssetBridge } from '../../../shared/asset-contracts'
import type { DiagramBridge } from '../../../shared/diagram-contracts'
import type { ImageBridge } from '../../../shared/image-contracts'
import { i18next } from '../i18n'
import { getSemanticService } from '../semantics/browser'
import { semanticMetric } from '../semantics/metrics'
import { canPreparePackedPreview } from '../semantics/packed-admission'
import type { PackedSnapshot } from '../semantics/packed-port'
import { absoluteNow, type Snapshot } from '../semantics/protocol'
import type { SemanticConnection, SemanticEvent, SemanticService } from '../semantics/service'
import { SlicedWork, type SliceRuntime, type SliceStats } from '../semantics/sliced-work'
import type { ReadingCapture } from '../translation/prepare'
import { prepareOwnedPreview } from './owned-preparation'
import { OwnedPackedPreview, type PackedPreviewLease } from './packed-preparation'
import { type PreparedPreview, preparePreview } from './preparation'
import { previewStatusLimits, type StatusResource } from './status-publication'
import { renderWidget } from './widgets'

export interface PreviewStatus {
  previewPublication: number
  mode: 'source' | 'live'
  semantic: 'idle' | 'pending' | 'ready' | 'error' | 'limit'
  semanticError: string | null
  semanticRevision: number | null
  wordCount: number | null
  characterCount: number | null
  outline: readonly Heading[]
  freshnessMs: number | null
  rawHtml: boolean
  remoteImages: boolean
  imagePermissionBusy: boolean
  imageError: boolean
}
export const initialPreviewStatus: PreviewStatus = {
  previewPublication: 0,
  mode: 'source',
  semantic: 'idle',
  semanticError: null,
  semanticRevision: null,
  wordCount: null,
  characterCount: null,
  outline: [],
  freshnessMs: null,
  rawHtml: false,
  remoteImages: false,
  imagePermissionBusy: false,
  imageError: false,
}
type PreviewSnapshot = Snapshot | PackedSnapshot

/** Native snapshots use the existing decoded-size estimate; packed revisions report
 * their complete admitted graph, including dependencies retained across deltas.
 */
export function retainedSnapshotBytes(snapshot: PreviewSnapshot | null): number {
  if (!snapshot) return 0
  return 'document' in snapshot ? snapshot.bytes * 2 : snapshot.retainedBytes
}

function packedFailureCode(error: unknown): 'semantic-limit' | 'semantic-parse' {
  return error instanceof Error &&
    !error.message.startsWith('Invalid ') &&
    /limit|scope|capacity/.test(error.message)
    ? 'semantic-limit'
    : 'semantic-parse'
}

type SnapshotEvent = Extract<SemanticEvent, { kind: 'snapshot' | 'packed-snapshot' }>
interface DocumentAccess {
  id: string
  state(): EditorState
  view(): EditorView | null
  revision(): number
  bytes(): number
  dispatch(spec: TransactionSpec): void
  synchronizeInput?(): Promise<void>
  status(patch: Partial<PreviewStatus>): void
  reserveStatus?(acquire: () => StatusResource): {
    publish(patch: Partial<PreviewStatus>): void
    release(): void
  }
  openLink(url: string): void
  images?: ImageBridge
  assets?: AssetBridge
  diagrams?: DiagramBridge
}

/** Derived semantics have a separate lifetime from file saving and the editable body. */
export class DocumentPreview {
  private readonly mode = new Compartment()
  private readonly metadata = new Compartment()
  private readonly occurrences = new OccurrenceTracker()
  private readonly options = {
    sourceLabel: () => i18next.t('revealSource'),
    previewLabel: () => i18next.t('liveMode'),
    taskLabel: () => i18next.t('toggleTask'),
    render: (...args: Parameters<LiveOptions['render']>): void => {
      const images = this.document.images
      const assets = this.document.assets
      const owned = this.activeOwned
      let lease: PackedPreviewLease | undefined
      try {
        lease = owned?.retain()
        renderWidget(
          ...args,
          this.remoteImages && images
            ? (url) => images.loadRemoteImage(this.document.id, url)
            : undefined,
          assets ? (url) => assets.loadLocalImage(this.document.id, url) : undefined,
          this.plugins.mermaid && this.document.diagrams
            ? { bridge: this.document.diagrams, documentId: this.document.id }
            : undefined,
          false,
          lease,
        )
      } catch (error) {
        lease?.release()
        if (!owned) throw error
        args[0].textContent = i18next.t('widgetLimit')
        // CodeMirror is mounting DOM; switch modes after its update completes.
        queueMicrotask(() => {
          if (!this.disposed && this.activeOwned === owned)
            this.received({ kind: 'error', code: 'semantic-limit', paused: false })
        })
      }
    },
    openLink: (url: string, link?: LiveLink): void => {
      void this.openLink(url, link)
    },
  }
  private connection: SemanticConnection | null = null
  private currentMode: PreviewStatus['mode'] = 'source'
  private rawHtml = false
  private plugins: MarkdownPlugins = defaultMarkdownPlugins
  private remoteImages = false
  private disposed = false
  private mounted = false
  private viewing = false
  private navigationPinned = false
  private navigationReaders = 0
  private get navigation(): boolean {
    return this.navigationPinned || this.navigationReaders > 0
  }
  private applying: SlicedWork<PreparedPreview> | null = null
  private packedApplying: SlicedWork<OwnedPackedPreview> | null = null
  private readonly packedOwner = new PackedSession({
    bytes: semanticLimits.messageBytes,
    retained: semanticLimits.rendererBytes,
    staging: semanticLimits.messageBytes,
    captures: 8,
    readers: 160,
  })
  private owned: OwnedPackedPreview | null = null
  private activeOwned: OwnedPackedPreview | null = null
  private settled: {
    revision: number
    snapshot: PreviewSnapshot
    model: LiveModel
    owned?: OwnedPackedPreview
  } | null = null
  private readonly captures = new Set<{
    revision: number
    resolve(snapshot: PreviewSnapshot): void
    reject(error: Error): void
  }>()
  constructor(
    private readonly document: DocumentAccess,
    private readonly service: () => SemanticService = getSemanticService,
    private readonly applyRuntime?: SliceRuntime,
  ) {}

  get extensions(): Extension[] {
    return [
      liveModel,
      isComposing,
      this.mode.of([]),
      this.metadata.of([
        yamlFrontmatter.of(this.plugins.typora),
        optMarkdown.of(this.plugins.opt),
        latexMarkdown.of(this.plugins.latex),
      ]),
    ]
  }

  attach(): void {
    this.viewing = true
    if (!this.mounted) {
      this.mounted = true
      if (this.document.bytes() <= semanticLimits.previewBytes) this.setMode('live')
    } else if (this.currentMode === 'live' || this.navigation) {
      if (this.currentMode === 'live')
        this.document.dispatch({ effects: this.mode.reconfigure(livePreview(this.options)) })
      this.activate()
    }
  }
  detach(): void {
    this.cancelApply()
    this.connection?.dispose()
    this.connection = null
  }
  /** Inactive tabs keep editable state, but release their derived snapshot and widgets. */
  suspend(): void {
    this.failCaptures('translation-capture-changed')
    this.viewing = false
    this.detach()
    this.settled = null
    this.releaseOwned()
    this.occurrences.reset()
    this.activeOwned = null
    this.document.dispatch({ effects: [setLiveModel.of(null), this.mode.reconfigure([])] })
    this.document.status({
      semantic: 'idle',
      semanticRevision: null,
      wordCount: null,
      characterCount: null,
      outline: [],
      freshnessMs: null,
    })
  }

  setMode(mode: PreviewStatus['mode']): void {
    if (this.disposed || mode === this.currentMode) return
    if (mode === 'live' && this.document.bytes() > semanticLimits.previewBytes) {
      this.document.status({ semantic: 'limit', semanticError: 'semantic-limit' })
      return
    }
    this.currentMode = mode
    if (mode === 'source') this.activeOwned = null
    const effects = [this.mode.reconfigure(mode === 'live' ? livePreview(this.options) : [])]
    if (mode === 'source') effects.push(setLiveModel.of(null))
    const scroll = this.document.view()?.scrollSnapshot()
    if (scroll) effects.push(scroll)
    this.document.dispatch({ effects })
    this.document.status({
      mode,
      ...(mode === 'source'
        ? { semantic: this.settled?.revision === this.document.revision() ? 'ready' : 'idle' }
        : {}),
    })
    if (mode === 'live') {
      this.connect()
      if (this.settled?.revision === this.document.revision())
        this.apply(this.settled.model, this.settled.owned)
      else this.request()
    } else if (this.navigation && this.viewing) this.activate()
    else if (!this.captures.size) this.detach()
  }

  setNavigation(enabled: boolean): void {
    this.navigationPinned = enabled
    this.navigationChanged()
  }

  /** Visible metadata consumers own independent leases, so closing one panel
   * cannot detach another panel's outline/count subscription.
   */
  observeNavigation(): () => void {
    this.navigationReaders++
    this.navigationChanged()
    let observing = true
    return () => {
      if (!observing) return
      observing = false
      this.navigationReaders--
      this.navigationChanged()
    }
  }

  private navigationChanged(): void {
    const enabled = this.navigation
    if (!this.viewing || this.disposed) return
    if (enabled && this.document.bytes() > semanticLimits.previewBytes) {
      this.document.status({ semantic: 'limit', semanticError: 'semantic-limit' })
      if (this.currentMode === 'source') this.detach()
    } else if (enabled && this.currentMode === 'source') this.activate()
    else if (this.currentMode === 'source' && !this.captures.size) this.detach()
  }

  private connect(): void {
    if (!this.connection)
      this.connection = this.service().connect(this.document.id, (event) => this.received(event))
  }
  private activate(): void {
    if (!this.viewing || this.document.bytes() > semanticLimits.previewBytes) return
    this.connect()
    if (this.settled?.revision !== this.document.revision()) this.request()
  }
  renderOptions(): RenderOptions {
    return {
      rawHtml: this.rawHtml,
      ...(!markdownPluginNames.every((name) => this.plugins[name] === defaultMarkdownPlugins[name])
        ? { plugins: this.plugins }
        : {}),
      footnotesLabel: i18next.t('footnotes'),
      footnoteBackLabel: i18next.t('backToFootnote'),
    }
  }
  private request(completion = false): void {
    if (!this.connection || this.disposed) return
    const state = this.document.state()
    this.document.status({ semantic: 'pending', semanticError: null })
    this.connection.request(
      this.document.revision(),
      () => state.doc.toString(),
      this.renderOptions(),
      completion,
    )
  }

  changed(transactions: readonly Transaction[]): void {
    if (!transactions.some((transaction) => transaction.docChanged) || this.disposed) return
    this.failCaptures('translation-capture-changed')
    for (const transaction of transactions)
      if (transaction.docChanged) {
        this.occurrences.map(transaction.changes)
        this.owned?.map(transaction.changes)
      }
    this.settled = null
    if (this.viewing && (this.currentMode === 'live' || this.navigation)) {
      if (this.document.bytes() > semanticLimits.previewBytes) {
        this.detach()
        this.document.status({ semantic: 'limit', semanticError: 'semantic-limit' })
        // Nested dispatch is forbidden inside CodeMirror's content-update listener.
        // This transaction has already invalidated all old widgets.
        queueMicrotask(() => {
          if (this.disposed || this.document.bytes() <= semanticLimits.previewBytes) return
          if (this.currentMode === 'live') this.setMode('source')
          this.document.status({ semantic: 'limit', semanticError: 'semantic-limit' })
        })
      } else {
        let completion = false
        if (
          this.currentMode === 'live' &&
          this.document.state().doc.length <= 64 * 1024 &&
          !this.document.view()?.compositionStarted &&
          !this.document.state().field(isComposing, false)
        )
          for (const transaction of transactions)
            if (transaction.isUserEvent('input') && !transaction.isUserEvent('input.paste'))
              transaction.changes.iterChanges((_from, _to, _nextFrom, _nextTo, inserted) => {
                if (
                  inserted.length > 0 &&
                  inserted.length <= 4 &&
                  /[\]$:^~=)*`}>\n]/.test(inserted.toString())
                )
                  completion = true
              })
        this.request(completion)
      }
    }
  }

  composing(composing: boolean): void {
    this.document.dispatch({ effects: composingEffect.of(composing) })
  }
  localize(): void {
    if (this.currentMode === 'live') {
      this.settled = null
      this.request()
    }
  }
  setRawHtml(enabled: boolean): void {
    this.cancelApply()
    this.rawHtml = enabled
    this.settled = null
    this.releaseOwned()
    this.activeOwned = null
    this.document.dispatch({ effects: setLiveModel.of(null) })
    this.document.status({ rawHtml: enabled })
    if (this.currentMode === 'live' || this.navigation) this.activate()
  }
  setMarkdownPlugins(plugins: MarkdownPlugins): void {
    if (markdownPluginNames.every((name) => plugins[name] === this.plugins[name])) return
    this.failCaptures('translation-capture-changed')
    this.plugins = { ...plugins }
    // A request already running for this revision must lose its consumer before
    // settings change; revision equality alone cannot distinguish two grammars.
    this.detach()
    this.settled = null
    this.releaseOwned()
    this.activeOwned = null
    this.document.dispatch({
      effects: [
        setLiveModel.of(null),
        this.metadata.reconfigure([
          yamlFrontmatter.of(this.plugins.typora),
          optMarkdown.of(this.plugins.opt),
          latexMarkdown.of(this.plugins.latex),
        ]),
      ],
    })
    if (this.viewing && (this.currentMode === 'live' || this.navigation)) this.activate()
  }
  async setRemoteImages(enabled: boolean): Promise<void> {
    if (!this.document.images || this.disposed) return
    this.document.status({ imagePermissionBusy: true, imageError: false })
    try {
      const result = await this.document.images.remoteImages(this.document.id, enabled)
      if (this.disposed) return
      if (!result.ok) {
        this.document.status({ imageError: true })
        return
      }
      this.remoteImages = result.value
      this.document.status({ remoteImages: result.value })
      this.document.dispatch({ effects: setLiveModel.of(null) })
      if (
        this.viewing &&
        this.currentMode === 'live' &&
        this.settled?.revision === this.document.revision()
      )
        this.apply(this.settled.model, this.settled.owned)
    } catch {
      if (!this.disposed) this.document.status({ imageError: true })
    } finally {
      if (!this.disposed) this.document.status({ imagePermissionBusy: false })
    }
  }
  retry(): void {
    if (this.disposed) return
    if (this.document.bytes() > semanticLimits.previewBytes) {
      this.setMode('live')
      return
    }
    this.settled = null
    // A new consumer prevents retry() from publishing the previous intent just
    // before request() replaces it with the explicit current revision/options.
    this.detach()
    this.connect()
    // Reset a paused service before publishing: a paused request synchronously
    // reports failure and detaches this consumer.
    this.connection?.retry()
    if (this.currentMode !== 'live') this.setMode('live')
    else this.request()
  }

  private received(event: SemanticEvent): void {
    if (this.disposed) return
    if (event.kind === 'pending') {
      this.cancelApply()
      this.document.status({ semantic: 'pending' })
      return
    }
    if (event.kind === 'error') {
      this.cancelApply()
      this.failCaptures(event.code)
      this.settled = null
      this.releaseOwned()
      this.activeOwned = null
      this.document.dispatch({ effects: setLiveModel.of(null) })
      this.setMode('source')
      this.document.status({
        semantic: event.code === 'semantic-limit' ? 'limit' : 'error',
        semanticError: event.code,
      })
      return
    }
    if (event.revision !== this.document.revision()) return
    const snapshot = event.snapshot
    if (retainedSnapshotBytes(snapshot) > semanticLimits.snapshotBytes) {
      this.failCaptures('semantic-limit')
      this.setMode('source')
      this.document.status({ semantic: 'limit', semanticError: 'semantic-limit' })
      return
    }
    this.cancelApply()
    const source = this.document.state().doc
    if (event.kind === 'packed-snapshot') {
      this.startReceivedPacked(event, source)
      return
    }
    if (this.startPacked(event, source)) return
    this.startNative(event, source)
  }

  private startReceivedPacked(
    event: Extract<SemanticEvent, { kind: 'packed-snapshot' }>,
    source: EditorState['doc'],
  ): void {
    let capture: PackedCapture | undefined
    let certificate: PackedSnapshotCertificate | undefined
    let iterator: PackedWork<OwnedPackedPreview>
    try {
      capture = event.capture.retain()
      const retained = capture
      certificate = event.certificate.retain()
      const proof = certificate
      const previous = this.owned?.canFork(capture) ? this.owned : undefined
      const preparation = OwnedPackedPreview.prepare(
        capture,
        capture.sourceResource,
        source,
        [],
        this.renderOptions(),
        {
          retained: 32 * 1024 * 1024,
          staging: semanticLimits.messageBytes,
          nodes: 800000,
          depth: 128,
        },
        previous,
        { snapshot: proof },
        true,
      )
      iterator = new PackedWork(
        (function* () {
          return yield* preparation
        })(),
        () => {
          try {
            preparation.return()
          } finally {
            try {
              proof.close()
            } finally {
              retained.release()
            }
          }
        },
      )
    } catch (error) {
      try {
        certificate?.close()
      } finally {
        capture?.release()
      }
      this.received({ kind: 'error', code: packedFailureCode(error), paused: false })
      return
    }
    let work: SlicedWork<OwnedPackedPreview>
    work = new SlicedWork(
      iterator,
      {
        valid: () =>
          this.packedApplying === work &&
          !this.disposed &&
          this.viewing &&
          event.revision === this.document.revision() &&
          this.document.state().doc === source,
        beforeComplete: this.document.synchronizeInput,
        discard: (owned) => owned.release(),
        complete: (owned) => {
          try {
            this.installOwned(event, owned)
          } catch (error) {
            owned.release()
            throw error
          }
        },
        finished: (stats) => {
          if (this.packedApplying === work) this.packedApplying = null
          this.recordApplied(event, stats)
        },
        failed: (error) => {
          if (this.packedApplying === work) this.packedApplying = null
          this.received({ kind: 'error', code: packedFailureCode(error), paused: false })
        },
        measured: (start) => semanticMetric('semantic-apply-slice', start),
      },
      this.applyRuntime,
    )
    this.packedApplying = work
    work.run()
  }

  private startPacked(
    event: Extract<SemanticEvent, { kind: 'snapshot' }>,
    source: EditorState['doc'],
  ): boolean {
    if (!event.snapshot.layout || !canPreparePackedPreview(source.length, event.snapshot.document))
      return false
    const iterator = prepareOwnedPreview(
      this.packedOwner,
      event.snapshot,
      source,
      this.document.id,
      event.revision,
      this.renderOptions(),
      this.owned ?? undefined,
    )
    let work!: SlicedWork<OwnedPackedPreview>
    work = new SlicedWork(
      iterator,
      {
        valid: () =>
          this.packedApplying === work &&
          !this.disposed &&
          this.viewing &&
          event.revision === this.document.revision() &&
          this.document.state().doc === source,
        beforeComplete: this.document.synchronizeInput,
        discard: (owned) => owned.release(),
        complete: (owned) => {
          try {
            this.installOwned(event, owned)
          } catch (error) {
            owned.release()
            throw error
          }
        },
        finished: (stats) => {
          if (this.packedApplying === work) this.packedApplying = null
          this.recordApplied(event, stats)
          semanticMetric('packed-preview-apply', event.applyStarted, {
            slices: stats.slices,
            maxSliceMs: stats.maxSliceMs,
            activeMs: stats.activeMs,
            bytes: event.snapshot.bytes,
          })
        },
        failed: () => {
          if (this.packedApplying === work) this.packedApplying = null
          this.packedOwner.invalidate()
          this.startNative(event, source)
        },
        measured: (start) => semanticMetric('semantic-apply-slice', start),
      },
      this.applyRuntime,
    )
    this.packedApplying = work
    work.run()
    return true
  }

  private startNative(
    event: Extract<SemanticEvent, { kind: 'snapshot' }>,
    source: EditorState['doc'],
  ): void {
    const work: SlicedWork<PreparedPreview> = new SlicedWork(
      preparePreview(event.snapshot, source, this.occurrences),
      {
        valid: () =>
          this.applying === work &&
          !this.disposed &&
          this.viewing &&
          event.revision === this.document.revision() &&
          this.document.state().doc === source,
        beforeComplete: this.document.synchronizeInput,
        complete: (prepared) => this.install(event, prepared),
        finished: (stats) => {
          if (this.applying === work) this.applying = null
          this.recordApplied(event, stats)
        },
        failed: () => {
          this.applying = null
          this.received({ kind: 'error', code: 'semantic-parse', paused: false })
        },
        measured: (start) => semanticMetric('semantic-apply-slice', start),
      },
      this.applyRuntime,
    )
    this.applying = work
    work.run()
  }

  private cancelApply(): void {
    this.applying?.cancel()
    this.applying = null
    this.packedApplying?.cancel()
    this.packedApplying = null
    try {
      this.packedOwner.invalidate()
    } catch {
      // Disposal owns the final cleanup when a cancellation races teardown.
    }
  }

  private installOwned(event: SnapshotEvent, owned: OwnedPackedPreview): void {
    const status = this.document.reserveStatus?.(() => {
      const lease = owned.retain()
      try {
        const hold = owned.reserveMetadata(previewStatusLimits.metadataBytes)
        return {
          release: () => {
            lease.release()
            hold.release()
          },
        }
      } catch (error) {
        lease.release()
        throw error
      }
    })
    try {
      if (!owned.commit()) throw new Error('Superseded packed occurrence preparation')
      const old = this.owned
      this.owned = owned
      this.settled = {
        revision: event.revision,
        snapshot: event.snapshot,
        model: owned.model,
        owned,
      }
      this.packedOwner.evict()
      if (this.currentMode === 'live') this.apply(owned.model, owned)
      old?.release()
      const patch: Partial<PreviewStatus> = {
        semantic: 'ready',
        semanticError: null,
        semanticRevision: event.revision,
        wordCount: owned.status.wordCount,
        characterCount: owned.status.characterCount,
        outline: owned.status.outline,
        freshnessMs: event.freshnessMs + performance.now() - event.applyStarted,
      }
      if (status) status.publish(patch)
      else this.document.status(patch)
      for (const capture of [...this.captures]) {
        if (capture.revision === event.revision) capture.resolve(event.snapshot)
      }
    } finally {
      status?.release()
    }
  }

  private install(
    event: Extract<SemanticEvent, { kind: 'snapshot' }>,
    prepared: PreparedPreview,
  ): void {
    if (!prepared.commit()) throw new Error('Superseded occurrence preparation')
    const snapshot = event.snapshot
    const old = this.owned
    this.owned = null
    this.settled = { revision: event.revision, snapshot, model: prepared.model }
    if (this.currentMode === 'live') this.apply(prepared.model)
    old?.release()
    this.document.status({
      semantic: 'ready',
      semanticError: null,
      semanticRevision: event.revision,
      ...prepared.status,
      freshnessMs: event.freshnessMs + performance.now() - event.applyStarted,
    })
    for (const capture of [...this.captures]) {
      if (capture.revision === event.revision) capture.resolve(snapshot)
    }
  }

  private recordApplied(event: SnapshotEvent, stats: SliceStats): void {
    const snapshot = event.snapshot
    semanticMetric('semantic-apply', event.applyStarted, {
      sequence: event.sequence,
      revision: event.revision,
      requestMs: absoluteNow() - event.requestSentAt,
      parseMs: 'document' in snapshot ? snapshot.document.timings.parse : snapshot.parseMs,
      describeMs: 'document' in snapshot ? snapshot.document.timings.describe : snapshot.describeMs,
      renderMs: 'projection' in snapshot ? snapshot.projection.renderMs : snapshot.renderMs,
      serializeMs: snapshot.serializeMs,
      transportInMs: snapshot.transportInMs,
      transportOutMs: event.transportOutMs,
      freshnessMs: event.freshnessMs + performance.now() - event.applyStarted,
      bytes: snapshot.bytes,
      cached: snapshot.cached,
      slices: stats.slices,
      maxSliceMs: stats.maxSliceMs,
      activeMs: stats.activeMs,
    })
    this.connection?.warm()
  }

  private apply(model: LiveModel, owned?: OwnedPackedPreview): void {
    this.activeOwned = owned ?? null
    this.document.dispatch({
      effects: setLiveModel.of(model),
    })
  }

  private releaseOwned(): void {
    const owned = this.owned
    this.owned = null
    owned?.release()
  }

  currentSnapshot(): PreviewSnapshot | null {
    return this.settled?.revision === this.document.revision() ? this.settled.snapshot : null
  }
  /** A retained widget may still display a reference from an older revision.
   * Wait off the input path and resolve its destination against current output.
   * If its owner or link structure changed, discard the obsolete activation.
   */
  async openLink(url: string, link?: LiveLink): Promise<void> {
    const started = performance.now()
    try {
      await this.document.synchronizeInput?.()
      const revision = this.document.revision()
      await this.capture(revision, new AbortController().signal)
      if (this.disposed || revision !== this.document.revision()) return
      const model = this.settled?.model
      if (!model) return
      if (link) {
        const block = model.blocks.find((block) => block.id === link.block.id)
        if (!block) return
        const before = document.createElement('template')
        const after = document.createElement('template')
        before.innerHTML = link.block.html
        after.innerHTML = block.html
        const previous = [...before.content.querySelectorAll('a[href]')]
        const current = [...after.content.querySelectorAll('a[href]')]
        if (previous.length !== link.count || current.length !== link.count) return
        const target = current[link.index]?.getAttribute('href')
        if (target === undefined || target === null) return
        for (const anchor of [...previous, ...current]) anchor.setAttribute('href', '')
        if (before.innerHTML !== after.innerHTML) return
        url = target
      }
      if (!url.startsWith('#')) {
        this.document.openLink(url)
        return
      }
      const literal = url.slice(1)
      let decoded: string
      try {
        decoded = decodeURIComponent(literal)
      } catch {
        return
      }
      const anchors = model.anchors
      const anchor =
        anchors?.find((anchor) => anchor.id === literal) ??
        anchors?.find((anchor) => {
          const id = anchor.id.startsWith('user-content-') ? anchor.id : `user-content-${anchor.id}`
          return id === literal || id === decoded || anchor.id === decoded
        })
      if (!anchor) return
      const view = this.document.view()
      if (anchor.rendered && view) navigateLiveAnchor(view, anchor)
      else {
        this.document.dispatch({ selection: { anchor: anchor.from }, scrollIntoView: true })
        view?.focus()
      }
    } catch {
      // A newer edit, tab suspension, disposal or failed parse cancels this activation.
    } finally {
      semanticMetric('linked-input', started)
    }
  }
  async captureReading(revision: number, signal: AbortSignal): Promise<ReadingCapture> {
    const plugins = this.plugins
    const snapshot = await this.capture(revision, signal)
    if (signal.aborted || this.disposed) throw new Error('translation-cancelled')
    if (plugins !== this.plugins) throw new Error('translation-capture-changed')
    const root = this.settled?.snapshot === snapshot ? this.owned?.captureRoot() : undefined
    if (root)
      return {
        kind: 'packed',
        ...root,
        plugins: { ...plugins },
        retainedBytes: Math.max(retainedSnapshotBytes(snapshot), root.capture.retainedBytes),
      }
    if ('document' in snapshot)
      return {
        kind: 'native',
        root: snapshot.document.root,
        plugins: { ...plugins },
        retainedBytes: retainedSnapshotBytes(snapshot),
      }
    throw new Error('translation-capture-changed')
  }
  /** Explicit consumers wait for this exact revision, never a convenient older AST. */
  capture(revision: number, signal: AbortSignal): Promise<PreviewSnapshot> {
    if (signal.aborted || this.disposed || !this.viewing || revision !== this.document.revision())
      return Promise.reject(new Error('translation-capture-changed'))
    if (this.document.bytes() > semanticLimits.previewBytes)
      return Promise.reject(new Error('semantic-limit'))
    const current = this.currentSnapshot()
    if (current) return Promise.resolve(current)
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, snapshot?: PreviewSnapshot): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.captures.delete(capture)
        if (this.currentMode === 'source' && !this.navigation && !this.captures.size) this.detach()
        if (error) reject(error)
        else if (snapshot) resolve(snapshot)
      }
      const capture = {
        revision,
        resolve: (snapshot: PreviewSnapshot) => finish(undefined, snapshot),
        reject: (error: Error) => finish(error),
      }
      const abort = (): void => finish(new Error('translation-cancelled'))
      const timer = setTimeout(() => finish(new Error('translation-capture-timeout')), 12000)
      this.captures.add(capture)
      signal.addEventListener('abort', abort, { once: true })
      if (!this.applying && !this.packedApplying) {
        this.connect()
        this.request()
      }
    })
  }
  private failCaptures(code: string): void {
    for (const capture of [...this.captures]) capture.reject(new Error(code))
  }
  reset(): void {
    this.cancelApply()
    this.failCaptures('translation-capture-changed')
    this.occurrences.reset()
    this.settled = null
    this.releaseOwned()
    this.activeOwned = null
    this.document.dispatch({ effects: setLiveModel.of(null) })
  }
  refreshAssets(): void {
    this.document.dispatch({ effects: setLiveModel.of(null) })
    if (
      this.viewing &&
      this.currentMode === 'live' &&
      this.settled?.revision === this.document.revision()
    )
      this.apply(this.settled.model, this.settled.owned)
  }
  dispose(): void {
    this.failCaptures('translation-cancelled')
    this.disposed = true
    this.detach()
    this.settled = null
    this.releaseOwned()
    this.activeOwned = null
    this.occurrences.reset()
    // Pending renderer promises still own native borrows after DOM teardown. They
    // keep this pure-memory owner reachable until their independently charged
    // leases close; disposing it now would revoke those reservations too early.
    if (this.packedOwner.stats.holds === 0 && this.packedOwner.stats.captures === 0)
      this.packedOwner.dispose()
    else this.packedOwner.evict()
  }
}
