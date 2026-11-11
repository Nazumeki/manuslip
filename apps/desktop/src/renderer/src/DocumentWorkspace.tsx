import { defaultMarkdownPlugins, type MarkdownPlugins } from '@manuslip/core/conventions'
import type { EditorPreferences } from '@manuslip/editor/preferences'
import type { ReadingLayout } from '@manuslip/renderer/reading'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { DocumentCommand } from '../../shared/file-contracts'
import { AppearanceDialog } from './AppearanceDialog'
import { AppearanceStyle } from './AppearanceStyle'
import { appearanceCopy } from './appearance-copy'
import { DocumentStatusBar } from './DocumentStatusBar'
import type { DocumentController } from './document'
import { ExportControls } from './ExportControls'
import { editorPhrases } from './editor-phrases'
import { Icon } from './Icons'
import { i18next } from './i18n'
import { PluginCommands } from './PluginCommands'
import { pluginCatalog } from './plugin-catalog'
import { pluginCopy } from './plugin-copy'
import { ReadingPreview } from './ReadingPreview'
import { SyncDialog } from './SyncDialog'
import { syncCopy } from './sync-copy'
import { TableEditor } from './TableEditor'
import { ToolbarDisclosure } from './ToolbarDisclosure'
import { readingCopy } from './translation/copy'
import type { ConfigureTranslation } from './translation/settings-navigation'
import { useDocumentStatus } from './use-document-status'

const noReading = createStore(() => ({ visible: false }))

