import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function clickBelow(page: Page) {
  const scroller = page.locator('.cm-editor[data-mode="live"] > .cm-scroller')
  const box = await scroller.boundingBox()
  if (!box) throw new Error('Missing editor scroller')
  await scroller.click({ position: { x: box.width / 2, y: box.height - 8 } })
}

for (const mode of [
  'completed',
  'rendered',
  'existing paragraph',
  'selected',
  'whitespace',
  'scrolled',
] as const) {
  test(`clicking below ${mode} creates or reuses an editable paragraph`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manuslip-tail-click-'))
    const path = join(directory, 'input.md')
    const block =
      mode === 'completed'
        ? '```\n\n```'
        : `${mode === 'scrolled' ? 'Paragraph\n\n'.repeat(80) : ''}\`\`\`\nbody\n\`\`\``
    const padding = mode === 'whitespace' ? '    ' : ''
    const original =
      mode === 'completed'
        ? ''
        : block + (mode === 'existing paragraph' ? '\n\n' : mode === 'whitespace' ? '\n    ' : '')
    await writeFile(path, original)
    const app = await launchDesktop(join(directory, 'profile'), [path])
    try {
      const page = await app.firstWindow()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await expect(editor).toBeVisible()
      if (mode === 'completed') {
        await editor.focus()
        await page.keyboard.type('```')
        await page.keyboard.press('Enter')
      } else if (mode === 'rendered') {
        await expect(page.locator('.cm-live-block')).toBeVisible()
      }
      if (mode === 'selected') {
        await editor.focus()
        await page.keyboard.press(`${modifier}+a`)
      }
      if (mode === 'scrolled') {
        await expect(
          page.getByRole('button', { name: /^\d+ words · Document details$/ }),
        ).toBeVisible()
        const scroller = page.locator('.cm-editor[data-mode="live"] > .cm-scroller')
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0)
        await expect(page.locator('.cm-live-code pre')).toHaveText('body')
      }
      await clickBelow(page)
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${block}\n\n${padding}`)
      await clickBelow(page)
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${block}\n\n${padding}`)
      if (mode !== 'existing paragraph') {
        await page.keyboard.press(`${modifier}+z`)
        await page.keyboard.press(`${modifier}+s`)
        await expect
          .poll(() => readFile(path, 'utf8'))
          .toBe(mode === 'completed' ? block : original)
        if (mode === 'selected') await page.keyboard.press('ArrowRight')
        if (mode === 'scrolled') {
          // Undo restores the earlier caret and its scroll position. Scroll back
          // down so the next click is below the document, not the top viewport.
          await page.locator('.cm-editor[data-mode="live"] > .cm-scroller').evaluate((element) => {
            element.scrollTop = element.scrollHeight
          })
          await expect(page.locator('.cm-live-code pre')).toHaveText('body')
        }
        await clickBelow(page)
      }
      await page.keyboard.type('After')
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${block}\n\nAfter${padding}`)
      await expect(editor).toBeFocused()
      await page.screenshot({ path: test.info().outputPath('paragraph-below-block.png') })
    } finally {
      await app
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .catch(() => {})
      await app.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
