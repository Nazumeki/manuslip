import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import axe from 'axe-core'
import { clickDocumentAction, launchDesktop, selectReadingLayout, waitForReading } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
async function stop(application: ElectronApplication): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}

test('reading presentations and images retain each bilingual layout without new translation requests', async () => {
  test.setTimeout(90_000)
  const directory = await mkdtemp(resolve('test/e2e/result/presentation-reading-'))
  if (!directory.startsWith(resolve('test/e2e/result') + sep))
    throw new Error('Unsafe fixture path')
  const path = join(directory, 'reading.md')
  const original =
    '# Hello first\r\n\r\nHello with $x^2$ and a note[^a].\r\n\r\n```mermaid\r\nflowchart LR\r\nA-->B\r\n```\r\n\r\n---\r\n\r\n# Hello second\r\n\r\nHello conclusion.\r\n\r\n[^a]: Hello reference.\r\n'
  await writeFile(path, original)
  let requests = 0
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests++
    reply.setHeader('Content-Type', 'application/json')
    reply.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: input.messages[1].content.replaceAll('Hello', '你好'),
            },
          },
        ],
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    const configuration: TranslationSettings = {
      provider: {
        adapter: 'openai-compatible',
        version: '1',
        baseUrl: `http://127.0.0.1:${address.port}/chat`,
        model: 'local-presentation-test',
        profile: null,
        options: {},
      },
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN',
      glossary: [],
      formality: 'default',
      promptVersion: 'prose-translation/v1',
    }
    expect(
      await page.evaluate((value) => window.manuslip.configureTranslation(value), configuration),
    ).toMatchObject({ ok: true })
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await waitForReading(page)
    const completed = requests
    expect(completed).toBeGreaterThan(0)
    for (const layout of ['replace', 'side-by-side', 'interlinear']) {
      await selectReadingLayout(page, layout)
      const created = application.waitForEvent('window', {
        predicate: (page) => page.url().includes('/print/index.html'),
      })
      await clickDocumentAction(page, 'Present reading copy')
      const view = await created
      await expect(view.locator('body')).toHaveClass(/presentation/)
      await expect(view.locator('#presentation-controls [role="status"]')).toHaveText('1 / 2')
      await expect(view.locator('.presentation-slide:visible h1').last()).toContainText(
        '你好 first',
      )
      if (layout !== 'replace') {
        await expect(view.locator('.presentation-slide:visible .reading-original h1')).toHaveText(
          'Hello first',
        )
        await expect(
          view.locator('.presentation-slide:visible .reading-translation h1'),
        ).toHaveText('你好 first')
      }
      await expect(
        view.locator('.presentation-slide:visible [data-export-kind="math"] svg').first(),
      ).toBeVisible()
      await expect(
        view.locator('.presentation-slide:visible [data-export-kind="diagram"] svg').first(),
      ).toBeVisible()
      if (layout === 'replace') {
        await selectReadingLayout(page, 'side-by-side')
        await expect(view.locator('.presentation-slide:visible .reading-replace')).toBeVisible()
        await expect(view.locator('.presentation-slide:visible .reading-original')).toHaveCount(0)
        await selectReadingLayout(page, layout)
      }
      await audit(view, `reading-${layout}-wide`)
      await view.locator('.presentation-slide:visible a[href^="#"]').first().click()
      await expect(view.locator('#presentation-controls [role="status"]')).toHaveText('2 / 2')
      await view.keyboard.press('Home')
      await narrow(application, view)
      await audit(view, `reading-${layout}-narrow`)
      await view.keyboard.press('Escape').catch((error: unknown) => {
        if (!view.isClosed()) throw error
      })
      await expect.poll(() => view.isClosed()).toBe(true)
      for (const format of ['png', 'jpeg'] as const) {
        const target = join(directory, `${layout}.${format}`)
        await application.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        }, target)
        await clickDocumentAction(page, `Export reading ${format.toUpperCase()}…`)
        await expect(page.getByText(`Exported to ${target}`, { exact: true })).toBeVisible({
          timeout: 20_000,
        })
        const stats = await imageStats(application, target)
        expect(stats).toMatchObject({ empty: false, width: 1024 })
        expect(stats.height).toBeGreaterThan(300)
        const info = test.info()
        await info.attach(`reading-${layout}-${format}`, {
          body: await readFile(target),
          contentType: `image/${format}`,
        })
      }
      expect(requests).toBe(completed)
      expect(await readFile(path, 'utf8')).toBe(original)
    }
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const editor = page.locator('.cm-content')
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await editor.press(`${modifier}+End`)
    await editor.press('Enter')
    await editor.type('Later source')
    await editor.press(`${modifier}+s`)
    await expect
      .poll(async () => (await readFile(path, 'utf8')).endsWith('Later source'))
      .toBe(true)
    const edited = await readFile(path, 'utf8')
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await clickDocumentAction(page, 'Present reading copy')
    await expect(page.getByRole('group', { name: 'Present this reading copy?' })).toBeVisible()
    const created = application.waitForEvent('window', {
      predicate: (page) => page.url().includes('/print/index.html'),
    })
    await page.getByRole('button', { name: 'Present this copy', exact: true }).click()
    const view = await created
    await expect(view.locator('body')).toHaveClass(/presentation/)
    await expect(view.locator('#document')).toContainText('你好')
    await clickDocumentAction(page, 'Close presentation')
    await expect.poll(() => view.isClosed()).toBe(true)
    expect(requests).toBe(completed)
    expect(await readFile(path, 'utf8')).toBe(edited)
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('presentation and image limits retain the document and previous destination, and a crashed view can restart', async () => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(resolve('test/e2e/result/presentation-recovery-'))
  if (!directory.startsWith(resolve('test/e2e/result') + sep))
    throw new Error('Unsafe fixture path')
  const target = join(directory, 'previous.png')
  await writeFile(target, 'previous image')
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.locator('.cm-content')
    await clickDocumentAction(page, 'Present document')
    await expect(page.getByRole('alert')).toHaveText(
      'Add slide content before starting a presentation.',
    )
    await editor.fill(
      Array.from({ length: 201 }, (_, index) => `# Slide ${index}\n\nContent\n\n`).join(''),
    )
    await clickDocumentAction(page, 'Present document')
    await expect(page.getByRole('alert')).toContainText('exceeds 200 slides')
    const tall = `# Tall document\n\n${'A complete paragraph.\n\n'.repeat(600)}`
    await editor.fill(tall)
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, target)
    await clickDocumentAction(page, 'Export PNG…')
    await expect(page.getByRole('alert')).toHaveText(
      'This image exceeds its size limit. Use PDF or a shorter document.',
    )
    expect(await readFile(target, 'utf8')).toBe('previous image')
    expect(await editor.textContent()).toContain('A complete paragraph.')
    await editor.fill('# A fresh presentation\n\nUsable after rejection.\n')
    let created = application.waitForEvent('window', {
      predicate: (page) => page.url().includes('/print/index.html'),
    })
    await clickDocumentAction(page, 'Present document')
    let view = await created
    await expect(view.locator('body')).toHaveClass(/presentation/)
    await application.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('/print/index.html'),
      )
      if (!view) throw new Error('Missing presentation')
      view.webContents.forcefullyCrashRenderer()
    })
    await expect(page.getByRole('alert')).toContainText('Export could not render the document.')
    await expect.poll(() => view.isClosed()).toBe(true)
    created = application.waitForEvent('window', {
      predicate: (page) => page.url().includes('/print/index.html'),
    })
    await clickDocumentAction(page, 'Present document')
    view = await created
    await expect(view.locator('body')).toHaveClass(/presentation/)
    await view
      .getByRole('button', { name: 'Exit presentation', exact: true })
      .click()
      .catch((error: unknown) => {
        if (!view.isClosed()) throw error
      })
    await expect.poll(() => view.isClosed()).toBe(true)
    await editor.focus()
    await editor.press(`${modifier}+z`)
    expect(await readFile(target, 'utf8')).toBe('previous image')
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
async function audit(page: Page, name: string): Promise<void> {
  const info = test.info()
  await page.evaluate(axe.source)
  const result = await page.evaluate(async () => {
    const value = await (window as unknown as { axe: typeof import('axe-core') }).axe.run(
      document,
      {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
      },
    )
    return {
      version: value.testEngine.version,
      violations: value.violations,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  await info.attach(`${name}-accessibility`, {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(result.violations).toEqual([])
  expect(result.overflow).toBe(false)
  await info.attach(`${name}-tree`, {
    body: await page.locator('body').ariaSnapshot(),
    contentType: 'text/plain',
  })
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await test.info().attach(name, { path, contentType: 'image/png' })
}
async function narrow(application: ElectronApplication, page: Page): Promise<void> {
  await application.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('/print/index.html'),
    )
    if (!view) throw new Error('Missing presentation window')
    if (view.isFullScreen()) {
      const left = new Promise<void>((resolve) => view.once('leave-full-screen', () => resolve()))
      view.setFullScreen(false)
      await left
    }
    view.setContentSize(420, 900)
  })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(420)
}
async function imageStats(application: ElectronApplication, path: string) {
  const encoded = (await readFile(path)).toString('base64')
  return application.evaluate(({ nativeImage }, encoded) => {
    const bytes = Buffer.from(encoded, 'base64'),
      image = nativeImage.createFromBuffer(bytes)
    const size = image.getSize(),
      bitmap = image.toBitmap()
    let coloredTail = 0
    for (
      let offset = Math.max(0, bitmap.length - size.width * 200 * 4);
      offset < bitmap.length;
      offset += 4
    ) {
      const channels = [bitmap[offset] || 0, bitmap[offset + 1] || 0, bitmap[offset + 2] || 0].sort(
        (a, b) => b - a,
      )
      if ((channels[0] || 0) > 160 && (channels[1] || 0) < 120 && bitmap[offset + 3] === 255)
        coloredTail++
    }
    return {
      ...size,
      signature: bytes.subarray(0, 8).toString('hex'),
      coloredTail,
      empty: image.isEmpty(),
    }
  }, encoded)
}
const source = (
  'token keep token\n\n# Hello slides 中文\n\nA snapshot with math $x^2$ and $\\ce{H2O}$.\n\n![Local pixel](pixel.png)\n\n```mermaid\nflowchart LR\nWrite[Write 写作]-->Share[Share 分享]\n```\n\n---\n\n# Second slide\n\n| Name | Detail |\n| --- | --- |\n| Hello | World |\n\n' +
  Array.from(
    { length: 20 },
    (_, index) =>
      `Paragraph ${index + 1}. Complete content stays in the image, including the end.\n\n`,
  ).join('') +
  '## Image end marker\n'
).replaceAll('\n', '\r\n')

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} presentation and raster exports preserve source, complete content and isolated assets`, async () => {
    test.setTimeout(90_000)
    const directory = await mkdtemp(resolve('test/e2e/result/presentation-'))
    if (!directory.startsWith(resolve('test/e2e/result') + sep))
      throw new Error('Unsafe fixture path')
    const profile = join(directory, 'profile'),
      path = join(directory, 'slides.md'),
      css = join(directory, 'local.css')
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({ schemaVersion: 1, locale, theme: locale === 'en' ? 'light' : 'dark' }),
    )
    await writeFile(path, source)
    await writeFile(css, 'h2 { background-color: #2458ca; color: white; padding: 24px; }')
    const application = await launchDesktop(profile, [path])
    try {
      const page = await application.firstWindow(),
        chinese = locale === 'zh-CN'
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const pixel = await application.evaluate(({ nativeImage }) =>
        nativeImage
          .createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
          .toPNG()
          .toString('base64'),
      )
      await writeFile(join(directory, 'pixel.png'), Buffer.from(pixel, 'base64'))
      await page.getByRole('button', { name: chinese ? '源码' : 'Source', exact: true }).click()
      const editor = page.locator('.cm-content')
      await clickDocumentAction(page, chinese ? '文档外观' : 'Document appearance')
      await application.evaluate(({ dialog }, css) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [css] })
      }, css)
      const appearance = page.getByRole('dialog', {
        name: chinese ? '文档外观' : 'Document appearance',
        exact: true,
      })
      await appearance
        .getByRole('button', { name: chinese ? '导入 CSS…' : 'Import CSS…', exact: true })
        .click()
      await expect(appearance.getByText('local.css', { exact: true })).toBeVisible()
      await appearance
        .getByRole('button', { name: chinese ? '关闭' : 'Close', exact: true })
        .click()
      await editor.focus()
      await editor.press(`${modifier}+Home`)
      await editor.press(`${modifier}+d`)
      await editor.press(`${modifier}+d`)
      await editor.evaluate((element) => {
        ;(window as unknown as { presentationEditor: Element }).presentationEditor = element
      })
      const created = application.waitForEvent('window', {
        predicate: (page) => page.url().includes('/print/index.html'),
      })
      await clickDocumentAction(page, chinese ? '演示文档' : 'Present document')
      const view = await created
      view.on('pageerror', (error) => errors.push(error.message))
      await expect(view.locator('body')).toHaveClass(/presentation/)
      await expect(view.locator('#presentation-controls [role="status"]')).toHaveText('1 / 2')
      await expect(view.locator('.presentation-slide:visible h1')).toContainText(
        'Hello slides 中文',
      )
      await expect(
        view.locator('.presentation-slide:visible [data-export-kind="math"] svg').first(),
      ).toBeVisible()
      await expect(
        view.locator('.presentation-slide:visible [data-export-kind="diagram"] svg'),
      ).toBeVisible()
      expect(
        await view
          .locator('.presentation-slide:visible img')
          .evaluate((element) => (element as HTMLImageElement).naturalWidth),
      ).toBe(1)
      expect(await view.evaluate(() => typeof Reflect.get(window, 'require'))).toBe('undefined')
      await audit(view, 'presentation-wide')
      await view.keyboard.press('ArrowRight')
      await expect(view.locator('#presentation-controls [role="status"]')).toHaveText('2 / 2')
      await expect(view.locator('.presentation-slide:visible table')).toBeVisible()
      await view.keyboard.press('Home')
      await expect(view.locator('#presentation-controls [role="status"]')).toHaveText('1 / 2')
      await view.keyboard.press('End')
      await expect(
        view.getByRole('button', { name: chinese ? '下一张幻灯片' : 'Next slide' }),
      ).toBeDisabled()
      await view.getByRole('button', { name: chinese ? '上一张幻灯片' : 'Previous slide' }).click()
      await narrow(application, view)
      await audit(view, 'presentation-narrow')
      await view.keyboard.press('Escape').catch((error: unknown) => {
        if (!view.isClosed()) throw error
      })
      await expect.poll(() => view.isClosed()).toBe(true)
      await expect(
        page.getByText(chinese ? '演示已关闭。' : 'Presentation closed.', { exact: true }),
      ).toBeVisible()
      expect(
        await editor.evaluate(
          (element) =>
            (window as unknown as { presentationEditor: Element }).presentationEditor === element,
        ),
      ).toBe(true)
      await editor.focus()
      await page.keyboard.type('X')
      await editor.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(source.replace('token keep token', 'X keep X'))
      await editor.press(`${modifier}+z`)
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
      for (const format of ['png', 'jpeg'] as const) {
        const target = join(directory, `snapshot.${format}`)
        await application.evaluate(({ dialog }, target) => {
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        }, target)
        await clickDocumentAction(
          page,
          chinese ? `导出 ${format.toUpperCase()}…` : `Export ${format.toUpperCase()}…`,
        )
        await expect(
          page.getByText(chinese ? `已导出至 ${target}` : `Exported to ${target}`, { exact: true }),
        ).toBeVisible({ timeout: 20_000 })
        const stats = await imageStats(application, target)
        expect(stats.empty).toBe(false)
        expect(stats.width).toBe(1024)
        expect(stats.height).toBeGreaterThan(1400)
        expect(stats.height).toBeLessThanOrEqual(8192)
        expect(stats.width * stats.height).toBeLessThanOrEqual(16_000_000)
        expect(stats.coloredTail).toBeGreaterThan(5000)
        if (format === 'png') expect(stats.signature).toBe('89504e470d0a1a0a')
        else expect(stats.signature.startsWith('ffd8')).toBe(true)
        const info = test.info()
        await info.attach(`raster-${format}`, {
          body: await readFile(target),
          contentType: `image/${format}`,
        })
        await info.attach(`raster-${format}-geometry`, {
          body: JSON.stringify(stats),
          contentType: 'application/json',
        })
      }
      expect(await readFile(path, 'utf8')).toBe(source)
      expect(errors).toEqual([])
    } finally {
      await stop(application)
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