export function DocumentWorkspace({
  document,
  command,
  busy,
  locale,
  spellcheck,
  editorPreferences,
  markdownPlugins,
  readingLayout,
  configureTranslation,
  toolbarHost,
}: {
  document: DocumentController
  command: (value: DocumentCommand) => void
  busy: boolean
  locale: string
  spellcheck: boolean
  editorPreferences: EditorPreferences
  markdownPlugins?: MarkdownPlugins
  readingLayout: ReadingLayout
  configureTranslation: ConfigureTranslation
  toolbarHost: HTMLElement | null
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const translatedMode = useRef<HTMLButtonElement>(null)
  const status = useDocumentStatus(document)
  const reading = useStore(document.reading?.store ?? noReading)
  const plugins = useStore(pluginCatalog)
  const hasPluginCommands = Boolean(plugins?.plugins.some((plugin) => plugin.enabled))
  const readingLabels = readingCopy[locale === 'zh-CN' ? 'zh-CN' : 'en']
  const [encoding, setEncoding] = useState(status.info.encoding)
  const [pluginOpen, setPluginOpen] = useState(false)
  useEffect(() => {
    if (!hasPluginCommands) setPluginOpen(false)
  }, [hasPluginCommands])
  const [syncOpen, setSyncOpen] = useState(false)
  const hadSync = useRef(false)
  useLayoutEffect(() => {
    if (!syncOpen && hadSync.current) {
      const trigger = window.document.querySelector<HTMLButtonElement>(
        '.document-toolbar button.toolbar-disclosure',
      )
      if (trigger?.checkVisibility()) trigger.focus()
      else document.focus()
    }
    hadSync.current = syncOpen
  }, [syncOpen, document])
  const hadPlugin = useRef(false)
  useLayoutEffect(() => {
    if (!pluginOpen && hadPlugin.current) {
      const trigger = window.document.querySelector<HTMLButtonElement>(
        '.document-toolbar button.toolbar-disclosure',
      )
      if (trigger?.checkVisibility()) trigger.focus()
      else document.focus()
    }
    hadPlugin.current = pluginOpen
  }, [pluginOpen, document])
  const t = i18next.t.bind(i18next)
  const stateLabel = t(
    status.saving
      ? 'savingDocument'
      : status.dirty
        ? 'unsavedDocument'
        : status.info.displayPath
          ? 'savedDocument'
          : 'blankDocument',
  )
  useLayoutEffect(() => document.setSpellcheck(spellcheck), [document, spellcheck])
  useLayoutEffect(() => {
    document.preview.setMarkdownPlugins(markdownPlugins ?? defaultMarkdownPlugins)
    document.reading?.conventionsChanged()
  }, [document, markdownPlugins])
  useLayoutEffect(
    () => document.setEditorPreferences(editorPreferences),
    [document, editorPreferences],
  )
  useLayoutEffect(
    () => document.reading?.setDefaultLayout(readingLayout),
    [document, readingLayout],
  )
  useLayoutEffect(() => {
    document.localize(i18next.t('sourceLabel'), locale === 'zh-CN' ? editorPhrases : {})
  }, [document, locale])
  useLayoutEffect(() => {
    if (host.current) return document.mount(host.current)
  }, [document])
  useEffect(() => {
    documentTitle(status.dirty, status.info.displayPath ? status.info.name : t('untitled'))
    return () => {
      window.document.title = 'Manuslip'
    }
  }, [status.dirty, status.info, t])

  async function changeMode(
    mode: 'source' | 'live' | 'translated',
    keyboard = false,
  ): Promise<void> {
    const owner = window.document
    const origin = owner.activeElement
    const focus =
      keyboard ||
      (reading.visible && mode !== 'translated') ||
      (mode === 'translated' && Boolean(origin && host.current?.contains(origin)))
    let ownsFocus = true
    const laterInput = (event: Event): void => {
      if (event.type === 'pointerdown' || event.target !== origin) ownsFocus = false
    }
    owner.addEventListener('pointerdown', laterInput, true)
    owner.addEventListener('focusin', laterInput, true)
    try {
      if (!(await document.changeMode(mode)) || !focus || !ownsFocus) return
      if (mode === 'translated') translatedMode.current?.focus()
      else document.focus()
    } finally {
      owner.removeEventListener('pointerdown', laterInput, true)
      owner.removeEventListener('focusin', laterInput, true)
    }
  }

  async function reload(selectedEncoding?: string): Promise<void> {
    document.lock(true)
    try {
      if (status.dirty && !(await document.prepareClose())) return
      await document.reload(selectedEncoding)
    } finally {
      document.lock(false)
    }
  }

  const fileActions = (
    <div className="toolbar-command-group">
      <button type="button" disabled={busy} onClick={() => command('new')}>
        <Icon name="new" />
        {t('newDocument')}
      </button>
      <button type="button" disabled={busy} onClick={() => command('open')}>
        <Icon name="open" />
        {t('openDocument')}
      </button>
      <button type="button" disabled={busy} onClick={() => command('open-folder')}>
        <Icon name="folder" />
        {t('openFolder')}
      </button>
      <button type="button" disabled={busy || status.saving} onClick={() => command('save-as')}>
        <Icon name="save" />
        {t('saveAs')}
      </button>
      <button type="button" disabled={busy || status.saving} onClick={() => command('save-copy')}>
        <Icon name="copy" />
        {t('saveCopy')}
      </button>
    </div>
  )
  const utilityTools = (
    <fieldset className="toolbar-command-group">
      <legend>{t('utilityTools')}</legend>
      {document.sync && (
        <button type="button" disabled={busy || status.composing} onClick={() => setSyncOpen(true)}>
          <Icon name="sync" />
          {syncCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'].title}
        </button>
      )}
      {document.plugins && hasPluginCommands && (
        <button
          type="button"
          disabled={busy || status.composing}
          onClick={() => setPluginOpen(true)}
        >
          <Icon name="plugins" />
          {pluginCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'].commands}
        </button>
      )}
      {document.appearance && (
        <button
          type="button"
          disabled={busy || status.composing}
          onClick={() => void document.appearance?.open()}
        >
          <Icon name="appearance" />
          {appearanceCopy[locale === 'zh-CN' ? 'zh-CN' : 'en'].title}
        </button>
      )}
      <button
        type="button"
        disabled={busy || status.composing || reading.visible}
        onClick={() => {
          void document.table.open()
        }}
      >
        <Icon name="table" />
        {t('editTable')}
      </button>
    </fieldset>
  )
  const modes = (
    <fieldset className="preview-toolbar" aria-label={t('editorMode')}>
      <button
        type="button"
        aria-label={t('sourceMode')}
        aria-pressed={!reading.visible && status.mode === 'source'}
        onClick={() => void changeMode('source')}
        title={t('sourceShortcut')}
      >
        <Icon name="code" size={18} />
      </button>
      <button
        type="button"
        aria-label={t('liveMode')}
        aria-pressed={!reading.visible && status.mode === 'live'}
        onClick={() => void changeMode('live')}
        title={t('liveShortcut')}
      >
        <Icon name="live" size={18} />
      </button>
      {document.reading && (
        <button
          ref={translatedMode}
          type="button"
          aria-label={readingLabels.mode}
          aria-pressed={reading.visible}
          title={readingLabels.shortcut}
          onClick={() => void changeMode('translated')}
        >
          <Icon name="translate" size={18} />
        </button>
      )}
      {status.semantic === 'pending' && (
        <span className="visually-hidden" role="status">
          {t('previewUpdating')}
        </span>
      )}
    </fieldset>
  )
  const toolbar = (actions: ReactNode): ReactNode =>
    toolbarHost &&
    createPortal(
      <div className="document-toolbar">
        <div className="document-heading visually-hidden">
          <h1 title={status.info.displayPath ? status.info.name : t('untitled')} dir="auto">
            {status.info.displayPath ? status.info.name : t('untitled')}
          </h1>
          <span role="status">{stateLabel}</span>
          {status.info.displayPath && (
            <p title={status.info.displayPath} dir="auto">
              {status.info.displayPath}
            </p>
          )}
        </div>
        {modes}
        <button
          className="icon-button document-save"
          type="button"
          aria-label={t('saveDocument')}
          title={t('saveDocument')}
          disabled={busy || status.saving}
          onClick={() => command('save')}
        >
          <Icon name="save" />
        </button>
        {actions}
      </div>,
      toolbarHost,
    )

  return (
    <section
      id="document-panel"
      className="document-workspace"
      data-style-document={status.info.id}
      role="tabpanel"
      aria-labelledby={`tab-${status.info.id}`}
      onKeyDownCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('dialog[open]')) return
        if (
          event.key === 'Escape' &&
          !window.document.querySelector('[popover]:popover-open') &&
          (document.replacements.cancel() || document.paste?.cancel())
        ) {
          event.preventDefault()
          event.stopPropagation()
          document.focus()
          return
        }
        if (
          !(event.ctrlKey || event.metaKey) ||
          event.altKey ||
          !['1', '2', '3'].includes(event.key)
        )
          return
        if (event.key === '3' && !document.reading) return
        event.preventDefault()
        event.stopPropagation()
        void changeMode(
          event.key === '3' ? 'translated' : event.key === '1' ? 'source' : 'live',
          true,
        )
      }}
    >
      <TableEditor document={document} locale={locale} />
      {syncOpen && document.sync && (
        <SyncDialog
          controller={document.sync}
          document={document}
          locale={locale}
          onClose={() => setSyncOpen(false)}
        />
      )}
      {pluginOpen && document.plugins && hasPluginCommands && (
        <PluginCommands
          controller={document.plugins}
          document={document}
          locale={locale}
          onClose={() => setPluginOpen(false)}
        />
      )}
      {document.appearance && (
        <>
          <AppearanceStyle
            controller={document.appearance}
            document={document}
            path={status.info.displayPath}
          />
          <AppearanceDialog controller={document.appearance} document={document} locale={locale} />
        </>
      )}
      <fieldset className="document-actions" aria-label={t('fileActions')}>
        {document.exporter ? (
          <ExportControls
            exporter={document.exporter}
            composing={status.composing}
            revision={status.revision}
            reading={reading.visible}
            readingReady={'projection' in reading && Boolean(reading.projection)}
            toolbar={toolbar}
          >
            {fileActions}
            {utilityTools}
          </ExportControls>
        ) : (
          toolbar(
            <ToolbarDisclosure label={t('documentCommands')}>
              {fileActions}
              {utilityTools}
            </ToolbarDisclosure>,
          )
        )}
      </fieldset>
      {status.pasting && (
        <div className="paste-status">
          <span role="status">{t('pasting')}</span>
          <button
            type="button"
            onClick={() => {
              document.paste?.cancel()
              document.focus()
            }}
          >
            {t('cancelPaste')}
          </button>
        </div>
      )}
      {status.replacing && (
        <div className="paste-status">
          <span role="status">{t('replacing')}</span>
          <button
            type="button"
            onClick={() => {
              document.replacements.cancel()
              document.focus()
            }}
          >
            {t('cancelReplace')}
          </button>
        </div>
      )}
      {status.imageError && (
        <p className="document-notice" role="status">
          {t('imagePermissionError')}
        </p>
      )}
      {(status.semantic === 'error' || status.semantic === 'limit') && (
        <div className="document-notice" role="status">
          <p>{t(status.semanticError || 'semantic-parse')}</p>
          <button type="button" onClick={() => document.preview.retry()}>
            {t('retryPreview')}
          </button>
        </div>
      )}
      {status.recovered && (
        <p className="document-notice" role="status">
          {t('recoveredDraft')}
        </p>
      )}
      {status.recoveryError && (
        <p className="document-notice" role="alert">
          {t(status.recoveryError, { defaultValue: t('recovery-io') })}
        </p>
      )}
      {status.error && (
        <p className="document-notice" role="alert">
          {t(status.error, { defaultValue: t('file-io') })}
        </p>
      )}
      {status.copyPath && (
        <p className="document-notice" role="status">
          {t('copySaved', { path: status.copyPath })}
        </p>
      )}
      {status.conflict && (
        <div className="document-notice" role="status">
          <p>{t('externalChange')}</p>
          <div className="action-row">
            <button type="button" disabled={status.saving} onClick={() => void reload()}>
              {t('reloadDocument')}
            </button>
            <button
              type="button"
              disabled={status.saving}
              onClick={() => void document.save('save-copy')}
            >
              {t('saveCopy')}
            </button>
            <button
              type="button"
              disabled={status.saving}
              onClick={() => void document.save('overwrite')}
            >
              {t('overwriteDocument')}
            </button>
          </div>
        </div>
      )}
      {status.info.unsafeDecoding && (
        <div className="document-notice">
          <p>{t('encodingNotice')}</p>
          <div className="action-row">
            <label htmlFor="file-encoding">{t('fileEncoding')}</label>
            <select
              id="file-encoding"
              value={encoding}
              onChange={(event) => setEncoding(event.target.value)}
            >
              {![
                'utf8',
                'utf16le',
                'utf16be',
                'gb18030',
                'big5',
                'shift_jis',
                'windows-1252',
              ].includes(encoding) && <option value={encoding}>{encoding}</option>}
              {['utf8', 'utf16le', 'utf16be', 'gb18030', 'big5', 'shift_jis', 'windows-1252'].map(
                (value) => (
                  <option key={value} value={value}>
                    {value.toUpperCase()}
                  </option>
                ),
              )}
            </select>
            <button type="button" onClick={() => void reload(encoding)}>
              {t('reopenEncoding')}
            </button>
            <button type="button" onClick={() => void document.save('save-copy')}>
              {t('saveCopy')}
            </button>
          </div>
        </div>
      )}
      {status.info.newline === 'mixed' && (
        <div className="document-notice">
          <p>{t('file-newlines')}</p>
          <div className="action-row">
            <button type="button" onClick={() => void document.save('save', { normalize: 'lf' })}>
              {t('normalizeLf')}
            </button>
            <button type="button" onClick={() => void document.save('save', { normalize: 'crlf' })}>
              {t('normalizeCrlf')}
            </button>
          </div>
        </div>
      )}
      {status.error === 'file-encoding' && (
        <div className="action-row">
          <button type="button" onClick={() => void document.save('save-as', { utf8: true })}>
            {t('saveUtf8')}
          </button>
        </div>
      )}
      <div className="source-editor" ref={host} hidden={reading.visible} />
      {document.reading && (
        <ReadingPreview
          reading={document.reading}
          document={document}
          locale={locale}
          configure={configureTranslation}
        />
      )}
      <DocumentStatusBar document={document} status={status} />
    </section>
  )
}

function documentTitle(dirty: boolean, name: string): void {
  window.document.title = `${dirty ? '● ' : ''}${name} — Manuslip`
}
