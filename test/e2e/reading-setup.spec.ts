import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { translationChannels } from '../../apps/desktop/src/shared/translation-contracts'
import { clickReadingAction, launchDesktop, waitForReading } from './helpers'

async function stop(application: ElectronApplication) {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed()) window.destroy()
    })
    .catch(() => {})
  await application.close()
}

test('reading setup reveals provider settings and sends prose only after Translate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-setup-'))
  const path = join(directory, 'reading.md')
  const source = '# Hello reader\n\nHello world. `PRIVATE_CODE`\n'
  await writeFile(path, source)
  const received: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    received.push(raw)
    const input = JSON.parse(raw)
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: input.messages[1].content.replaceAll('Hello', 'Bonjour'),
        },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server')
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    await expect(page.locator('.cm-content')).toContainText('Hello reader')
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Set up translation', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeEnabled()
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('zh-CN')
    await expect(page.getByLabel('Read in', { exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Load cached', exact: true })).toHaveCount(0)
    await expect(page.locator('.reading-article')).toContainText('Hello reader')
    await page.getByRole('button', { name: 'Set up translation', exact: true }).focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('.translation-settings')
    await expect(panel).toHaveJSProperty('open', true)
    await expect(panel.getByLabel('Provider', { exact: true })).toBeFocused()
    await panel.getByLabel('Provider', { exact: true }).selectOption('ollama')
    await panel
      .getByLabel('Full chat endpoint', { exact: true })
      .fill(`http://127.0.0.1:${address.port}/api/chat`)
    await panel.getByLabel('Model', { exact: true }).fill('local-test-model')
    await panel.getByLabel('Target language', { exact: true }).fill('fr')
    await panel.getByRole('button', { name: 'Save translation settings', exact: true }).click()
    await expect(panel.getByText('Translation settings saved.', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Set up translation', exact: true, includeHidden: true }),
    ).toHaveCount(0)
    const state = await page.evaluate(() => window.manuslip.translationState())
    if (!state.ok) throw new Error('Missing saved translation state')
    // Keep the reader's controls disabled until after the dialog has closed.
    await application.evaluate(
      ({ ipcMain, BrowserWindow }, { channels, state }) => {
        const probe = { pending: [] as (() => void)[], released: false }
        Object.assign(globalThis, { savedSettingsProbe: probe })
        ipcMain.removeHandler(channels.state)
        ipcMain.handle(channels.state, () => {
          if (probe.released) return state
          return new Promise((resolve) => probe.pending.push(() => resolve(state)))
        })
        BrowserWindow.getAllWindows()[0]?.webContents.send(channels.changed)
      },
      { channels: translationChannels, state },
    )
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.locator('.preferences-dialog')).not.toBeVisible()
    const translate = page.getByRole('button', { name: 'Translate', exact: true })
    await expect(translate).toBeDisabled()
    await application.evaluate(() => {
      const probe = (
        globalThis as unknown as {
          savedSettingsProbe: { pending: (() => void)[]; released: boolean }
        }
      ).savedSettingsProbe
      probe.released = true
      for (const resolve of probe.pending) resolve()
    })
    await expect(translate).toBeFocused()
    await expect(translate).toBeEnabled()
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('fr')
    await expect(page.locator('.reading-article')).toContainText('Hello reader')
    expect(await page.evaluate(() => window.manuslip.translationState())).toMatchObject({
      ok: true,
      value: { credential: 'none' },
    })
    expect(received).toHaveLength(0)
    await page.screenshot({ path: test.info().outputPath('configured-reading.png') })
    await page.keyboard.press('Enter')
    await waitForReading(page)
    await expect(page.locator('.reading-article')).toContainText('Bonjour reader')
    await expect(page.locator('.reading-article code')).toContainText('PRIVATE_CODE')
    expect(received).toHaveLength(2)
    expect(received.join('')).not.toContain('PRIVATE_CODE')
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    await stop(application)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('reading settings show loading, recover from failure, and never claim a missing provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-recovery-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const state = await page.evaluate(() => window.manuslip.translationState())
    if (!state.ok) throw new Error('Missing state')
    await application.evaluate(
      ({ ipcMain }, { channel, state }) => {
        const probe = { calls: 0, resolve: null as ((value: unknown) => void) | null }
        Object.assign(globalThis, { readingSetupProbe: probe })
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => {
          probe.calls++
          if (probe.calls > 1) return { ok: true, value: state }
          return new Promise((resolve) => {
            probe.resolve = resolve
          })
        })
      },
      { channel: translationChannels.state, state: state.value },
    )
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await expect(page.getByText('Loading translation settings…', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Set up translation', exact: true })).toHaveCount(
      0,
    )
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeDisabled()
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('zh-CN')
    await application.evaluate(() => {
      const probe = (
        globalThis as unknown as { readingSetupProbe: { resolve(value: unknown): void } }
      ).readingSetupProbe
      probe.resolve({ ok: false, code: 'translation-storage', error: 'PRIVATE_SETTINGS_ERROR' })
    })
    await expect(page.getByRole('alert')).toContainText('Unable to load translation settings')
    await expect(page.getByRole('alert')).toContainText('Reload settings')
    await expect(page.getByRole('button', { name: 'Set up translation', exact: true })).toHaveCount(
      0,
    )
    await expect(page.locator('body')).not.toContainText('PRIVATE_SETTINGS_ERROR')
    await page.screenshot({ path: test.info().outputPath('settings-recovery.png') })
    await page.getByRole('button', { name: 'Reload settings', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Set up translation', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Translate', exact: true })).toBeFocused()
    await expect(page.locator('.reading-article')).toBeVisible()
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true })
  }
})

