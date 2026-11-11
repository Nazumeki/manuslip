import { defaultEditorPreferences } from '@manuslip/editor/preferences'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useStore } from 'zustand'
import appIcon from '../../../build/icon.svg?url'
import type { Bootstrap, Settings } from '../../shared/contracts'
import type { DocumentCommand } from '../../shared/file-contracts'
import { DocumentOutline } from './DocumentOutline'
import { DocumentTabs } from './DocumentTabs'
import { DocumentWorkspace } from './DocumentWorkspace'
import { DocumentsController } from './documents'
import { EditingTools } from './EditingTools'
import { Icon } from './Icons'
import { IncomingNotices } from './IncomingNotices'
import { i18next } from './i18n'
import { IncomingController } from './incoming'
import { trackLayerMotion } from './layer-motion'
import { type PreferencesPage, PreferencesPanel } from './PreferencesPanel'
import { loadPluginCatalog } from './plugin-catalog'
import { RecoveryPanel } from './RecoveryPanel'
import { RecoveryController } from './recovery'
import { SearchController } from './search'
import type {
  TranslationSettingsHandle,
  TranslationSettingsTarget,
} from './translation/settings-navigation'
import { WorkspaceSearch } from './WorkspaceSearch'
import { WorkspaceNotices, WorkspaceSidebar } from './WorkspaceSidebar'
import { WorkspaceController } from './workspace'

