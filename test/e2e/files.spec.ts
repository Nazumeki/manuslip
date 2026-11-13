import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { clickDocumentAction, contrast, launchDesktop, selectEditorMode } from './helpers'

async function chooseOpen(application: ElectronApplication, path: string): Promise<void> {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, path)
}
async function chooseSave(application: ElectronApplication, path: string | null): Promise<void> {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = async () =>
      selected ? { canceled: false, filePath: selected } : { canceled: true, filePath: '' }
  }, path)
}
async function closeAnswer(application: ElectronApplication, response: number): Promise<void> {
  await application.evaluate(({ dialog }, answer) => {
    dialog.showMessageBox = async () => ({ response: answer, checkboxChecked: false })
  }, response)
}
async function cleanup(application: ElectronApplication, directory: string): Promise<void> {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('native open, source editing, autosave, Save As and reopen preserve Unicode BOM/CRLF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-files-e2e-'))
  const path = join(directory, '世界.md')
  const target = join(directory, 'saved.md')
  await writeFile(
    path,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 世界\r\n原文\r\n')]),
  )
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await chooseOpen(application, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toContainText('原文')
    await editor.fill('# 世界\n编辑 📝\n')
    await expect
      .poll(async () => (await readFile(path)).toString('hex'))
      .toBe(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('# 世界\r\n编辑 📝\r\n'),
        ]).toString('hex'),
      )
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    await chooseSave(application, target)
    await clickDocumentAction(page, 'Save As…')
    await expect(page.getByRole('tab', { name: 'saved.md' })).toBeVisible()
    expect(await readFile(target)).toEqual(await readFile(path))
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await chooseOpen(application, target)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(editor).toContainText('编辑 📝')
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await expect(page.getByRole('heading', { name: '偏好设置' })).toBeVisible()
    await page.getByRole('button', { name: '关闭偏好设置' }).click()
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor-chinese.png') })
    expect(errors).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('cancelled save and window close retain a draft; Save Copy does not mark it saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-draft-e2e-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('# Draft\nDo not lose this.\n')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${modifier}+z`)
    await expect(editor).toHaveText('')
    await expect(page.getByText('No changes', { exact: true })).toBeVisible()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await expect(editor).toContainText('Do not lose this.')
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await chooseSave(application, null)
    await page.keyboard.press(`${modifier}+s`)
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await expect(editor).toContainText('Do not lose this.')
    await closeAnswer(application, 2)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect(editor).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    const copy = join(directory, 'copy.md')
    await chooseSave(application, copy)
    await clickDocumentAction(page, 'Save a copy…')
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await expect.poll(async () => readFile(copy, 'utf8')).toBe('# Draft\nDo not lose this.\n')
    await closeAnswer(application, 1)
    await page.getByRole('button', { name: 'Close Untitled 1', exact: true }).click()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await expect(editor).toHaveText('')
    await editor.fill('save on quit')
    await closeAnswer(application, 2)
    await application.evaluate(({ app }) => {
      app.quit()
    })
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(editor).toHaveText('save on quit')
    const finalPath = join(directory, 'saved-on-quit.md')
    await chooseSave(application, finalPath)
    await closeAnswer(application, 0)
    const closed = application.waitForEvent('close')
    await application
      .evaluate(({ app }) => {
        app.quit()
      })
      .catch(() => {})
    await closed
    expect(await readFile(finalPath, 'utf8')).toBe('save on quit')
  } finally {
    await cleanup(application, directory)
  }
})

