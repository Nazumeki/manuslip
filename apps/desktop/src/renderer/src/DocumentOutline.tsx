import type { Heading } from '@manuslip/core'
import { useEffect, useState } from 'react'
import type { DocumentController } from './document'
import { Icon } from './Icons'
import { i18next } from './i18n'
import { useDocumentStatus } from './use-document-status'

function revealHeading(document: DocumentController, from: number): () => void {
  return () => document.revealHeading(from)
}

interface OutlineItem {
  heading: Heading
  children: OutlineItem[]
}

function nestHeadings(headings: readonly Heading[]): OutlineItem[] {
  const roots: OutlineItem[] = []
  const parents: OutlineItem[] = []
  for (const heading of headings) {
    while ((parents.at(-1)?.heading.depth ?? 0) >= heading.depth) parents.pop()
    const item: OutlineItem = { heading, children: [] }
    const siblings = parents.at(-1)?.children ?? roots
    siblings.push(item)
    parents.push(item)
  }
  return roots
}

function OutlineList({
  items,
  document,
  disabled,
}: {
  items: OutlineItem[]
  document: DocumentController
  disabled: boolean
}): React.JSX.Element {
  return (
    <ul className="outline-list">
      {items.map(({ heading, children }) => (
        <li key={`${heading.from}:${heading.to}`}>
          <button
            type="button"
            disabled={disabled}
            data-depth={heading.depth}
            onClick={revealHeading(document, heading.from)}
          >
            <span className="outline-marker" aria-hidden="true" />
            <bdi>{heading.text || i18next.t('emptyHeading')}</bdi>
          </button>
          {!!children.length && (
            <OutlineList items={children} document={document} disabled={disabled} />
          )}
        </li>
      ))}
    </ul>
  )
}

export function DocumentOutline({
  document,
  busy,
  panel = false,
  active = true,
}: {
  document: DocumentController
  busy: boolean
  panel?: boolean
  active?: boolean
}): React.JSX.Element {
  const status = useDocumentStatus(document)
  const outline = document.store.getState().outline
  const [expanded, setExpanded] = useState(false)
  const [visible, setVisible] = useState(200)
  const t = i18next.t.bind(i18next)
  const observing = active && (panel || expanded)
  useEffect(() => {
    if (!observing) return
    return document.preview.observeNavigation()
  }, [document, observing])
  const current = status.semanticRevision === status.revision && status.semantic === 'ready'
  return (
    <details
      className="document-outline"
      open={panel || expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary hidden={panel}>
        <Icon name="outline" size={16} />
        {t('outline')}
        <Icon name="chevron" size={12} />
      </summary>
      {(panel || expanded) && (
        <nav aria-label={t('documentHeadings')}>
          {!current && (
            <p role="status">
              {t(
                status.semantic === 'error' || status.semantic === 'limit'
                  ? 'outlineUnavailable'
                  : 'outlineUpdating',
              )}
            </p>
          )}
          {current && !outline.length && <p>{t('noHeadings')}</p>}
          <OutlineList
            items={nestHeadings(outline.slice(0, visible))}
            document={document}
            disabled={busy || !current || status.composing}
          />
          {outline.length > visible && (
            <button type="button" onClick={() => setVisible((count) => count + 200)}>
              {t('moreHeadings')}
            </button>
          )}
        </nav>
      )}
    </details>
  )
}
