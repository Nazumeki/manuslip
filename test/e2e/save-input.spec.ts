import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'

interface PendingInput {
  application: ElectronApplication
  page: Page
  editor: Locator
  path: string
  original: string
}

async function withPendingInput(
  action: (context: PendingInput) => Promise<void>,
  anotherTab = false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-save-input-'))
  const path = join(directory, 'pending.md')
  const original = '# Original\n\nKeep this text.'
  await writeFile(path, original)
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Start writing' })).toBeVisible()
    await page.evaluate(() => {
      // Deterministically delay observer delivery and layout, like a busy renderer. Native
      // takeRecords must still expose the pending mutation when CodeMirror synchronizes.
      let holding = false
      let heldRecords = 0,
        taken = 0,
        heldFrames = 0
      document.addEventListener(
        'selectionchange',
        (event) => {
          if (holding) event.stopImmediatePropagation()
        },
        true,
      )
      const frames: FrameRequestCallback[] = []
      const nativeFrame = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (callback) =>
        nativeFrame((time) => {
          if (holding) {
            frames.push(callback)
            heldFrames++
          } else callback(time)
        })
      const NativeObserver = window.MutationObserver
      window.MutationObserver = class extends NativeObserver {
        constructor(callback: MutationCallback) {
          const held: MutationRecord[] = []
          super((records, observer) => {
            if (
              holding &&
              records.some((record) => {
                const target =
                  record.target instanceof Element ? record.target : record.target.parentElement
                return target?.closest('.cm-content')
              })
            ) {
              held.push(...records)
              heldRecords += records.length
            } else callback(records, observer)
          })
          const take = this.takeRecords.bind(this)
          this.takeRecords = () => {
            const records = [...held, ...take()]
            if (holding) taken += records.length
            held.length = 0
            return records
          }
        }
      }
      Reflect.set(window, '__saveInputHold', () => {
        holding = true
      })
      Reflect.set(window, '__saveInputStats', () => ({ heldRecords, taken, heldFrames }))
      Reflect.set(window, '__saveInputRelease', () => {
        holding = false
        for (const callback of frames.splice(0)) nativeFrame(callback)
      })
    })
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toContainText('Keep this text.')
    if (anotherTab) {
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('manuslip:command', 'new')
      })
      await expect(page.getByRole('tab')).toHaveCount(2)
      await expect(editor).not.toContainText('Keep this text.')
      await editor.fill('Other tab')
      await page.getByRole('tab').first().click()
      await expect(editor).toContainText('Keep this text.')
    }
    // Finish preview setup before deliberately suspending native input delivery.
    await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
    await editor.focus()
    await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/)
    await page.evaluate(() => {
      Reflect.get(window, '__saveInputHold')()
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('Missing source editor')
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text
      if (!last) throw new Error('Missing source text')
      last.appendData(' pending 世界')
      getSelection()?.collapse(last, last.length)
      content.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: ' pending 世界',
        }),
      )
    })
    const pending = await page.evaluate(() => Reflect.get(window, '__saveInputStats')())
    expect(pending.heldRecords).toBeGreaterThan(0)
    expect(pending.taken).toBe(0)
    await action({ application, page, editor, path, original })
    expect(errors).toEqual([])
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

test('Save includes pending DOM input before reporting that all changes are saved', async () => {
  await withPendingInput(async ({ application, page, editor, path, original }) => {
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('manuslip:command', 'save')
    })
    await expect(page.getByText('Saving…', { exact: true })).toBeVisible()
    expect(await readFile(path, 'utf8')).toBe(original)
    await page.evaluate(() => Reflect.get(window, '__saveInputRelease')())
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    expect(await readFile(path, 'utf8')).toBe(`${original} pending 世界`)
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
    await expect(editor).toContainText('Keep this text.')
    await expect(editor).not.toContainText('pending 世界')
  })
})

test('New document synchronizes pending input before replacing the editor and preserves undo', async () => {
  await withPendingInput(async ({ application, page, editor, path, original }) => {
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('manuslip:command', 'new')
    })
    await expect(page.getByRole('tab').first()).toBeDisabled()
    await expect(page.getByRole('tab')).toHaveCount(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    await page.evaluate(() => Reflect.get(window, '__saveInputRelease')())
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(editor).not.toContainText('Keep this text.')
    await page.getByRole('tab').first().click()
    await expect(editor).toContainText('pending 世界')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await editor.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(`${original} pending 世界`)
    await editor.press(`${modifier}+z`)
    await expect(editor).not.toContainText('pending 世界')
    await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await expect(editor).toContainText('pending 世界')
  })
})

test('tab activation waits for pending native input before unmounting its source view', async () => {
  await withPendingInput(async ({ page, editor, path, original }) => {
    const first = page.getByRole('tab').first()
    const second = page.getByRole('tab').nth(1)
    // Mutation delivery/layout are intentionally suspended here. Preserve editor focus so
    // CodeMirror's independent delayed blur update cannot consume the fixture-held records.
    await second.evaluate((button) => (button as HTMLButtonElement).click())
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(second).toHaveAttribute('aria-selected', 'false')
    expect(await readFile(path, 'utf8')).toBe(original)
    await page.evaluate(() => Reflect.get(window, '__saveInputRelease')())
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(editor).toContainText('Other tab')
    await first.click()
    await expect(editor).toContainText('pending 世界')
    await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => readFile(path, 'utf8')).toBe(`${original} pending 世界`)
  }, true)
})

for (const command of ['close-document', 'close-window'] as const) {
  test(`${command} synchronizes pending input before deciding whether to discard a clean-looking document`, async () => {
    await withPendingInput(async ({ application, page, editor, path, original }) => {
      await application.evaluate(({ dialog }) => {
        process.env.MANUSLIP_INPUT_CLOSE = '0'
        dialog.showMessageBox = async () => {
          process.env.MANUSLIP_INPUT_CLOSE = '1'
          return { response: 2, checkboxChecked: false }
        }
      })
      await application.evaluate(({ BrowserWindow }, action) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('manuslip:command', action)
      }, command)
      await expect(page.getByRole('tab').first()).toBeDisabled()
      expect(await application.evaluate(() => process.env.MANUSLIP_INPUT_CLOSE)).toBe('0')
      await page.evaluate(() => Reflect.get(window, '__saveInputRelease')())
      await expect
        .poll(() => application.evaluate(() => process.env.MANUSLIP_INPUT_CLOSE))
        .toBe('1')
      await expect(page.getByRole('tab')).toHaveCount(1)
      await expect(page.getByRole('tab').first()).toBeEnabled()
      await expect(editor).toContainText('pending 世界')
      await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${original} pending 世界`)
    })
  })
}
