import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { expectBundledCjkSamples, expectCjkPdf } from './fonts'
import {
  clickDocumentAction,
  contrast,
  launchDesktop,
  openDocumentActions,
  openMarkdownExtensions,
} from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function cleanup(application: ElectronApplication, directory: string): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.destroy()
    })
    .catch(() => {})
  await application.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
test('self-contained HTML and PDF export preserve tables, Unicode, code, local images, math and diagrams offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-export-'))
  const path = join(directory, '原文.md')
  const source =
    '# 世界 — Export\n\n[Reference][ref]\n\n| Language | Text |\n| - | - |\n| 中文 | 你好 |\n\nHan and radicals: 文 ⽂, 二 ⼆, 長 ⻑ ⾧, 中・文, 龘𠮷.\n\n```js\nconst message = "Hello — 你好"\n```\n\nMath $x^2$ and $\\ce{H2O}$.\n\n```mermaid\nflowchart LR\nWrite[写作 Write]-->Share[分享 Share]\n```\n\n![Local picture](pixel.png)\n\n[ref]: https://example.com\n'
  await writeFile(path, source)
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const png = await application.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
        .toPNG()
        .toString('base64'),
    )
    await writeFile(join(directory, 'pixel.png'), Buffer.from(png, 'base64'))
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(page.getByRole('tab', { name: '原文.md', exact: true })).toBeVisible()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const htmlPath = join(directory, 'export.html')
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, htmlPath)
    await clickDocumentAction(page, 'Export HTML…')
    await expect(page.getByText(`Exported to ${htmlPath}`, { exact: true })).toBeVisible({
      timeout: 15000,
    })
    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('<table>')
    expect(html).toContain('你好')
    expect(html).toContain('const message = "Hello — 你好"')
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('<svg')
    expect(html).toContain('Share')
    expect(html).not.toMatch(
      /<script|foreignObject|manuslip-asset:|data-export-slot|<style[^>]*>.*javascript:/,
    )
    expect(html).toContain('href="https://example.com/"')
    await writeFile(test.info().outputPath('export-example.html'), html)
    const retainedHtml = test.info().outputPath('export.html')
    await writeFile(retainedHtml, html)
    await test.info().attach('export-html', { path: retainedHtml, contentType: 'text/html' })
    const artifactPromise = application.waitForEvent('window')
    await application.evaluate(async ({ BrowserWindow }, path) => {
      const artifact = new BrowserWindow({
        show: true,
        width: 900,
        height: 1000,
        webPreferences: {
          partition: 'export-artifact-test',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      artifact.webContents.session.enableNetworkEmulation({ offline: true })
      await artifact.loadFile(path)
    }, htmlPath)
    const artifact = await artifactPromise
    await expect(
      artifact.getByRole('heading', { name: '世界 — Export', exact: true }),
    ).toBeVisible()
    await expectBundledCjkSamples(artifact, [
      ['article > h1', 2],
      ['article > p:nth-of-type(2)', 12],
      ['tbody td:nth-child(2)', 2],
      ['pre code', 2],
      ['[data-export-kind="diagram"] text', 2],
    ])
    await expect(artifact.locator('[data-export-kind="math"] svg')).toHaveCount(2)
    await expect(artifact.locator('[data-export-kind="diagram"] svg')).toContainText('Share')
    await expect
      .poll(() =>
        artifact
          .locator('img')
          .evaluate((element) => (element instanceof HTMLImageElement ? element.naturalWidth : 0)),
      )
      .toBe(1)
    await artifact.screenshot({
      path: test.info().outputPath('export-document.png'),
      fullPage: true,
    })
    await artifact.screenshot({
      path: test.info().outputPath('chinese-export.png'),
      fullPage: true,
    })
    await artifact.close()
    await page.bringToFront()
    const pdfPath = join(directory, 'export.pdf')
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, pdfPath)
    await clickDocumentAction(page, 'Export PDF…')
    await expect(page.getByText(`Exported to ${pdfPath}`, { exact: true })).toBeVisible({
      timeout: 15000,
    })
    const bytes = await readFile(pdfPath)
    const retainedPdf = test.info().outputPath('export.pdf')
    await writeFile(retainedPdf, bytes)
    await test.info().attach('export-pdf', { path: retainedPdf, contentType: 'application/pdf' })
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThan(0)
    expect(pdf.getPageCount()).toBeLessThan(5)
    expect(
      pdf.context
        .enumerateIndirectObjects()
        .some(
          ([, object]) =>
            object instanceof PDFRawStream &&
            object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image',
        ),
    ).toBe(true)
    expectCjkPdf(pdf, '世界中文你好写作分享⽂二⼆長⻑⾧・龘𠮷')
    expect(
      pdf.context
        .enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFDict && object.has(PDFName.of('ToUnicode'))),
    ).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(source)
    await expect
      .poll(() =>
        application.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) =>
              /manuslip-(?:print|diagram):/.test(window.webContents.getURL()),
            ).length,
        ),
      )
      .toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('export captures the clicked revision while editing continues and preserves the undo history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-export-revision-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('# Captured before\n\nOriginal text')
    const target = join(directory, 'captured.html')
    await application.evaluate(({ dialog }, path) => {
      process.env.MANUSLIP_EXPORT_DIALOG = '0'
      dialog.showSaveDialog = async () => {
        process.env.MANUSLIP_EXPORT_DIALOG = '1'
        return new Promise((resolve) =>
          process.once('manuslip-export-choice', () =>
            resolve({ canceled: false, filePath: path }),
          ),
        )
      }
    }, target)
    await clickDocumentAction(page, 'Export HTML…')
    await expect
      .poll(() => application.evaluate(() => process.env.MANUSLIP_EXPORT_DIALOG))
      .toBe('1')
    await editor.press(`${modifier}+End`)
    await editor.press('Enter')
    await editor.pressSequentially('Later edit')
    await application.evaluate(() =>
      (process as NodeJS.EventEmitter).emit('manuslip-export-choice'),
    )
    await expect(
      page.getByText(`Exported to ${target}. Edits made after export started are not included.`, {
        exact: true,
      }),
    ).toBeVisible()
    const html = await readFile(target, 'utf8')
    expect(html).toContain('Captured before')
    expect(html).not.toContain('data:font/woff2;base64,')
    expect(html).not.toContain('Later edit')
    await expect(editor).toContainText('Later edit')
    await expect(editor).toBeFocused()
    await editor.press(`${modifier}+z`)
    await expect(editor).not.toContainText('Later edit')
    await application.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
    })
    await clickDocumentAction(page, 'Export HTML…')
    await expect(
      page.getByText('Export cancelled. Your document is unchanged.', { exact: true }),
    ).toBeVisible()
    expect(await readFile(target, 'utf8')).toBe(html)
    await expect(page.getByRole('button', { name: 'Document actions', exact: true })).toBeFocused()
  } finally {
    await cleanup(application, directory)
  }
})

