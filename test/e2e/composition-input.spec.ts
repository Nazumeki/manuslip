import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'
import { attachInput, observeInput } from './input-provenance'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const original = '# Original\n\nKeep this text. '
const committed = `${original}世界`

interface Composition {
  application: ElectronApplication
  page: Page
  editor: Locator
  path: string
  directory: string
  command(action: string): Promise<void>
  finish(): Promise<void>
}

async function withComposition(
  action: (composition: Composition) => Promise<void>,
  anotherTab = false,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-composition-'))
  const path = join(directory, 'composition.md')
  await writeFile(path, original)
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await observeInput(page)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toContainText('Keep this text.')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const command = async (action: string): Promise<void> => {
      await application.evaluate(({ BrowserWindow }, command) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('manuslip:command', command)
      }, action)
    }
    if (anotherTab) {
      await command('new')
      await expect(page.getByRole('tab')).toHaveCount(2)
      await expect(editor).not.toContainText('Keep this text.')
      await editor.fill('Second document')
      await page.getByRole('tab').first().click()
      await expect(editor).toContainText('Keep this text.')
    }
    await editor.focus()
    await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/)
    await page.keyboard.press(`${modifier}+End`)
    await page.evaluate(() => {
      const events: { type: string; text: string; trusted: boolean }[] = []
      Reflect.set(window, '__compositionInputEvents', events)
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
        document.addEventListener(
          type,
          (event) => {
            if (!(event.target instanceof Element) || !event.target.closest('.cm-content')) return
            events.push({
              type,
              text: (event as CompositionEvent).data,
              trusted: event.isTrusted,
            })
          },
          true,
        )
      }
    })
    const ime = async (method: string, params: Record<string, unknown>): Promise<void> => {
      await application.evaluate(
        async ({ BrowserWindow }, { method, params }) => {
          const debug = BrowserWindow.getAllWindows()[0]?.webContents.debugger
          if (!debug) throw new Error('Missing source window')
          if (!debug.isAttached()) debug.attach('1.3')
          await debug.sendCommand(method, params)
        },
        { method, params },
      )
    }
    await ime('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 })
    await expect(editor).toContainText('shi')
    expect(
      await page.evaluate(() => Reflect.get(window, '__compositionInputEvents')),
    ).toContainEqual({ type: 'compositionstart', text: '', trusted: true })
    const finish = async (): Promise<void> => {
      await ime('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
      await ime('Input.insertText', { text: '世界' })
    }
    try {
      await action({ application, page, editor, path, directory, command, finish })
      expect(errors).toEqual([])
      const events = (await page.evaluate(() =>
        Reflect.get(window, '__compositionInputEvents'),
      )) as {
        type: string
        text: string
        trusted: boolean
      }[]
      // Input.insertText can end a debugger-driven composition with isTrusted=false.
      // Keep that provenance in the attachment; require one final commit with exact text.
      expect(
        events
          .filter((event) => event.type === 'compositionend')
          .map(({ type, text }) => ({ type, text })),
      ).toEqual([{ type: 'compositionend', text: '世界' }])
    } finally {
      await attachInput(page, test.info())
      const events = await page
        .evaluate(() => Reflect.get(window, '__compositionInputEvents'))
        .catch(() => null)
      await test.info().attach('native-composition-events', {
        body: JSON.stringify({ events, errors }),
        contentType: 'application/json',
      })
    }
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

/** Let native layout callbacks run while keeping the browser composition open. */
async function pendingFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0
        const frame = () => {
          if (++frames === 12) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
  )
}

async function save(page: Page, path: string, expected = committed): Promise<void> {
  await page.getByRole('textbox', { name: 'Markdown source' }).press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(expected)
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
}

test('New waits for active native composition and preserves its final text and undo history', async () => {
  await withComposition(async ({ page, editor, path, command, finish }) => {
    await command('new')
    await pendingFrames(page)
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect(editor).toBeFocused()
    expect(await readFile(path, 'utf8')).toBe(original)
    await finish()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(editor).not.toContainText('Keep this text.')
    await page.getByRole('tab').first().click()
    await save(page, path)
    await editor.press(`${modifier}+z`)
    await save(page, path, original)
    await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await save(page, path)
  })
})

test('Save waits for the final native composition before acknowledging saved content', async () => {
  await withComposition(async ({ page, editor, path, command, finish }) => {
    await command('save')
    await pendingFrames(page)
    await expect(page.getByText('Saving…', { exact: true })).toBeVisible()
    await expect(editor).toBeFocused()
    expect(await readFile(path, 'utf8')).toBe(original)
    await finish()
    await expect.poll(() => readFile(path, 'utf8')).toBe(committed)
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    await editor.press(`${modifier}+z`)
    await save(page, path, original)
  })
})

test('Save As defers its native dialog until composition finishes and keeps the original file', async () => {
  await withComposition(async ({ application, page, path, directory, command, finish }) => {
    const target = join(directory, 'saved-as.md')
    await application.evaluate(({ dialog }, target) => {
      process.env.MANUSLIP_COMPOSITION_DIALOG = '0'
      dialog.showSaveDialog = async () => {
        process.env.MANUSLIP_COMPOSITION_DIALOG = '1'
        return { canceled: false, filePath: target }
      }
    }, target)
    await command('save-as')
    await pendingFrames(page)
    expect(await application.evaluate(() => process.env.MANUSLIP_COMPOSITION_DIALOG)).toBe('0')
    await finish()
    await expect(page.getByRole('tab', { name: 'saved-as.md', exact: true })).toBeVisible()
    expect(await readFile(target, 'utf8')).toBe(committed)
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})

test('a tab activation request keeps native composition in its original document', async () => {
  await withComposition(async ({ page, editor, path, finish }) => {
    const first = page.getByRole('tab').first()
    await expect(first).toContainText('composition.md')
    const second = page.getByRole('tab').nth(1)
    // Request activation without blurring/committing the native IME on pointerdown.
    await second.evaluate((element) => (element as HTMLButtonElement).click())
    await pendingFrames(page)
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(editor).toBeFocused()
    await finish()
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(editor).toHaveText('Second document')
    await first.click()
    await save(page, path)
  }, true)
})

for (const command of ['close-document', 'close-window'] as const) {
  test(`${command} waits for composition before a cancellable close decision`, async () => {
    await withComposition(async ({ application, page, editor, path, command: send, finish }) => {
      await application.evaluate(({ dialog }) => {
        process.env.MANUSLIP_COMPOSITION_CLOSE = '0'
        dialog.showMessageBox = async () => {
          process.env.MANUSLIP_COMPOSITION_CLOSE = '1'
          return { response: 2, checkboxChecked: false }
        }
      })
      await send(command)
      await pendingFrames(page)
      expect(await application.evaluate(() => process.env.MANUSLIP_COMPOSITION_CLOSE)).toBe('0')
      await expect(editor).toHaveAttribute('contenteditable', 'true')
      await finish()
      await expect
        .poll(() => application.evaluate(() => process.env.MANUSLIP_COMPOSITION_CLOSE))
        .toBe('1')
      await expect(page.getByRole('tab')).toHaveCount(1)
      await expect(page.getByRole('tab').first()).toBeEnabled()
      await expect(editor).toContainText('世界')
      await save(page, path)
    })
  })
}