test('future translation settings explain read-only recovery and preserve the saved configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-readonly-'))
  const profile = join(directory, 'profile')
  await mkdir(profile)
  const path = join(profile, 'translation-settings.json')
  const source = JSON.stringify({ schemaVersion: 999, settings: { future: true } })
  await writeFile(path, source)
  const application = await launchDesktop(profile)
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await expect(page.locator('.reading-controls')).toContainText(
      'Translation settings are read-only',
    )
    await expect(page.getByRole('button', { name: 'Set up translation', exact: true })).toHaveCount(
      0,
    )
    await page.getByRole('button', { name: 'Translation settings', exact: true }).click()
    const panel = page.locator('.translation-settings')
    await expect(panel.getByLabel('Provider', { exact: true })).toBeDisabled()
    await expect(panel.locator('> summary')).toBeFocused()
    await expect(
      panel.getByText(
        'Translation settings are read-only. Update Manuslip or check profile storage.',
        { exact: true },
      ),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('button', { name: 'Translation settings', exact: true }),
    ).toBeFocused()
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true })
  }
})

test('reopening translation settings refreshes saved values while preserving an unsaved draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-reading-draft-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await page.getByRole('button', { name: 'Translated preview', exact: true }).click()
    await page.getByRole('button', { name: 'Set up translation', exact: true }).click()
    const panel = page.locator('.translation-settings')
    await expect(panel.getByLabel('Provider', { exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
    const configured = await page.evaluate(() =>
      window.manuslip.configureTranslation({
        provider: {
          adapter: 'ollama',
          version: '1',
          baseUrl: 'http://127.0.0.1:9/api/chat',
          model: 'saved-local-model',
          profile: null,
          options: {},
        },
        sourceLanguage: 'auto',
        targetLanguage: 'fr',
        glossary: [],
        formality: 'default',
        promptVersion: 'prose-translation/v1',
      }),
    )
    expect(configured.ok).toBe(true)
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('fr')
    await clickReadingAction(page, 'Translation settings')
    await expect(panel.getByLabel('Provider', { exact: true })).toBeFocused()
    await expect(panel.getByLabel('Provider', { exact: true })).toHaveValue('ollama')
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('saved-local-model')
    await expect(panel.getByLabel('Target language', { exact: true })).toHaveValue('fr')
    await panel.getByLabel('Model', { exact: true }).fill('unsaved-local-model')
    await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
    await page.getByLabel('Read in', { exact: true }).selectOption('ja')
    await expect(page.getByLabel('Read in', { exact: true })).toHaveValue('ja')
    await clickReadingAction(page, 'Translation settings')
    await expect(panel.getByLabel('Provider', { exact: true })).toBeFocused()
    await expect(panel.getByLabel('Model', { exact: true })).toHaveValue('unsaved-local-model')
    await expect(panel.getByLabel('Target language', { exact: true })).toHaveValue('fr')
    await expect(
      panel.getByText(
        'Saved settings changed. Your unsaved edits are kept. Save to apply your draft.',
        { exact: true },
      ),
    ).toBeVisible()
    expect(await page.evaluate(() => window.manuslip.translationState())).toMatchObject({
      ok: true,
      value: { settings: { targetLanguage: 'ja', provider: { model: 'saved-local-model' } } },
    })
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true })
  }
})
