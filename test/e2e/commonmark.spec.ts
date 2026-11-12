import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { clickDocumentAction, launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function withDocument(
  source: string,
  run: (
    page: Page,
    application: ElectronApplication,
    path: string,
    directory: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(resolve('test/e2e/result/commonmark-'))
  if (!directory.startsWith(resolve('test/e2e/result') + sep))
    throw new Error('Unsafe fixture path')
  const path = join(directory, 'commonmark.md')
  await writeFile(path, source)
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await run(page, application, path, directory)
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

test('CommonMark code blocks render with exact literal content and optional highlighting', async () => {
  await withDocument('    first\n', async (page) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    const cases = [
      {
        source: '    <tag> &amp; **literal**\n      indented\tend',
        text: '<tag> &amp; **literal**\n  indented\tend\n',
      },
      { source: '\tTabbed\n\t\tinner', text: 'Tabbed\n\tinner\n' },
      {
        source: '  ```js extra metadata\n  const answer = 42\n  ```   ',
        text: 'const answer = 42\n',
        language: 'js',
      },
      {
        source: ' ~~~~unknown extra metadata\n literal `code` &amp;\n ~~~~',
        text: 'literal `code` &amp;\n',
        language: 'unknown',
      },
      {
        source: '   ```\n   unfinished <tag> **literal**',
        text: 'unfinished <tag> **literal**\n',
        unfinished: true,
      },
      { source: '```\n```', text: '' },
      { source: '    first\n\n    second\n\n', text: 'first\n\nsecond\n' },
      {
        source: '  > ```js\n  > const quoted = 1\n  > ```',
        text: 'const quoted = 1\n',
        language: 'js',
      },
      {
        source: '  - Item\n\n    ```js\n    const nested = 2\n    ```',
        text: 'const nested = 2\n',
        language: 'js',
      },
    ]
    for (const [index, example] of cases.entries()) {
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await editor.fill(example.source)
      await editor.press(`${modifier}+End`)
      await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
      const code = editor.locator('pre > code')
      if (example.unfinished) {
        await expect(code).toHaveCount(0)
        await expect(editor).toContainText('unfinished <tag> **literal**')
        continue
      }
      await expect(code).toHaveCount(1)
      if (index === 0) await page.screenshot({ path: test.info().outputPath('indented-code.png') })
      expect(await code.textContent()).toBe(example.text)
      if (example.language) await expect(code).toHaveClass(`language-${example.language}`)
      if (example.language === 'js')
        await expect(code.locator('[class*="tok-"]').first()).toBeVisible()
      await expect(editor.locator('tag, strong')).toHaveCount(0)
      if (index === 2) {
        await code.click()
        expect(await page.evaluate(() => getSelection()?.toString())).toBe('')
        await expect(editor.locator('.cm-live-edit-source').first()).toContainText('```js')
        await editor.press('Escape')
        await expect(code).toHaveCount(1)
      }
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect
        .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(example.source)
    }
    await editor.fill(cases[0]?.source ?? '')
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await page.setViewportSize({ width: 420, height: 900 })
    await expect(editor.locator('pre > code')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('indented-code-narrow.png') })
  })
})

test('indented code source can be selected, edited, undone, saved and exported without losing indentation', async () => {
  const source =
    '    const message = "<tag> &amp; **literal**";\r\n      indented\tend\r\n\r\nTail\r\n'
  await withDocument(source, async (page, application, path, directory) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(editor.locator('pre > code')).toHaveCount(1)
    await editor.locator('pre > code').click()
    const selected = await page.evaluate(() => getSelection()?.toString())
    expect(selected).toBe('')
    await expect(editor.locator('.cm-live-edit-source').first()).toContainText(
      'const message = "<tag> &amp; **literal**";',
    )
    await expect(editor.locator('pre > code')).toHaveCount(0)
    await editor.press('Escape')
    await expect(editor.locator('pre > code')).toHaveCount(1)
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await editor.press(`${modifier}+Home`)
    await page.keyboard.insertText('    added\n')
    await page.keyboard.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(`    added\r\n${source}`)
    await editor.press(`${modifier}+z`)
    await page.keyboard.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(source)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(editor.locator('pre > code')).toHaveText(
      'const message = "<tag> &amp; **literal**";\n  indented\tend\n',
    )
    const target = join(directory, 'commonmark.html')
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, target)
    await clickDocumentAction(page, 'Export HTML…')
    await expect.poll(() => readFile(target, 'utf8').catch(() => '')).toContain('<pre><code>')
    const html = await readFile(target, 'utf8')
    expect(html).toContain('&lt;tag&gt; &amp;amp; **literal**')
    expect(html).toContain('  indented\tend\n</code></pre>')
    expect(html).not.toContain('<tag>')
    expect(await readFile(path, 'utf8')).toBe(source)
  })
})

test('ordered lists use CommonMark numbering and retain their original source markers', async () => {
  const source =
    '3. first\n1. second\n9. third\n\n0) zero\n0) one\n\n- Outer\n\n  7. nested\n  1. next\n\nTail'
  await withDocument(source, async (page, application, path, directory) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const lists = editor.locator('.cm-live-list')
    await expect(lists).toHaveCount(3)
    await expect(lists.nth(0).locator('ol')).toHaveAttribute('start', '3')
    await expect(lists.nth(0).locator('li')).toHaveText(['first', 'second', 'third'])
    await expect(lists.nth(1).locator('ol')).toHaveAttribute('start', '0')
    await expect(lists.nth(1).locator('li')).toHaveText(['zero', 'one'])
    await expect(lists.nth(2).locator('ul > li > ol')).toHaveAttribute('start', '7')
    await expect(lists.nth(2).locator('ol > li')).toHaveText(['nested', 'next'])
    await page.screenshot({ path: test.info().outputPath('ordered-lists.png') })
    const target = join(directory, 'lists.html')
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, target)
    await clickDocumentAction(page, 'Export HTML…')
    await expect.poll(() => readFile(target, 'utf8').catch(() => '')).toContain('<ol start="3">')
    const html = await readFile(target, 'utf8')
    expect(html).toContain('<ol start="0">')
    expect(html).toContain('<ol start="7">')
    expect(await readFile(path, 'utf8')).toBe(source)
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect
      .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
      .toBe(source)
  })
})
