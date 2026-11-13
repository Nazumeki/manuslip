import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarkdown } from '@manuslip/core'
import {
  extractTranslation,
  type TranslationSettings,
  translationSettingsKey,
  translationUnitKey,
} from '@manuslip/translate'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import {
  providerCapabilities,
  type TranslationRequest,
} from '../../apps/desktop/src/shared/translation-contracts'
import { contrast, launchDesktop } from './helpers'

const source =
  'Hello *world*, `PRIVATE_CODE`, $PRIVATE_MATH$ and [label](https://private.invalid/secret "PRIVATE_TITLE").'
async function request(page: Page, documentId: string, text = source): Promise<TranslationRequest> {
  const state = await page.evaluate(() => window.manuslip.translationState())
  if (!state.ok || !state.value.settings) throw new Error('No settings')
  const payload = extractTranslation(parseMarkdown(text).root, text).units[0]?.payload
  if (!payload) throw new Error('No payload')
  return {
    requestId: randomUUID(),
    documentId,
    occurrenceId: randomUUID(),
    sessionGeneration: 0,
    settingsRevision: state.value.settingsRevision,
    cacheGeneration: state.value.cacheGeneration,
    unitKey: await translationUnitKey(
      payload,
      await translationSettingsKey(state.value.settings, providerCapabilities),
    ),
    payload,
    network: true,
  }
}
async function newDocument(page: Page): Promise<string> {
  const document = await page.evaluate(() => window.manuslip.newDocument())
  if (!document.ok) throw new Error('No document')
  return document.value.info.id
}
async function stop(application: ElectronApplication): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}
function settings(baseUrl: string, adapter = 'openai-compatible'): TranslationSettings {
  return {
    provider: {
      adapter,
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

test('packaged translation uses local providers, OS-protected credentials and SQLite cache across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-translation-'))
  const profile = join(directory, 'profile')
  const received: { url: string; body: string; authorization: string | undefined }[] = []
  const server = createServer(async (incoming, reply) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    received.push({ url: incoming.url ?? '', body, authorization: incoming.headers.authorization })
    const input = JSON.parse(body)
    const content = input.messages[1].content
      .replaceAll('Hello', '你好')
      .replaceAll('world', '世界')
    reply.setHeader('Content-Type', 'application/json')
    reply.end(
      JSON.stringify(
        incoming.url === '/api/chat'
          ? { done: true, done_reason: 'stop', message: { role: 'assistant', content } }
          : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] },
      ),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  const endpoint = `http://127.0.0.1:${address.port}`
  let application = await launchDesktop(profile)
  try {
    let page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Start writing' })).toBeVisible()
    expect(await page.evaluate(() => window.manuslip.translationState())).toMatchObject({
      ok: true,
      value: { settings: null, credential: 'none', cache: 'idle' },
    })
    expect(
      await page.evaluate(
        (settings) => window.manuslip.configureTranslation(settings),
        settings(`${endpoint}/v1/chat/completions`),
      ),
    ).toMatchObject({ ok: true })
    const state = await page.evaluate(() => window.manuslip.translationState())
    if (!state.ok) throw new Error('No state')
    const canPersist = await application.evaluate(
      async ({ safeStorage }) =>
        (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    )
    const credential = await page.evaluate(
      (input) => window.manuslip.setTranslationCredential(input),
      {
        settingsRevision: state.value.settingsRevision,
        key: 'dummy-e2e-private-key',
        persist: canPersist,
      },
    )
    expect(credential).toMatchObject({
      ok: true,
      value: { credential: canPersist ? 'stored' : 'session' },
    })
    expect(JSON.stringify(credential)).not.toContain('dummy-e2e-private-key')
    let id = await newDocument(page)
    const input = await request(page, id)
    const result = await page.evaluate((input) => window.manuslip.translateUnit(input), input)
    expect(result).toMatchObject({
      ok: true,
      value: { cached: false, cache: 'ready', output: expect.stringContaining('你好') },
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.authorization).toBe('Bearer dummy-e2e-private-key')
    for (const hidden of [
      'PRIVATE_CODE',
      'PRIVATE_MATH',
      'private.invalid',
      'PRIVATE_TITLE',
      'dummy-e2e-private-key',
      'bindings',
      'documentId',
    ])
      expect(received[0]?.body).not.toContain(hidden)
    expect(await readFile(join(profile, 'translation-settings.json'), 'utf8')).not.toContain(
      'dummy-e2e-private-key',
    )
    if (canPersist)
      expect(await readFile(join(profile, 'translation-credential.json'), 'utf8')).not.toContain(
        'dummy-e2e-private-key',
      )
    await stop(application)
    application = await launchDesktop(profile)
    page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Start writing' })).toBeVisible()
    const restored = await page.evaluate(() => window.manuslip.translationState())
    expect(restored).toMatchObject({
      ok: true,
      value: { credential: canPersist ? 'stored' : 'none' },
    })
    id = await newDocument(page)
    const offline = { ...(await request(page, id)), network: false }
    expect(
      await page.evaluate((input) => window.manuslip.translateUnit(input), offline),
    ).toMatchObject({ ok: true, value: { cached: true, output: expect.stringContaining('世界') } })
    expect(received).toHaveLength(1)
    if (canPersist) {
      expect(
        await page.evaluate(
          (input) => window.manuslip.translateUnit(input),
          await request(page, id, 'Hello new prose.'),
        ),
      ).toMatchObject({ ok: true })
      expect(received.at(-1)?.authorization).toBe('Bearer dummy-e2e-private-key')
    }
    expect(await page.evaluate(() => window.manuslip.clearTranslationCache())).toMatchObject({
      ok: true,
      value: { cacheGeneration: 1 },
    })
    expect(
      await page.evaluate((input) => window.manuslip.translateUnit(input), {
        ...(await request(page, id)),
        network: false,
      }),
    ).toMatchObject({ ok: true, value: { output: null, cached: false } })
    expect(
      await page.evaluate(
        (settings) => window.manuslip.configureTranslation(settings),
        settings(`${endpoint}/api/chat`, 'ollama'),
      ),
    ).toMatchObject({ ok: true, value: { credential: 'none' } })
    expect(
      await page.evaluate((input) => window.manuslip.translateUnit(input), await request(page, id)),
    ).toMatchObject({ ok: true, value: { output: expect.stringContaining('你好') } })
    expect(received.at(-1)?.url).toBe('/api/chat')
    expect(received.at(-1)?.authorization).toBeUndefined()
    expect(JSON.parse(received.at(-1)?.body ?? '{}').stream).toBe(false)
    expect(await page.evaluate(() => window.manuslip.bootstrap())).toMatchObject({ ok: true })
    await expect(
      page.getByRole('button', { name: 'New document', exact: true }).first(),
    ).toBeEnabled()
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('packaged cancellation and cache clearing reject late local-provider work without blocking the editor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-translation-cancel-'))
  const waiting: ServerResponse[] = []
  const server = createServer(async (incoming, reply) => {
    for await (const _chunk of incoming) {
      /* Drain the test request before holding its reply. */
    }
    waiting.push(reply)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Start writing' })).toBeVisible()
    expect(
      await page.evaluate(
        (settings) => window.manuslip.configureTranslation(settings),
        settings(`http://127.0.0.1:${address.port}/chat`),
      ),
    ).toMatchObject({ ok: true })
    const id = await newDocument(page)
    const first = await request(page, id)
    const pending = page.evaluate((input) => window.manuslip.translateUnit(input), first)
    await expect.poll(() => waiting.length).toBe(1)
    expect(
      await page.evaluate((id) => window.manuslip.cancelTranslation(id), first.requestId),
    ).toMatchObject({ ok: true })
    expect(await pending).toMatchObject({ ok: false, code: 'translation-cancelled' })
    const second = await request(page, id)
    const late = page.evaluate((input) => window.manuslip.translateUnit(input), second)
    await expect.poll(() => waiting.length).toBe(2)
    expect(await page.evaluate(() => window.manuslip.clearTranslationCache())).toMatchObject({
      ok: true,
    })
    expect(await late).toMatchObject({ ok: false, code: 'translation-stale' })
    for (const reply of waiting)
      reply.end(
        JSON.stringify({
          choices: [
            { finish_reason: 'stop', message: { role: 'assistant', content: second.payload.text } },
          ],
        }),
      )
    expect(
      await page.evaluate((input) => window.manuslip.translateUnit(input), {
        ...(await request(page, id)),
        network: false,
      }),
    ).toMatchObject({ ok: true, value: { output: null } })
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.locator('.cm-content').fill('The source editor still works.')
    await expect(page.locator('.cm-content')).toContainText('The source editor still works.')
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('translation preferences support keyboard setup, session keys, cache confirmation and narrow localized layouts offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-translation-ui-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Start writing' })).toBeVisible()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const panel = page.locator('.translation-settings')
    await page.getByRole('button', { name: 'Translation', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByLabel('Model', { exact: true })).toBeVisible()
    await panel.getByLabel('Model', { exact: true }).fill('local-test-model')
    await panel.getByLabel('Full chat endpoint', { exact: true }).fill('http://remote.invalid/chat')
    await panel.getByRole('button', { name: 'Save translation settings', exact: true }).click()
    await expect(panel.getByLabel('Full chat endpoint', { exact: true })).toBeFocused()
    await expect(panel.getByLabel('Full chat endpoint', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    await panel.getByLabel('Provider', { exact: true }).selectOption('ollama')
    await panel.getByLabel('Model', { exact: true }).fill('installed-local-model')
    // Changing provider resets the endpoint; typing clears any old validation state.
    await panel
      .getByLabel('Full chat endpoint', { exact: true })
      .fill('http://localhost:11434/api/chat')
    await panel.getByRole('button', { name: 'Save translation settings', exact: true }).click()
    await expect(panel.getByText('Translation settings saved.', { exact: true })).toBeVisible()
    await panel.locator('.translation-options > summary').click()
    await panel.getByLabel('Glossary', { exact: true }).fill('missing delimiter')
    await panel.getByRole('button', { name: 'Save translation settings', exact: true }).click()
    await expect(panel.getByLabel('Glossary', { exact: true })).toBeFocused()
    await panel.getByLabel('Glossary', { exact: true }).fill('world => 世界')
    await panel.getByLabel('Formality', { exact: true }).selectOption('formal')
    await panel.getByLabel('Temperature', { exact: true }).fill('0.2')
    await panel.getByLabel('Maximum output tokens', { exact: true }).fill('512')
    await panel.getByRole('button', { name: 'Save translation settings', exact: true }).click()
    await expect(panel.getByText('Translation settings saved.', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.manuslip.translationState())).toMatchObject({
      ok: true,
      value: {
        settings: {
          glossary: [{ source: 'world', target: '世界' }],
          formality: 'formal',
          provider: { options: { temperature: 0.2, maxOutputTokens: 512 } },
        },
      },
    })
    await panel.getByLabel('Glossary', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('translation-settings-options.png') })
    await panel.locator('.translation-options > summary').click()
    await expect(panel.getByText('No API key configured.', { exact: true })).toBeVisible()
    await application.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => false
    })
    await panel.getByLabel('Remember with the OS key store', { exact: true }).check()
    await panel.getByLabel('API key', { exact: true }).fill('dummy-ui-unavailable-store')
    await panel.getByRole('button', { name: 'Set API key', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('The OS key store is unavailable.')
    await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('')
    await panel.getByRole('alert').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: test.info().outputPath('translation-settings-key-store-error.png'),
    })
    await panel.getByLabel('Remember with the OS key store', { exact: true }).uncheck()
    await panel.getByLabel('API key', { exact: true }).fill('dummy-ui-session-key')
    await panel.getByRole('button', { name: 'Set API key', exact: true }).click()
    await expect(panel.getByLabel('API key', { exact: true })).toHaveValue('')
    await expect(
      panel.getByText('API key is available for this session.', { exact: true }),
    ).toBeVisible()
    await panel.getByRole('button', { name: 'Remove API key', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(panel.getByText('No API key configured.', { exact: true })).toBeVisible()
    await expect(panel.getByLabel('API key', { exact: true })).toBeFocused()
    await panel.getByRole('button', { name: 'Clear translation cache…', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Clear cache', exact: true })).toBeFocused()
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(
      panel.getByRole('button', { name: 'Clear translation cache…', exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await expect(panel.getByText('Translation cache cleared.', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('button', { name: 'Clear translation cache…', exact: true }),
    ).toBeFocused()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.locator('#theme').selectOption('light')
    await page.getByRole('button', { name: 'Translation', exact: true }).click()
    await panel.getByLabel('Full chat endpoint', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('translation-settings-light.png') })
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'General', exact: true }).click()
      await page.locator('#theme').selectOption(theme)
      await page.getByRole('button', { name: 'Translation', exact: true }).click()
      await page.getByRole('button', { name: 'Translation', exact: true }).click()
      await panel.getByLabel('Full chat endpoint', { exact: true }).focus()
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      await expect(panel.getByLabel('Full chat endpoint', { exact: true })).toBeFocused()
      const colors = await panel
        .getByLabel('Full chat endpoint', { exact: true })
        .evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            text: style.color,
            background: style.backgroundColor,
            border: style.borderColor,
            focus: style.outlineColor,
            outline: style.outlineStyle,
          }
        })
      expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(colors.border, colors.background)).toBeGreaterThanOrEqual(3)
      expect(contrast(colors.focus, colors.background)).toBeGreaterThanOrEqual(3)
      expect(colors.outline).toBe('solid')
      console.log(
        `Translation settings ${theme} contrast:`,
        JSON.stringify({
          text: contrast(colors.text, colors.background),
          border: contrast(colors.border, colors.background),
          focus: contrast(colors.focus, colors.background),
        }),
      )
    }
    await panel.locator('> summary').focus()
    await page.screenshot({ path: test.info().outputPath('translation-settings-dark.png') })
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.locator('#locale').selectOption('zh-CN')
    await page.getByRole('button', { name: '翻译', exact: true }).click()
    const provider = panel.getByLabel('翻译服务', { exact: true })
    await expect(provider).toBeVisible()
    await page.setViewportSize({ width: 320, height: 720 })
    await provider.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(
      await page
        .locator('dialog[open]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({
      path: test.info().outputPath('translation-settings-narrow-chinese.png'),
    })
    await page.setViewportSize({ width: 1160, height: 780 })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    await provider.scrollIntoViewIfNeeded()
    expect(
      await page
        .locator('dialog[open]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    await page.screenshot({ path: test.info().outputPath('translation-settings-zoom-chinese.png') })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '偏好设置', exact: true })).toBeFocused()
    await page.locator('.cm-content').fill('Original text remains editable.')
    await expect(page.locator('.cm-content')).toContainText('Original text remains editable.')
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
