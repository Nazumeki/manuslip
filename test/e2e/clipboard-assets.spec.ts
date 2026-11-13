import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import {
  clickDocumentAction,
  contrast,
  launchDesktop,
  openMarkdownExtensions,
  plainPasteShortcut,
} from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function htmlClipboard(
  application: ElectronApplication,
  html: string,
  text = 'Plain content',
): Promise<void> {
  await application.evaluate(
    async ({ clipboard, ClipboardItem }, input) => {
      await clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([input.html], { type: 'text/html' }),
          'text/plain': new Blob([input.text], { type: 'text/plain' }),
        }),
      ])
    },
    { html, text },
  )
}
async function imageClipboard(application: ElectronApplication): Promise<string> {
  return application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const pixels = Buffer.alloc(240 * 100 * 4)
    for (let index = 0; index < pixels.length; index += 4)
      pixels.set(
        Math.floor(index / 4 / 240) < 50 ? [55, 120, 220, 255] : [95, 160, 230, 255],
        index,
      )
    const bytes = nativeImage.createFromBitmap(pixels, { width: 240, height: 100 }).toPNG()
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }),
    ])
    return bytes.toString('base64')
  })
}
async function chooseSave(application: ElectronApplication, path: string | null): Promise<void> {
  await application.evaluate(({ dialog }, selected) => {
    process.env.MANUSLIP_PASTE_SAVE_SEEN = '0'
    dialog.showSaveDialog = async () => {
      process.env.MANUSLIP_PASTE_SAVE_SEEN = '1'
      return selected ? { canceled: false, filePath: selected } : { canceled: true, filePath: '' }
    }
  }, path)
}
async function cleanup(application: ElectronApplication, directory: string): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('native paste preserves plain text when HTML is also available, including oversized HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-clipboard-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('Before\n\n')
    await editor.press(`${modifier}+End`)
    await htmlClipboard(
      application,
      '<h2>Clipboard 标题</h2><p><strong>Bold</strong> <del>Old</del></p><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><script>window.compromised=true</script>',
    )
    await editor.press(`${modifier}+v`)
    await expect(editor).toContainText('Plain content')
    await expect(editor).not.toContainText('Clipboard 标题')
    await expect(editor).not.toContainText('compromised')
    await editor.press(`${modifier}+z`)
    await expect
      .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
      .toBe('Before\n\n')
    await editor.press(plainPasteShortcut)
    await expect(editor).toContainText('Plain content')
    await expect(editor).not.toContainText('Clipboard 标题')
    await editor.fill('```text\n\n```')
    await editor.press(`${modifier}+Home`)
    await editor.press('ArrowDown')
    await editor.press(`${modifier}+v`)
    await expect
      .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
      .toBe('```text\nPlain content\n```')
    await editor.fill('Retained text')
    await editor.press(`${modifier}+End`)
    await htmlClipboard(application, `<p>${'x'.repeat(1024 * 1024)}</p>`)
    await editor.press(`${modifier}+v`)
    await expect(editor).toHaveText('Retained textPlain content')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await htmlClipboard(application, '<p>Different <em>HTML</em></p>', 'Literal **Markdown**')
    await editor.press(`${modifier}+End`)
    await editor.press(`${modifier}+v`)
    await expect(editor).toContainText('Literal **Markdown**')
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('native image paste handles cancelled Save As, unique imports, undo retention and local preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-image-paste-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('Image below:\n\n')
    await editor.press(`${modifier}+End`)
    const png = Buffer.from(await imageClipboard(application), 'base64')
    await chooseSave(application, null)
    await editor.press(`${modifier}+v`)
    await expect
      .poll(() => application.evaluate(() => process.env.MANUSLIP_PASTE_SAVE_SEEN))
      .toBe('1')
    await expect(page.getByText('Pasting…', { exact: true })).toHaveCount(0)
    await expect(editor).toHaveText('Image below:')
    await expect(readdir(join(directory, 'assets'))).rejects.toBeDefined()
    const target = join(directory, 'saved.md')
    await chooseSave(application, target)
    await editor.press(`${modifier}+v`)
    await expect(editor).toContainText('![Image](assets/pasted-')
    await expect(page.getByText('Pasting…', { exact: true })).toHaveCount(0)
    await expect.poll(async () => (await readdir(join(directory, 'assets'))).length).toBe(1)
    const first = (await readdir(join(directory, 'assets')))[0] || ''
    const imported = await readFile(join(directory, 'assets', first))
    expect(
      await application.evaluate(
        ({ nativeImage }, input) => {
          const original = nativeImage.createFromBuffer(Buffer.from(input.original, 'base64'))
          const imported = nativeImage.createFromBuffer(Buffer.from(input.imported, 'base64'))
          return { same: original.toBitmap().equals(imported.toBitmap()), size: imported.getSize() }
        },
        { original: png.toString('base64'), imported: imported.toString('base64') },
      ),
    ).toEqual({ same: true, size: { width: 240, height: 100 } })
    await editor.press(`${modifier}+z`)
    await expect(editor).not.toContainText('![Image]')
    expect(await readFile(join(directory, 'assets', first))).toEqual(imported)
    await editor.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await expect(editor).toContainText('![Image]')
    await editor.press(`${modifier}+End`)
    await editor.press('Enter')
    await editor.press('Enter')
    await editor.press(`${modifier}+v`)
    await expect.poll(async () => (await readdir(join(directory, 'assets'))).length).toBe(2)
    await expect.poll(() => readFile(target, 'utf8')).toMatch(/assets\/pasted-[a-f0-9-]+\.png/)
    await editor.press(`${modifier}+Home`)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const images = page.locator('img[data-local-image]')
    await expect(images).toHaveCount(2)
    await expect
      .poll(() =>
        images.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          ),
        ),
      )
      .toBe(true)
    const extensions = await openMarkdownExtensions(page)
    await expect(extensions.getByLabel('Load remote images…')).not.toBeChecked()
    await page.keyboard.press('Escape')
    await page.screenshot({ path: test.info().outputPath('clipboard-local-images.png') })
  } finally {
    await cleanup(application, directory)
  }
})

