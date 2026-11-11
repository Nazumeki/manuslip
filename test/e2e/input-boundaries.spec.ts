import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'
import { attachInput, observeInput } from './input-provenance'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function fixture(
  source: string,
  run: (page: Page, app: ElectronApplication, path: string) => Promise<void>,
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manuslip-boundary-review-')))
  const path = join(directory, 'input.md')
  await writeFile(path, source)
  const app = await launchDesktop(join(directory, 'profile'), [path])
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible()
    await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
    await observeInput(page)
    await run(page, app, path)
    expect(errors).toEqual([])
  } finally {
    await attachInput(page, test.info())
    await test
      .info()
      .attach('saved-source', { body: await readFile(path), contentType: 'text/plain' })
    await test
      .info()
      .attach('page-errors', { body: JSON.stringify(errors), contentType: 'application/json' })
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function saved(page: Page, path: string, expected: string) {
  await page.keyboard.press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(expected)
}

for (const source of ['<div>\n```js', '<!--\n~~~']) {
  test(`Enter remains literal in HTML context ${JSON.stringify(source)}`, async () => {
    await fixture(source, async (page, _app, path) => {
      if (source.startsWith('<!--'))
        await page.getByRole('button', { name: 'Source', exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Enter')
      await saved(page, path, `${source}\n`)
    })
  })
}

test('a closing fence at the end of a large document does not become another opener', async () => {
  const source = `${'Paragraph **text**.\n\n'.repeat(10000)}\`\`\`js\ntext\n\`\`\``
  await fixture(source, async (page, _app, path) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.press(`${modifier}+End`)
    await page.keyboard.press('Enter')
    await saved(page, path, `${source}\n`)
  })
})

for (const source of ['````\ntext\n```', '```\ntext\n~~~']) {
  test(`Mod+Enter keeps invalid closer inside the code body ${JSON.stringify(source)}`, async () => {
    await fixture(source, async (page, _app, path) => {
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+Home`)
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('End')
      await page.keyboard.press(`${modifier}+Enter`)
      await page.keyboard.type('After')
      await saved(page, path, source.replace('\ntext\n', '\ntext\nAfter\n'))
    })
  })
}

test('Shift+Enter renders a line break inside a strong table cell with HTML disabled', async () => {
  const source = '| Header |\n| -- |\n| **ab** |'
  await fixture(source, async (page, _app, path) => {
    await page.locator('.cm-live-table td').first().click()
    const child = page.locator('[data-table-cell-editor]')
    await expect(child).toBeFocused()
    await page.keyboard.press('Home')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+Enter')
    await saved(page, path, source.replace('**ab**', '**a<br />b**'))
    await page.keyboard.press('Escape')
    await expect(page.locator('.cm-live-table td strong br')).toHaveCount(1)
  })
})

test('one undo reverts selected-cell deletion and row creation from one Mod+Enter', async () => {
  const source = '| A | B |\n| -- | -- |\n| x | y |'
  await fixture(source, async (page, _app, path) => {
    await page.locator('.cm-live-table td').first().click()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('y')
    await page.keyboard.press(`${modifier}+Enter`)
    await saved(page, path, `${source.replace(' y |', '  |')}\n|  |  |`)
    await page.keyboard.press(`${modifier}+z`)
    await saved(page, path, source)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await saved(page, path, `${source.replace(' y |', '  |')}\n|  |  |`)
  })
})

test('a refused row insertion preserves the selected cell at the 200-row limit', async () => {
  const source = `| A | B |\n| -- | -- |\n${Array.from({ length: 199 }, () => '| x | y |').join('\n')}`
  await fixture(source, async (page, _app, path) => {
    await page.locator('.cm-live-table td').first().click()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('y')
    await page.keyboard.press(`${modifier}+Enter`)
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${modifier}+s`)
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    expect(await readFile(path, 'utf8')).toBe(source)
  })
})
