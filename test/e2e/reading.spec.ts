import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranslationSettings } from '@manuslip/translate'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { expectBundledCjk } from './fonts'
import {
  contrast,
  launchDesktop,
  openReadingOptions,
  selectReadingLayout,
  waitForReading,
} from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function stop(application: ElectronApplication) {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}
function settings(baseUrl: string): TranslationSettings {
  return {
    provider: {
      adapter: 'openai-compatible',
      version: '1',
      baseUrl,
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
}
function answer(reply: ServerResponse, content: string) {
  reply.setHeader('Content-Type', 'application/json')
  reply.end(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  )
}
test('concurrent translation renders buffered responses in order and keeps its toolbar visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-order-'))
  const path = join(directory, 'reading.md')
  const source = ['First', 'Second', 'Third', 'Fourth']
    .map((name) => `${name} paragraph. ${'Source text. '.repeat(80)}`)
    .join('\n\n')
  await writeFile(path, source)
  const waiting: ServerResponse[] = []
  const server = createServer(async (incoming, reply) => {
    let body = ''
    for await (const chunk of incoming) body += chunk.toString()
    // Concurrent HTTP requests may arrive in either order. Route each response
    // to its authored paragraph rather than assigning translations by arrival.
    const index = ['First', 'Second', 'Third', 'Fourth'].findIndex((name) =>
      body.includes(`${name} paragraph.`),
    )
    if (index < 0) {
      reply.writeHead(400).end()
      return
    }
    waiting[index] = reply
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('First paragraph.')
    await page.evaluate(
      (value) => window.manuslip.configureTranslation(value),
      settings(`http://127.0.0.1:${address.port}/chat`),
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('zh-CN')
    expect(waiting).toHaveLength(0)
    await expect(page.getByRole('button', { name: 'Load cached', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => waiting.filter(Boolean).length).toBe(2)
    const article = page.locator('.reading-article')
    const translations = ['第一段。', '第二段。', '第三段。'].map(
      (text) => `${text}${'正文内容。'.repeat(120)}`,
    )
    answer(waiting[1] as ServerResponse, translations[1] as string)
    await expect.poll(() => waiting.filter(Boolean).length).toBe(3)
    await expect(page.getByText('1 of 4 prose units translated · 0 cached')).toBeVisible()
    await expect(article).not.toContainText('第二段。')
    answer(waiting[2] as ServerResponse, translations[2] as string)
    await expect.poll(() => waiting.filter(Boolean).length).toBe(4)
    await expect(page.getByText('2 of 4 prose units translated · 0 cached')).toBeVisible()
    await expect(article).not.toContainText('第三段。')
    answer(waiting[0] as ServerResponse, translations[0] as string)
    await expect(article).toContainText('第三段。')
    const text = (await article.textContent()) ?? ''
    expect(text.indexOf('第一段。')).toBeLessThan(text.indexOf('第二段。'))
    expect(text.indexOf('第二段。')).toBeLessThan(text.indexOf('第三段。'))
    await page.locator('.reading-pane').evaluate((element) => {
      element.scrollTop = 600
    })
    await expect(
      page.getByRole('button', { name: 'Cancel translation', exact: true }),
    ).toBeInViewport({
      ratio: 1,
    })
    const toolbar = await page.locator('.reading-controls').boundingBox()
    const pane = await page.locator('.reading-pane').boundingBox()
    expect(Math.abs((toolbar?.y ?? -1) - (pane?.y ?? -100))).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath('reading-ordered-sticky-toolbar.png') })
    await page.getByRole('button', { name: 'Cancel translation', exact: true }).click()
    answer(waiting[3] as ServerResponse, 'LATE')
    await expect(
      page.getByText('Translation cancelled. Completed translations are kept.'),
    ).toBeVisible()
    await expect(article).toContainText('第三段。')
    await expect(article).not.toContainText('LATE')
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
test('translated reading preserves structure, private bindings, source history, cache and explicit refresh', async () => {
  test.setTimeout(45_000)
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-'))
  const path = join(directory, 'reading.md')
  const source =
    '# Hello world\n\nHello *world*, `PRIVATE_ONE`, $x^2$ and [label](https://private.invalid/one "PRIVATE_TITLE").\n\nHello *world*, `PRIVATE_TWO`, $y^2$ and [label](https://private.invalid/two "PRIVATE_TITLE").\n\n- [x] Hello task\n\n> Hello quote\n\n| Hello | world |\n| - | - |\n| Hello cell | world cell |\n\n```ts\nconst PRIVATE_BLOCK = 1\n```\n\n$$\n\\ce{H2O}\n$$\n\n```mermaid\ngraph LR\n A[PRIVATE_GRAPH] --> B[Done]\n```\n\n![PRIVATE_ALT](PRIVATE.png)\n\nHello note[^note].\n\n[^note]: Hello footnote.\n\nHello <span>PRIVATE_HTML</span>.\n'
  await writeFile(path, source)
  await writeFile(
    join(directory, 'PRIVATE.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XcAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const received: string[] = []
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    received.push(raw)
    const input = JSON.parse(raw)
    answer(reply, input.messages[1].content.replaceAll('Hello', '你好').replaceAll('world', '世界'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  let application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    let page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello')
    await page.evaluate(() => {
      const probe = {
        packed: 0,
        native: 0,
        bytes: 0,
        detached: 0,
        shared: 0,
        units: 0,
        payloads: 0,
        responseBytes: 0,
        privatePayload: false,
      }
      Object.assign(window, { readingTransferProbe: probe })
      Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
        apply(target, worker, args) {
          const operation = args[0]?.operation as
            | { kind?: string; payload?: ArrayBuffer; settings?: unknown }
            | undefined
          // The local Markdown preview has no translation request payloads.
          if (operation?.settings === null) return Reflect.apply(target, worker, args)
          if (operation?.kind === 'prepare') {
            probe.native++
            probe.bytes += new TextEncoder().encode(JSON.stringify(operation)).byteLength
          }
          if (operation?.kind === 'prepare-packed') {
            probe.packed++
            probe.bytes += operation.payload?.byteLength ?? 0
          }
          if (operation?.kind === 'prepare' || operation?.kind === 'prepare-packed')
            worker.addEventListener(
              'message',
              (event: MessageEvent) => {
                const value = event.data?.value
                if (value?.kind !== 'prepared-shared') return
                probe.shared++
                probe.units = value.units.length
                probe.payloads = value.payloads.length
                probe.responseBytes = new TextEncoder().encode(
                  JSON.stringify(event.data),
                ).byteLength
                probe.privatePayload = /PRIVATE_|private.invalid|H2O/.test(
                  JSON.stringify(value.payloads),
                )
              },
              { once: true },
            )
          const result = Reflect.apply(target, worker, args)
          if (operation?.kind === 'prepare-packed' && operation.payload?.byteLength === 0)
            probe.detached++
          return result
        },
      })
    })
    expect(
      await page.evaluate(
        (value) => window.manuslip.configureTranslation(value),
        settings(`http://127.0.0.1:${address.port}/chat`),
      ),
    ).toMatchObject({ ok: true })
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await waitForReading(page)
    expect(received).toHaveLength(0)
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await waitForReading(page)
    const transfer = await page.evaluate(
      () =>
        (
          window as unknown as {
            readingTransferProbe: {
              packed: number
              native: number
              bytes: number
              detached: number
              shared: number
              units: number
              payloads: number
              responseBytes: number
              privatePayload: boolean
            }
          }
        ).readingTransferProbe,
    )
    // Configurable document conventions use the native semantic path so their
    // heading, callout and inline metadata survive into the reading worker.
    expect(transfer.packed).toBe(0)
    expect(transfer.native).toBe(2)
    expect(transfer.detached).toBe(transfer.packed)
    expect(transfer.bytes).toBeGreaterThan(4)
    expect(transfer.shared).toBe(2)
    expect(transfer.units).toBeGreaterThan(transfer.payloads)
    expect(transfer.payloads).toBeGreaterThan(0)
    expect(transfer.responseBytes).toBeLessThan(8 * 1024 * 1024)
    expect(transfer.privatePayload).toBe(false)
    console.log('Reading worker shared response probe:', JSON.stringify(transfer))
    const article = page.locator('.reading-article')
    await expect(article.getByRole('group', { name: 'Translation', exact: true })).toHaveCount(1)
    await expect(article.locator('.reading-replace')).toHaveAttribute('lang', 'zh-CN')
    await expect(article.getByRole('heading', { name: '你好 世界', exact: true })).toBeVisible()
    await expectBundledCjk(page, '.reading-replace h1', 4)
    await expect(article.locator('code').filter({ hasText: 'PRIVATE_ONE' })).toHaveCount(1)
    await expect(article.locator('code').filter({ hasText: 'PRIVATE_TWO' })).toHaveCount(1)
    await expect(article.locator('pre code')).toContainText('PRIVATE_BLOCK')
    await expect(article.locator('a[href="https://private.invalid/one"]')).toHaveCount(1)
    await expect(article.locator('a[href="https://private.invalid/two"]')).toHaveCount(1)
    await expect(article.locator('input[type="checkbox"]')).toBeDisabled()
    await expect(article.locator('table')).toContainText('你好 cell')
    await expect(article.locator('blockquote')).toContainText('你好 quote')
    await expect(article.locator('[role="math"]')).toHaveCount(3)
    await expect(article.locator('[role="img"][aria-label="Diagram"] svg')).toBeVisible()
    await expect
      .poll(() =>
        article.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1)
    expect(received.length).toBeGreaterThan(6)
    expect(received.join('')).not.toMatch(/PRIVATE_|private.invalid|x\^2|y\^2|H2O|graph LR/)
    expect(await readFile(path, 'utf8')).toBe(source)
    const readingWorker = page.workers().find((worker) => worker.url().includes('reading.worker'))
    if (!readingWorker) throw new Error('No dedicated reading worker')
    await readingWorker.evaluate(() => {
      const probe = { rootClones: 0, otherClones: 0 }
      Object.assign(globalThis, { readingCloneProbe: probe })
      globalThis.structuredClone = new Proxy(globalThis.structuredClone, {
        apply(target, receiver, args) {
          if (args[0]?.type === 'root') probe.rootClones++
          else probe.otherClones++
          return Reflect.apply(target, receiver, args)
        },
      })
    })
    await selectReadingLayout(page, 'side-by-side')
    await expect(article.locator('.reading-side-by-side')).toHaveCount(1)
    await expect(article.getByRole('heading', { name: 'Hello world', exact: true })).toBeVisible()
    await expect(article.getByRole('heading', { name: '你好 世界', exact: true })).toBeVisible()
    await selectReadingLayout(page, 'replace')
    await expect(article.locator('.reading-side-by-side')).toHaveCount(0)
    await expect(article.getByRole('heading', { name: 'Hello world', exact: true })).toHaveCount(0)
    await expect(article.getByRole('heading', { name: '你好 世界', exact: true })).toBeVisible()
    const cloneProbe = await readingWorker.evaluate(() =>
      Reflect.get(globalThis, 'readingCloneProbe'),
    )
    expect(cloneProbe).toMatchObject({ rootClones: 0 })
    console.log('Reading worker clone probe during layout renders:', JSON.stringify(cloneProbe))
    await page.screenshot({ path: test.info().outputPath('reading-structure.png') })
    const calls = received.length
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await waitForReading(page)
    expect(received).toHaveLength(calls)
    // Source history contains only the user's edit, never translated content.
    await page.keyboard.press(`${modifier}+1`)
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').focus()
    await expect(page.locator('.cm-content')).toBeFocused()
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.type('Hello added paragraph.')
    await page.keyboard.press(`${modifier}+3`)
    await expect(
      page.getByText(
        'The source has changed. This copy shows the earlier text. Refresh to include your edits.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(article).not.toContainText('added paragraph')
    expect(received).toHaveLength(calls)
    await page.screenshot({ path: test.info().outputPath('reading-stale.png') })
    await page.getByRole('button', { name: 'Refresh translation', exact: true }).click()
    await expect(article).toContainText('你好 added paragraph.')
    await waitForReading(page)
    expect(received).toHaveLength(calls + 1)
    await page.keyboard.press(`${modifier}+1`)
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.locator('.cm-content').focus()
    await page.keyboard.press(`${modifier}+z`)
    await expect(page.locator('.cm-content')).not.toContainText('added paragraph')
    await expect(page.locator('.cm-content')).toContainText('Hello world')
    // Persisted cache works after a process restart with the provider stopped.
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    application = await launchDesktop(join(directory, 'profile'), [path])
    page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello world')
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await expect(
      page.locator('.reading-article').getByRole('heading', { name: '你好 世界', exact: true }),
    ).toBeVisible()
    await waitForReading(page)
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).not.toBeFocused()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('tab', { name: 'reading.md', exact: true }).click()
    await expect(page.locator('.reading-article')).toContainText('你好 世界')
    await waitForReading(page)
    expect(received).toHaveLength(calls + 1)
  } finally {
    await stop(application)
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('reading shows partial failure and retry, rejects cancelled work and language changes, and remains usable in narrow localized layouts', async () => {
  test.setTimeout(45_000)
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-ui-'))
  const path = join(directory, 'reading.md')
  await writeFile(path, '# Hello world\n\nHello first.\n\nHello failed.\n\nHello slow.')
  let fail = true,
    hold = false
  const waiting: { reply: ServerResponse; text: string }[] = []
  const received: string[] = []
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const text: string = body.messages[1].content
    received.push(text)
    if (hold) {
      waiting.push({ reply, text })
      return
    }
    if (fail && text.includes('failed')) {
      reply.writeHead(401)
      reply.end()
      return
    }
    answer(reply, text.replaceAll('Hello', '你好').replaceAll('world', '世界'))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello')
    await page.evaluate(
      (value) => window.manuslip.configureTranslation(value),
      settings(`http://127.0.0.1:${address.port}/chat`),
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry failed', exact: true })).toBeVisible()
    await expect(
      page.getByText(
        'The provider rejected the API key. Update it in Translation settings, then retry failed units.',
        { exact: true },
      ),
    ).toBeVisible()
    await expect(page.locator('.reading-article')).toContainText('Hello failed.')
    await expect(page.locator('.reading-article')).toContainText('你好 first.')
    await page.screenshot({ path: test.info().outputPath('reading-error-light.png') })
    const count = received.length
    await page.getByRole('button', { name: 'Update API key', exact: true }).click()
    await expect(
      page.locator('.translation-settings').getByLabel('API key', { exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Update API key', exact: true })).toBeFocused()
    expect(received).toHaveLength(count)
    fail = false
    await page.getByRole('button', { name: 'Retry failed', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.reading-article')).toContainText('你好 failed.')
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeFocused()
    expect(received).toHaveLength(count + 1)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (theme) => {
        const state = await window.manuslip.bootstrap()
        if (state.ok)
          await window.manuslip.updateSettings({
            ...state.value.settings,
            theme: theme as 'light' | 'dark',
          })
      }, theme)
      // Apply settings as the real Preferences flow does, retaining this copy.
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByRole('button', { name: 'General', exact: true }).click()
      await page.locator('#theme').selectOption(theme)
      await page.keyboard.press('Escape')
      await page.locator('.reading-article').focus()
      const colors = await page.locator('.reading-article').evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          text: style.color,
          background: getComputedStyle(document.documentElement).backgroundColor,
          focus: style.outlineColor,
          outline: style.outlineStyle,
        }
      })
      expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5)
      expect(colors.outline).toBe('solid')
      await page.screenshot({ path: test.info().outputPath(`reading-${theme}.png`) })
    }
    // Changing the target resets the derived copy without making requests.
    await page.getByLabel('Read in', { exact: true }).selectOption('ja')
    await waitForReading(page)
    await expect(page.locator('.reading-article')).toContainText('Hello first.')
    expect(received).toHaveLength(count + 1)
    hold = true
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => waiting.length).toBe(2)
    await page.screenshot({ path: test.info().outputPath('reading-loading.png') })
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('tab', { name: 'reading.md', exact: true }).click()
    for (const pending of waiting) answer(pending.reply, `LATE ${pending.text}`)
    await waitForReading(page)
    await expect(page.locator('.reading-article')).toContainText('Hello first.')
    await expect(page.locator('.reading-article')).not.toContainText('LATE')
    const afterSwitch = received.length
    await page.getByRole('button', { name: 'Translate', exact: true }).click()
    await expect.poll(() => waiting.length).toBe(4)
    await page.getByRole('button', { name: 'Cancel translation', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeFocused()
    for (const pending of waiting.slice(2)) answer(pending.reply, `LATE ${pending.text}`)
    await expect(
      page.getByText('Translation cancelled. Completed translations are kept.', { exact: true }),
    ).toBeVisible()
    await expect(page.locator('.reading-article')).not.toContainText('LATE')
    const afterCancel = received.length
    expect(afterCancel).toBe(afterSwitch + 2)
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.locator('#locale').selectOption('zh-CN')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 320, height: 720 })
    await page.getByRole('button', { name: '翻译', exact: true }).scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await page
        .locator('.reading-pane')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({ path: test.info().outputPath('reading-narrow-chinese.png') })
    await page.setViewportSize({ width: 1160, height: 780 })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    await openReadingOptions(page)
    await page.getByLabel('阅读布局', { exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByLabel('阅读布局', { exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.getByLabel('阅读布局', { exact: true }).selectOption('interlinear')
    await page.keyboard.press('Escape')
    await expect(
      page.locator('.reading-original').getByRole('heading', { name: 'Hello world', exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath('reading-zoom-chinese.png') })
    expect(received).toHaveLength(afterCancel)
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
    )
    await page.getByRole('button', { name: '源码', exact: true }).click()
    await expect(page.locator('.cm-content')).toBeFocused()
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.type('Still editable.')
    await expect(page.locator('.cm-content')).toContainText('Still editable.')
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
