import type { WebContents } from 'electron'
import type { DocumentCommand } from '../shared/file-contracts'

/** Route tab switching before native menus/OS bindings can consume the key. */
export function installDocumentShortcuts(
  contents: WebContents,
  command: (value: DocumentCommand) => void,
): void {
  contents.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      input.key !== 'Tab' ||
      !input.control ||
      input.alt ||
      input.meta
    )
      return
    event.preventDefault()
    command(input.shift ? 'previous-document' : 'next-document')
  })
}
