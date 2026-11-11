import {
  activeEmbeddedEditor,
  Compartment,
  createSourceState,
  documentBytes,
  type EditorScrollSnapshot,
  EditorState,
  EditorView,
  isolateHistory,
  limitRejected,
  mountSourceEditor,
  openSearchPanel,
  punctuationAction,
  redo,
  SourceInputSynchronization,
  StateEffect,
  selectAll,
  sourceDisplay,
  Text,
  type Transaction,
  type TransactionSpec,
  undo,
  type ViewUpdate,
} from '@manuslip/editor'
import { defaultEditorPreferences, type EditorPreferences } from '@manuslip/editor/preferences'
import { createStore } from 'zustand/vanilla'
import type { AssetBridge } from '../../shared/asset-contracts'
import type { DiagramBridge } from '../../shared/diagram-contracts'
import type { ExportBridge } from '../../shared/export-contracts'
import type { FileBridge, FileInfo, FileSnapshot, SaveRequest } from '../../shared/file-contracts'
import type { ImageBridge } from '../../shared/image-contracts'
import type { PluginBridge } from '../../shared/plugin-contracts'
import type { SearchAnchor } from '../../shared/search-contracts'
import type { SpellingCorrection } from '../../shared/spelling-contracts'
import type { StyleBridge } from '../../shared/style-contracts'
import type { SyncBridge } from '../../shared/sync-contracts'
import type { TranslationBridge } from '../../shared/translation-contracts'
import { DocumentAppearance } from './appearance'
import { DocumentExport } from './export'
import { DocumentPaste } from './paste'
import { DocumentPlugins } from './plugins'
import {
  DocumentPreview,
  initialPreviewStatus,
  type PreviewStatus,
  retainedSnapshotBytes,
} from './preview/controller'
import { PreviewStatusPublication } from './preview/status-publication'
import { DocumentReplace } from './replace'
import { semanticMetric } from './semantics/metrics'
import { DocumentSync } from './sync'
import { DocumentTable } from './table'
import { DocumentReading } from './translation/controller'

export interface DocumentStatus extends PreviewStatus {
  pasting: boolean
  replacing: boolean
  info: FileInfo
  revision: number
  dirty: boolean
  saving: boolean
  composing: boolean
  conflict: boolean
  error: string | null
  copyPath: string | null
  recoveryError: string | null
  recovered: boolean
  line: number
  column: number
  bytes: number
}

/** CodeMirror owns the body. This store only publishes document metadata and UI status. */
export class DocumentController {
  state: EditorState
  readonly store
  readonly preview: DocumentPreview
  readonly previewStatuses = new PreviewStatusPublication()
  readonly paste: DocumentPaste | null
  readonly replacements: DocumentReplace
  readonly exporter: DocumentExport | null
  readonly reading: DocumentReading | null
  readonly table: DocumentTable
  readonly appearance: DocumentAppearance | null
  readonly plugins: DocumentPlugins | null
  readonly sync: DocumentSync | null
  private baseline: Text
  private view: EditorView | null = null
  private input: SourceInputSynchronization | undefined
  private modeRequest = 0
  private scroll: EditorScrollSnapshot | undefined
  private pendingReveal: { from: number; to: number } | null = null
  private disposed = false
  private locked = false
  private saveQueue: Promise<void> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null
  private checkpointQueue: Promise<void> = Promise.resolve()
  private checkpointRevision = -1
  private dirtySince: number | null = null
  private readonly unsubscribe: () => void
  private readonly readOnly = new Compartment()
  private readonly language = new Compartment()
  private readonly spelling = new Compartment()
  private readonly display = new Compartment()