test('an isolated stalled PDF is cleaned up when its document closes while editing and saving continue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-export-cancel-'))
  const sourcePath = join(directory, 'source.md')
  const source = '# Printable\n\nMath $x^2$.'
  await writeFile(sourcePath, source)
  const application = await launchDesktop(join(directory, 'profile'), [sourcePath])
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('tab', { name: 'source.md', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    const target = join(directory, 'cancelled.pdf')
    await application.evaluate(({ app, dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      process.env.MANUSLIP_EXPORT_PRINT = '0'
      app.once('browser-window-created', (_event, window) => {
        window.webContents.printToPDF = async () => {
          process.env.MANUSLIP_EXPORT_PRINT = '1'
          return new Promise(() => {})
        }
      })
    }, target)
    await clickDocumentAction(page, 'Export PDF…')
    await expect.poll(() => application.evaluate(() => process.env.MANUSLIP_EXPORT_PRINT)).toBe('1')
    const isolation = await application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('manuslip-print:'),
      )
      const editor = BrowserWindow.getAllWindows().find(
        (window) => !/manuslip-(?:print|diagram):/.test(window.webContents.getURL()),
      )
      if (!host || !editor) throw new Error('Missing print host')
      const preferences = (
        host.webContents as typeof host.webContents & {
          getLastWebPreferences(): Electron.WebPreferences
        }
      ).getLastWebPreferences()
      return {
        separate: host.webContents.getOSProcessId() !== editor.webContents.getOSProcessId(),
        session: host.webContents.session !== editor.webContents.session,
        sandbox: preferences.sandbox,
        isolation: preferences.contextIsolation,
        node: preferences.nodeIntegration,
        visible: host.isVisible(),
      }
    })
    expect(isolation).toEqual({
      separate: true,
      session: true,
      sandbox: true,
      isolation: true,
      node: false,
      visible: false,
    })
    const host = application.windows().find((window) => window.url().includes('manuslip-print:'))
    if (!host) throw new Error('Missing print page')
    expect(
      await host.evaluate(async () => ({
        bridge: typeof (window as unknown as { manuslip?: unknown }).manuslip,
        node: typeof (window as unknown as { require?: unknown }).require,
        popup: window.open('https://example.com') === null,
        denied: await Promise.all(
          [
            'https://example.com/private',
            'file:///etc/passwd',
            'manuslip-print://render/index.html',
          ].map(async (url) => {
            try {
              await fetch(url)
              return false
            } catch {
              return true
            }
          }),
        ),
      })),
    ).toEqual({ bridge: 'undefined', node: 'undefined', popup: true, denied: [true, true, true] })
    const oldProcess = await application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('manuslip-print:'),
      )
      if (!host) throw new Error('Missing print host')
      const pid = host.webContents.getOSProcessId()
      void host.webContents.executeJavaScript('for (;;) {}').catch(() => {})
      return pid
    })
    await editor.press(`${modifier}+End`)
    await editor.press('Enter')
    await editor.pressSequentially('Saved during export')
    await editor.press(`${modifier}+s`)
    await expect.poll(() => readFile(sourcePath, 'utf8')).toContain('Saved during export')
    await expect(page.getByRole('button', { name: 'Cancel export', exact: true })).toHaveCount(0)
    await expect(editor).toBeFocused()
    await page.getByRole('button', { name: /^Close.*source\.md/ }).click()
    await expect
      .poll(() =>
        application.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((window) =>
              window.webContents.getURL().includes('manuslip-print:'),
            ).length,
        ),
      )
      .toBe(0)
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp') || name.endsWith('.pdf')),
    ).toEqual([])
    expect(
      await application.evaluate(
        ({ BrowserWindow }, old) =>
          BrowserWindow.getAllWindows().every(
            (window) => window.webContents.getOSProcessId() !== old,
          ),
        oldProcess,
      ),
    ).toBe(true)
    await application.evaluate(({ dialog }, path) => {
      process.env.MANUSLIP_EXPORT_PRINT = 'done'
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, sourcePath)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(editor).toContainText('Saved during export')
    await clickDocumentAction(page, 'Export PDF…')
    await expect(page.getByText(`Exported to ${target}`, { exact: true })).toBeVisible()
    expect((await readFile(target)).subarray(0, 5).toString()).toBe('%PDF-')
  } finally {
    await cleanup(application, directory)
  }
})

