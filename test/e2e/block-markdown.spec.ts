import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import axe from 'axe-core'
import { clickDocumentAction, launchDesktop, waitForReading } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const sequence =
  'Title: Review 审阅\r\nparticipant "Writer 作者" as W\r\nparticipant Reader\r\nW->Reader: Send draft 发送\r\nNote over W,Reader: Private diagram message\r\nReader-->>W: Ready 完成'
const flow =
  's=>start: 开始\r\nop=>operation: Review "<draft>" & keep #35;\r\nc=>condition: Ready?\r\ne=>end: 完成\r\ns->op->c\r\nc(yes)->e\r\nc(no)->op'
const source = `# Field notes 笔记\r\n\r\nTerm :smile:\r\n: Hello **world** and \`private-one\`.\r\n: Details [manual][manual].\r\n\r\nTerm :heart:\r\n: Hello **world** and \`private-two\`.\r\n\r\n| Key | Value |\r\n| --- | --- |\r\n| : literal | H~2~O |\r\n\r\n\`\`\`seq\r\n${sequence}\r\n\`\`\`\r\n\r\n\`\`\`FLOW\r\n${flow}\r\n\`\`\`\r\n\r\n[manual]: https://example.invalid/private-reference\r\n\r\nEnd.\r\n`
const labels = {
  en: {
    source: 'Source',
    live: 'Live Preview',
    reading: 'Translated preview',
    translate: 'Translate',
    export: 'Export HTML…',
    unsupported:
      'This legacy diagram uses unsupported syntax. Edit its source or convert it to a Mermaid fence.',
  },
  'zh-CN': {
    source: '源码',
    live: '实时预览',
    reading: '译文预览',
    translate: '翻译',
    export: '导出 HTML…',
    unsupported: '此旧版图表使用了暂不支持的语法。请编辑源码，或将其转换为 Mermaid 代码块。',
  },
}
async function stop(application: ElectronApplication) {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}
async function audit(page: Page, name: string) {
  await page.evaluate(axe.source)
  const result = await page.evaluate(async () => {
    const checker = (window as unknown as { axe: typeof import('axe-core') }).axe
    const result = await checker.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    })
    return {
      version: result.testEngine.version,
      violations: result.violations,
      incomplete: result.incomplete,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  await test.info().attach(`${name}-accessibility`, {
    body: JSON.stringify(result),
    contentType: 'application/json',
  })
  expect(result.violations).toEqual([])
  expect(result.overflow).toBe(false)
  await test.info().attach(`${name}-tree`, {
    body: await page.locator('body').ariaSnapshot(),
    contentType: 'text/plain',
  })
  const path = test.info().outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`${locale} definition lists and legacy diagrams preserve editing, translation and export`, async () => {
    test.setTimeout(60_000)
    const directory = await mkdtemp(resolve('test/e2e/result/block-markdown-'))
    if (!resolve(directory).startsWith(resolve('test/e2e/result') + sep))
      throw new Error('Unsafe fixture path')
    const profile = join(directory, 'profile'),
      path = join(directory, 'blocks.md'),
      target = join(directory, 'blocks.html')
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({ schemaVersion: 1, locale, theme: locale === 'en' ? 'light' : 'dark' }),
    )
    await writeFile(path, source)
    const received: string[] = [],
      errors: string[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      received.push(raw)
      const input = JSON.parse(raw)
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: input.messages[1].content
                  .replaceAll('Hello', '你好')
                  .replaceAll('world', '世界')
                  .replaceAll('Term', '术语'),
              },
            },
          ],
        }),
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback address')
    let application = await launchDesktop(profile, [path])
    try {
      const page = await application.firstWindow(),
        names = labels[locale]
      page.on('pageerror', (error) => errors.push(error.message))
      await page.getByRole('button', { name: names.source, exact: true }).click()
      const editor = page.locator('.cm-content')
      await expect(editor).toContainText('Term :smile:')
      await page.getByRole('button', { name: names.live, exact: true }).click()
      await expect(page.locator('.cm-live-defList dt')).toHaveText(['Term 😄', 'Term ❤️'])
      await expect(page.locator('.cm-live-defList dd')).toHaveCount(3)
      await expect(page.locator('.cm-live-table td').first()).toHaveText(': literal')
      const diagrams = page.locator('.cm-live-diagram svg')
      await expect(diagrams.first()).toContainText('Writer 作者')
      await expect(diagrams.first()).toContainText('Send draft 发送')
      // Live Preview mounts block widgets around the viewport.
      await editor.press(`${modifier}+End`)
      const flowDiagram = page.locator('.cm-live-diagram svg[aria-roledescription="flowchart-v2"]')
      await expect(flowDiagram).toContainText('Review')
      await expect(flowDiagram).toContainText('"<draft>"')
      await expect(flowDiagram).toContainText('#35;')
      await expect(flowDiagram).not.toContainText('&#')
      const scale = await flowDiagram.evaluate((element) => {
        const svg = element as SVGSVGElement
        return svg.getBoundingClientRect().width / svg.viewBox.baseVal.width
      })
      expect(scale).toBeGreaterThan(0)
      expect(scale).toBeLessThanOrEqual(1.01)
      await expect(
        diagrams.locator('script, foreignObject, a, image, [onload], [onclick]'),
      ).toHaveCount(0)
      await audit(page, 'blocks-flow-wide')
      await editor.press(`${modifier}+Home`)
      await page.locator('.cm-live-defList dt').first().click()
      await editor.press('Shift+ArrowRight')
      await expect(editor).toContainText('Term :smile:')
      await expect(editor).toContainText('**world** and `private-one`')
      await editor.press(`${modifier}+End`)
      await editor.press(`${modifier}+Home`)
      await expect(page.locator('.cm-live-defList dt')).toHaveCount(2)
      await audit(page, 'blocks-live-wide')
      await editor.press(`${modifier}+End`)
      await page.keyboard.insertText('Edited 世界')
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${source}Edited 世界`)
      await page.keyboard.press(`${modifier}+z`)
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(`${source}Edited 世界`)
      await page.keyboard.press(`${modifier}+z`)
      await page.keyboard.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, target)
      await clickDocumentAction(page, names.export)
      await expect
        .poll(async () => readFile(target, 'utf8').catch(() => ''), { timeout: 20_000 })
        .toContain('<dt>Term')
      await expect
        .poll(async () => readFile(target, 'utf8').catch(() => ''))
        .toContain('data-export-kind="diagram"')
      const html = await readFile(target, 'utf8')
      expect(html.match(/<[^>]+data-export-kind="diagram"/g)).toHaveLength(2)
      expect(html).toContain('Send draft 发送')
      expect(html).toContain('private-one')
      expect(html).toContain(': literal')
      expect(html).not.toMatch(/<script|<foreignObject|<img[^>]+src="https?:/i)
      await test.info().attach('block-export', { body: html, contentType: 'text/html' })
      const settings: TranslationSettings = {
        provider: {
          adapter: 'openai-compatible',
          version: '1',
          baseUrl: `http://127.0.0.1:${address.port}/chat`,
          model: 'local-test-model',
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
        await page.evaluate((value) => window.manuslip.configureTranslation(value), settings),
      ).toMatchObject({ ok: true })
      await page.getByRole('button', { name: names.reading, exact: true }).click()
      expect(received).toHaveLength(0)
      await page.getByRole('button', { name: names.translate, exact: true }).click()
      await waitForReading(page)
      const article = page.locator('.reading-article')
      await expect(article.locator('dt')).toHaveText(['术语 😄', '术语 ❤️'])
      await expect(article.locator('dd strong')).toHaveText(['世界', '世界'])
      await expect(article.locator('dd code')).toHaveText(['private-one', 'private-two'])
      await expect(article.locator('[role="img"] svg')).toHaveCount(2)
      await expect(article.locator('[role="img"] svg').first()).toContainText(
        'Private diagram message',
      )
      for (const secret of [
        'private-one',
        'private-two',
        'Private diagram message',
        'Send draft',
        'example.invalid',
        ':smile:',
        ':heart:',
        '😄',
        '❤️',
      ])
        expect(received.join('\n')).not.toContain(secret)
      await page.setViewportSize({ width: 420, height: 900 })
      await audit(page, 'blocks-reading-narrow')
      expect(await readFile(path, 'utf8')).toBe(source)
      expect(errors).toEqual([])
      await stop(application)
      application = await launchDesktop(profile, [path])
      const reopened = await application.firstWindow()
      await reopened.getByRole('button', { name: names.source, exact: true }).click()
      await expect(reopened.locator('.cm-content')).toContainText('Term :smile:')
      const bytes = await readFile(path)
      expect(bytes).toEqual(Buffer.from(source))
      await test.info().attach('source-save-reopen', {
        body: JSON.stringify({
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
        contentType: 'application/json',
      })
      const unsupported = 'a=>operation: Keep all original source\nb=>end: Done\na(right)->b'
      await reopened
        .locator('.cm-content')
        .fill(`# Unsupported\n\n\`\`\`flowchart\n${unsupported}\n\`\`\`\n\nEnd`)
      await reopened.locator('.cm-content').press(`${modifier}+Home`)
      await reopened.getByRole('button', { name: names.live, exact: true }).click()
      await expect(reopened.locator('.cm-live-diagram pre')).toHaveText(unsupported)
      await expect(reopened.locator('.cm-live-diagram [role="status"]')).toHaveText(
        names.unsupported,
      )
      await application.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath })
      }, target)
      await clickDocumentAction(reopened, names.export)
      await expect(reopened.getByText(names.unsupported, { exact: true })).toHaveCount(2)
      expect(await readFile(target, 'utf8')).toBe(html)
    } finally {
      await stop(application)
      await new Promise<void>((done) => server.close(() => done()))
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
