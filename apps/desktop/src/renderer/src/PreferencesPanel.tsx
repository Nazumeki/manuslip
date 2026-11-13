import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Bootstrap, Locale, Settings, Theme } from '../../shared/contracts'
import type { DocumentController } from './document'
import { EditorSettings } from './EditorSettings'
import { Icon } from './Icons'
import { i18next } from './i18n'
import { MarkdownSettings } from './MarkdownSettings'
import { PluginSettings } from './PluginSettings'
import { preferenceKeywords, preferencesCopy } from './preferences-copy'
import { TranslationSettings } from './TranslationSettings'
import type { TranslationSettingsHandle } from './translation/settings-navigation'

export type PreferencesPage = 'general' | 'editor' | 'translation' | 'plugins'

const pages = [
  { page: 'general', icon: 'sliders' },
  { page: 'editor', icon: 'edit' },
  { page: 'translation', icon: 'translate' },
  { page: 'plugins', icon: 'plugins' },
] as const

export function PreferencesPanel({
  bootstrap,
  activeDocument,
  open,
  pendingSettings,
  failedSettings,
  busy,
  status,
  preferencePage,
  setPreferencePage,
  retryPreferences,
  translationSettings,
  update,
  onClose,
}: {
  bootstrap: Bootstrap
  activeDocument: DocumentController | null
  open: boolean
  pendingSettings: Settings | null
  failedSettings: Settings | null
  busy: boolean
  status: string
  preferencePage: PreferencesPage
  setPreferencePage(page: PreferencesPage): void
  retryPreferences: RefObject<HTMLButtonElement | null>
  translationSettings: RefObject<TranslationSettingsHandle | null>
  update(patch: Partial<Settings>): Promise<void>
  onClose(): void
}): React.JSX.Element {
  const t = i18next.t.bind(i18next)
  const copy = preferencesCopy[bootstrap.settings.locale]
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const navigation = useRef<{ page: PreferencesPage; fromSearch: boolean } | null>(null)
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  const current = pendingSettings ?? bootstrap.settings
  const disabled = busy || bootstrap.settingsReadOnly
  const normalizedQuery = query
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase(bootstrap.settings.locale)
  const results = pages.filter(({ page }) => {
    const text =
      `${copy[page]} ${copy[`${page}Hint`]} ${preferenceKeywords[page]}`.toLocaleLowerCase(
        bootstrap.settings.locale,
      )
    return normalizedQuery.split(/\s+/).every((word) => text.includes(word))
  })
  const navigate = (page: PreferencesPage, fromSearch = false): void => {
    if (page === preferencePage && !query) {
      document.querySelector('.preferences-content')?.scrollTo(0, 0)
      if (page === 'translation') translationSettings.current?.reveal('provider')
      return
    }
    navigation.current = { page, fromSearch }
    setQuery('')
    setPreferencePage(page)
  }
  useLayoutEffect(() => {
    const target = navigation.current
    navigation.current = null
    if (!open || !target) return
    document.querySelector('.preferences-content')?.scrollTo(0, 0)
    if (target.page === 'translation') translationSettings.current?.reveal('provider')
    else if (target.fromSearch)
      document
        .querySelector<HTMLElement>(
          `#preferences-${target.page} :is(select, input, button):not(:disabled)`,
        )
        ?.focus()
  })
  const feedback = (
    <>
      <p className="feedback" role="status">
        {status ? t(status) : ''}
      </p>
      {failedSettings && (
        <div className="preference-error">
          <p role="alert">{t('saveError')}</p>
          <button
            ref={retryPreferences}
            type="button"
            disabled={disabled}
            onClick={() => void update(failedSettings)}
          >
            {t('retryPreferences')}
          </button>
        </div>
      )}
    </>
  )
  return (
    <section className="preferences" aria-labelledby="preferences-heading">
      <header className="preferences-header">
        <div>
          <h2 id="preferences-heading">{t('settings')}</h2>
          <p className="preference-hint">{copy.appScope}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t('closePreferences')}
          title={t('closePreferences')}
          onClick={() => onClose()}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="preferences-search">
        <Icon name="search" size={16} />
        <label className="visually-hidden" htmlFor="preferences-search">
          {copy.search}
        </label>
        <input
          id="preferences-search"
          ref={search}
          type="search"
          value={query}
          placeholder={copy.search}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-button"
            aria-label={copy.clearSearch}
            onClick={() => {
              setQuery('')
              search.current?.focus()
            }}
          >
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="preferences-layout">
        <nav className="preferences-navigation" aria-label={t('settings')}>
          {pages.map(({ page, icon }) => (
            <button
              key={page}
              type="button"
              aria-pressed={!normalizedQuery && preferencePage === page}
              aria-controls={`preferences-${page}`}
              onClick={() => navigate(page)}
            >
              <Icon name={icon} />
              {copy[page]}
            </button>
          ))}
        </nav>
        <div className="preferences-content">
          {bootstrap.settingsRecovered && (
            <p className="preference-notice" role="status">
              {t('recovered')}
            </p>
          )}
          {bootstrap.settingsReadOnly && (
            <p className="preference-notice" role="status">
              {t('readOnly')}
            </p>
          )}
          {normalizedQuery && (
            <div className="preferences-results">
              <h3 className="preferences-page-title">{copy.results}</h3>
              <p className="preference-hint" role="status">
                {results.length ? query : copy.noResults}
              </p>
              {results.map(({ page, icon }) => (
                <button type="button" key={page} onClick={() => navigate(page, true)}>
                  <Icon name={icon} />
                  <span>
                    <strong>{copy[page]}</strong>
                    <span className="preference-hint">{copy[`${page}Hint`]}</span>
                  </span>
                  <Icon name="chevronRight" size={16} />
                </button>
              ))}
            </div>
          )}
          <div
            id="preferences-general"
            hidden={Boolean(normalizedQuery) || preferencePage !== 'general'}
          >
            <h3 className="preferences-page-title">{copy.general}</h3>
            <p className="preferences-page-hint">{copy.generalHint}</p>
            <div className="preference-row">
              <label htmlFor="theme">{t('appearance')}</label>
              <select
                id="theme"
                disabled={busy || bootstrap.settingsReadOnly}
                value={(pendingSettings || bootstrap.settings).theme}
                onChange={(event) => void update({ theme: event.target.value as Theme })}
              >
                <option value="system">{t('system')}</option>
                <option value="light">{t('light')}</option>
                <option value="dark">{t('dark')}</option>
              </select>
            </div>
            <div className="preference-row">
              <label htmlFor="locale">{t('language')}</label>
              <select
                id="locale"
                disabled={busy || bootstrap.settingsReadOnly}
                value={(pendingSettings || bootstrap.settings).locale}
                onChange={(event) => void update({ locale: event.target.value as Locale })}
              >
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </div>
            {preferencePage === 'general' && feedback}
            <label className="spellcheck-preference">
              <input
                type="checkbox"
                aria-describedby="spellcheck-hint"
                checked={Boolean((pendingSettings || bootstrap.settings).spellcheck)}
                disabled={busy || bootstrap.settingsReadOnly || !bootstrap.spellcheckAvailable}
                onChange={(event) => void update({ spellcheck: event.target.checked })}
              />
              {t('spellcheck')}
            </label>
            <p className="preference-hint" id="spellcheck-hint">
              {t(bootstrap.spellcheckAvailable ? 'spellcheckHint' : 'spellcheckUnavailable')}
            </p>
          </div>
          <div
            id="preferences-editor"
            hidden={Boolean(normalizedQuery) || preferencePage !== 'editor'}
          >
            <EditorSettings
              settings={current}
              locale={bootstrap.settings.locale}
              disabled={disabled}
              update={update}
            />
            {preferencePage === 'editor' && feedback}
          </div>
          <div
            id="preferences-translation"
            hidden={Boolean(normalizedQuery) || preferencePage !== 'translation'}
          >
            <TranslationSettings
              ref={translationSettings}
              locale={bootstrap.settings.locale}
              active={open && preferencePage === 'translation' && !normalizedQuery}
            />
            <fieldset className="preference-group reading-defaults" disabled={disabled}>
              <legend>{copy.reading}</legend>
              <label htmlFor="reading-default-layout">{copy.readingLayout}</label>
              <select
                id="reading-default-layout"
                value={current.reading?.layout ?? 'replace'}
                aria-describedby="reading-default-hint"
                onChange={(event) =>
                  void update({
                    reading: {
                      layout: event.target.value as NonNullable<Settings['reading']>['layout'],
                    },
                  })
                }
              >
                {(['replace', 'side-by-side', 'interlinear'] as const).map((layout) => (
                  <option key={layout} value={layout}>
                    {copy[layout]}
                  </option>
                ))}
              </select>
              <p className="preference-hint" id="reading-default-hint">
                {copy.readingHint}
              </p>
            </fieldset>
            {preferencePage === 'translation' && feedback}
          </div>
          <div
            id="preferences-plugins"
            hidden={Boolean(normalizedQuery) || preferencePage !== 'plugins'}
          >
            <MarkdownSettings
              document={activeDocument}
              settings={current}
              locale={bootstrap.settings.locale}
              disabled={disabled}
              update={update}
            />
            {preferencePage === 'plugins' && feedback}
            <PluginSettings locale={bootstrap.settings.locale} />
          </div>
        </div>
      </div>
      <footer className="preferences-footer">
        <span>{copy.saveHint}</span>
        <span>
          {copy.appVersion} {bootstrap.runtime.app}
        </span>
      </footer>
    </section>
  )
}