export function App(): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingSettings, setPendingSettings] = useState<Settings | null>(null)
  const [failedSettings, setFailedSettings] = useState<Settings | null>(null)
  const settingsFocus = useRef<HTMLElement | null>(null)
  const retryPreferences = useRef<HTMLButtonElement>(null)
  const [documents] = useState(() => new DocumentsController(window.manuslip))
  const [recovery] = useState(
    () => new RecoveryController(window.manuslip, (id) => documents.restore(id, false)),
  )
  const [workspace] = useState(() => new WorkspaceController(window.manuslip, documents))
  const [incoming] = useState(() => new IncomingController(window.manuslip, documents))
  const [search] = useState(() => new SearchController(window.manuslip, documents))
  const folder = useStore(workspace.store)
  const tabs = useStore(documents.store)
  const activeDocument = documents.active
  const activePath = useSyncExternalStore(
    useCallback(
      (notify) => activeDocument?.store.subscribe(notify) ?? (() => {}),
      [activeDocument],
    ),
    () => activeDocument?.store.getState().info.displayPath || null,
  )
  const fileBusy = tabs.busy || folder.busy
  const [fileCommandFocus, setFileCommandFocus] = useState<HTMLButtonElement | null>(null)
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [preferencePage, setPreferencePage] = useState<PreferencesPage>('general')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false)
  const searchToggle = useRef<HTMLButtonElement>(null)
  const openFolderButton = useRef<HTMLButtonElement>(null)
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const searchFocusRequest = useStore(search.store, (state) => state.focusRequest)
  useLayoutEffect(() => {
    if (!searchFocusRequest) return
    setSidebarCollapsed(false)
    setWorkspaceSearchOpen(true)
  }, [searchFocusRequest])
  useEffect(() => workspace.watch(), [workspace])
  useEffect(() => {
    if (!workspaceSearchOpen || sidebarCollapsed) return
    const dismiss = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        !(event.target instanceof HTMLElement) ||
        !event.target.closest('#workspace-sidebar')
      )
        return
      event.preventDefault()
      setWorkspaceSearchOpen(false)
      const focusTarget = folder.value?.root ? searchToggle.current : openFolderButton.current
      focusTarget?.focus()
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [workspaceSearchOpen, sidebarCollapsed, folder.value?.root])
  useEffect(() => trackLayerMotion(window), [])
  useEffect(() => {
    void loadPluginCatalog(window.manuslip)
  }, [])
  useEffect(() => {
    search.setRoot(folder.value?.root?.id || null)
  }, [search, folder.value?.root?.id])
  const command = useCallback(
    async (value: DocumentCommand): Promise<void> => {
      const focused = window.document.activeElement
      if (value === 'next-document' || value === 'previous-document') {
        if (preferencesDialog.current?.open) return
        await documents.command(value)
        if (focused === window.document.activeElement && focused?.closest('[role="tablist"]'))
          window.document.getElementById(`tab-${documents.store.getState().activeId}`)?.focus()
        return
      }
      setFileCommandFocus(focused instanceof HTMLButtonElement ? focused : null)
      if (value === 'open-folder') {
        setSidebarCollapsed(false)
        setWorkspaceSearchOpen(false)
        await workspace.choose()
      } else if (value === 'find-file' || value === 'search-workspace') {
        setPreferencesOpen(false)
        setSidebarCollapsed(false)
        setWorkspaceSearchOpen(true)
        search.show()
      } else await documents.command(value)
    },
    [workspace, documents, search],
  )

  useEffect(() => {
    if (!fileCommandFocus) return
    const owner = fileCommandFocus.ownerDocument
    if (fileBusy) {
      const cancelRestore = (): void => setFileCommandFocus(null)
      owner.addEventListener('pointerdown', cancelRestore, true)
      owner.addEventListener('keydown', cancelRestore, true)
      return () => {
        owner.removeEventListener('pointerdown', cancelRestore, true)
        owner.removeEventListener('keydown', cancelRestore, true)
      }
    }
    setFileCommandFocus(null)
    if (
      owner.activeElement === owner.body &&
      fileCommandFocus.isConnected &&
      !fileCommandFocus.disabled &&
      fileCommandFocus.checkVisibility()
    )
      fileCommandFocus.focus()
  }, [fileBusy, fileCommandFocus])
  const preferencesDialog = useRef<HTMLDialogElement>(null)
  const translationSettings = useRef<TranslationSettingsHandle>(null)
  const translationSettingsTarget = useRef<TranslationSettingsTarget | null>(null)
  const translationSettingsClosed = useRef<(() => void) | null>(null)
  const t = i18next.t.bind(i18next)

  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if (
        event.key !== ',' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.defaultPrevented ||
        event.isComposing ||
        documents.active?.store.getState().composing
      )
        return
      const dialog = preferencesDialog.current
      if (!dialog || (window.document.querySelector('dialog[open]') && !dialog.open)) return
      event.preventDefault()
      if (dialog.open) window.document.getElementById('preferences-search')?.focus()
      else setPreferencesOpen(true)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [documents])

  const load = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const result = await window.manuslip.bootstrap()
      if (!result.ok) throw new Error(result.error)
      await i18next.changeLanguage(result.value.settings.locale)
      setBootstrap(result.value)
      await workspace.start()
      void recovery.reload()
      incoming.start()
    } catch {
      setError('startupError')
    }
  }, [workspace, incoming, recovery])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    document.documentElement.lang = bootstrap?.settings.locale || 'en'
    document.documentElement.dataset.theme = bootstrap?.settings.theme || 'system'
  }, [bootstrap?.settings])
  useEffect(() => {
    if (preferencesOpen) {
      preferencesDialog.current?.showModal()
      if (translationSettingsTarget.current) {
        translationSettings.current?.reveal(translationSettingsTarget.current)
        translationSettingsTarget.current = null
      } else {
        preferencesDialog.current
          ?.querySelector<HTMLElement>(
            '.preferences-content > div:not([hidden]) :is(select, input, button, summary):not(:disabled)',
          )
          ?.focus()
      }
    } else {
      preferencesDialog.current?.close()
      translationSettingsTarget.current = null
    }
  }, [preferencesOpen])

  useEffect(
    () =>
      window.manuslip.onCommand((value) => {
        void command(value)
      }),
    [command],
  )
  useEffect(
    () =>
      window.manuslip.onSpellingCorrection((correction) => {
        void documents.active?.correctSpelling(correction)
      }),
    [documents],
  )

  useEffect(() => {
    if (busy) {
      const cancelRestore = (): void => {
        settingsFocus.current = null
      }
      window.document.addEventListener('pointerdown', cancelRestore, true)
      window.document.addEventListener('keydown', cancelRestore, true)
      return () => {
        window.document.removeEventListener('pointerdown', cancelRestore, true)
        window.document.removeEventListener('keydown', cancelRestore, true)
      }
    }
    const previous = settingsFocus.current
    settingsFocus.current = null
    if (
      !previous ||
      (window.document.activeElement !== window.document.body &&
        window.document.activeElement !== preferencesDialog.current)
    )
      return
    const target = previous.isConnected
      ? previous
      : (retryPreferences.current ?? window.document.getElementById('theme'))
    if (target?.checkVisibility()) target.focus()
  }, [busy])

  async function update(patch: Partial<Settings>): Promise<void> {
    if (!bootstrap || busy) return
    const focused = window.document.activeElement
    settingsFocus.current =
      focused instanceof HTMLElement && focused.closest('.preferences') ? focused : null
    setBusy(true)
    const next = { ...bootstrap.settings, ...patch }
    setPendingSettings(next)
    setFailedSettings(null)
    setStatus('')
    try {
      const result = await window.manuslip.updateSettings(next)
      if (!result.ok) throw new Error(result.error)
      await i18next.changeLanguage(result.value.locale)
      setBootstrap({ ...bootstrap, settings: result.value })
      setStatus('saved')
    } catch {
      setFailedSettings(next)
    } finally {
      setPendingSettings(null)
      setBusy(false)
    }
  }

  if (!bootstrap)
    return (
      <main className="startup">
        <h1>Manuslip</h1>
        <p role="status">{t(error || 'loading')}</p>
        {error && (
          <button type="button" onClick={() => void load()}>
            {t('retry')}
          </button>
        )}
      </main>
    )

  const preferences = (
    <PreferencesPanel
      activeDocument={activeDocument}
      bootstrap={bootstrap}
      open={preferencesOpen}
      pendingSettings={pendingSettings}
      failedSettings={failedSettings}
      busy={busy}
      status={status}
      preferencePage={preferencePage}
      setPreferencePage={setPreferencePage}
      retryPreferences={retryPreferences}
      translationSettings={translationSettings}
      update={update}
      onClose={() => setPreferencesOpen(false)}
    />
  )

  const sidebarToggle = (
    <button
      className="icon-button sidebar-toggle"
      type="button"
      aria-label={t(sidebarCollapsed ? 'showWorkspace' : 'hideWorkspace')}
      title={t(sidebarCollapsed ? 'showWorkspace' : 'hideWorkspace')}
      aria-controls="workspace-sidebar workspace-outline"
      aria-expanded={!sidebarCollapsed}
      onClick={() => {
        if (sidebarCollapsed) setWorkspaceSearchOpen(false)
        setSidebarCollapsed((value) => !value)
      }}
    >
      <Icon name="sidebar" />
    </button>
  )

  return (
    <div
      className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}${workspaceSearchOpen ? ' workspace-search-open' : ''}`}
    >
      <a className="skip-link" href="#content">
        {t('skip')}
      </a>
      <nav className="app-toolbar" aria-label={t('applicationToolbar')}>
        <div className="toolbar-start">
          {sidebarToggle}
          <div className="toolbar-files">
            <button
              className="icon-button"
              type="button"
              aria-label={t('newDocument')}
              title={t('newDocument')}
              disabled={fileBusy}
              onClick={() => void command('new')}
            >
              <Icon name="new" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label={t('openDocument')}
              title={t('openDocument')}
              disabled={fileBusy}
              onClick={() => void command('open')}
            >
              <Icon name="open" />
            </button>
          </div>
          {activeDocument && <EditingTools document={activeDocument} busy={fileBusy} />}
        </div>
        <DocumentTabs controller={documents} locale={bootstrap.settings.locale} />
        {!activeDocument && <span className="toolbar-brand">Manuslip</span>}
        <div className="toolbar-document-tools" ref={setToolbarHost} />
        <button
          className="icon-button preferences-trigger"
          type="button"
          aria-label={t('settings')}
          aria-keyshortcuts="Control+, Meta+,"
          title={t('settings')}
          onClick={() => setPreferencesOpen(true)}
        >
          <Icon name="settings" />
        </button>
      </nav>
      <aside
        id="workspace-sidebar"
        className="sidebar"
        aria-label={t('workspace')}
        hidden={sidebarCollapsed}
      >
        <div className="workspace-heading">
          <h2>{t('files')}</h2>
          <div className="workspace-heading-actions">
            <button
              ref={searchToggle}
              className="icon-button workspace-file-search"
              type="button"
              hidden={!folder.value?.root && !workspaceSearchOpen}
              aria-label={t(workspaceSearchOpen ? 'closeWorkspaceSearch' : 'filenameQuery')}
              title={t(workspaceSearchOpen ? 'closeWorkspaceSearch' : 'filenameQuery')}
              aria-controls="workspace-search-panel"
              aria-expanded={workspaceSearchOpen}
              aria-keyshortcuts="Control+p Meta+p"
              onClick={() => {
                if (workspaceSearchOpen) {
                  setWorkspaceSearchOpen(false)
                  if (!folder.value?.root) openFolderButton.current?.focus()
                } else void command('find-file')
              }}
            >
              <Icon name={workspaceSearchOpen ? 'close' : 'search'} size={16} />
            </button>
            <button
              ref={openFolderButton}
              className="icon-button"
              type="button"
              aria-label={t('openFolder')}
              title={t('openFolder')}
              disabled={fileBusy}
              onClick={() => void command('open-folder')}
            >
              <Icon name="open" size={16} />
            </button>
          </div>
        </div>
        <div id="workspace-navigation" className="workspace-navigation">
          <div hidden={workspaceSearchOpen}>
            <WorkspaceSidebar
              controller={workspace}
              busy={fileBusy}
              activePath={activePath}
              closeFolder={() =>
                void workspace.close().then(() => {
                  if (!workspace.store.getState().value?.root) openFolderButton.current?.focus()
                })
              }
            />
          </div>
          <div id="workspace-search-panel" hidden={!workspaceSearchOpen}>
            <WorkspaceSearch
              controller={search}
              busy={fileBusy}
              chooseFolder={() => void workspace.choose()}
              panel
            />
          </div>
        </div>
      </aside>
      <div className="main-column">
        {failedSettings && !preferencesOpen && (
          <div className="document-notice">
            <p role="alert">{t('saveError')}</p>
            <button
              type="button"
              onClick={() => {
                setPreferencePage('editor')
                setPreferencesOpen(true)
              }}
            >
              {t('settings')}
            </button>
          </div>
        )}
        {(error || tabs.error) && (
          <p className="document-notice" role="alert">
            {t(error || tabs.error || '')}
          </p>
        )}
        <main id="content" className={activeDocument ? 'editing' : undefined} tabIndex={-1}>
          <WorkspaceNotices controller={workspace} busy={fileBusy} />
          <IncomingNotices controller={incoming} busy={fileBusy} />
          <RecoveryPanel controller={recovery} busy={fileBusy} />
          {activeDocument ? (
            <DocumentWorkspace
              key={tabs.activeId}
              locale={bootstrap.settings.locale}
              spellcheck={Boolean(bootstrap.settings.spellcheck) && bootstrap.spellcheckAvailable}
              editorPreferences={bootstrap.settings.editor ?? defaultEditorPreferences}
              markdownPlugins={bootstrap.settings.markdown}
              readingLayout={bootstrap.settings.reading?.layout ?? 'replace'}
              document={activeDocument}
              command={(value) => void command(value)}
              busy={fileBusy}
              toolbarHost={toolbarHost}
              configureTranslation={(target = 'provider', afterClose) => {
                translationSettingsTarget.current = target
                translationSettingsClosed.current = afterClose ?? null
                setPreferencePage('translation')
                setPreferencesOpen(true)
              }}
            />
          ) : (
            <div className="welcome">
              <img
                className="welcome-logo"
                src={appIcon}
                width={80}
                height={80}
                alt=""
                draggable={false}
              />
              <h1>{t('welcome')}</h1>
              <p className="muted">{t('foundation')}</p>
              <div className="action-row">
                <button
                  className="primary"
                  type="button"
                  disabled={fileBusy}
                  onClick={() => void command('new')}
                >
                  <Icon name="new" />
                  {t('newDocument')}
                </button>
                <button type="button" disabled={fileBusy} onClick={() => void command('open')}>
                  <Icon name="open" />
                  {t('openDocument')}
                </button>
              </div>
              <p className="welcome-drop-hint">{t('dropHint')}</p>
            </div>
          )}
        </main>
        <dialog
          className="preferences-dialog"
          aria-labelledby="preferences-heading"
          ref={preferencesDialog}
          onKeyDown={(event) => {
            if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button, input, select, textarea, summary, a[href], [tabindex]',
              ),
            ).filter(
              (control) =>
                control.tabIndex >= 0 && !control.matches(':disabled') && control.checkVisibility(),
            )
            const boundary = event.shiftKey ? controls[0] : controls.at(-1),
              target = event.shiftKey ? controls.at(-1) : controls[0]
            if (target && window.document.activeElement === boundary) {
              event.preventDefault()
              target.focus()
            }
          }}
          onCancel={() => setPreferencesOpen(false)}
          onClose={() => {
            setPreferencesOpen(false)
            const afterClose = translationSettingsClosed.current
            translationSettingsClosed.current = null
            afterClose?.()
            translationSettings.current?.conceal()
          }}
        >
          {preferences}
        </dialog>
        {!activeDocument && (
          <footer>
            <span>{t('local')}</span>
            <span>Markdown</span>
          </footer>
        )}
      </div>
      <aside
        id="workspace-outline"
        className="outline-sidebar"
        aria-label={t('outline')}
        hidden={sidebarCollapsed}
      >
        <div className="workspace-heading">
          <h2>{t('outline')}</h2>
          <Icon name="outline" size={16} />
        </div>
        <div className="workspace-navigation">
          {activeDocument ? (
            <DocumentOutline
              key={tabs.activeId}
              document={activeDocument}
              busy={fileBusy}
              panel
              active={!sidebarCollapsed}
            />
          ) : (
            <p className="workspace-hint">{t('outlineEmpty')}</p>
          )}
        </div>
      </aside>
    </div>
  )
}