test('failed assets and invalid math retain the previous export and show usable localized states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-export-errors-'))
  const target = join(directory, 'retained.html')
  await writeFile(target, 'Previous export')
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, target)
    for (const source of [
      '![Missing](missing.png)',
      '![Blocked](https://example.com/private.png)',
      '![Blocked](file:///etc/passwd)',
    ]) {
      await editor.fill(source)
      await clickDocumentAction(page, 'Export HTML…')
      await expect(page.getByRole('alert')).toContainText('An image could not be included')
      expect(await readFile(target, 'utf8')).toBe('Previous export')
      await expect(editor).toContainText(source)
    }
    await editor.fill('$\\notARealCommand{x}$')
    await clickDocumentAction(page, 'Export HTML…')
    await expect(page.getByRole('alert')).toContainText('Export could not render')
    expect(await readFile(target, 'utf8')).toBe('Previous export')
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
      const colors = await page.getByRole('alert').evaluate((element) => {
        const style = getComputedStyle(element)
        const parent = getComputedStyle(document.documentElement)
        return { text: style.color, background: parent.backgroundColor }
      })
      expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: test.info().outputPath(`export-error-${theme}.png`) })
    }
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
    await page.setViewportSize({ width: 320, height: 800 })
    await openDocumentActions(page)
    await expect(page.getByRole('button', { name: '导出 HTML…', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('export-narrow-chinese.png') })
    await page.setViewportSize({ width: 1144, height: 800 })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const zoomExport = page.getByRole('button', { name: '导出 PDF…', exact: true })
    await openDocumentActions(page)
    await zoomExport.focus()
    await expect(zoomExport).toBeInViewport()
    await page.screenshot({ path: test.info().outputPath('export-zoom-chinese.png') })
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('export sanitizes opted-in HTML and rejects over-limit PDF pages without replacing an earlier file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-export-policy-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const extensions = await openMarkdownExtensions(page)
    await extensions.getByLabel('Render sanitized HTML', { exact: true }).check()
    await page.keyboard.press('Escape')
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill(
      '# Safe export\n\n<div onclick="window.compromised=true">Visible <strong>raw HTML</strong><script>window.compromised=true</script><iframe src="https://example.com/private"></iframe><object data="file:///etc/passwd"></object><a href="javascript:alert(1)">Safe text</a></div>\n\n<style>@import "https://example.com/leak";</style>',
    )
    const htmlPath = join(directory, 'sanitized.html')
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, htmlPath)
    await clickDocumentAction(page, 'Export HTML…')
    await expect(page.getByText(`Exported to ${htmlPath}`, { exact: true })).toBeVisible()
    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('Visible <strong>raw HTML</strong>')
    expect(html).not.toMatch(
      /compromised|onclick|<script|<iframe|<object|javascript:|@import|example.com\/leak/,
    )
    const pdfPath = join(directory, 'retained.pdf')
    await writeFile(pdfPath, 'Previous PDF')
    const overLimit = await PDFDocument.create()
    for (let i = 0; i < 2001; i++) overLimit.addPage([10, 10])
    const bytes = Buffer.from(await overLimit.save()).toString('base64')
    await application.evaluate(
      ({ app, dialog }, input) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.path })
        app.once('browser-window-created', (_event, window) => {
          window.webContents.printToPDF = async () => Buffer.from(input.bytes, 'base64')
        })
      },
      { path: pdfPath, bytes },
    )
    await clickDocumentAction(page, 'Export PDF…')
    await expect(page.getByRole('alert')).toContainText('2,000-page limit')
    expect(await readFile(pdfPath, 'utf8')).toBe('Previous PDF')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await expect(editor).toContainText('Safe export')
  } finally {
    await cleanup(application, directory)
  }
})
