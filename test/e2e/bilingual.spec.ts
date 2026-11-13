import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import {
  clickDocumentAction,
  launchDesktop,
  openDocumentActions,
  openMarkdownExtensions,
  openReadingOptions,
  selectReadingLayout,
  waitForReading,
} from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
function settings(baseUrl: string): TranslationSettings {
  return {
    provider: {
      adapter: 'openai-compatible',
      version: '1',
      baseUrl,
      model: 'fake',
      profile: null,
      options: {},
    },
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    glossary: [],
    formality: 'default',
    promptVersion: 'prose-translation/v1',
  }
}
function answer(reply: ServerResponse, text: string) {
  reply.setHeader('Content-Type', 'application/json')
  reply.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: text.replaceAll('Hello', '你好，欢迎阅读这份跨语言文档'),
          },
        },
      ],
    }),
  )
}
async function stop(application: ElectronApplication) {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}

test('bilingual blocks align, preserve scroll anchors and export both languages with independent references', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-bilingual-'))
  const path = join(directory, 'bilingual.md')
  const source =
    '# Hello reader\n\nHello `PRIVATE_ONE` $x^2$ and [label][ref].\n\nHello `PRIVATE_TWO` $y^2$ and [label][ref].\n\n- [x] Hello task\n- Hello next task\n\n| Hello | Value |\n| - | - |\n| Cell | 2 |\n\n```ts\nconst PRIVATE_BLOCK = 1\n```\n\n```mermaid\ngraph LR\n A[PRIVATE_GRAPH] --> B[Done]\n```\n\n![PRIVATE_ALT](pixel.png)\n\nHello note[^n].\n\n<span id="custom">Custom target</span>\n\n[Custom link](#custom).\n\n' +
    Array.from(
      { length: 20 },
      (_, i) =>
        `Hello paragraph ${i}. ${'Readable source text with a varying translated height. '.repeat(8)}`,
    ).join('\n\n') +
    '\n\n[^n]: Hello footnote.\n\n[ref]: https://private.invalid/\n'
  await writeFile(path, source)
  let calls = 0
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const text: string = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content
    expect(text).not.toMatch(/PRIVATE_|private.invalid|x\^2|y\^2|graph LR/)
    calls++
    answer(reply, text)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello reader')
    const extensions = await openMarkdownExtensions(page)
    await extensions.getByRole('checkbox', { name: 'Render sanitized HTML', exact: true }).check()
    await page.keyboard.press('Escape')
    const png = await application.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
        .toPNG()
        .toString('base64'),
    )
    await writeFile(join(directory, 'pixel.png'), Buffer.from(png, 'base64'))
    await page.evaluate(
      (value) => window.manuslip.configureTranslation(value),
      settings(`http://127.0.0.1:${address.port}/chat`),
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await clickDocumentAction(page, 'Export reading HTML…')
    await expect(page.getByRole('alert')).toContainText('Choose Translate before exporting')
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await waitForReading(page)
    const count = calls
    await selectReadingLayout(page, 'side-by-side')
    const article = page.locator('.reading-article')
    await expect(article.locator('.reading-side-by-side')).toHaveCount(1)
    await expect(article.locator('[role="math"]')).toHaveCount(4)
    await expect(article.locator('[role="img"][aria-label="Diagram"] svg')).toHaveCount(2)
    await expect
      .poll(() =>
        article
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth === 1),
          ),
      )
      .toBe(true)
    expect(
      await article.locator('.reading-pair').evaluateAll((pairs) =>
        pairs.every((pair) => {
          const [original, translated] = [...pair.children]
          return (
            original &&
            translated &&
            Math.abs(
              original.getBoundingClientRect().top - translated.getBoundingClientRect().top,
            ) < 1
          )
        }),
      ),
    ).toBe(true)
    const references = () =>
      article.evaluate((element) => {
        const nodes = [...element.querySelectorAll('a[data-footnote-ref], a[href*="custom"]')]
        return (
          nodes.length === 4 &&
          nodes.every((link) => {
            const id = (link.getAttribute('href') ?? '').slice(1)
            const target = [...element.querySelectorAll('[id]')].find((node) => node.id === id)
            const selector = '.reading-original, .reading-translation'
            return (
              target && target.closest(selector)?.className === link.closest(selector)?.className
            )
          }) &&
          new Set([...element.querySelectorAll('[id]')].map((node) => node.id)).size ===
            element.querySelectorAll('[id]').length &&
          [...element.querySelectorAll('[aria-describedby]')].every((node) =>
            (node.getAttribute('aria-describedby') ?? '')
              .split(/\s+/)
              .every((id) =>
                [...element.querySelectorAll('[id]')].some((target) => target.id === id),
              ),
          )
        )
      })
    expect(await references()).toBe(true)
    await page.screenshot({ path: test.info().outputPath('bilingual-light.png') })
    // The same logical anchor remains at the same offset after changing layout and resource height.
    const anchor = await article.locator('.reading-pair').nth(15).getAttribute('data-reading-block')
    if (!anchor) throw new Error('Missing block anchor')
    await article.locator(`[data-reading-block="${anchor}"]`).evaluate((element) => {
      const pane = element.closest('.reading-pane')
      if (pane)
        pane.scrollTop +=
          element.getBoundingClientRect().top - pane.getBoundingClientRect().top + 12
    })
    await expect
      .poll(() => page.locator('.reading-pane').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(200)
    const offset = () =>
      article
        .locator(`[data-reading-block="${anchor}"]`)
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            (element.closest('.reading-pane')?.getBoundingClientRect().top ?? 0),
        )
    await expect.poll(async () => Math.abs((await offset()) + 12)).toBeLessThanOrEqual(1)
    // Select via keyboard-like DOM interaction without scrolling the offscreen control into view.
    await page.locator('#reading-layout').evaluate((element) => {
      ;(element as HTMLSelectElement).value = 'interlinear'
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(article.locator('.reading-interlinear')).toHaveCount(1)
    await expect.poll(async () => Math.abs((await offset()) + 12)).toBeLessThanOrEqual(1)
    await article
      .locator('.reading-pair')
      .first()
      .evaluate((element) => element.setAttribute('style', 'min-height: 800px'))
    await expect.poll(async () => Math.abs((await offset()) + 12)).toBeLessThanOrEqual(1)
    expect(calls).toBe(count)
    await page.locator('#reading-layout').evaluate((element) => {
      ;(element as HTMLSelectElement).value = 'side-by-side'
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(article.locator('.reading-side-by-side')).toHaveCount(1)
    const htmlPath = join(directory, 'bilingual.html')
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, htmlPath)
    await clickDocumentAction(page, 'Export reading HTML…')
    await expect(page.getByText(`Exported to ${htmlPath}`, { exact: true })).toBeVisible({
      timeout: 20000,
    })
    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('manuslip-reading-layout" content="side-by-side"')
    expect(html).toContain('manuslip-target-language" content="zh-CN"')
    expect(html).toContain('Hello reader')
    expect(html).toContain('你好，欢迎阅读这份跨语言文档 reader')
    expect(html.match(/<code>PRIVATE_ONE<\/code>/g)).toHaveLength(2)
    expect(html).toContain('data:image/png;base64,')
    expect(html).not.toMatch(/<script|foreignObject|data-export-slot|manuslip-asset:/)
    await writeFile(test.info().outputPath('bilingual-example.html'), html)
    const artifactPromise = application.waitForEvent('window')
    await application.evaluate(async ({ BrowserWindow }, path) => {
      const artifact = new BrowserWindow({
        show: true,
        width: 1000,
        height: 800,
        webPreferences: {
          partition: 'bilingual-artifact-test',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      await artifact.loadFile(path)
    }, htmlPath)
    const artifact = await artifactPromise
    await expect(artifact.locator('.reading-pair').first().locator(':scope > div')).toHaveCount(2)
    expect(
      await artifact
        .locator('.reading-pair')
        .first()
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    ).toBe(2)
    await artifact.screenshot({ path: test.info().outputPath('bilingual-export.png') })
    await artifact.setViewportSize({ width: 320, height: 720 })
    expect(await artifact.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    )
    await artifact.close()
    await page.bringToFront()
    const pdfPath = join(directory, 'bilingual.pdf')
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, pdfPath)
    await clickDocumentAction(page, 'Export reading PDF…')
    await expect(page.getByText(`Exported to ${pdfPath}`, { exact: true })).toBeVisible({
      timeout: 20000,
    })
    const pdf = await PDFDocument.load(await readFile(pdfPath))
    expect(pdf.getPageCount()).toBeGreaterThan(1)
    expect(
      pdf.context
        .enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFDict && object.has(PDFName.of('ToUnicode'))),
    ).toBe(true)
    // The native menu uses the visible reading mode too, including target-only exports.
    await selectReadingLayout(page, 'replace')
    const targetPath = join(directory, 'target-only.html')
    await application.evaluate(({ dialog, Menu, BrowserWindow }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === 'Export HTML…')
      if (!item) throw new Error('Missing native export')
      item.click(item, BrowserWindow.getFocusedWindow() ?? undefined, {} as Electron.KeyboardEvent)
    }, targetPath)
    await expect(page.getByText(`Exported to ${targetPath}`, { exact: true })).toBeVisible({
      timeout: 15000,
    })
    const targetHtml = await readFile(targetPath, 'utf8')
    expect(targetHtml).toContain('<html lang="zh-CN">')
    expect(targetHtml).toContain('你好，欢迎阅读这份跨语言文档 reader')
    expect(targetHtml).not.toContain('Hello reader')
    expect(targetHtml).not.toContain('class="reading-original"')
    await selectReadingLayout(page, 'side-by-side')
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.locator('#theme').selectOption('dark')
    await page.keyboard.press('Escape')
    await page.locator('.reading-pane').evaluate((element) => {
      element.scrollTop = 0
    })
    await page.screenshot({ path: test.info().outputPath('bilingual-dark.png') })
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.locator('#locale').selectOption('zh-CN')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 320, height: 720 })
    await openReadingOptions(page)
    await page.getByLabel('阅读布局', { exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await article.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({ path: test.info().outputPath('bilingual-narrow-chinese.png') })
    await page.setViewportSize({ width: 1160, height: 780 })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await (await application.browserWindow(page)).evaluate((window) => {
      window.setContentSize(1160, 780)
      window.webContents.setZoomFactor(2)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(580)
    await openReadingOptions(page)
    await page.getByLabel('阅读布局', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByLabel('阅读布局', { exact: true })).toBeInViewport({ ratio: 1 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('bilingual-zoom-chinese.png') })
    expect(calls).toBe(count)
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('partial and stale export choices preserve the clicked copy despite late results, layout changes and source edits', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-capture-'))
  const path = join(directory, 'capture.md')
  const source = '# Hello captured\n\nHello first pending.\n\nHello second pending.'
  await writeFile(path, source)
  const waiting: { reply: ServerResponse; text: string }[] = []
  let calls = 0
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const text: string = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content
    calls++
    if (text.includes('pending')) waiting.push({ reply, text })
    else answer(reply, text)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello captured')
    await page.evaluate(
      (value) => window.manuslip.configureTranslation(value),
      settings(`http://127.0.0.1:${address.port}/chat`),
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await selectReadingLayout(page, 'side-by-side')
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => waiting.length).toBe(2)
    await expect(page.locator('.reading-article')).toContainText(
      '你好，欢迎阅读这份跨语言文档 captured',
    )
    const htmlPath = join(directory, 'partial.html')
    await application.evaluate(({ dialog }, path) => {
      process.env.MANUSLIP_READING_DIALOGS = '0'
      dialog.showSaveDialog = async () => {
        process.env.MANUSLIP_READING_DIALOGS = String(
          Number(process.env.MANUSLIP_READING_DIALOGS) + 1,
        )
        return { canceled: false, filePath: path }
      }
    }, htmlPath)
    await openDocumentActions(page)
    await page.getByRole('button', { name: 'Export reading HTML…', exact: true }).focus()
    await page.keyboard.press('Enter')
    const choice = page.getByRole('group', {
      name: 'Export the captured reading copy?',
      exact: true,
    })
    await expect(choice).toContainText('2 untranslated prose units')
    await expect(
      choice.getByRole('button', { name: 'Export this copy', exact: true }),
    ).toBeFocused()
    expect(await application.evaluate(() => process.env.MANUSLIP_READING_DIALOGS)).toBe('0')
    await page.screenshot({ path: test.info().outputPath('bilingual-partial-choice.png') })
    await selectReadingLayout(page, 'interlinear')
    for (const pending of waiting) answer(pending.reply, pending.text)
    await waitForReading(page)
    await expect(page.locator('.reading-article')).toContainText(
      '你好，欢迎阅读这份跨语言文档 first pending.',
    )
    await page.keyboard.press(`${modifier}+1`)
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.locator('.cm-content').focus()
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.type('\n\nLATER SOURCE EDIT')
    await expect(page.locator('.cm-content')).toContainText('LATER SOURCE EDIT')
    await page.keyboard.press(`${modifier}+3`)
    await expect(
      page.getByRole('button', { name: 'Translated preview', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(choice).toContainText('Side by side')
    await expect(choice).toContainText('2 untranslated prose units')
    await choice.getByRole('button', { name: 'Export this copy', exact: true }).click()
    await expect(
      page.getByText(`Exported to ${htmlPath}. Edits made after export started are not included.`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 })
    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('manuslip-reading-layout" content="side-by-side"')
    expect(html).toContain('1 of 3 prose units translated')
    expect(html).toContain('Untranslated units retain their source text.')
    expect(html).toContain('Hello first pending.')
    expect(html).not.toContain('你好，欢迎阅读这份跨语言文档 first pending.')
    expect(html).not.toContain('LATER SOURCE EDIT')
    expect(await application.evaluate(() => process.env.MANUSLIP_READING_DIALOGS)).toBe('1')
    expect(calls).toBe(3)
    // A new capture now includes all completed results but still explicitly identifies stale source.
    await clickDocumentAction(page, 'Export reading HTML…')
    await expect(choice).toContainText('This copy excludes later source edits.')
    await expect(choice).toContainText('Interlinear')
    await expect(choice).not.toContainText('untranslated prose units')
    await choice.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Document actions', exact: true })).toBeFocused()
    expect(await readFile(htmlPath, 'utf8')).toBe(html)
    expect(await application.evaluate(() => process.env.MANUSLIP_READING_DIALOGS)).toBe('1')
    await clickDocumentAction(page, 'Export reading HTML…')
    await page.screenshot({ path: test.info().outputPath('bilingual-stale-choice.png') })
    await choice.getByRole('button', { name: 'Export this copy', exact: true }).click()
    await expect(
      page.getByText(`Exported to ${htmlPath}. Edits made after export started are not included.`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 15000 })
    const staleHtml = await readFile(htmlPath, 'utf8')
    expect(staleHtml).toContain('manuslip-reading-layout" content="interlinear"')
    expect(staleHtml).toContain('manuslip-stale-copy" content="true"')
    expect(staleHtml).toContain('This copy excludes later source edits.')
    expect(staleHtml).toContain('你好，欢迎阅读这份跨语言文档 first pending.')
    expect(staleHtml).not.toContain('LATER SOURCE EDIT')
    await expect(page.getByRole('button', { name: 'Document actions', exact: true })).toBeFocused()
    // Returning to Source restores ordinary exports of the current editable document.
    await page.keyboard.press(`${modifier}+1`)
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await clickDocumentAction(page, 'Export HTML…')
    await expect(page.getByText(`Exported to ${htmlPath}`, { exact: true })).toBeVisible({
      timeout: 15000,
    })
    const sourceHtml = await readFile(htmlPath, 'utf8')
    expect(sourceHtml).toContain('LATER SOURCE EDIT')
    expect(sourceHtml).not.toContain('manuslip-reading-layout')
    expect(sourceHtml).not.toContain('你好，欢迎阅读这份跨语言文档')
    expect(calls).toBe(3)
    await expect(page.locator('.cm-content')).toContainText('LATER SOURCE EDIT')
    await page.keyboard.press(`${modifier}+3`)
    await clickDocumentAction(page, 'Export reading HTML…')
    await expect(choice).toBeVisible()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('tab', { name: /capture\.md/ }).click()
    await expect(choice).toHaveCount(0)
    expect(await application.evaluate(() => process.env.MANUSLIP_READING_DIALOGS)).toBe('3')
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('a late translation above the reader preserves its block and pixel offset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-anchor-'))
  const path = join(directory, 'anchor.md')
  const source = [
    'Hello leading.',
    ...Array.from(
      { length: 20 },
      (_, i) => `Hello paragraph ${i}. ${'Source text for reading. '.repeat(12)}`,
    ),
  ].join('\n\n')
  await writeFile(path, source)
  let leading: ServerResponse | undefined
  let calls = 0
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const text: string = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[1].content
    calls++
    if (text === 'Hello leading.') leading = reply
    else answer(reply, text)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello leading.')
    await page.evaluate(
      (value) => window.manuslip.configureTranslation(value),
      settings(`http://127.0.0.1:${address.port}/chat`),
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await selectReadingLayout(page, 'side-by-side')
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => calls).toBe(21)
    await expect(page.getByText('20 of 21 prose units translated · 0 cached')).toBeVisible()
    await expect(page.locator('.reading-article')).toContainText('Hello paragraph 19.')
    await expect(page.locator('.reading-article')).not.toContainText(
      '你好，欢迎阅读这份跨语言文档 paragraph 19.',
    )
    const pair = page.locator('.reading-pair').nth(10)
    const id = await pair.getAttribute('data-reading-block')
    await pair.evaluate((element) => {
      const pane = element.closest('.reading-pane')
      const controls = pane?.querySelector('.reading-controls')
      if (pane && controls)
        pane.scrollTop +=
          element.getBoundingClientRect().top - controls.getBoundingClientRect().bottom + 17
    })
    const offset = () =>
      pair.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          (element
            .closest('.reading-pane')
            ?.querySelector('.reading-controls')
            ?.getBoundingClientRect().bottom ?? 0),
      )
    // Chromium may quantize scrollTop to device pixels. Capture the achieved
    // offset, then verify that the late translation preserves it.
    await expect.poll(async () => Math.abs((await offset()) + 17)).toBeLessThanOrEqual(1)
    const beforeTranslation = await offset()
    if (!leading) throw new Error('Missing held translation')
    answer(
      leading,
      `Hello leading. ${'A much longer translated passage changes the height above the reader. '.repeat(90)}`,
    )
    await expect(page.locator('.reading-translation').first()).toContainText(
      'A much longer translated passage',
    )
    await expect.poll(offset).toBeCloseTo(beforeTranslation, 0)
    expect(await pair.getAttribute('data-reading-block')).toBe(id)
    expect(
      await page
        .locator('.reading-pair')
        .first()
        .evaluate((element) => element.getBoundingClientRect().height),
    ).toBeGreaterThan(1000)
    await page.screenshot({ path: test.info().outputPath('bilingual-late-anchor.png') })
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