  constructor(
    snapshot: FileSnapshot,
    private readonly bridge: FileBridge,
    label: string,
    recovered = false,
    openLink: (url: string) => void = () => {},
    images?: ImageBridge,
    assets?: AssetBridge,
    diagrams?: DiagramBridge,
    exports?: ExportBridge,
    translation?: TranslationBridge,
    styles?: StyleBridge,
    plugins?: PluginBridge,
    sync?: SyncBridge,
  ) {
    this.sync = sync
      ? new DocumentSync(
          sync,
          () => this.synchronizeInput(),
          () => {
            const status = this.store.getState()
            return {
              id: status.info.id,
              path: status.info.displayPath,
              revision: status.revision,
              dirty: status.dirty,
              saving: status.saving,
              composing: this.disposed || this.locked || status.composing,
              conflict: status.conflict,
            }
          },
        )
      : null
    this.plugins = plugins
      ? new DocumentPlugins(
          plugins,
          () => this.synchronizeInput(),
          () => {
            const status = this.store.getState()
            if (this.disposed || this.locked || status.composing) throw new Error('plugin-changed')
            if (status.bytes > 2 * 1024 * 1024 || this.state.selection.ranges.length > 256)
              throw new Error('plugin-limit')
            return {
              documentId: status.info.id,
              revision: status.revision,
              text: this.state.doc.toString(),
              selections: this.state.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
            }
          },
          (revision, text) => {
            if (
              this.disposed ||
              this.locked ||
              this.store.getState().composing ||
              this.store.getState().revision !== revision
            )
              return false
            this.reading?.show(false)
            this.dispatch({
              changes: { from: 0, to: this.state.doc.length, insert: text },
              annotations: isolateHistory.of('full'),
              userEvent: 'input.plugin',
            })
            this.focus()
            return true
          },
        )
      : null
    this.replacements = new DocumentReplace({
      state: () => this.state,
      canApply: () => !this.disposed && !this.locked && !this.store.getState().composing,
      dispatch: (spec) => this.dispatch(spec),
      status: (replacing, error) => {
        if (replacing) this.paste?.cancel()
        if (!this.disposed)
          this.store.setState({
            replacing,
            ...(error ? { error } : replacing ? { error: null } : {}),
          })
      },
    })
    this.paste = assets
      ? new DocumentPaste(
          {
            id: snapshot.info.id,
            state: () => this.state,
            canApply: () => !this.disposed && !this.locked && !this.store.getState().composing,
            named: () => this.store.getState().info.displayPath !== null,
            save: () => this.save('save-as'),
            dispatch: (spec) => this.dispatch(spec),
            status: (pasting, error) => {
              if (pasting) this.replacements.cancel()
              if (!this.disposed)
                this.store.setState({
                  pasting,
                  ...(error ? { error } : pasting ? { error: null } : {}),
                })
            },
          },
          assets,
        )
      : null
    this.state = createSourceState(snapshot.text, {
      display: this.display.of(sourceDisplay()),
      extensions: [
        this.readOnly.of([]),
        this.language.of([]),
        this.spelling.of([]),
        this.replacements.extension,
        ...(this.paste ? [this.paste.extension] : []),
      ],
      label,
      onSave: () => {
        void this.save()
      },
      onSaveAs: () => {
        void this.save('save-as')
      },
      onUpdate: (update) => this.updated(update),
      onMode: (mode) => {
        void this.changeMode(mode)
      },
      onComposition: (composing) => {
        if (composing) this.replacements.cancel()
        if (composing) this.paste?.cancel()
        this.store.setState({ composing })
        this.preview.composing(composing)
        if (composing) this.cancelAutosave()
        else this.scheduleAutosave()
      },
    })
    this.baseline = recovered ? Text.empty : this.state.doc
    this.store = createStore<DocumentStatus>(() => ({
      ...initialPreviewStatus,
      info: snapshot.info,
      revision: 0,
      dirty: recovered,
      saving: false,
      pasting: false,
      replacing: false,
      composing: false,
      conflict: false,
      error: null,
      copyPath: null,
      recoveryError: null,
      recovered,
      line: 1,
      column: 1,
      bytes: this.state.field(documentBytes),
    }))
    this.appearance = styles
      ? new DocumentAppearance(snapshot.info.id, styles, {
          synchronizeInput: () => this.synchronizeInput(),
          canChange: () => !this.disposed && !this.locked && !this.store.getState().composing,
        })
      : null
    this.exporter = exports
      ? new DocumentExport(
          () => {
            const status = this.store.getState()
            if (!status.composing && this.reading?.store.getState().visible) {
              return {
                ...this.reading.captureExport(),
                documentId: status.info.id,
                rawHtml: status.rawHtml,
                remoteImages: status.remoteImages,
              }
            }
            return status.composing
              ? null
              : {
                  documentId: status.info.id,
                  revision: status.revision,
                  source: this.state.doc.toString(),
                  rawHtml: status.rawHtml,
                  plugins: this.preview.renderOptions().plugins,
                  remoteImages: status.remoteImages,
                }
          },
          exports,
          () => this.synchronizeInput(),
        )
      : null
    this.preview = new DocumentPreview({
      id: snapshot.info.id,
      state: () => this.state,
      view: () => this.view,
      revision: () => this.store.getState().revision,
      bytes: () => this.store.getState().bytes,
      dispatch: (spec) => this.dispatch(spec),
      status: (patch) => this.publishPreviewStatus(patch),
      synchronizeInput: () => this.synchronizeInput(),
      reserveStatus: (acquire) => {
        const reservation = this.previewStatuses.prepare(acquire)
        return {
          publish: (patch) => this.publishPreviewStatus(patch, reservation.publish()),
          release: () => reservation.release(),
        }
      },
      openLink,
      images,
      assets,
      diagrams,
    })
    this.table = new DocumentTable({
      state: () => this.state,
      revision: () => this.store.getState().revision,
      canApply: () =>
        !this.disposed &&
        !this.locked &&
        Boolean(this.view) &&
        !this.state.readOnly &&
        !this.view?.composing &&
        !this.store.getState().composing &&
        !this.reading?.store.getState().visible,
      synchronizeInput: () => this.synchronizeInput(),
      capture: async (revision, signal) => {
        const snapshot = await this.preview.capture(revision, signal)
        return 'document' in snapshot ? snapshot.document.root : null
      },
      dispatch: (spec) => this.dispatch(spec),
    })
    this.reading = translation
      ? new DocumentReading(
          {
            id: snapshot.info.id,
            state: () => this.state,
            revision: () => this.store.getState().revision,
            composing: () => this.store.getState().composing,
            capture: (revision, signal) => this.preview.captureReading(revision, signal),
            options: () => this.preview.renderOptions(),
          },
          translation,
        )
      : null
    this.state = this.state.update({
      effects: StateEffect.appendConfig.of(this.preview.extensions),
    }).state
    this.unsubscribe = bridge.onFileChanged((id) => {
      if (id === this.store.getState().info.id) void this.externalChange()
    })
    if (recovered) this.scheduleCheckpoint()
  }

