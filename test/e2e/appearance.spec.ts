import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import axe from 'axe-core'
import { clickDocumentAction, launchDesktop, waitForReading } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const original =
  'token keep token\r\n\r\n# Hello appearance 中文\r\n\r\n> Hello quote.\r\n\r\n| Name | Detail |\r\n| --- | --- |\r\n| Hello | world |\r\n'
const safeCss =
  'h1 { color: light-dark(#315d44, #b8d8a7); font-size: 28px; font-weight: 400; } blockquote { padding-inline-start: 16px; border-left-width: 2px; border-style: solid; } td { padding: 8px; }'
const labels = {
  en: {
    title: 'Document appearance',
    font: 'Font',
    size: 'Text size',
    leading: 'Line spacing',
    measure: 'Writing width',
    import: 'Import CSS…',
    reset: 'Reset defaults',
    close: 'Close',
    source: 'Source',
    live: 'Live Preview',
    reading: 'Translated preview',
    translate: 'Translate',
    export: 'Export reading HTML…',
    confirm: 'Export this copy',
  },
  'zh-CN': {
    title: '文档外观',
    font: '字体',
    size: '字号',
    leading: '行距',
    measure: '写作宽度',
    import: '导入 CSS…',
    reset: '恢复默认',
    close: '关闭',
    source: '源码',
    live: '实时预览',
    reading: '译文预览',
    translate: '翻译',
    export: '导出阅读副本 HTML…',
    confirm: '导出此副本',
  },
}
async function stop(application: ElectronApplication): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}
async function audit(page: Page, name: string): Promise<void> {
  await page.evaluate(axe.source)
  const value = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: typeof import('axe-core') }).axe.run(
      document,
      {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
      },
    )
    return {
      version: result.testEngine.version,
      violations: result.violations,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  await test.info().attach(`${name}-accessibility`, {
    body: JSON.stringify(value),
    contentType: 'application/json',
  })
  expect(value.violations).toEqual([])
  expect(value.overflow).toBe(false)
  await test.info().attach(`${name}-tree`, {
    body: await page.locator('body').ariaSnapshot(),
    contentType: 'text/plain',
  })
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await test.info().attach(name, { path, contentType: 'image/png' })
}
for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} document appearance preserves writing, scopes CSS and survives reading, export and restart`, async () => {
    test.setTimeout(60_000)
    const directory = await mkdtemp(resolve('test/e2e/result/appearance-'))
    if (!directory.startsWith(resolve('test/e2e/result') + sep))
      throw new Error('Unsafe fixture path')
    const profile = join(directory, 'profile'),
      path = join(directory, 'notebook.md'),
      css = join(directory, 'local.css'),
      bad = join(directory, 'unsafe.css'),
      names = labels[locale]
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({ schemaVersion: 1, locale, theme: locale === 'en' ? 'light' : 'dark' }),
    )
    await writeFile(path, original)
    await writeFile(css, safeCss)
    await writeFile(bad, 'button { display: none }')
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
    if (!address || typeof address === 'string') throw new Error('No local server')
    let application = await launchDesktop(profile, [path])
    const errors: string[] = []
    try {
      let page = await application.firstWindow()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.getByRole('button', { name: names.source, exact: true }).click()
      let editor = page.locator('.cm-content')
      await expect(editor).toContainText('token keep token')
      await editor.evaluate((element) => {
        Object.assign(window, { appearanceEditor: element })
      })
      await editor.press(`${modifier}+Home`)
      await editor.press(`${modifier}+d`)
      await editor.press(`${modifier}+d`)
      await clickDocumentAction(page, names.title)
      const dialog = page.getByRole('dialog', { name: names.title, exact: true })
      await dialog.getByLabel(names.font, { exact: true }).selectOption('serif')
      await dialog.getByLabel(names.size, { exact: true }).selectOption('20')
      await dialog.getByLabel(names.leading, { exact: true }).selectOption('1.6')
      await dialog.getByLabel(names.measure, { exact: true }).selectOption('640')
      await application.evaluate(({ dialog }, css) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [css] })
      }, css)
      await dialog.getByRole('button', { name: names.import, exact: true }).click()
      await expect(dialog.getByText('local.css', { exact: true })).toBeVisible()
      await audit(page, 'appearance-wide')
      await application.evaluate(({ dialog }, bad) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [bad] })
      }, bad)
      await dialog.getByRole('button', { name: names.import, exact: true }).click()
      await expect(dialog.getByRole('alert')).toBeVisible()
      await expect(dialog.getByText('local.css', { exact: true })).toBeVisible()
      await audit(page, 'appearance-invalid')
      await page.setViewportSize({ width: 420, height: 900 })
      await audit(page, 'appearance-narrow')
      await page.keyboard.press('Escape')
      await expect(editor).toBeFocused()
      expect(
        await editor.evaluate(
          (element) =>
            (window as unknown as { appearanceEditor: HTMLElement }).appearanceEditor === element,
        ),
      ).toBe(true)
      await expect(editor).toHaveCSS('font-size', '20px')
      await page.keyboard.type('X')
      await editor.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(original.replace('token keep token', 'X keep X'))
      await editor.press(`${modifier}+z`)
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(original)
      await page.setViewportSize({ width: 1144, height: 715 })
      await page.getByRole('button', { name: names.live, exact: true }).click()
      await expect(page.locator('.cm-live-heading-1')).toHaveCSS('font-size', '28px')
      await expect(page.locator('.cm-live-heading-1 span').last()).toHaveCSS(
        'color',
        locale === 'en' ? 'rgb(49, 93, 68)' : 'rgb(184, 216, 167)',
      )
      await expect(page.locator('.cm-live-heading-1 span').last()).toHaveCSS('font-weight', '400')
      await expect(page.locator('.cm-live-table button')).toHaveCount(0)
      await audit(page, 'appearance-live')
      const configuration: TranslationSettings = {
        provider: {
          adapter: 'openai-compatible',
          version: '1',
          baseUrl: `http://127.0.0.1:${address.port}/chat`,
          model: 'local-appearance-test',
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
      await page.getByRole('button', { name: names.reading, exact: true }).click()
      await page.getByRole('button', { name: names.translate, exact: true }).click()
      await waitForReading(page)
      await expect(page.locator('.reading-article h1')).toContainText('你好')
      await expect(page.locator('.reading-article h1')).toHaveCSS('font-size', '28px')
      const completedRequests = requests
      await clickDocumentAction(page, names.title)
      await dialog.getByLabel(names.size, { exact: true }).selectOption('22')
      await dialog.getByRole('button', { name: names.close, exact: true }).click()
      await expect(page.locator('.reading-article')).toHaveCSS('font-size', '22px')
      expect(requests).toBe(completedRequests)
      await page.setViewportSize({ width: 420, height: 900 })
      await audit(page, 'appearance-reading-narrow')
      await page.setViewportSize({ width: 1144, height: 715 })
      const htmlPath = join(directory, 'styled.html')
      await application.evaluate(({ dialog }, target) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
      }, htmlPath)
      await clickDocumentAction(page, names.export)
      await expect
        .poll(
          async () =>
            (await readFile(htmlPath, 'utf8').catch(() => '')).includes(
              'data-document-style="export"',
            ),
          { timeout: 20_000 },
        )
        .toBe(true)
      const html = await readFile(htmlPath, 'utf8')
      expect(html).toContain('font-size:22px')
      expect(html).toContain('font-size:clamp(10px, 28px, 64px)')
      expect(html).toContain('你好')
      await test.info().attach('styled-export', { body: html, contentType: 'text/html' })
      expect(await readFile(path, 'utf8')).toBe(original)
      expect(errors).toEqual([])
      await stop(application)
      application = await launchDesktop(profile, [path])
      page = await application.firstWindow()
      editor = page.locator('.cm-content')
      await expect(editor).toHaveCSS('font-size', '22px')
      await clickDocumentAction(page, names.title)
      await expect(
        page.getByRole('dialog', { name: names.title }).getByText('local.css', { exact: true }),
      ).toBeVisible()
      await page
        .getByRole('dialog', { name: names.title })
        .getByRole('button', { name: names.reset, exact: true })
        .click()
      await page
        .getByRole('dialog', { name: names.title })
        .getByRole('button', { name: names.close, exact: true })
        .click()
      await page.getByRole('button', { name: names.source, exact: true }).click()
      await expect(editor).toHaveCSS('font-size', '15px')
      expect(await readFile(path, 'utf8')).toBe(original)
    } finally {
      await stop(application).catch(() => {})
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}

