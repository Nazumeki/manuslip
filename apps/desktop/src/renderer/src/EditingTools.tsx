import { useState } from 'react'
import { useStore } from 'zustand'
import type { ClipboardAction } from '../../shared/contracts'
import type { DocumentController } from './document'
import { Icon, type IconName } from './Icons'
import { i18next } from './i18n'
import { ToolbarDisclosure } from './ToolbarDisclosure'
import { useDocumentStatus } from './use-document-status'

export function EditingTools({
  document,
  busy,
}: {
  document: DocumentController
  busy: boolean
}): React.JSX.Element {
  const status = useDocumentStatus(document)
  const reading = useStore(
    document.reading?.store ?? document.store,
    (state) => 'visible' in state && state.visible,
  )
  const [error, setError] = useState(false)
  const t = i18next.t.bind(i18next)
  const disabled = busy || status.composing || Boolean(reading)
  const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  async function clipboard(action: ClipboardAction): Promise<void> {
    setError(false)
    await document.synchronizeInput()
    if (document.store.getState().composing || !document.focus()) return
    try {
      const result = await window.manuslip.edit(action)
      setError(!result.ok)
    } catch {
      setError(true)
    }
  }
  const actions: {
    key: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'find'
    icon: IconName
    shortcut: string
    run(): void
  }[] = [
    { key: 'undo', icon: 'undo', shortcut: `${modifier}Z`, run: () => void document.edit('undo') },
    {
      key: 'redo',
      icon: 'redo',
      shortcut: /Mac/.test(navigator.platform) ? '⌘Shift+Z' : 'Ctrl+Y',
      run: () => void document.edit('redo'),
    },
    { key: 'cut', icon: 'cut', shortcut: `${modifier}X`, run: () => void clipboard('cut') },
    { key: 'copy', icon: 'copy', shortcut: `${modifier}C`, run: () => void clipboard('copy') },
    { key: 'paste', icon: 'paste', shortcut: `${modifier}V`, run: () => void clipboard('paste') },
    {
      key: 'selectAll',
      icon: 'selectAll',
      shortcut: `${modifier}A`,
      run: () => void document.edit('select-all'),
    },
    {
      key: 'find',
      icon: 'search',
      shortcut: `${modifier}F`,
      run: () => void document.edit('find'),
    },
  ]
  return (
    <div className="editing-tools">
      <ToolbarDisclosure label={t('editMenu')} icon="edit" iconOnly>
        <div className="toolbar-command-group editing-commands">
          {actions.map((action) => (
            <button key={action.key} type="button" disabled={disabled} onClick={action.run}>
              <Icon name={action.icon} size={18} />
              <span>{t(action.key)}</span>
              <kbd>{action.shortcut}</kbd>
            </button>
          ))}
        </div>
      </ToolbarDisclosure>
      {error && (
        <p className="toolbar-error" role="alert">
          {t('editFailed')}
        </p>
      )}
    </div>
  )
}
