import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const value = [
  String.raw`\begin{aligned}`,
  String.raw`x &= a+b \\`,
  'y &= c+d',
  String.raw`\end{aligned}`,
].join('\n')

for (const { width, zoom, theme } of [
  { width: 1144, zoom: 1, theme: 'light' },
  { width: 420, zoom: 1.25, theme: 'dark' },
]) {
  for (const target of ['gap', 'padding']) {
    test(`${theme} first click in LaTeX ${target} opens the closest expression row`, async () => {
      const directory = await mkdtemp(resolve('test/e2e/result/latex-first-click-'))
      const profile = join(directory, 'profile'),
        path = join(directory, 'equation.md')
      const prefix =
        target === 'padding'
          ? Array.from({ length: 30 }, (_, index) => `Paragraph ${index}.\n\n`).join('')
          : ''
      const source = `${prefix}$$\n${value}\n$$\n\nAfter.\n`
      await mkdir(profile)
      await writeFile(
        join(profile, 'preferences.json'),
        JSON.stringify({ schemaVersion: 1, locale: 'en', theme }),
      )
      await writeFile(path, source)
      const application = await launchDesktop(profile, [path])
      try {
        const page = await application.firstWindow()
        await page.setViewportSize({ width, height: 700 })
        await application.evaluate(({ BrowserWindow }, zoom) => {
          BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom)
        }, zoom)
        const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
        if (prefix) {
          await expect(
            page.getByRole('button', { name: /^\d+ words · Document details$/ }),
          ).toBeVisible()
          await page.locator('.cm-scroller').evaluate((element) => {
            element.scrollTop = element.scrollHeight
          })
        }
        const math = editor.getByRole('math', { name: value, exact: true })
        await expect(math.locator('svg')).toBeVisible()
        await expect(editor.locator('.cm-live-edit-source')).toHaveCount(0)
        await page.getByRole('button', { name: 'Source', exact: true }).focus()
        await expect(editor).not.toBeFocused()
        await math.hover()
        const point = await math.evaluate(
          (element, { target, value }) => {
            const box = element.getBoundingClientRect()
            const c = element.querySelector(`[data-source-from="${value.indexOf('c+d')}"]`)
            const plus = element.querySelector(`[data-source-from="${value.indexOf('c+d') + 1}"]`)
            if (!c || !plus) throw new Error('Missing second equation row')
            const before = c.getBoundingClientRect(),
              after = plus.getBoundingClientRect()
            return {
              x:
                target === 'padding'
                  ? box.left + 4
                  : before.right + (after.left - before.right) / 4,
              y: before.top + before.height / 2,
            }
          },
          { target, value },
        )
        await page.mouse.click(point.x, point.y)
        await expect(editor).toBeFocused()
        const line = await page.evaluate(
          () => getSelection()?.focusNode?.parentElement?.closest('.cm-line')?.textContent,
        )
        expect(line).toBe('y &= c+d')
        await page.keyboard.insertText('Q')
        await editor.press(`${modifier}+s`)
        await expect
          .poll(() => readFile(path, 'utf8'))
          .toBe(
            source.replace(target === 'gap' ? 'c+d' : 'y &=', target === 'gap' ? 'cQ+d' : 'Qy &='),
          )
        await page.screenshot({
          path: test.info().outputPath(`first-click-${target}-${width}.png`),
        })
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
}