test('appearance first-save and Save As keep local styles, while failed storage still permits trusted reset and Source', async () => {
  const directory = await mkdtemp(resolve('test/e2e/result/appearance-recovery-'))
  if (!directory.startsWith(resolve('test/e2e/result') + sep))
    throw new Error('Unsafe fixture path')
  const profile = join(directory, 'profile'),
    path = join(directory, 'first.md'),
    second = join(directory, 'second.md'),
    css = join(directory, 'unreadable.css')
  await writeFile(
    css,
    'body { color: white; background-color: white; font-size: 64px; line-height: 3; font-family: serif; }',
  )
  const application = await launchDesktop(profile)
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    const source = '# Appearance\n\n| A | B |\n| --- | --- |\n| one | two |\n\n'
    await editor.fill(source)
    await clickDocumentAction(page, 'Document appearance')
    const dialog = page.getByRole('dialog', { name: 'Document appearance', exact: true })
    await dialog.getByLabel('Text size', { exact: true }).selectOption('20')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await application.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, path)
    await editor.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8').catch(() => '')).toBe(source)
    const storePath = join(profile, 'writing-styles.json')
    await expect
      .poll(
        async () =>
          Object.keys(
            JSON.parse(await readFile(storePath, 'utf8').catch(() => '{"entries":{}}')).entries,
          ).length,
      )
      .toBe(1)
    await application.evaluate(({ dialog }, second) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: second })
    }, second)
    await clickDocumentAction(page, 'Save As…')
    await expect.poll(() => readFile(second, 'utf8').catch(() => '')).toBe(source)
    await expect
      .poll(async () => Object.keys(JSON.parse(await readFile(storePath, 'utf8')).entries).length)
      .toBe(2)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await editor.press(`${modifier}+End`)
    await clickDocumentAction(page, 'Document appearance')
    await application.evaluate(({ dialog }, css) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [css] })
    }, css)
    await dialog.getByRole('button', { name: 'Import CSS…', exact: true }).click()
    await expect(dialog.getByText('unreadable.css', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    const table = page.locator('.cm-live-table').last()
    await expect(table).toBeVisible()
    await expect(table.locator('button')).toHaveCount(0)
    await table.focus()
    await table.press('Enter')
    const cell = page.locator('[data-table-cell-editor]')
    await expect(cell).toBeFocused()
    await expect(cell).toHaveText('A')
    await cell.press('Escape')
    await expect(editor).toBeFocused()
    await expect(cell).toHaveCount(0)
    await clickDocumentAction(page, 'Document appearance')
    const backup = `${storePath}.fixture-backup`
    await rename(storePath, backup)
    await mkdir(storePath)
    await dialog.getByRole('button', { name: 'Reset defaults', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('Saving failed')
    await expect(dialog.getByRole('button', { name: 'Reset defaults', exact: true })).toBeEnabled()
    await expect(dialog.getByText('No custom stylesheet', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Use Source', exact: true }).click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveCSS('font-size', '15px')
    expect(await readFile(second, 'utf8')).toBe(source)
    await rmdir(storePath)
    await rename(backup, storePath)
    await clickDocumentAction(page, 'Document appearance')
    await dialog.getByRole('button', { name: 'Retry save', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect
      .poll(async () => Object.keys(JSON.parse(await readFile(storePath, 'utf8')).entries))
      .toHaveLength(1)
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