test('tabs retain selection and undo history; cancelling window close keeps every dirty draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-tabs-e2e-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const create = page.getByRole('button', { name: 'New document', exact: true }).first()
    await create.click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('first draft')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText('Ln 1, Col 3', { exact: true })).toBeVisible()
    await create.click()
    await expect(page.getByRole('tab', { name: 'Untitled 2', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await editor.fill('second draft')
    const first = page.getByRole('tab', { name: 'Untitled 1', exact: false })
    const second = page.getByRole('tab', { name: 'Untitled 2', exact: false })
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.locator('.cm-editor')).toHaveCount(1)
    await first.click()
    await expect(editor).toHaveText('first draft')
    await expect(page.getByText('Ln 1, Col 3', { exact: true })).toBeVisible()
    await first.focus()
    await page.keyboard.press('ArrowRight')
    await expect(second).toBeFocused()
    await expect(editor).toHaveText('second draft')
    await page.keyboard.press('Home')
    await expect(first).toBeFocused()
    await expect(editor).toHaveText('first draft')
    await editor.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(editor).toHaveText('')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    await expect(editor).toHaveText('first draft')
    await application.evaluate(({ dialog, BrowserWindow }) => {
      let count = 0
      dialog.showMessageBox = async () => ({
        response: count++ === 0 ? 1 : 2,
        checkboxChecked: false,
      })
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await first.click()
    await expect(editor).toHaveText('first draft')
    await closeAnswer(application, 2)
    await application.evaluate(({ Menu }) => {
      const close = Menu.getApplicationMenu()
        ?.items.flatMap((item) => item.submenu?.items || [])
        .find((item) => item.accelerator === 'CmdOrCtrl+W')
      if (!close) throw new Error('Missing native Close document accelerator')
      close.click()
    })
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await closeAnswer(application, 1)
    await page.getByRole('button', { name: 'Close Untitled 1', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect(editor).toHaveText('second draft')
    await page.screenshot({ path: test.info().outputPath('document-tabs.png') })
    expect(errors).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('inactive files autosave and reload; reopening activates the existing tab and restores scroll', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-tab-file-e2e-'))
  const path = join(directory, 'long.md')
  const text = Array.from({ length: 1000 }, (_, index) => `Line ${index + 1}`).join('\n')
  await writeFile(path, text)
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await chooseOpen(application, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await selectEditorMode(page, 'Source')
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
    await page.keyboard.insertText(' edited')
    await expect(page.getByText('Ln 1000, Col 17', { exact: true })).toBeVisible()
    const scroll = await page.locator('.cm-scroller').evaluate((element) => element.scrollTop)
    expect(scroll).toBeGreaterThan(1000)
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await expect(page.getByRole('tab', { name: 'Untitled 2', exact: false })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await editor.fill('another draft')
    await expect.poll(async () => readFile(path, 'utf8')).toBe(`${text} edited`)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: 'long.md', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByText('Ln 1000, Col 17', { exact: true })).toBeVisible()
    await expect
      .poll(async () => page.locator('.cm-scroller').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scroll - 100)
    await page.getByRole('tab', { name: 'Untitled 2', exact: false }).click()
    await expect(page.getByRole('tab', { name: 'Untitled 2', exact: false })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(editor).toHaveText('another draft')
    await writeFile(path, 'updated externally')
    await page.getByRole('tab', { name: 'long.md', exact: true }).click()
    await expect(editor).toHaveText('updated externally')
  } finally {
    await cleanup(application, directory)
  }
})

test('uncertain encodings and mixed line endings stay protected until an explicit choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-encoding-e2e-'))
  const legacy = join(directory, 'legacy.md')
  const mixed = join(directory, 'mixed.md')
  await writeFile(legacy, Buffer.from([0x43, 0x61, 0x66, 0xe9]))
  await writeFile(mixed, 'first\r\nsecond\n')
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await chooseOpen(application, legacy)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(
      page.getByText('The detected encoding needs confirmation.', { exact: false }),
    ).toBeVisible()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('local text')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Choose an encoding')
    expect(await readFile(legacy)).toEqual(Buffer.from([0x43, 0x61, 0x66, 0xe9]))
    await closeAnswer(application, 1)
    await page.getByLabel('File encoding').selectOption('windows-1252')
    await page.getByRole('button', { name: 'Reopen with encoding' }).click()
    await expect(editor).toHaveText('Café')
    await expect(
      page.getByText('The detected encoding needs confirmation.', { exact: false }),
    ).toHaveCount(0)
    await editor.fill('Café 世界')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Some characters cannot be saved')
    const utf8 = join(directory, 'utf8.md')
    await chooseSave(application, utf8)
    await page.getByRole('button', { name: 'Save As UTF-8…' }).click()
    await expect(page.getByRole('tab', { name: 'utf8.md' })).toBeVisible()
    expect(await readFile(utf8, 'utf8')).toBe('Café 世界')
    expect(await readFile(legacy)).toEqual(Buffer.from([0x43, 0x61, 0x66, 0xe9]))
    await chooseOpen(application, mixed)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Save with CRLF' })).toBeVisible()
    await editor.fill('first\nsecond edited\n')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('mixed line endings')
    expect(await readFile(mixed, 'utf8')).toBe('first\r\nsecond\n')
    await page.getByRole('button', { name: 'Save with CRLF' }).click()
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    expect(await readFile(mixed, 'utf8')).toBe('first\r\nsecond edited\r\n')
  } finally {
    await cleanup(application, directory)
  }
})

test('external edits never replace a dirty buffer; explicit overwrite requires confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-conflict-e2e-'))
  const path = join(directory, 'conflict.md')
  await writeFile(path, 'original')
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await chooseOpen(application, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toHaveText('original')
    await editor.fill('local changes')
    await writeFile(path, 'external changes')
    await expect(
      page.getByText('This file changed outside Manuslip.', { exact: false }),
    ).toBeVisible()
    await expect(editor).toHaveText('local changes')
    expect(await readFile(path, 'utf8')).toBe('external changes')
    await closeAnswer(application, 1)
    await page.getByRole('button', { name: 'Overwrite disk file…' }).click()
    await expect(page.getByRole('button', { name: 'Overwrite disk file…' })).toBeEnabled()
    expect(await readFile(path, 'utf8')).toBe('external changes')
    await closeAnswer(application, 0)
    await page.getByRole('button', { name: 'Overwrite disk file…' }).click()
    await expect.poll(async () => readFile(path, 'utf8')).toBe('local changes')
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor-light.png') })
  } finally {
    await cleanup(application, directory)
  }
})

