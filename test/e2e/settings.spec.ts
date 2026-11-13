import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { contrast, launchDesktop } from './helpers'

async function preferencesContrast(page: import('@playwright/test').Page): Promise<void> {
  const pairs = await page.locator('.preferences :is(label, p, select)').evaluateAll((elements) =>
    elements.map((element) => {
      let background: Element | null = element
      while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)')
        background = background.parentElement
      return {
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(background || document.documentElement).backgroundColor,
      }
    }),
  )
  for (const pair of pairs)
    expect(contrast(pair.foreground, pair.background)).toBeGreaterThanOrEqual(4.5)
  console.log(
    'Preferences minimum text contrast:',
    Math.min(...pairs.map((pair) => contrast(pair.foreground, pair.background))).toFixed(2),
  )
}

test('offline spelling is opt-in, offers native corrections with undo and survives restart', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'manuslip-spelling-'))
  const path = join(profile, 'spelling.md')
  await writeFile(path, 'mispell example')
  let application = await launchDesktop(profile, [path])
  try {
    let page = await application.firstWindow()
    let editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toHaveText('mispell example')
    await expect(editor).toHaveAttribute('spellcheck', 'false')
    // macOS uses the OS spelling service; Chromium dictionaries serve Windows/Linux.
    if (process.platform !== 'darwin')
      expect((await readFile(join(profile, 'Dictionaries', 'en-US-10-2.bdic'))).length).toBe(451982)
    await application.evaluate(({ session }) =>
      session.defaultSession.enableNetworkEmulation({ offline: true }),
    )
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(
      page.getByRole('checkbox', { name: 'Check spelling', exact: true }),
    ).not.toBeChecked()
    await page.getByRole('checkbox', { name: 'Check spelling', exact: true }).check()
    await expect(page.getByText('Preferences saved', { exact: true })).toBeVisible()
    await preferencesContrast(page)
    await page.screenshot({ path: test.info().outputPath('spelling-preferences-light.png') })
    await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
    await expect(editor).toHaveAttribute('spellcheck', 'true')
    const source = page.getByRole('button', { name: 'Source', exact: true })
    await source.click()
    await expect(source).toHaveAttribute('aria-pressed', 'true')
    let suggestion = ''
    await expect
      .poll(
        async () => {
          // Install the capture before dispatching input, without leaving an event promise
          // running after the poll deadline. macOS may still be starting its spelling service.
          const correction = await application.evaluateHandle(({ Menu }) => {
            const result = { suggestion: null as string | null }
            const original = Menu.buildFromTemplate
            Menu.buildFromTemplate = (template) => {
              Menu.buildFromTemplate = original
              const menu = original(template)
              menu.popup = () => {
                // A native menu choice happens after the context-menu event
                // returns and Chromium has selected the misspelled word.
                setImmediate(() => {
                  const suggestion = menu.getMenuItemById('spelling-0')
                  suggestion?.click()
                  result.suggestion = suggestion?.label || ''
                })
              }
              return menu
            }
            return result
          })
          try {
            await editor
              .locator('.cm-line')
              .first()
              .click({ button: 'right', position: { x: 25, y: 10 } })
            await expect
              .poll(() => correction.evaluate((result) => result.suggestion))
              .not.toBeNull()
            suggestion = (await correction.evaluate((result) => result.suggestion)) || ''
            return suggestion
          } finally {
            await correction.dispose()
          }
        },
        { timeout: process.platform === 'darwin' ? 10_000 : 5_000 },
      )
      .not.toBe('')
    await expect(editor).toHaveText(`${suggestion} example`)
    await editor.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(editor).toHaveText('mispell example')
    const closed = application.waitForEvent('close')
    await application.evaluate(({ app }) => app.exit(0))
    await closed
    expect(JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8')).spellcheck).toBe(
      true,
    )
    application = await launchDesktop(profile, [path])
    page = await application.firstWindow()
    editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toHaveAttribute('spellcheck', 'true')
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Check spelling', exact: true })).toBeChecked()
    await page.getByRole('checkbox', { name: 'Check spelling', exact: true }).uncheck()
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark')
    await preferencesContrast(page)
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    await expect(page.getByRole('checkbox', { name: '检查拼写', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
    )
    await page.setViewportSize({ width: 320, height: 950 })
    await page.getByRole('checkbox', { name: '检查拼写', exact: true }).focus()
    await page.screenshot({
      path: test.info().outputPath('spelling-preferences-narrow-chinese.png'),
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
    editor = page.getByRole('textbox', { name: 'Markdown 源码', exact: true })
    await expect(editor).toHaveAttribute('spellcheck', 'false')
    expect(
      await application.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()),
    ).toBe(false)
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('future preferences stay read-only with original data and a dated backup', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'manuslip-future-'))
  const path = join(profile, 'preferences.json')
  const source = '{"schemaVersion":2,"theme":"dark","locale":"en","futureSetting":true}'
  await writeFile(path, source)
  const application = await launchDesktop(profile)
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByText(/Preferences were created by a newer version/)).toBeVisible()
    await expect(page.getByLabel('Appearance', { exact: true })).toBeDisabled()
    await expect(page.getByLabel('Interface language')).toBeDisabled()
    const result = await page.evaluate(() =>
      window.manuslip.updateSettings({ schemaVersion: 1, theme: 'light', locale: 'en' }),
    )
    expect(result.ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe(source)
    const backup = (await readdir(profile)).find((name) =>
      name.startsWith('preferences.json.backup-'),
    )
    expect(backup).toMatch(/backup-\d{4}-\d{2}-\d{2}T/)
    expect(await readFile(join(profile, backup || ''), 'utf8')).toBe(source)
  } finally {
    await application.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('malformed preferences recover visibly while preserving a backup', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'manuslip-corrupt-'))
  await writeFile(join(profile, 'preferences.json'), '{broken')
  const application = await launchDesktop(profile)
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await expect(page.getByText(/Preferences were reset/)).toBeVisible()
    await expect(page.getByLabel('Appearance', { exact: true })).toBeEnabled()
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark')
    await expect(page.getByText('Preferences saved', { exact: true })).toBeVisible()
    const backup = (await readdir(profile)).find((name) =>
      name.startsWith('preferences.json.backup-'),
    )
    expect(await readFile(join(profile, backup || ''), 'utf8')).toBe('{broken')
  } finally {
    await application.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('a failed spelling preference write rolls back its control and permits retry', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'manuslip-settings-write-'))
  const path = join(profile, 'preferences.json')
  const backup = join(profile, 'original.json')
  const application = await launchDesktop(profile)
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const checkbox = page.getByRole('checkbox', { name: 'Check spelling', exact: true })
    await expect(checkbox).toBeEnabled()
    await rename(path, backup)
    await mkdir(path)
    await checkbox.click()
    await expect(
      page.getByText('Unable to save preferences. Try again.', { exact: true }),
    ).toBeVisible()
    await expect(checkbox).not.toBeChecked()
    expect(
      await application.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled()),
    ).toBe(false)
    await rm(path, { recursive: true })
    await rename(backup, path)
    await checkbox.check()
    await expect(page.getByText('Preferences saved', { exact: true })).toBeVisible()
    await expect(checkbox).toBeChecked()
  } finally {
    await application.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

for (const state of [
  { name: 'wide English', locale: 'en', theme: 'light', width: 1160, height: 800, zoom: 1 },
  { name: 'narrow Chinese', locale: 'zh-CN', theme: 'dark', width: 320, height: 800, zoom: 1 },
  { name: 'zoomed Chinese', locale: 'zh-CN', theme: 'light', width: 1160, height: 1000, zoom: 2 },
])
  test(`preferences failures remain actionable inside the dialog: ${state.name}`, async () => {
    await mkdir('test/e2e/result', { recursive: true })
    const directory = await mkdtemp(resolve('test/e2e/result/preferences-save-e2e-'))
    const profile = join(directory, 'profile')
    const path = join(profile, 'preferences.json'),
      backup = join(profile, 'original.json')
    const file = join(directory, 'Notes α中文.md')
    const original = '\ufeff# Notes α中文\r\n\r\nBefore changes.\r\n'
    const draft = '# Notes α中文\n\nUnsaved writing stays here.'
    await writeFile(file, original)
    let application = await launchDesktop(profile, [file])
    let blocked = false
    const restoreStorage = async (): Promise<void> => {
      if (!blocked) return
      await rmdir(path)
      await rename(backup, path)
      blocked = false
    }
    try {
      let page = await application.firstWindow()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await expect(editor).toBeVisible()
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect
        .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(original.replace(/^\ufeff/, '').replaceAll('\r\n', '\n'))
      await editor.focus()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
      await page.keyboard.insertText(draft)
      await expect
        .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(draft)
      const preferences = page.getByRole('button', {
        name: /^(Preferences|偏好设置)$/,
        exact: true,
      })
      await preferences.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: /^(Preferences|偏好设置)$/, exact: true })
      const appearance = page.getByLabel(/^(Appearance|外观)$/, { exact: true })
      const language = page.getByLabel(/^(Interface language|界面语言)$/, { exact: true })
      await appearance.selectOption(state.theme)
      await expect(appearance).toBeEnabled()
      await language.selectOption(state.locale)
      await expect(language).toBeEnabled()
      await application.evaluate(({ BrowserWindow }, state) => {
        const window = BrowserWindow.getAllWindows()[0]
        window?.setMinimumSize(0, 0)
        window?.webContents.setZoomFactor(state.zoom)
        window?.setContentSize(state.width, state.height)
      }, state)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(state.width / state.zoom)
      const requestedTheme = state.theme === 'light' ? 'dark' : 'light'
      const message =
        state.locale === 'en'
          ? 'Unable to save preferences. Try again.'
          : '无法保存偏好设置，请重试。'
      await rename(path, backup)
      await mkdir(path)
      blocked = true
      await appearance.focus()
      await appearance.selectOption(requestedTheme)
      await expect(dialog.getByRole('alert')).toHaveText(message)
      await expect(appearance).toHaveValue(state.theme)
      await expect(appearance).toBeFocused()
      await expect(page.locator('.main-column > .document-notice')).toHaveCount(0)
      const retry = dialog.getByRole('button', {
        name: /^(Retry saving preferences|重试保存偏好设置)$/,
        exact: true,
      })
      // Traverse the actual keyboard sequence from the rolled-back control.
      for (let stop = 0; stop < 4; stop++) {
        if (await retry.evaluate((element) => element === document.activeElement)) break
        await page.keyboard.press('Tab')
      }
      await expect(retry).toBeFocused()
      await expect(retry).toBeInViewport({ ratio: 1 })
      const visual = await retry.evaluate((element) => {
        let background: Element | null = element
        while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)')
          background = background.parentElement
        const style = getComputedStyle(element)
        const container = element.closest('dialog')
        return {
          foreground: style.color,
          background: getComputedStyle(background || document.documentElement).backgroundColor,
          outline: style.outlineStyle,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          outlineColor: style.outlineColor,
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          dialogOverflow: container ? container.scrollWidth > container.clientWidth + 1 : true,
        }
      })
      expect(visual.pageOverflow).toBe(false)
      expect(visual.dialogOverflow).toBe(false)
      expect(visual.outline).toBe('solid')
      expect(visual.outlineWidth).toBeGreaterThanOrEqual(2)
      expect(visual.width).toBeGreaterThanOrEqual(24)
      expect(visual.height).toBeGreaterThanOrEqual(40)
      expect(contrast(visual.foreground, visual.background)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(visual.outlineColor, visual.background)).toBeGreaterThanOrEqual(3)
      await preferencesContrast(page)
      await page.evaluate(axe.source)
      const accessibility = await page.evaluate(async () => {
        const checker = (window as unknown as { axe: typeof import('axe-core') }).axe
        const dialog = document.querySelector('dialog:modal')
        if (!dialog) throw new Error('Preferences dialog is not open')
        const result = await checker.run(dialog, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
          },
        })
        return { violations: result.violations, incomplete: result.incomplete }
      })
      await writeFile(join(directory, 'axe.json'), JSON.stringify(accessibility, null, 2))
      expect(accessibility.violations).toEqual([])
      const client = await page.context().newCDPSession(page)
      try {
        const tree = await client.send('Accessibility.getFullAXTree')
        await writeFile(join(directory, 'error-ax.json'), JSON.stringify(tree, null, 2))
        expect(
          tree.nodes.some((node) => !node.ignored && node.name?.value?.includes(message)),
        ).toBe(true)
      } finally {
        await client.detach()
      }
      await page.screenshot({ path: join(directory, 'error.png') })
      // An unsuccessful retry keeps the recovery action, and its focus, available.
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('alert')).toHaveText(message)
      await expect(retry).toBeFocused()
      await expect(appearance).toHaveValue(state.theme)
      await restoreStorage()
      await page.keyboard.press('Enter')
      await expect(dialog.getByRole('alert')).toHaveCount(0)
      await expect(retry).toHaveCount(0)
      await expect(appearance).toHaveValue(requestedTheme)
      await expect(appearance).toBeFocused()
      expect(JSON.parse(await readFile(path, 'utf8')).theme).toBe(requestedTheme)
      // A different successful choice supersedes an older failed request.
      await rename(path, backup)
      await mkdir(path)
      blocked = true
      await appearance.selectOption(state.theme)
      await expect(dialog.getByRole('alert')).toHaveText(message)
      await restoreStorage()
      const nextLocale = state.locale === 'en' ? 'zh-CN' : 'en'
      await language.selectOption(nextLocale)
      await expect(language).toBeEnabled()
      await expect(dialog.getByRole('alert')).toHaveCount(0)
      await expect(retry).toHaveCount(0)
      await expect(appearance).toHaveValue(requestedTheme)
      await page.screenshot({ path: join(directory, 'saved.png') })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(preferences).toBeFocused()
      const localizedEditor = page.getByRole('textbox', {
        name: /^(Markdown source|Markdown 源码)$/,
      })
      await expect
        .poll(async () => (await localizedEditor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(draft)
      await localizedEditor.focus()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
      await expect
        .poll(async () => (await localizedEditor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(original.replace(/^\ufeff/, '').replaceAll('\r\n', '\n'))
      await expect.poll(() => readFile(file, 'utf8')).toBe(original)
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      await application.close()
      application = await launchDesktop(profile, [file])
      page = await application.firstWindow()
      await expect(
        page.getByRole('textbox', { name: /^(Markdown source|Markdown 源码)$/ }),
      ).toBeVisible()
      expect(
        await page.evaluate(async () => {
          const result = await window.manuslip.bootstrap()
          if (!result.ok) throw new Error(result.error)
          return { theme: result.value.settings.theme, locale: result.value.settings.locale }
        }),
      ).toEqual({ theme: requestedTheme, locale: nextLocale })
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify(
          { state, visual, requestedTheme, nextLocale, sourcePreserved: true },
          null,
          2,
        ),
      )
    } finally {
      await restoreStorage()
      await application
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .catch(() => {})
      await application.close()
    }
  })
