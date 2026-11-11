import { useEffect, useState } from 'react'
import type { DocumentController, DocumentStatus } from './document'
import { i18next } from './i18n'
import { ToolbarDisclosure } from './ToolbarDisclosure'

function LocalTime(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const update = (): void => {
      setNow(new Date())
      clearTimeout(timer)
      timer = setTimeout(update, 60_000 - (Date.now() % 60_000))
    }
    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return (
    <time className="local-time" dateTime={time} dir="ltr" title={i18next.t('localTime')}>
      {time}
    </time>
  )
}

export function DocumentStatusBar({
  status,
  document,
}: {
  document: DocumentController
  status: Pick<
    DocumentStatus,
    | 'info'
    | 'line'
    | 'column'
    | 'bytes'
    | 'wordCount'
    | 'characterCount'
    | 'revision'
    | 'semanticRevision'
  >
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (expanded) return document.preview.observeNavigation()
  }, [document, expanded])
  const t = i18next.t.bind(i18next)
  const countsCurrent = status.semanticRevision === status.revision
  const words =
    countsCurrent && status.wordCount !== null ? t('wordCount', { count: status.wordCount }) : null
  const characters =
    countsCurrent && status.characterCount !== null
      ? t('characterCount', { count: status.characterCount })
      : null
  return (
    <div className="editor-status">
      <span className="editor-cursor-position">
        {t('cursorPosition', { line: status.line, column: status.column })}
      </span>
      <div className="document-status-summary">
        <ToolbarDisclosure
          label={t('documentDetails')}
          summary={words ?? characters ?? undefined}
          onOpenChange={setExpanded}
        >
          <div className="document-details">
            {(words || characters) && (
              <dl className="document-statistics">
                {words && (
                  <div>
                    <dt>{t('documentWords')}</dt>
                    <dd>{status.wordCount?.toLocaleString(i18next.language)}</dd>
                  </div>
                )}
                {characters && (
                  <div>
                    <dt>{t('documentCharacters')}</dt>
                    <dd>{status.characterCount?.toLocaleString(i18next.language)}</dd>
                  </div>
                )}
              </dl>
            )}
            {!words && !characters && (
              <p className="document-counts-unavailable">{t('documentCountsUnavailable')}</p>
            )}
            <dl className="document-file-details">
              <dt>{t('fileEncoding')}</dt>
              <dd>
                {status.info.encoding.toUpperCase()}
                {status.info.bom ? ' · BOM' : ''}
              </dd>
              <dt>{t('documentLineEndings')}</dt>
              <dd>{status.info.newline.toUpperCase()}</dd>
              <dt>{t('documentSize')}</dt>
              <dd>
                {t('documentBytes', { bytes: status.bytes.toLocaleString(i18next.language) })}
              </dd>
            </dl>
            <dl className="document-location">
              <dt>{t('documentLocation')}</dt>
              <dd dir="auto">{status.info.displayPath || t('untitled')}</dd>
            </dl>
          </div>
        </ToolbarDisclosure>
        <LocalTime />
      </div>
    </div>
  )
}
