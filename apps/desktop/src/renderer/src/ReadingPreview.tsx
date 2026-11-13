import { useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { DocumentController } from './document'
import { Icon } from './Icons'
import { ReadingPlaceholder } from './ReadingPlaceholder'
import { ToolbarDisclosure } from './ToolbarDisclosure'
import { requiresTranslationKey } from './translation/availability'
import type { DocumentReading } from './translation/controller'
import { readingCopy } from './translation/copy'
import { languageName, translationLanguages } from './translation/languages'
import type {
  ConfigureTranslation,
  TranslationSettingsTarget,
} from './translation/settings-navigation'
import { useSourcePreview } from './translation/source-preview'
import { mountReading } from './translation/surface'
import { ReadingViewport } from './translation/viewport'
import { useDocumentStatus } from './use-document-status'

export function ReadingPreview({
  reading,
  document,
  locale,
  configure: showSettings,
}: {
  reading: DocumentReading
  document: DocumentController
  locale: string
  configure: ConfigureTranslation
}): React.JSX.Element {
  const status = useStore(reading.store)
  const source = useDocumentStatus(document)
  const [pendingActions, setPendingActions] = useState(0)
  const [settingsReturn, setSettingsReturn] = useState<TranslationSettingsTarget | null>(null)
  const article = useRef<HTMLElement>(null)
  const viewport = useRef<ReadingViewport | null>(null)
  const actions = useRef<HTMLDivElement>(null)
  const translate = useRef<HTMLButtonElement>(null)
  const language = useRef<HTMLSelectElement>(null)
  const configure: ConfigureTranslation = (target = 'provider') => {
    const origin = window.document.activeElement
    showSettings(target, () => {
      // Native dialogs return to a surviving invoker. Setup can remove that button.
      if (!origin?.isConnected) setSettingsReturn(target)
    })
  }
  useLayoutEffect(() => {
    if (!settingsReturn || (status.visible && status.configurationLoading)) return
    setSettingsReturn(null)
    if (!status.visible || !status.configuration?.settings) return
    const active = window.document.activeElement
    if (active !== window.document.body && !active?.closest('dialog:not([open])')) return
    const field = settingsReturn === 'languages' ? language.current : translate.current
    if (field && !field.disabled) field.focus()
  }, [settingsReturn, status.visible, status.configurationLoading, status.configuration])
  const busy = status.phase === 'preparing' || status.phase === 'translating'
  const sourcePreview = useSourcePreview(
    document,
    status.visible && !status.projection,
    !busy,
    source.revision,
  )
  const projection = status.projection ?? sourcePreview.projection
  const revealed = useRef<typeof status.navigation>(null)
  const wasBusy = useRef(false)
  const returnFocus = useRef(false)
  const copy = readingCopy[locale === 'zh-CN' ? 'zh-CN' : 'en']
  useLayoutEffect(() => {
    if (!status.visible)
      for (const panel of actions.current?.querySelectorAll<HTMLElement>(
        '[popover]:popover-open',
      ) ?? [])
        panel.hidePopover()
  }, [status.visible])
  useLayoutEffect(() => {
    const element = article.current
    const scroller = element?.closest<HTMLElement>('.reading-pane')
    if (!element || !scroller) return
    viewport.current = new ReadingViewport(scroller, element)
    return () => {
      viewport.current?.dispose()
      viewport.current = null
    }
  }, [])
  useLayoutEffect(() => {
    if (!article.current || !status.visible) return
    if (!projection) {
      article.current.textContent = ''
      viewport.current?.reset()
      return
    }
    let unmount: () => void
    try {
      unmount = mountReading(
        article.current,
        projection,
        source.info.id,
        source.remoteImages,
        window.manuslip,
      )
    } catch {
      reading.mountFailed()
      viewport.current?.reset()
      return
    }
    viewport.current?.refresh()
    viewport.current?.restore()
    return () => {
      viewport.current?.capture()
      unmount()
    }
  }, [projection, status.visible, source.info.id, source.remoteImages, reading])
  useLayoutEffect(() => {
    const request = status.navigation
    if (!status.visible || !request || request === revealed.current) return
    if (status.projection && status.revision !== source.revision) return
    const block = projection?.blocks?.find(
      (block) => block.from <= request.from && block.to > request.from,
    )
    if (!block) return
    let headingIndex = 0
    for (const heading of document.store.getState().outline) {
      if (heading.from >= request.from) break
      if (heading.from >= block.from) headingIndex++
    }
    if (viewport.current?.reveal(block.id, headingIndex)) revealed.current = request
  }, [
    status.navigation,
    status.visible,
    status.projection,
    status.revision,
    source.revision,
    projection,
    document,
  ])
  useLayoutEffect(() => {
    const working = busy || pendingActions > 0
    if (wasBusy.current && !working) {
      if (
        returnFocus.current &&
        (window.document.activeElement === window.document.body ||
          actions.current?.contains(window.document.activeElement))
      ) {
        if (translate.current && !translate.current.disabled) translate.current.focus()
        else {
          const pane = article.current?.parentElement
          const next =
            pane?.querySelector<HTMLButtonElement>('.reading-recovery button:not(:disabled)') ??
            actions.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          next?.focus()
        }
      }
      returnFocus.current = false
    }
    wasBusy.current = working
  }, [busy, pendingActions])
  const waitFor = (operation: Promise<unknown>): void => {
    setPendingActions((count) => count + 1)
    void operation.finally(() => setPendingActions((count) => count - 1))
  }
  const run = (failedOnly = false): void => {
    const active = window.document.activeElement
    returnFocus.current = Boolean(
      actions.current?.contains(active) || active?.closest('.reading-recovery'),
    )
    waitFor(reading.start(!needsKey, failedOnly))
  }
  const reload = (): void => {
    returnFocus.current = true
    waitFor(reading.metadata())
  }
  const error =
    status.error === 'translation-not-configured'
      ? copy.none
      : status.error === 'translation-composing'
        ? copy.composing
        : status.error === 'translation-refresh-first'
          ? copy.refreshFirst
          : status.error === 'translation-capture-changed'
            ? copy.changed
            : [
                  'translation-view-limit',
                  'semantic-limit',
                  'translation-unit-large',
                  'translation-document-large',
                ].includes(status.error ?? '')
              ? copy.limit
              : [
                    'translation-view-worker',
                    'translation-capture-timeout',
                    'semantic-parse',
                  ].includes(status.error ?? '')
                ? copy.worker
                : copy.error
  const languages =
    status.configuration?.settings?.provider.adapter === 'deepl'
      ? (status.configuration.languages ?? [])
          .filter((language) => language.target && language.tags)
          .map((language) => language.tag)
      : [...translationLanguages]
  const remaining = Math.max(0, status.total - status.completed - status.failed - status.limited)
  const configured = Boolean(status.configuration?.settings)
  const settingsBusy = status.configurationLoading || Boolean(status.configurationError)
  const needsKey =
    status.configuration?.settings &&
    requiresTranslationKey(status.configuration.settings) &&
    status.configuration.credential === 'none'
  return (
    <section
      className="reading-pane"
      aria-label={copy.mode}
      hidden={!status.visible}
      onScroll={() => {
        returnFocus.current = false
      }}
      onWheelCapture={() => {
        returnFocus.current = false
      }}
      onPointerDownCapture={(event) => {
        if (!actions.current?.contains(event.target as Node)) returnFocus.current = false
      }}
    >
      <div className="reading-controls">
        <div className="reading-actions" ref={actions}>
          <div className="reading-primary-actions">
            <div className="toolbar-field">
              <label htmlFor="reading-language">{copy.target}</label>
              <select
                id="reading-language"
                ref={language}
                value={status.target}
                disabled={
                  busy ||
                  settingsBusy ||
                  !configured ||
                  !languages.length ||
                  status.configuration?.configuration === 'read-only'
                }
                onChange={(event) => void reading.target(event.target.value)}
              >
                {!languages.includes(status.target) && (
                  <option value={status.target}>{languageName(status.target, locale)}</option>
                )}
                {languages.map((language) => (
                  <option key={language} value={language}>
                    {languageName(language, locale)}
                  </option>
                ))}
              </select>
            </div>
            {!languages.length && (
              <button type="button" onClick={() => configure('languages')}>
                {copy.languages}
              </button>
            )}
            <button
              ref={translate}
              className="primary"
              type="button"
              disabled={busy || settingsBusy || source.composing}
              onClick={() => (configured ? run() : configure())}
            >
              <Icon name={status.stale ? 'refresh' : 'translate'} size={16} />
              {status.stale ? copy.refresh : copy.translate}
            </button>
            {busy && (
              <button type="button" onClick={() => reading.cancel()}>
                {copy.cancel}
              </button>
            )}
            {!busy && status.failed > 0 && (
              <button
                type="button"
                disabled={status.stale || settingsBusy || needsKey || source.composing}
                onClick={() => run(true)}
              >
                {copy.retry}
              </button>
            )}
          </div>
          <ToolbarDisclosure label={copy.options} icon="sliders">
            <div className="toolbar-field">
              <label className="toolbar-field-caption" htmlFor="reading-layout">
                {copy.layout}
              </label>
              <select
                id="reading-layout"
                value={status.layout}
                onChange={(event) =>
                  reading.setLayout(
                    event.target.value as 'replace' | 'side-by-side' | 'interlinear',
                  )
                }
              >
                {(['replace', 'side-by-side', 'interlinear'] as const).map((layout) => (
                  <option key={layout} value={layout}>
                    {copy[layout]}
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-command-group">
              <button type="button" onClick={() => configure()}>
                <Icon name="settings" size={16} />
                {copy.configure}
              </button>
            </div>
            <details className="reading-hint">
              <summary>{copy.about}</summary>
              <p>{copy.intro}</p>
            </details>
          </ToolbarDisclosure>
        </div>
        <div role="status" aria-atomic="true" className="reading-progress">
          {status.projection && status.configurationLoading && <p>{copy.loadingSettings}</p>}
          {status.phase !== 'idle' && status.phase !== 'error' && status.phase !== 'ready' && (
            <p>{copy[status.phase]}</p>
          )}
          {status.total > 0 && (
            <p>{copy.progress(status.completed, status.total, status.cached)}</p>
          )}
        </div>
        {status.stale && (
          <p className="reading-stale" role="status">
            {copy.stale}
          </p>
        )}
        {status.projection && status.configurationError && (
          <div className="reading-recovery">
            <p role="alert">{copy.settingsError}</p>
            <button type="button" disabled={status.configurationLoading} onClick={reload}>
              {copy.reload}
            </button>
          </div>
        )}
        {status.error && (configured || status.error !== 'translation-not-configured') && (
          <p role="alert">{error}</p>
        )}
        {status.projection && needsKey && !status.unitError && !busy && (
          <div className="reading-recovery">
            <p>{copy.keyOffline}</p>
            <button type="button" onClick={() => configure('key')}>
              {copy.addKey}
            </button>
          </div>
        )}
        {(status.failed > 0 || status.limited > 0 || (!busy && remaining > 0)) && (
          <p>{copy.fallback(status.failed, remaining, status.limited)}</p>
        )}
        {status.unitError && (
          <div className="reading-recovery">
            <p>
              {status.unitError === 'translation-key-required'
                ? copy.keyRequired
                : status.unitError === 'translation-settings'
                  ? copy.unsupported
                  : status.unitError === 'translation-auth'
                    ? copy.auth
                    : status.unitError === 'translation-quota'
                      ? copy.quota
                      : status.unitError === 'translation-rate'
                        ? copy.rate
                        : ['translation-response', 'translation-incomplete'].includes(
                              status.unitError,
                            )
                          ? copy.response
                          : status.unitError === 'translation-view-limit'
                            ? copy.limit
                            : copy.provider}
            </p>
            {['translation-key-required', 'translation-auth', 'translation-settings'].includes(
              status.unitError,
            ) && (
              <button
                type="button"
                onClick={() =>
                  configure(status.unitError === 'translation-settings' ? 'languages' : 'key')
                }
              >
                {status.unitError === 'translation-auth'
                  ? copy.updateKey
                  : status.unitError === 'translation-settings'
                    ? copy.languages
                    : copy.addKey}
              </button>
            )}
          </div>
        )}
        {['unavailable', 'future'].includes(status.configuration?.cache ?? '') && (
          <p>{copy.cache}</p>
        )}
        {!status.projection && (
          <ReadingPlaceholder
            status={status}
            locale={locale}
            configure={configure}
            reload={reload}
          />
        )}
        {sourcePreview.error && <p role="alert">{copy.worker}</p>}
      </div>
      <article
        className="reading-article cm-live-rendered"
        ref={article}
        hidden={!projection}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus lets keyboard users scroll and read the independently scrolling copy.
        tabIndex={0}
        aria-label={copy.mode}
        lang={status.projection?.layout === 'replace' ? status.target || undefined : undefined}
      />
    </section>
  )
}