test('local image failures expose retry while traversal, SVG and ambient network remain blocked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-local-images-'))
  const documentDirectory = join(directory, 'documents')
  await mkdir(documentDirectory)
  const path = join(documentDirectory, 'local.md')
  await writeFile(
    path,
    '# Local assets\n\n![Missing](missing.png)\n\n![Outside](../outside.png)\n\n![Vector](unsafe.svg)\n\n![Remote](https://example.invalid/image.png)\n\nEnd',
  )
  await writeFile(
    join(documentDirectory, 'unsafe.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"/>',
  )
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    const requests: string[] = []
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url())
    })
    const png = Buffer.from(await imageClipboard(application), 'base64')
    await writeFile(join(directory, 'outside.png'), png)
    const missingRetry = page.getByRole('button', { name: 'Retry Missing', exact: true })
    await expect(missingRetry).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry Outside', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry Vector', exact: true })).toBeVisible()
    await expect(page.locator('.cm-image[data-render-state="blocked"]')).toContainText(
      'Remote image blocked',
    )
    await expect(
      page.locator('.cm-image[data-render-state="error"]').first().locator('.markdown-icon'),
    ).toBeVisible()
    await writeFile(join(documentDirectory, 'missing.png'), png)
    await missingRetry.click()
    const image = page.locator('img[data-local-image="missing.png"]')
    await expect
      .poll(() =>
        image.evaluate(
          (element) => element instanceof HTMLImageElement && element.naturalWidth > 0,
        ),
      )
      .toBe(true)
    await expect(missingRetry).toBeHidden()
    expect(requests).toEqual([])
    await page.screenshot({ path: test.info().outputPath('local-image-retry.png') })
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByRole('button', { name: 'Close preferences' }).click()
      await expect(page.locator('.preferences-dialog')).toBeHidden()
      const retry = page.getByRole('button', { name: 'Retry Outside', exact: true })
      const colors = await retry.evaluate((button) => ({
        foreground: getComputedStyle(button).color,
        background: getComputedStyle(button).backgroundColor,
      }))
      expect(contrast(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5)
      console.log(
        `Local image retry (${theme}) contrast:`,
        contrast(colors.foreground, colors.background).toFixed(2),
      )
      await page.keyboard.press('Tab')
      await retry.focus()
      await expect(retry).toBeFocused()
      expect(await retry.evaluate((button) => getComputedStyle(button).outlineWidth)).toBe('2px')
      await page.screenshot({ path: test.info().outputPath(`local-image-${theme}.png`) })
    }
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await page.getByRole('button', { name: '关闭偏好设置' }).click()
    await expect(page.locator('.preferences-dialog')).toBeHidden()
    await expect(page.getByRole('button', { name: '重试加载Outside', exact: true })).toBeVisible()
    await expect(page.getByText('正在更新预览…', { exact: true })).toHaveCount(0)
    await page.setViewportSize({ width: 320, height: 850 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.getByRole('button', { name: '重试加载Outside', exact: true }).focus()
    await page.screenshot({ path: test.info().outputPath('local-image-narrow-chinese.png') })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  } finally {
    await cleanup(application, directory)
  }
})

test('Save As resolves images from the new directory and retains the original assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-assets-saveas-'))
  const original = join(directory, 'original')
  const destination = join(directory, 'destination')
  await mkdir(original)
  await mkdir(destination)
  const source = '# Images\n\n![Picture](picture.png)\n\nEnd'
  await writeFile(join(original, 'doc.md'), source)
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const png = Buffer.from(await imageClipboard(application), 'base64')
    await writeFile(join(original, 'picture.png'), png)
    await application.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      },
      join(original, 'doc.md'),
    )
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    const retry = page.getByRole('button', { name: 'Retry Picture', exact: true })
    const image = page.locator('img[data-local-image="picture.png"]')
    await expect
      .poll(() =>
        image.evaluate(
          (element) => element instanceof HTMLImageElement && element.naturalWidth > 0,
        ),
      )
      .toBe(true)
    const oldToken = await image.getAttribute('src')
    const target = join(destination, 'copy.md')
    await chooseSave(application, target)
    await clickDocumentAction(page, 'Save As…')
    await expect(page.getByRole('tab', { name: 'copy.md', exact: true })).toBeVisible()
    await expect(retry).toBeVisible()
    expect(await image.getAttribute('src')).not.toBe(oldToken)
    await expect(page.locator('.cm-live-image-error')).toContainText('Image not found')
    expect(await readFile(target, 'utf8')).toBe(source)
    expect(await readFile(join(original, 'picture.png'))).toEqual(png)
    await writeFile(join(destination, 'picture.png'), png)
    await retry.click()
    await expect
      .poll(() =>
        image.evaluate(
          (element) => element instanceof HTMLImageElement && element.naturalWidth > 0,
        ),
      )
      .toBe(true)
  } finally {
    await cleanup(application, directory)
  }
})
