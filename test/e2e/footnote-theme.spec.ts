import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { clickDocumentAction, contrast, launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

const source = `# Notes and references

Good references stay close to the text.[^origin] A second citation[^detail] and a return to the original.[^origin]

Read the [field guide][guide] or the [research notes][research]. An inline note^[Inline notes share the same quiet typography.] completes the paragraph.

[^detail]: A longer note with **emphasis**, a [reference link][guide] and a second paragraph.

    Additional context stays aligned with its number, even when it wraps onto another line.

[^origin]: The original source, kept in its authored position.

[guide]: https://example.invalid/field-guide "Field guide"
[research]:
    https://example.invalid/a-long-reference-path/with-many-details/and-a-final-section
    "Research notes"

脚注与引用。中文注释[^origin]、العربية[^detail]。
`

for (const theme of ['light', 'dark'] as const) {
  test(`footnotes and references stay readable and editable in ${theme}`, async () => {
    const directory = await mkdtemp(resolve('test/e2e/result/footnote-theme-'))
    const profile = join(directory, 'profile')
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({ schemaVersion: 1, theme, locale: 'en' }),
    )
    const path = join(directory, 'notes.md')
    await writeFile(path, source)
    const application = await launchDesktop(profile, [path])
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.setViewportSize({ width: 1100, height: 1100 })
      const editor = page.getByRole('textbox', { name: 'Markdown source' })
      const references = editor.locator('a[data-footnote-ref]')
      await expect(references).toHaveCount(6)
      await expect(references.first()).toHaveAccessibleName('Footnotes 1')
      await expect(editor.locator('.cm-live-reference-label')).toHaveText(['[guide]', '[research]'])
      await expect(editor.locator('.cm-live-reference-url')).toHaveCount(2)
      const numbers = editor.locator('.markdown-footnote-list')
      await expect(numbers).toHaveCount(3)
      await expect(numbers.nth(0)).toHaveAttribute('start', '2')
      await expect(numbers.nth(1)).toHaveAttribute('start', '1')
      await expect(numbers.nth(2)).toHaveAttribute('start', '3')
      await expect(editor.locator('a[data-footnote-backref] .markdown-icon-backref')).toHaveCount(6)
      const styles = await references.first().evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          foreground: style.color,
          background: style.backgroundColor,
          underline: style.textDecorationLine,
        }
      })
      expect(contrast(styles.foreground, styles.background)).toBeGreaterThanOrEqual(4.5)
      expect(styles.underline).toBe('none')
      await references.first().focus()
      await references.first().press('Enter')
      const origin = editor
        .locator('.markdown-footnote-list li')
        .filter({ hasText: 'The original source' })
      await expect(origin).toBeFocused()
      await origin.locator('a[data-footnote-backref]').first().click()
      await expect(references.first()).toBeFocused()
      const iconPositions = await origin
        .locator('.markdown-icon-backref')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y))
      expect(Math.max(...iconPositions) - Math.min(...iconPositions)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: test.info().outputPath(`notes-${theme}.png`) })

      await page.evaluate(axe.source)
      expect(
        await page.evaluate(
          async () =>
            (await (window as unknown as { axe: typeof import('axe-core') }).axe.run()).violations,
        ),
      ).toEqual([])
      for (const width of [480, 320]) {
        await page.setViewportSize({ width, height: 1100 })
        await editor.press(`${modifier}+End`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        expect(
          await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true)
        await expect(numbers.last()).toBeVisible()
        await page.screenshot({ path: test.info().outputPath(`notes-${theme}-${width}.png`) })
      }
      await page.emulateMedia({ forcedColors: 'active' })
      await references.last().focus()
      await expect(references.last()).toHaveCSS('outline-style', 'solid')
      await page.screenshot({ path: test.info().outputPath(`notes-${theme}-forced.png`) })
      await page.emulateMedia({ forcedColors: 'none' })

      // Editing a displayed definition keeps its original markers and undo history.
      await page.setViewportSize({ width: 1100, height: 1100 })
      const definition = editor.locator('.cm-line.cm-live-reference-definition').first()
      await definition.click()
      await page.keyboard.press('End')
      await page.keyboard.type(' edited')
      await page.keyboard.press(`${modifier}+z`)
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect(editor).toContainText(
        '[guide]: https://example.invalid/field-guide "Field guide"',
      )
      await page.keyboard.press(`${modifier}+s`)
      expect(await readFile(path, 'utf8')).toBe(source)
      await page.getByRole('button', { name: 'Live Preview', exact: true }).click()

      const htmlPath = join(directory, 'notes.html')
      await application.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      }, htmlPath)
      await clickDocumentAction(page, 'Export HTML…')
      await expect
        .poll(async () => await readFile(htmlPath, 'utf8').catch(() => ''))
        .toContain('markdown-footnote-ref')
      const opened = application.waitForEvent('window')
      await application.evaluate(async ({ BrowserWindow }, path) => {
        const window = new BrowserWindow({
          width: 1100,
          height: 1100,
          webPreferences: {
            partition: 'footnote-theme-export',
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        })
        window.webContents.session.enableNetworkEmulation({ offline: true })
        await window.loadFile(path)
      }, htmlPath)
      const artifact = await opened
      await expect(artifact.locator('.footnotes li')).toHaveCount(3)
      await expect(artifact.locator('.footnotes > .sr-only')).toHaveCSS('clip-path', 'inset(50%)')
      await expect(artifact.locator('a[data-footnote-backref] .markdown-icon-backref')).toHaveCount(
        6,
      )
      await expect(
        artifact.getByRole('link', { name: 'field guide', exact: true }),
      ).toHaveAttribute('href', 'https://example.invalid/field-guide')
      await artifact.locator('a[data-footnote-ref]').first().click()
      await expect(artifact.locator('.footnotes li').first()).toBeInViewport()
      await artifact.locator('a[data-footnote-backref]').first().click()
      await expect(artifact.locator('a[data-footnote-ref]').first()).toBeInViewport()
      await artifact.screenshot({
        path: test.info().outputPath(`notes-${theme}-export.png`),
        fullPage: true,
      })
      await artifact.setViewportSize({ width: 320, height: 1100 })
      expect(
        await artifact.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true)
      expect(errors).toEqual([])
    } catch (error) {
      await page.screenshot({ path: test.info().outputPath('failure.png') }).catch(() => {})
      throw error
    } finally {
      await application
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .catch(() => {})
      await application.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