  mount(parent: HTMLElement): () => void {
    if (this.disposed || this.view) throw new Error('Document view is unavailable')
    const view = mountSourceEditor(parent, this.state, this.scroll)
    this.view = view
    const input = new SourceInputSynchronization(view)
    this.input = input
    this.preview.attach()
    this.reading?.attach()
    if (!parent.ownerDocument.activeElement?.closest('.document-tabs')) view.focus()
    if (this.pendingReveal) this.revealRange(this.pendingReveal.from, this.pendingReveal.to)
    return () => {
      this.modeRequest++
      this.table.close()
      this.appearance?.close()
      this.scroll = view.scrollSnapshot()
      this.paste?.cancel()
      this.replacements.cancel()
      if (this.exporter?.store.getState().confirmation) this.exporter.cancelConfirmation()
      this.reading?.suspend()
      this.preview.suspend()
      this.state = view.state
      input.close()
      if (this.input === input) this.input = undefined
      view.destroy()
      if (this.view === view) this.view = null
    }
  }

  focus(): boolean {
    this.view?.focus()
    return Boolean(this.view?.hasFocus)
  }
  async edit(action: 'undo' | 'redo' | 'select-all' | 'find'): Promise<void> {
    await this.synchronizeInput()
    if (!this.view || this.disposed || this.locked || this.store.getState().composing) return
    if (this.reading?.store.getState().visible) return
    const embedded = activeEmbeddedEditor(this.view)
    if (embedded && action === 'select-all') {
      embedded.focus()
      selectAll(embedded)
      return
    }
    this.view.focus()
    const commands = { undo, redo, 'select-all': selectAll, find: openSearchPanel }
    commands[action](this.view)
    if (embedded && (action === 'undo' || action === 'redo')) embedded.focus()
  }
  measureAppearance(): void {
    this.view?.requestMeasure()
  }
  synchronizeInput(): Promise<void> {
    return this.input?.flush() ?? Promise.resolve()
  }
  async changeMode(mode: 'source' | 'live' | 'translated'): Promise<boolean> {
    const request = ++this.modeRequest
    if (this.disposed || this.locked || (mode === 'translated' && !this.reading)) return false
    await this.synchronizeInput()
    if (this.disposed || this.locked || request !== this.modeRequest) return false
    this.reading?.show(mode === 'translated')
    this.preview.setMode(mode === 'translated' ? 'source' : mode)
    return true
  }
  setSpellcheck(enabled: boolean): void {
    this.dispatch({
      effects: this.spelling.reconfigure(
        EditorView.contentAttributes.of({ spellcheck: String(enabled) }),
      ),
    })
  }
  async correctSpelling({ word, replacement }: SpellingCorrection): Promise<void> {
    const view = this.view
    const revision = this.store.getState().revision
    await this.synchronizeInput()
    if (
      !view ||
      view !== this.view ||
      this.disposed ||
      this.locked ||
      !view.hasFocus ||
      view.state.readOnly ||
      this.store.getState().composing ||
      this.reading?.store.getState().visible ||
      revision !== this.store.getState().revision ||
      !view.contentDOM.spellcheck ||
      view.state.selection.ranges.length !== 1
    )
      return
    const range = view.state.selection.main
    if (range.empty || view.state.doc.sliceString(range.from, range.to) !== word) return
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: replacement },
      selection: { anchor: range.from + replacement.length },
      annotations: isolateHistory.of('full'),
      userEvent: 'input.spelling',
    })
  }
  setEditorPreferences(preferences: EditorPreferences = defaultEditorPreferences): void {
    if (this.disposed) return
    this.dispatch({ effects: this.display.reconfigure(sourceDisplay(preferences)) })
  }
  revealHeading(from: number): void {
    if (this.disposed || this.locked || this.store.getState().composing) return
    if (this.reading?.store.getState().visible) this.reading.revealHeading(from)
    else this.revealRange(from)
  }
  revealRange(from: number, to = from): boolean {
    if (
      this.disposed ||
      this.locked ||
      this.store.getState().composing ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.state.doc.length
    )
      return false
    this.reading?.show(false)
    this.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 24 }),
    })
    this.pendingReveal = this.view ? null : { from, to }
    this.view?.focus()
    return true
  }
  revealSearch(anchor: SearchAnchor): boolean {
    if (anchor.line < 1 || anchor.line > this.state.doc.lines) return false
    const line = this.state.doc.line(anchor.line)
    if (
      line.text !== anchor.text ||
      anchor.from < 0 ||
      anchor.to < anchor.from ||
      anchor.to > line.length
    )
      return false
    return this.revealRange(line.from + anchor.from, line.from + anchor.to)
  }

  dispatch(spec: TransactionSpec): void {
    if (this.disposed) return
    if (this.view) this.view.dispatch(spec)
    else {
      const started = performance.now()
      const revision = this.store.getState().revision
      const transaction = this.state.update(spec)
      this.paste?.map([transaction])
      this.replacements.changed([transaction])
      this.scroll = this.scroll?.map(transaction.changes)
      this.accept(
        transaction.state,
        transaction.docChanged ? 1 : 0,
        transaction.effects.some((effect) => effect.is(limitRejected)),
      )
      this.recordInput([transaction], started, revision)
      this.table.changed()
      this.preview.changed([transaction])
      this.reading?.changed([transaction])
    }
  }

  lock(locked: boolean): void {
    if (locked) this.replacements.cancel()
    if (locked) this.paste?.cancel()
    this.locked = locked
    if (locked) this.cancelAutosave()
    this.dispatch({
      effects: this.readOnly.reconfigure([
        EditorState.readOnly.of(locked),
        EditorView.editable.of(!locked),
      ]),
    })
    if (!locked) this.scheduleAutosave()
  }

  localize(label: string, phrases: Record<string, string>): void {
    // Changing CodeMirror phrases recreates its view state; restore the viewport afterwards.
    const scroll = this.view?.scrollSnapshot()
    this.dispatch({
      effects: this.language.reconfigure([
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorState.phrases.of(phrases),
      ]),
    })
    if (scroll) this.dispatch({ effects: scroll })
    this.preview.localize()
    this.reading?.refreshRendering()
  }

  private updated(update: ViewUpdate): void {
    const started = performance.now()
    const revision = this.store.getState().revision
    this.paste?.map(update.transactions)
    this.replacements.changed(update.transactions)
    this.accept(
      update.state,
      update.transactions.filter((transaction) => transaction.docChanged).length,
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(limitRejected)),
      ),
    )
    this.recordInput(update.transactions, started, revision)
    this.table.changed()
    this.preview.changed(update.transactions)
    this.reading?.changed(update.transactions)
    semanticMetric('editor-update', started, {
      changed: update.docChanged,
      selection: update.selectionSet,
    })
  }

  /** Accepted parent transactions are the source oracle, including forwarded cell
   * edits. DOM beforeinput/input events describe intent, not accepted content.
   * Record only scalar metadata; source text never enters the performance buffer.
   */
  private recordInput(
    transactions: readonly Transaction[],
    started: number,
    revision: number,
  ): void {
    for (const transaction of transactions) {
      const punctuation = transaction.annotation(punctuationAction)
      if (punctuation) semanticMetric('punctuation-input', started, { ...punctuation })
      if (!transaction.docChanged) continue
      let inserted = 0
      let deleted = 0
      let ranges = 0
      transaction.changes.iterChanges((from, to, _newFrom, _newTo, text) => {
        inserted += text.length
        deleted += to - from
        ranges++
      })
      semanticMetric('input-accepted', started, {
        revisionBefore: revision++,
        revisionAfter: revision,
        sourceUnitsBefore: transaction.startState.doc.length,
        sourceUnitsAfter: transaction.newDoc.length,
        anchorBefore: transaction.startState.selection.main.anchor,
        headBefore: transaction.startState.selection.main.head,
        anchorAfter: transaction.newSelection.main.anchor,
        headAfter: transaction.newSelection.main.head,
        inserted,
        deleted,
        ranges,
        selections: transaction.newSelection.ranges.length,
        input: transaction.isUserEvent('input'),
        paste: transaction.isUserEvent('input.paste'),
        delete: transaction.isUserEvent('delete'),
        undo: transaction.isUserEvent('undo'),
        redo: transaction.isUserEvent('redo'),
        composing: this.store.getState().composing,
        cell: !!this.view && !!activeEmbeddedEditor(this.view),
        punctuation: !!punctuation,
      })
    }
  }

  private accept(state: EditorState, changes: number, rejected: boolean): void {
    if (this.disposed) return
    if (changes) this.pendingReveal = null
    this.state = state
    const position = state.selection.main.head
    const line = state.doc.lineAt(position)
    this.store.setState((status) => ({
      revision: status.revision + changes,
      dirty: status.recovered || !state.doc.eq(this.baseline),
      line: line.number,
      column: position - line.from + 1,
      bytes: state.field(documentBytes),
      ...(rejected ? { error: 'file-large' } : {}),
      ...(changes ? { copyPath: null } : {}),
    }))
    if (this.store.getState().dirty) this.dirtySince ??= Date.now()
    else this.dirtySince = null
    if (changes) {
      this.scheduleAutosave()
      this.scheduleCheckpoint()
    }
  }

  private scheduleCheckpoint(): void {
    if (this.disposed) return
    const status = this.store.getState()
    if (!status.dirty) {
      if (this.checkpointTimer) clearTimeout(this.checkpointTimer)
      this.checkpointTimer = null
      void this.clearCheckpoint(status.revision)
      return
    }
    if (this.checkpointTimer || status.revision === this.checkpointRevision) return
    this.checkpointTimer = setTimeout(
      () => {
        this.checkpointTimer = null
        const operation = this.checkpointQueue
          .then(async () => {
            const latest = this.store.getState()
            if (this.disposed || !latest.dirty || latest.revision === this.checkpointRevision)
              return
            const result = await this.bridge.checkpoint({
              id: latest.info.id,
              revision: latest.revision,
              text: this.state.doc.toString(),
            })
            if (this.disposed) return
            if (!result.ok) this.store.setState({ recoveryError: result.code || 'recovery-io' })
            else {
              this.checkpointRevision = latest.revision
              this.store.setState({ recoveryError: null })
            }
          })
          .catch(() => {
            if (!this.disposed) this.store.setState({ recoveryError: 'recovery-io' })
          })
        this.checkpointQueue = operation
        void operation.then(() => this.scheduleCheckpoint())
      },
      status.bytes > 1024 * 1024 ? 10000 : 2000,
    )
  }

  private async clearCheckpoint(revision: number): Promise<void> {
    try {
      const result = await this.bridge.clearRecovery(this.store.getState().info.id, revision)
      if (!this.disposed)
        this.store.setState({ recoveryError: result.ok ? null : result.code || 'recovery-io' })
    } catch {
      if (!this.disposed) this.store.setState({ recoveryError: 'recovery-io' })
    }
  }

  private cancelAutosave(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.idleTimer = null
    this.maxTimer = null
  }

  private scheduleAutosave(): void {
    const status = this.store.getState()
    if (
      this.disposed ||
      this.locked ||
      !status.dirty ||
      status.saving ||
      status.composing ||
      status.conflict ||
      status.error ||
      !status.info.displayPath ||
      status.info.unsafeDecoding ||
      status.info.newline === 'mixed'
    ) {
      this.cancelAutosave()
      return
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const run = (): void => {
      this.cancelAutosave()
      void this.save()
    }
    this.idleTimer = setTimeout(run, 750)
    this.dirtySince ??= Date.now()
    this.maxTimer ??= setTimeout(run, Math.max(0, 5000 - (Date.now() - this.dirtySince)))
  }

  save(
    action: SaveRequest['action'] = 'save',
    options: { normalize?: 'lf' | 'crlf'; utf8?: boolean } = {},
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    this.cancelAutosave()
    this.store.setState({ saving: true, error: null, copyPath: null })
    let saved = false
    const operation = this.saveQueue
      .then(async () => {
        await this.synchronizeInput()
        if (this.disposed) return
        const status = this.store.getState()
        const captured = this.state.doc
        const result = await this.bridge.saveDocument({
          id: status.info.id,
          text: captured.toString(),
          revision: status.revision,
          expectedFingerprint: status.info.fingerprint,
          action,
          normalize: options.normalize || null,
          utf8: options.utf8 || false,
        })
        if (this.disposed) return
        if (!result.ok) {
          this.store.setState({
            error: result.code || 'file-io',
            ...(result.code === 'file-changed' ? { conflict: true } : {}),
          })
          return
        }
        const outcome = result.value
        if (outcome.kind === 'cancelled') return
        if (outcome.revision !== status.revision) throw new Error('Mismatched save acknowledgement')
        if (outcome.kind === 'copy') {
          this.store.setState({ copyPath: outcome.displayPath })
          saved = true
          return
        }
        if (outcome.info.id !== status.info.id)
          throw new Error('Mismatched document acknowledgement')
        this.baseline = captured
        this.store.setState({
          info: outcome.info,
          dirty: !this.state.doc.eq(captured),
          conflict: false,
          recovered: false,
        })
        if (status.info.displayPath !== outcome.info.displayPath) {
          this.preview.refreshAssets()
          this.reading?.refreshRendering()
        }
        if (!this.store.getState().dirty) this.dirtySince = null
        void this.clearCheckpoint(status.revision)
        this.scheduleCheckpoint()
        saved = true
      })
      .catch(() => {
        if (!this.disposed) this.store.setState({ error: 'file-io' })
      })
    this.saveQueue = operation
    return operation.then(() => {
      if (this.saveQueue === operation && !this.disposed) {
        this.store.setState({ saving: false })
        this.scheduleAutosave()
      }
      return saved
    })
  }

  private async externalChange(): Promise<void> {
    if (this.disposed) return
    const status = this.store.getState()
    if (status.dirty || status.saving || status.composing) {
      this.cancelAutosave()
      this.store.setState({ conflict: true })
    } else await this.reload()
  }

  async reload(encoding?: string): Promise<boolean> {
    this.cancelAutosave()
    await this.saveQueue
    if (this.disposed) return false
    const before = this.store.getState()
    try {
      const result = await this.bridge.reloadDocument(before.info.id, encoding)
      if (this.disposed) return false
      if (!result.ok) {
        this.store.setState({ error: result.code || 'file-io', conflict: true })
        return false
      }
      // An edit made while the read was in flight always wins over an automatic reload.
      if (this.store.getState().revision !== before.revision) {
        this.store.setState({ conflict: true })
        return false
      }
      this.preview.reset()
      this.paste?.cancel()
      this.replacements.cancel()
      this.dispatch({ changes: { from: 0, to: this.state.doc.length, insert: result.value.text } })
      this.baseline = this.state.doc
      this.store.setState({
        info: result.value.info,
        dirty: false,
        conflict: false,
        error: null,
        recovered: false,
      })
      this.dirtySince = null
      this.cancelAutosave()
      this.scheduleCheckpoint()
      return true
    } catch {
      this.store.setState({ error: 'file-io', conflict: true })
      return false
    }
  }

  async prepareClose(): Promise<boolean> {
    this.cancelAutosave()
    await this.saveQueue
    while (!this.disposed && this.store.getState().dirty) {
      const answer = await this.bridge.confirmDocumentClose(this.store.getState().info.id)
      if (!answer.ok || answer.value === 'cancel') {
        this.scheduleAutosave()
        return false
      }
      if (answer.value === 'discard') return true
      if (!(await this.save())) return false
    }
    return !this.disposed
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.input?.close()
    this.input = undefined
    const previewPublication = this.previewStatuses.close()
    this.store.setState({
      previewPublication,
      outline: [],
      wordCount: null,
      characterCount: null,
      semantic: 'idle',
      semanticRevision: null,
    })
    this.replacements.cancel()
    this.paste?.cancel()
    this.table.close()
    this.appearance?.dispose()
    this.preview.dispose()
    this.reading?.dispose()
    this.exporter?.dispose()
    this.plugins?.dispose()
    this.sync?.dispose()
    this.cancelAutosave()
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer)
    this.checkpointTimer = null
    this.unsubscribe()
    await this.saveQueue
    await this.checkpointQueue
    await this.clearCheckpoint(this.store.getState().revision)
    await this.bridge.closeDocument(this.store.getState().info.id)
  }

  private publishPreviewStatus(patch: Partial<PreviewStatus>, publication?: number): void {
    this.store.setState({
      ...patch,
      ...('outline' in patch
        ? { previewPublication: publication ?? this.previewStatuses.replace() }
        : {}),
    })
    if (patch.semantic === 'ready')
      this.reading?.semanticChanged(retainedSnapshotBytes(this.preview.currentSnapshot()))
  }
}
