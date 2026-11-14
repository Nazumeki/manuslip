import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'
import { attachInput, observeInput } from './input-provenance'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const original = '# Original\n\nKeep this text. '

interface Source {
  application: ElectronApplication
  page: Page
  editor: Locator
  path: string
}

async function withSource(
  action: (source: Source) => Promise<void>,
  holdInput = false,
): Promise<void> {
  await mkdir('test/e2e/result', { recursive: true })
  const directory = await mkdtemp(resolve('test/e2e/result/mode-input-'))
  const path = join(directory, 'mode-input.md')
  await writeFile(path, original)
  const application = await launchDesktop(join(directory, 'profile'), holdInput ? [] : [path])
  const page = await application.firstWindow()
  try {
    await observeInput(page)
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    if (holdInput) {
      const open = page.getByRole('button', { name: 'Open file…', exact: true }).first()
      await expect(open).toBeVisible()
      await installPendingInput(page)
      await application.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, path)
      await open.click()
    }
    await expect(editor).toContainText('Keep this text.')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await editor.focus()
    await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/)
    await page.keyboard.press(`${modifier}+End`)
    await frames(page)
    await action({ application, page, editor, path })
    expect(errors).toEqual([])
  } finally {
    await attachInput(page, test.info())
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
  }
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let count = 0
        const frame = () => {
          if (++count === 3) resolve()
          else requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      }),
  )
}

async function composition({ application, page, editor }: Source): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const events: { type: string; text: string; trusted: boolean }[] = []
    Reflect.set(window, '__modeComposition', events)
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend'])
      document.addEventListener(
        type,
        (event) =>
          events.push({ type, text: (event as CompositionEvent).data, trusted: event.isTrusted }),
        true,
      )
  })
  const ime = async (method: string, params: Record<string, unknown>): Promise<void> => {
    await application.evaluate(
      async ({ BrowserWindow }, { method, params }) => {
        const debug = BrowserWindow.getAllWindows()[0]?.webContents.debugger
        if (!debug) throw new Error('Missing editor window')
        if (!debug.isAttached()) debug.attach('1.3')
        await debug.sendCommand(method, params)
      },
      { method, params },
    )
  }
  await ime('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 })
  await expect(editor).toContainText('shi')
  return async () => {
    await ime('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
    await ime('Input.insertText', { text: '世界' })
    const events = (await page.evaluate(() => Reflect.get(window, '__modeComposition'))) as {
      type: string
      text: string
      trusted: boolean
    }[]
    await test.info().attach('mode-composition', {
      body: JSON.stringify(events),
      contentType: 'application/json',
    })
    expect(events).toContainEqual({ type: 'compositionstart', text: '', trusted: true })
    expect(events).toContainEqual({ type: 'compositionupdate', text: '世界', trusted: true })
    expect(
      events.filter((event) => event.type === 'compositionend').map((event) => event.text),
    ).toEqual(['世界'])
  }
}

async function save({ page, path }: Source, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Markdown source' }).press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(text)
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
}

test('translated-preview shortcut finishes native composition before hiding source and retains keyboard context', async () => {
  await withSource(async (source) => {
    const { page, editor } = source
    const finish = await composition(source)
    await editor.press(`${modifier}+3`)
    await frames(page)
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await finish()
    const translated = page.getByRole('button', { name: 'Translated preview', exact: true })
    await expect(translated).toHaveAttribute('aria-pressed', 'true')
    await expect(translated).toBeFocused()
    await page.keyboard.press('Tab')
    // The mode controls share the application toolbar, followed by Save.
    const saveButton = page.getByRole('button', { name: 'Save', exact: true })
    await expect(saveButton).toBeFocused()
    await saveButton.press(`${modifier}+1`)
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(editor).toBeFocused()
    await save(source, `${original}世界`)
    await editor.press(`${modifier}+z`)
    await save(source, original)
    await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await save(source, `${original}世界`)
  })
})

test('a translated-preview button request preserves an active composition', async () => {
  await withSource(async (source) => {
    const { page, editor } = source
    const finish = await composition(source)
    const translated = page.getByRole('button', { name: 'Translated preview', exact: true })
    // Assistive or programmatic activation can invoke the action without pointer blur.
    await translated.evaluate((element) => (element as HTMLButtonElement).click())
    await frames(page)
    await expect(editor).toBeVisible()
    await finish()
    await expect(translated).toHaveAttribute('aria-pressed', 'true')
    await expect(translated).toBeFocused()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(editor).toBeFocused()
    await save(source, `${original}世界`)
  })
})

test('rapid mode shortcuts apply only the latest request after composition', async () => {
  await withSource(async (source) => {
    const { page, editor } = source
    const finish = await composition(source)
    for (const key of ['3', '2', '1']) await editor.press(`${modifier}+${key}`)
    await expect(editor).toBeVisible()
    await finish()
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(editor).toBeFocused()
    await save(source, `${original}世界`)
  })
})

async function installPendingInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    let holding = false
    const queuedFrames: FrameRequestCallback[] = []
    let held = 0
    const frame = requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) =>
      frame((time) => (holding ? queuedFrames.push(callback) : callback(time)))
    document.addEventListener(
      'selectionchange',
      (event) => {
        if (holding) event.stopImmediatePropagation()
      },
      true,
    )
    const NativeObserver = MutationObserver
    window.MutationObserver = class extends NativeObserver {
      constructor(callback: MutationCallback) {
        const retained: MutationRecord[] = []
        super((records, observer) => {
          if (
            holding &&
            records.some((record) =>
              (record.target instanceof Element
                ? record.target
                : record.target.parentElement
              )?.closest('.cm-content'),
            )
          ) {
            retained.push(...records)
            held += records.length
          } else callback(records, observer)
        })
        const take = this.takeRecords.bind(this)
        this.takeRecords = () => retained.splice(0).concat(take())
      }
    }
    Reflect.set(window, '__modeHeldInput', () => held)
    Reflect.set(window, '__modeHoldInput', () => {
      holding = true
      held = 0
    })
    Reflect.set(window, '__modeReleaseInput', () => {
      holding = false
      for (const callback of queuedFrames.splice(0)) frame(callback)
    })
  })
}

async function pendingInput(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    Reflect.get(window, '__modeHoldInput')()
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('Missing source')
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text
    if (!last) throw new Error('Missing text')
    last.appendData('pending 世界')
    getSelection()?.collapse(last, last.length)
    content.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: 'pending 世界', bubbles: true }),
    )
  })
  expect(await page.evaluate(() => Reflect.get(window, '__modeHeldInput')())).toBeGreaterThan(0)
  return () => page.evaluate(() => Reflect.get(window, '__modeReleaseInput')())
}

test('mode switching consumes pending DOM input before the source view becomes hidden', async () => {
  await withSource(async (source) => {
    const { page, editor } = source
    const release = await pendingInput(page)
    await editor.press(`${modifier}+3`)
    await expect(editor).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Translated preview', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false')
    await release()
    await expect(
      page.getByRole('button', { name: 'Translated preview', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await save(source, `${original}pending 世界`)
  }, true)
})

test('completing a pending mode change preserves later Preferences focus', async () => {
  await withSource(async (source) => {
    const { page, editor } = source
    const release = await pendingInput(page)
    await editor.press(`${modifier}+3`)
    await expect(editor).toBeVisible()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const theme = page.getByRole('combobox', { name: 'Appearance', exact: true })
    await theme.focus()
    await release()
    await expect(
      page.getByRole('button', { name: 'Translated preview', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(theme).toBeFocused()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await save(source, `${original}pending 世界`)
  }, true)
})
