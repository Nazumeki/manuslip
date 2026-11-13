import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { expect, test } from '@playwright/test'
import { readPandocZip } from '../../apps/desktop/src/main/pandoc/zip'
import { pandocFixture, pandocTestPath } from '../helpers/pandoc'
import { clickDocumentAction, launchDesktop, selectReadingLayout, waitForReading } from './helpers'

test('Pandoc reading exports retain each layout and a confirmed stale copy without translation requests', {
  tag: '@pandoc',
}, async () => {
  const tool = pandocTestPath()
  test.setTimeout(90_000)
  const directory = await mkdtemp(resolve('test/e2e/result/pandoc-reading-'))
  if (!directory.startsWith(resolve('test/e2e/result') + sep))
    throw new Error('Unsafe fixture path')
  const path = join(directory, 'reading.md'),
    info = test.info()
  const original = await pandocFixture('reading', 'crlf')
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
        model: 'local-pandoc-test',
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
      const target = join(directory, `${layout}.docx`)
      await application.evaluate(
        ({ dialog }, values) => {
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [values.tool] })
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: values.target })
        },
        { tool, target },
      )
      await clickDocumentAction(page, 'Export reading with Pandoc…')
      const modal = page.getByRole('dialog', { name: 'Export with Pandoc', exact: true })
      if (layout === 'replace')
        await modal.getByRole('button', { name: 'Choose Pandoc…', exact: true }).click()
      await expect(modal.getByRole('button', { name: 'Export…', exact: true })).toBeEnabled()
      await modal.getByRole('button', { name: 'Export…', exact: true }).click()
      await expect(page.getByText(`Exported to ${target}`, { exact: true })).toBeVisible({
        timeout: 25_000,
      })
      const bytes = await readFile(target),
        files = readPandocZip(bytes),
        xml = files.get('word/document.xml')?.toString() || ''
      const word = await page.evaluate((xml) => {
        const parsed = new DOMParser().parseFromString(xml, 'application/xml')
        return {
          text: [...parsed.getElementsByTagName('w:t')].map((node) => node.textContent).join(''),
          drawings: parsed.getElementsByTagName('w:drawing').length,
          columns: [...parsed.getElementsByTagName('w:tblGrid')].map(
            (grid) => grid.getElementsByTagName('w:gridCol').length,
          ),
        }
      }, xml)
      expect(word.text).toContain('你好 first')
      expect(word.text).toContain('你好 end marker')
      const noteXml = [...files]
        .filter(([name]) => name.endsWith('.xml'))
        .map(([, bytes]) => bytes.toString())
      const notes = await page.evaluate(
        (values) =>
          values
            .map((value) =>
              [
                ...new DOMParser()
                  .parseFromString(value, 'application/xml')
                  .getElementsByTagName('w:t'),
              ]
                .map((node) => node.textContent)
                .join(''),
            )
            .join('\n'),
        noteXml,
      )
      expect(notes).toContain('你好 reference')
      expect(
        [...files.keys()].filter((name) => name.startsWith('word/media/')).length,
      ).toBeGreaterThanOrEqual(2)
      expect(word.drawings).toBeGreaterThanOrEqual(layout === 'replace' ? 2 : 4)
      if (layout === 'replace') expect(word.text).not.toContain('Hello first')
      else {
        expect(word.text).toContain('Hello first')
        expect(word.text).toContain('Original')
        expect(word.text).toContain('Translation')
      }
      if (layout === 'side-by-side') {
        expect(word.columns).toContain(2)
      }
      await info.attach(`pandoc-reading-${layout}`, {
        body: bytes,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      expect(requests).toBe(completed)
      expect(await readFile(path, 'utf8')).toBe(original)
    }
    const sourceMode = page.getByRole('button', { name: 'Source', exact: true })
    await sourceMode.click()
    await expect(sourceMode).toHaveAttribute('aria-pressed', 'true')
    const editor = page.locator('.cm-content'),
      modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await editor.press(`${modifier}+End`)
    await editor.press('Enter')
    await editor.type('Later source')
    await expect(editor).toContainText('Later source')
    await editor.press(`${modifier}+s`)
    await expect
      .poll(async () => (await readFile(path, 'utf8')).endsWith('Later source'))
      .toBe(true)
    const edited = await readFile(path, 'utf8')
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    const target = join(directory, 'stale.epub')
    await application.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, target)
    await clickDocumentAction(page, 'Export reading with Pandoc…')
    const modal = page.getByRole('dialog', { name: 'Export with Pandoc', exact: true })
    await modal.getByRole('combobox', { name: 'Format', exact: true }).selectOption('epub')
    await modal.getByRole('button', { name: 'Export…', exact: true }).click()
    await expect(
      page.getByRole('group', { name: 'Export the captured reading copy?' }),
    ).toBeVisible()
    await expect(
      page.getByText('This copy excludes later source edits.', { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Export this copy', exact: true }).click()
    await expect(
      page.getByText(`Exported to ${target}. Edits made after export started are not included.`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 25_000 })
    const bytes = await readFile(target),
      files = readPandocZip(bytes)
    const text = [...files]
      .filter(([name]) => /\.(?:html|xhtml)$/.test(name))
      .map(([, bytes]) => bytes.toString())
      .join('\n')
    expect(text).toContain('你好 first')
    expect(text).not.toContain('Later source')
    await info.attach('pandoc-reading-stale', { body: bytes, contentType: 'application/epub+zip' })
    expect(requests).toBe(completed)
    expect(await readFile(path, 'utf8')).toBe(edited)
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
