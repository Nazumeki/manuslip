import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchDesktop, openMarkdownExtensions } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function fixture(
  source: string,
  run: (page: Page, application: ElectronApplication, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-input-regression-'))
  const path = join(directory, 'input.md')
  await writeFile(path, source)
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeVisible()
    await run(page, application, path)
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

async function saved(page: Page, path: string, source: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Markdown source', exact: true }).press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(source)
}

async function ime(application: ElectronApplication, method: string, text: string): Promise<void> {
  await application.evaluate(
    async ({ BrowserWindow }, { method, text }) => {
      const debug = BrowserWindow.getAllWindows()[0]?.webContents.debugger
      if (!debug) throw new Error('Missing editor window')
      if (!debug.isAttached()) debug.attach('1.3')
      await debug.sendCommand(
        method,
        method === 'Input.insertText'
          ? { text }
          : {
              text,
              selectionStart: text.length,
              selectionEnd: text.length,
            },
      )
    },
    { method, text },
  )
}

for (const mode of ['Source', 'Live Preview']) {
  test(`${mode} keeps HTML typing literal in Markdown and fenced HTML`, async () => {
    await fixture('', async (page, _application, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      for (const prefix of ['', '```html\n']) {
        await editor.fill(prefix)
        await editor.press(`${modifier}+End`)
        await page.keyboard.type('<div>text</div><br><section>')
        const source = `${prefix}<div>text</div><br><section>`
        await saved(page, path, source)
        await page.keyboard.insertText('</section>')
        await saved(page, path, `${source}</section>`)
        await editor.press(`${modifier}+z`)
        await saved(page, path, source)
      }
    })
  })
}

for (const { kind, source, selector } of [
  { kind: 'smart punctuation', source: 'Quoted "word', selector: '.cm-live-paragraph' },
  { kind: 'HTML', source: '<div>text', selector: '.cm-live-html' },
  { kind: 'table', source: '| A |\n| --- |\n| B |', selector: '.cm-live-table' },
  {
    kind: 'footnote',
    source: 'Call[^n].\n\n[^n]: original',
    selector: '.cm-live-footnoteDefinition',
  },
]) {
  test(`keyboard boundaries preserve first input, delete, paste and IME in projected ${kind}`, async () => {
    await fixture(source, async (page, application, path) => {
      if (kind === 'HTML') {
        const extensions = await openMarkdownExtensions(page)
        await extensions.getByLabel('Render sanitized HTML', { exact: true }).check()
        await page.keyboard.press('Escape')
      }
      await expect(page.locator(`${selector}:not(.cm-live-edit-preview)`).first()).toBeVisible()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.focus()
      await editor.press(`${modifier}+End`)
      await page.keyboard.type('Q')
      await saved(page, path, `${source}Q`)
      await editor.press(`${modifier}+z`)
      await saved(page, path, source)
      await editor.press('Backspace')
      await saved(page, path, source.slice(0, -1))
      await editor.press(`${modifier}+z`)
      await saved(page, path, source)
      await application.evaluate(async ({ clipboard, ClipboardItem }) => {
        await clipboard.write([new ClipboardItem({ 'text/plain': new Blob([' pasted']) })])
      })
      await editor.press(`${modifier}+v`)
      await saved(page, path, `${source} pasted`)
      await editor.press(`${modifier}+z`)
      await saved(page, path, source)
      await ime(application, 'Input.imeSetComposition', 'shi')
      await ime(application, 'Input.imeSetComposition', '世界')
      await ime(application, 'Input.insertText', '世界')
      await saved(page, path, `${source}世界`)
      await editor.press(`${modifier}+z`)
      await saved(page, path, source)
      await editor.press(`${modifier}+Home`)
      await page.keyboard.type('Z')
      await saved(page, path, `Z${source}`)
      const metadata = await page.evaluate(() =>
        performance
          .getEntriesByName('manuslip:input-accepted')
          .map((entry) => (entry as PerformanceMeasure).detail),
      )
      expect(
        metadata.some(
          (entry) => entry.inserted === 1 && entry.headBefore === 0 && entry.headAfter === 1,
        ),
      ).toBe(true)
    })
  })
}

test('hidden Source outline releases semantics and refreshes when shown', async () => {
  await fixture('# Original\n\nBody', async (page, _application, path) => {
    await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.locator('#workspace-outline')).toBeHidden()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await page.evaluate(() => performance.clearMeasures('manuslip:semantic-apply'))
    await editor.press(`${modifier}+End`)
    await page.keyboard.type('\n\n## Added while hidden')
    await saved(page, path, '# Original\n\nBody\n\n## Added while hidden')
    // Beyond the semantic debounce, no hidden consumer should request/apply output.
    await page.waitForTimeout(350)
    expect(
      await page.evaluate(() => performance.getEntriesByName('manuslip:semantic-apply').length),
    ).toBe(0)
    await page.getByRole('button', { name: /Document details/ }).click()
    const details = page.getByRole('group', { name: 'Document details', exact: true })
    await expect(details.locator('.document-statistics')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('[aria-controls="workspace-sidebar workspace-outline"]').click()
    await expect(
      page
        .locator('#workspace-outline')
        .getByRole('button', { name: 'Added while hidden', exact: true }),
    ).toBeEnabled()
  })
})

test('an oversized legacy cell can shrink and undo restores the accepted parent source', async () => {
  const value = 'x'.repeat(4100)
  const source = `| Header |\n| --- |\n| ${value} |`
  await fixture(source, async (page, _application, path) => {
    const cell = page.locator('.cm-live-table td').first()
    await cell.click({ position: { x: 8, y: 8 } })
    const editor = page.locator('[data-table-cell-editor]')
    await expect(editor).toBeFocused()
    await editor.press(`${modifier}+End`)
    await editor.press('Backspace')
    await editor.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace(value, value.slice(0, -1)))
    await editor.press(`${modifier}+z`)
    await editor.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(source)
    await expect(editor).toHaveText(value)
  })
})

for (const action of ['destination', 'removed', 'superseded'] as const) {
  test(`a pending reference-link activation uses current output: ${action}`, async () => {
    const source = '[shown][id]\n\n[id]: https://example.com/base'
    await fixture(source, async (page, application, path) => {
      const link = page.locator('.cm-content a[href="https://example.com/base"]').first()
      await expect(link).toBeVisible()
      await application.evaluate(({ shell }) => {
        const urls: string[] = []
        Reflect.set(globalThis, '__inputLinkDestinations', urls)
        shell.openExternal = async (url) => {
          urls.push(url)
        }
      })
      const worker = page.workers().find((worker) => worker.url().includes('semantic.worker'))
      if (!worker) throw new Error('Missing semantic worker')
      await worker.evaluate(() => {
        const receive = self.onmessage
        if (!receive) throw new Error('Missing semantic handler')
        const held: MessageEvent[] = []
        self.onmessage = (event) => {
          held.push(event)
        }
        Reflect.set(self, '__heldInputRequests', held)
        Reflect.set(self, '__releaseInputRequests', () => {
          self.onmessage = receive
          for (const event of held.splice(0)) receive.call(self, event)
        })
      })
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.focus()
      await editor.press(`${modifier}+End`)
      if (action === 'removed') {
        await editor.press('Shift+Home')
        await editor.press('Backspace')
      } else await page.keyboard.insertText('/new')
      await expect
        .poll(() => worker.evaluate(() => Reflect.get(self, '__heldInputRequests').length))
        .toBe(1)
      await expect(link).toBeVisible()
      await link.evaluate((element) =>
        element.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        ),
      )
      // Wait until the click has entered its revision capture, while parsing is held.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      expect(
        await application.evaluate(() => Reflect.get(globalThis, '__inputLinkDestinations')),
      ).toEqual([])
      if (action === 'superseded') await page.keyboard.insertText('/later')
      await worker.evaluate(() => Reflect.get(self, '__releaseInputRequests')())
      if (action === 'destination') {
        await expect
          .poll(() =>
            application.evaluate(() => Reflect.get(globalThis, '__inputLinkDestinations')),
          )
          .toEqual(['https://example.com/base/new'])
      } else {
        await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
        await expect
          .poll(() =>
            page.evaluate(() => performance.getEntriesByName('manuslip:linked-input').length),
          )
          .toBe(1)
        expect(
          await application.evaluate(() => Reflect.get(globalThis, '__inputLinkDestinations')),
        ).toEqual([])
      }
      await saved(
        page,
        path,
        action === 'removed'
          ? '[shown][id]\n\n'
          : `${source}/new${action === 'superseded' ? '/later' : ''}`,
      )
    })
  })
}
