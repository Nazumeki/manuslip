import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function fixture(
  source: string,
  run: (page: Page, app: ElectronApplication, path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reference-'))
  const path = join(directory, 'input.md')
  await writeFile(path, source)
  const app = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible()
    await run(page, app, path)
    expect(errors).toEqual([])
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function saved(page: Page, path: string, source: string) {
  // Preserve whichever native editor owns focus, including a table child.
  await page.keyboard.press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(source)
}

for (const mode of ['Source', 'Live Preview']) {
  test(`${mode} follows Zed pairing, selected surrounds, skipping and pair deletion`, async () => {
    await fixture('', async (page, _app, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.focus()
      await page.keyboard.type('(')
      await saved(page, path, '()')
      await page.keyboard.press('Backspace')
      await saved(page, path, '')
      await page.keyboard.type('([x])')
      await saved(page, path, '([x])')
      const actions = await page.evaluate(() =>
        performance
          .getEntriesByName('manuslip:punctuation-input')
          .map((entry) => (entry as PerformanceMeasure).detail),
      )
      expect(actions.filter((action) => action.skipped > 0)).toHaveLength(2)
      await editor.fill('word')
      await editor.press(`${modifier}+a`)
      await page.keyboard.type('*')
      await saved(page, path, '*word*')
      // Surrounding keeps the original content selected for a second marker.
      await page.keyboard.type('*')
      await saved(page, path, '**word**')
      await editor.fill('()')
      await editor.press(`${modifier}+Home`)
      await editor.press('ArrowRight')
      await page.keyboard.type(')')
      await saved(page, path, '())')
      await editor.fill('')
      await page.keyboard.type('"\'`*~_^=$')
      await saved(page, path, '"\'`*~_^=$')
      await editor.fill('')
      await page.keyboard.type('{')
      await page.keyboard.press('Enter')
      await page.keyboard.type('body')
      await saved(page, path, '{\n  body\n}')
    })
  })

  test(`${mode} preserves IME punctuation and continues an existing Markdown list`, async () => {
    await fixture('', async (page, app, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.focus()
      await app.evaluate(async ({ BrowserWindow }) => {
        const debug = BrowserWindow.getAllWindows()[0]?.webContents.debugger
        if (!debug) throw new Error('Missing editor window')
        if (!debug.isAttached()) debug.attach('1.3')
        await debug.sendCommand('Input.imeSetComposition', {
          text: '(',
          selectionStart: 1,
          selectionEnd: 1,
        })
        await debug.sendCommand('Input.insertText', { text: '(' })
      })
      await saved(page, path, '(')
      await editor.fill('- item')
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Enter')
      await page.keyboard.type('next')
      await saved(page, path, '- item\n- next')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await saved(page, path, '- item\n- next\n')
    })
  })
}

test('one-line metadata openers accept all source without a DOM/state divergence', async () => {
  await fixture('', async (page, _app, path) => {
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.focus()
    await page.keyboard.type('+++')
    await saved(page, path, '+++')
    await page.keyboard.press('Enter')
    await page.keyboard.type('title = "A"')
    await page.keyboard.press('Enter')
    await page.keyboard.type('+++')
    await saved(page, path, '+++\ntitle = "A"\n+++')
  })
})

test('Live fence entry is atomic and never duplicates a closing fence', async () => {
  await fixture('', async (page, _app, path) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.focus()
    await page.keyboard.type('```js')
    await page.keyboard.press('Enter')
    await saved(page, path, '```js\n\n```')
    await page.keyboard.type('value')
    await saved(page, path, '```js\nvalue\n```')
    await editor.press(`${modifier}+End`)
    await page.keyboard.press('Enter')
    await saved(page, path, '```js\nvalue\n```\n')
  })
})

test('table Shift+Enter, last-cell Tab and Mod+Enter use canonical undoable source', async () => {
  const source = '| A | B |\n| -- | -- |\n| x | y |'
  await fixture(source, async (page, _app, path) => {
    await page.locator('.cm-live-table td').first().click()
    const child = page.locator('[data-table-cell-editor]')
    await expect(child).toBeFocused()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('y')
    await page.keyboard.type('y')
    await saved(page, path, source)
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('z')
    const multiline = source.replace('y |', 'y<br />z |')
    await saved(page, path, multiline)
    await page.keyboard.press('Tab')
    await expect(child).toBeFocused()
    await saved(page, path, `${multiline}\n|  |  |`)
    await page.keyboard.type('new')
    await saved(page, path, `${multiline}\n| new |  |`)
    await page.keyboard.press(`${modifier}+Enter`)
    await saved(page, path, `${multiline}\n| new |  |\n|  |  |`)
    await page.keyboard.press(`${modifier}+z`)
    await saved(page, path, `${multiline}\n| new |  |`)
    await page.keyboard.press('Escape')
    await expect(page.locator('.cm-live-table td br')).toHaveCount(1)
  })
})

test('Mod+Enter finishes a math body at its end without changing TeX source', async () => {
  const source = '$$\nx\n$$'
  await fixture(source, async (page, _app, path) => {
    await page.locator('.cm-live-math:not(.cm-live-edit-preview)').click()
    await page.keyboard.press('End')
    await page.keyboard.press(`${modifier}+Enter`)
    await page.keyboard.type('After')
    await saved(page, path, `${source}\n\nAfter`)
  })
})
