import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { launchDesktop, openMarkdownExtensions } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const kind of ['html', 'math', 'diagram'] as const) {
  for (const size of ['short', 'long', 'tall'] as const) {
    test(`${kind} ${kind === 'html' ? 'switches between source and output' : 'keeps the clicked source and preview visible'} with ${size} content`, async () => {
      const long = size !== 'short'
      const directory = await mkdtemp(resolve('test/e2e/result/editing-context-'))
      const profile = join(directory, 'profile'),
        path = join(directory, 'source.md')
      const padding = Array.from({ length: 24 }, (_, at) => `Paragraph ${at}.\n\n`).join('')
      const comments = Array.from({ length: size === 'long' ? 100 : 1 }, (_, at) =>
        kind === 'html'
          ? `<!-- hidden ${at} -->`
          : `${kind === 'diagram' ? '%%' : '%'} hidden ${at}`,
      ).join('\n')
      const value =
        kind === 'html'
          ? `<div title="Same"><span>Same</span><b>Sa&amp;me</b>\n${size === 'tall' ? '<p>Tall paragraph</p>\n'.repeat(35).trimEnd() : comments}\n</div>`
          : kind === 'math'
            ? size === 'tall'
              ? `\\begin{aligned}\n${Array.from({ length: 30 }, (_, at) => `x_${at} &= y_${at} \\\\`).join('\n')}\n\\end{aligned}`
              : `x+y\n${comments}`
            : `flowchart ${size === 'tall' ? 'TB' : 'LR'}\nA[Same] --> B[Same]\n${size === 'tall' ? Array.from({ length: 30 }, (_, at) => `${at ? `C${at - 1}` : 'B'} --> C${at}[Row ${at}]`).join('\n') : comments}`
      const block =
        kind === 'html'
          ? value
          : kind === 'math'
            ? `$$\n${value}\n$$`
            : `\`\`\`mermaid\n${value}\n\`\`\``
      const source = `${padding}${block}\n\n${padding}`
      await mkdir(profile)
      await writeFile(
        join(profile, 'preferences.json'),
        JSON.stringify({
          schemaVersion: 1,
          locale: 'en',
          theme: long ? 'dark' : 'light',
        }),
      )
      await writeFile(path, source)
      const application = await launchDesktop(profile, [path])
      try {
        const page = await application.firstWindow()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.setViewportSize({ width: long ? 480 : 1144, height: 640 })
        const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
        if (kind === 'html') {
          const extensions = await openMarkdownExtensions(page)
          await extensions.getByLabel('Render sanitized HTML', { exact: true }).check()
          await page.keyboard.press('Escape')
        }
        const scroller = page.locator('.cm-scroller')
        await scroller.evaluate((element) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
        })
        const rendered = page.locator(`.cm-live-${kind}:not(.cm-live-edit-preview)`)
        await rendered.scrollIntoViewIfNeeded()
        if (kind !== 'html') await expect(rendered.locator('svg')).toBeVisible()
        await page.getByRole('button', { name: 'Source', exact: true }).focus()
        let expected: string
        if (kind === 'html') {
          await rendered.locator('b').scrollIntoViewIfNeeded()
          const point = await rendered.locator('b').evaluate((element) => {
            const text = element.firstChild
            if (!text) throw new Error('Missing HTML text')
            const range = document.createRange()
            range.setStart(text, 2)
            range.collapse(true)
            const box = range.getBoundingClientRect()
            return { x: box.left, y: box.top + box.height / 2 }
          })
          await page.mouse.click(point.x, point.y)
          expected = source.replace('Sa&amp;me', 'SaQ&amp;me')
        } else if (kind === 'math') {
          const symbol = rendered.locator(`[data-source-from="${value.indexOf('x')}"]`).last()
          await symbol.scrollIntoViewIfNeeded()
          const box = await symbol.boundingBox()
          if (!box) throw new Error('Missing formula symbol')
          await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2)
          expected = size === 'tall' ? source.replace('x_0', 'xQ_0') : source.replace('x+y', 'xQ+y')
        } else {
          const label = rendered.locator(`text[data-source-from="${value.lastIndexOf('Same')}"]`)
          await label.click({ position: { x: 1, y: 2 } })
          expected = source.replace('B[Same]', 'B[QSame]')
        }
        await expect(editor).toBeFocused()
        const preview = page.locator('.cm-live-edit-preview')
        if (kind === 'html') {
          await expect(rendered).toHaveCount(0)
          await expect(preview).toHaveCount(0)
          await expect(page.locator('.cm-live-preview-panel')).toHaveCount(0)
          await page.keyboard.insertText('Q')
          await editor.press(`${modifier}+s`)
          await expect.poll(() => readFile(path, 'utf8')).toBe(expected)
          await page.setViewportSize({ width: 420, height: 500 })
          await expect(editor).toBeFocused()
          await expect(preview).toHaveCount(0)
          await expect(page.locator('.cm-live-preview-panel')).toHaveCount(0)
          await page.screenshot({ path: test.info().outputPath(`html-source-${size}.png`) })
          if (long) {
            await page.evaluate(axe.source)
            expect(
              await page.evaluate(
                async () =>
                  (await (window as unknown as { axe: typeof import('axe-core') }).axe.run())
                    .violations,
              ),
            ).toEqual([])
          }
          await editor.press('Escape')
          await expect(rendered).toBeVisible()
          await expect(rendered).toBeFocused()
          await expect(rendered).toBeInViewport()
          if (size !== 'tall')
            await expect
              .poll(() =>
                rendered.evaluate((element) => {
                  const bounds = element.getBoundingClientRect()
                  const viewport = element.closest('.cm-scroller')?.getBoundingClientRect()
                  return (
                    !!viewport &&
                    bounds.top >= viewport.top + 6 &&
                    bounds.bottom <= viewport.bottom - 6
                  )
                }),
              )
              .toBe(true)
          await expect(rendered.locator('b')).toHaveText('SaQ&me')
          await expect(rendered).toHaveAttribute('aria-keyshortcuts', 'Enter Space')
          await page.screenshot({ path: test.info().outputPath(`html-output-${size}.png`) })
          await rendered.press('Space')
          await expect(editor).toBeFocused()
          await expect(rendered).toHaveCount(0)
          await expect(preview).toHaveCount(0)
          await expect(page.locator('.cm-live-preview-panel')).toHaveCount(0)
          await editor.press('Escape')
          await expect(rendered).toBeFocused()
          await rendered.locator('b').click({ modifiers: [modifier] })
          await expect(editor).toBeFocused()
          await expect(rendered).toHaveCount(0)
          await expect(preview).toHaveCount(0)
          expect(errors).toEqual([])
          return
        }
        await expect(preview).toBeVisible()
        const visible = () =>
          preview.evaluate((element) => {
            const scroller = document.querySelector('.cm-scroller')?.getBoundingClientRect()
            const selection = getSelection()
            const caret = selection?.rangeCount
              ? selection.getRangeAt(0).getBoundingClientRect()
              : undefined
            const box = (
              element.closest('.cm-live-preview-panel') ?? element
            ).getBoundingClientRect()
            return Boolean(
              caret &&
                scroller &&
                caret.top >= scroller.top - 1 &&
                caret.bottom <= scroller.bottom + 1 &&
                box.top >= 0 &&
                box.bottom <= innerHeight,
            )
          })
        await expect.poll(visible).toBe(true)
        await page.keyboard.insertText('Q')
        await editor.press(`${modifier}+s`)
        await expect.poll(() => readFile(path, 'utf8')).toBe(expected)
        await expect.poll(visible).toBe(true)
        await page.setViewportSize({ width: 420, height: 500 })
        await expect.poll(visible).toBe(true)
        await page.screenshot({
          path: test.info().outputPath(`${kind}-${size}.png`),
        })
        if (long) {
          const panel = page.locator('.cm-live-preview-panel')
          await expect(panel).toBeVisible()
          if (size === 'tall') {
            expect(
              await panel.evaluate((element) => element.scrollHeight > element.clientHeight),
            ).toBe(true)
            await panel.hover()
            await page.mouse.wheel(0, 200)
            await expect
              .poll(() => panel.evaluate((element) => element.scrollTop))
              .toBeGreaterThan(100)
            await expect.poll(visible).toBe(true)
          }
          await panel.focus()
          await panel.press('Escape')
          await expect(panel).toHaveCount(0)
          await expect(editor).toBeFocused()
          await expect(rendered).toBeVisible()
          const focusable = kind === 'math' ? rendered.getByRole('math') : rendered
          await focusable.focus()
          await focusable.press('Enter')
          await expect(panel).toBeVisible()
          await expect.poll(visible).toBe(true)
          await editor.press('ArrowDown')
          await expect.poll(visible).toBe(true)
        }
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
    })
  }
}