test('interrupted drafts are offered on restart and restored as new files without replacing disk content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-recover-e2e-'))
  const profile = join(directory, 'profile')
  const original = join(directory, 'original.md')
  await writeFile(original, 'original disk text')
  let application = await launchDesktop(profile)
  try {
    let page = await application.firstWindow()
    await chooseOpen(application, original)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    let editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toHaveText('original disk text')
    await editor.fill('recovered local text 📝')
    await writeFile(original, 'external disk text')
    await expect(
      page.getByText('This file changed outside Manuslip.', { exact: false }),
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          (await readdir(join(profile, 'recovery'))).filter((name) => name.endsWith('.recovery'))
            .length,
      )
      .toBe(1)
    // app.exit bypasses the orderly close/save/discard handshake, simulating interruption.
    const stopped = application.waitForEvent('close')
    await application
      .evaluate(({ app }) => {
        app.exit(0)
      })
      .catch(() => {})
    await stopped
    application = await launchDesktop(profile)
    page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Recover your writing' })).toBeVisible()
    expect(await readFile(original, 'utf8')).toBe('external disk text')
    await page.getByRole('button', { name: 'Restore draft' }).click()
    editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toHaveText('recovered local text 📝')
    await expect(page.getByRole('tab', { name: /^Untitled/ })).toBeVisible()
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('editor-recovered.png') })
    const saved = join(directory, 'recovered.md')
    await chooseSave(application, saved)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
    expect(await readFile(saved, 'utf8')).toBe('recovered local text 📝')
    expect(await readFile(original, 'utf8')).toBe('external disk text')
    await expect
      .poll(
        async () =>
          (await readdir(join(profile, 'recovery'))).filter((name) => name.endsWith('.recovery'))
            .length,
      )
      .toBe(0)
  } finally {
    await cleanup(application, directory)
  }
})

test('source editor reflows at 200% zoom with readable syntax in both themes and localized search', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-editor-ui-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await editor.fill(
      '# Writing room\n\n**Strong** and *emphasis*, ~~removed~~, [link](https://example.com)\n\n```javascript\n// A comment\nconst message = "hello"\nconst count = 42\nif (true) console.log(message)\n```\n',
    )
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await page.getByRole('button', { name: 'Close preferences' }).click()
      await expect(page.locator('.cm-content span').first()).toBeVisible()
      const pairs = await page
        .locator('.cm-content span, .editor-status, .document-heading span')
        .evaluateAll((elements) =>
          elements.map((element) => {
            let background: Element | null = element
            while (
              background &&
              getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)'
            )
              background = background.parentElement
            return {
              text: element.textContent,
              foreground: getComputedStyle(element).color,
              background: getComputedStyle(background || document.documentElement).backgroundColor,
            }
          }),
        )
      expect(pairs.length).toBeGreaterThan(10)
      for (const pair of pairs)
        expect(
          contrast(pair.foreground, pair.background),
          `${theme}: ${pair.text}`,
        ).toBeGreaterThanOrEqual(4.5)
      await page.screenshot({ path: test.info().outputPath(`editor-${theme}.png`) })
    }
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await expect(editor).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
    )
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await expect(page.getByRole('button', { name: '关闭偏好设置' })).toBeVisible()
    await page.getByRole('button', { name: '关闭偏好设置' }).click()
    const source = page.getByRole('textbox', { name: 'Markdown 源码' })
    await source.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
    await expect(page.getByRole('textbox', { name: '查找', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(source).toContainText('Writing room')
  } finally {
    await cleanup(application, directory)
  }
})
