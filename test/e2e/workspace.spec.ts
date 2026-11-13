import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { clickDocumentAction, contrast, launchDesktop } from './helpers'

async function checkWorkspaceContrast(page: Page): Promise<void> {
  const pairs = await page
    .locator(
      '.workspace-browser button, .workspace-browser summary, .workspace-path, .recent-workspaces button',
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        let background: Element | null = element
        while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)')
          background = background.parentElement
        return {
          text: element.textContent,
          foreground: getComputedStyle(element).color,
          background: getComputedStyle(background || document.documentElement).backgroundColor,
        }
      }),
    )
  expect(pairs.length).toBeGreaterThan(4)
  for (const pair of pairs)
    expect(contrast(pair.foreground, pair.background), pair.text || '').toBeGreaterThanOrEqual(4.5)
}

async function chooseFolder(application: ElectronApplication, path: string): Promise<void> {
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
async function stop(application: ElectronApplication): Promise<void> {
  const closed = application.waitForEvent('close')
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await closed
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

test('folder navigation preserves drafts, updates automatically and restores named tabs in order after closing', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manuslip-workspace-e2e-')))
  const root = join(directory, '写作项目')
  const profile = join(directory, 'profile')
  await mkdir(join(root, 'chapters'), { recursive: true })
  await mkdir(join(root, '.git'))
  await mkdir(join(root, 'node_modules'))
  const a = join(root, 'notes.md'),
    b = join(root, 'chapters', 'chapter.md')
  await writeFile(a, '# Notes\n\nFirst file.')
  await writeFile(b, '# Chapter\n\nSecond file.')
  await writeFile(join(root, 'image.png'), 'ignored')
  let application = await launchDesktop(profile)
  try {
    let page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    let editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('draft retained while browsing')
    await chooseFolder(application, root)
    await clickDocumentAction(page, 'Open folder…')
    const navigation = page.getByRole('navigation', { name: 'Workspace files' })
    await expect(navigation.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible()
    await expect(navigation).not.toContainText('node_modules')
    await expect(navigation).not.toContainText('.git')
    await expect(navigation).not.toContainText('image.png')
    await expect(editor).toHaveText('draft retained while browsing')
    await navigation.getByRole('button', { name: 'notes.md', exact: true }).click()
    await expect(editor).toContainText('First file.')
    const folder = navigation.locator('summary').filter({ hasText: /^chapters$/ })
    await folder.focus()
    await page.keyboard.press('Enter')
    await navigation.getByRole('button', { name: 'chapter.md', exact: true }).click()
    await expect(editor).toContainText('Second file.')
    await page.getByRole('tab', { name: 'Untitled 1', exact: false }).click()
    await expect(editor).toHaveText('draft retained while browsing')
    await navigation.getByRole('button', { name: 'notes.md', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(3)
    await expect(page.locator('.workspace-switcher')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
    const headings = page.getByRole('navigation', { name: 'Document headings' })
    await expect(headings.getByRole('button', { name: 'Notes', exact: true })).toBeVisible()
    const positions = await page.evaluate(() => {
      const files = document.querySelector('.sidebar')?.getBoundingClientRect()
      const editor = document.querySelector('.main-column')?.getBoundingClientRect()
      const outline = document.querySelector('.outline-sidebar')?.getBoundingClientRect()
      return {
        filesEnd: files?.right,
        editorStart: editor?.left,
        editorEnd: editor?.right,
        outlineStart: outline?.left,
      }
    })
    expect(positions.filesEnd).toBe(positions.editorStart)
    expect(positions.editorEnd).toBe(positions.outlineStart)
    await folder.focus()
    await writeFile(join(root, 'new.md'), '# New file')
    await expect(navigation.getByRole('button', { name: 'new.md', exact: true })).toBeVisible()
    await expect(folder).toBeFocused()
    await expect(navigation.getByRole('button', { name: 'chapter.md', exact: true })).toBeVisible()
    await writeFile(join(root, 'chapters', 'next.md'), '# Next chapter')
    await expect(navigation.getByRole('button', { name: 'next.md', exact: true })).toBeVisible()
    await rename(join(root, 'new.md'), join(root, 'moved.md'))
    await expect(navigation.getByRole('button', { name: 'new.md', exact: true })).toHaveCount(0)
    await expect(navigation.getByRole('button', { name: 'moved.md', exact: true })).toBeVisible()
    await rm(join(root, 'moved.md'))
    await expect(navigation.getByRole('button', { name: 'moved.md', exact: true })).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(3)
    await page.getByRole('button', { name: 'Find a file', exact: true }).click()
    await expect(page.locator('#workspace-query')).toBeFocused()
    await page.locator('#workspace-query').fill('next')
    await expect(page.locator('.search-results')).toContainText('next.md')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Find a file', exact: true })).toBeFocused()
    await expect(navigation.getByRole('button', { name: 'chapter.md', exact: true })).toBeVisible()
    await checkWorkspaceContrast(page)
    await page.screenshot({ path: test.info().outputPath('workspace-light.png') })
    await application.evaluate(
      ({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      },
      join(root, 'renamed.md'),
    )
    await clickDocumentAction(page, 'Save As…')
    await expect(page.getByRole('tab', { name: 'renamed.md', exact: true })).toBeVisible()
    await expect(
      navigation.getByRole('button', { name: 'renamed.md', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await page.getByRole('tab', { name: 'chapter.md', exact: true }).click()
    await application.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      BrowserWindow.getAllWindows()[0]?.close()
    })
    await expect.poll(() => page.isClosed()).toBe(true)
    await application.close()
    const saved = JSON.parse(await readFile(join(profile, 'workspace-state.json'), 'utf8'))
    expect(saved.documents).toEqual([join(root, 'renamed.md'), b])
    expect(saved.activePath).toBe(b)
    expect(saved.root).toBe(root)
    application = await launchDesktop(profile)
    page = await application.firstWindow()
    editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: 'chapter.md', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(editor).toContainText('Second file.')
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Workspace files' })).toContainText(
      'renamed.md',
    )
    await page.getByText('Recent folders', { exact: true }).click()
    await page.locator('.recent-workspaces button').first().click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark')
    await page.getByLabel('Interface language').selectOption('zh-CN')
    await page.getByRole('button', { name: '关闭偏好设置' }).click()
    await checkWorkspaceContrast(page)
    await page.screenshot({ path: test.info().outputPath('workspace-dark-chinese.png') })
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2),
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1),
    )
    await page.setViewportSize({ width: 320, height: 950 })
    const expandWorkspace = page.getByRole('button', { name: '展开写作空间', exact: true })
    if (await expandWorkspace.isVisible()) await expandWorkspace.click()
    await page.getByRole('button', { name: '收起写作空间', exact: true }).click()
    await page.getByRole('button', { name: '展开写作空间', exact: true }).click()
    await expect(
      page.locator('.sidebar').getByRole('heading', { name: '文件', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '打开文件夹…', exact: true })).toBeVisible()
    await page
      .getByRole('navigation', { name: '工作区文件' })
      .getByRole('button', { name: 'renamed.md', exact: true })
      .click()
    await expect(page.getByRole('tab', { name: 'renamed.md', exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.screenshot({ path: test.info().outputPath('workspace-narrow-chinese.png') })
    expect(errors).toEqual([])
  } finally {
    await cleanup(application, directory)
  }
})

test('missing session files can be retried or forgotten while interrupted drafts remain recoverable', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manuslip-session-missing-')))
  const profile = join(directory, 'profile')
  const path = join(directory, 'missing.md')
  await mkdir(profile)
  await writeFile(path, 'original')
  await writeFile(
    join(profile, 'workspace-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      root: join(directory, 'missing-folder'),
      recents: [join(directory, 'missing-folder')],
      documents: [path],
      activePath: path,
    }),
  )
  let application = await launchDesktop(profile)
  try {
    let page = await application.firstWindow()
    await expect(page.getByRole('tab', { name: 'missing.md', exact: true })).toBeVisible()
    await expect(
      page.getByText('The previous folder is unavailable.', { exact: false }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await expect(page.getByRole('tab', { name: 'Untitled 2', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await page.getByRole('textbox', { name: 'Markdown source' }).fill('interrupted draft')
    await expect
      .poll(
        async () =>
          (await readdir(join(profile, 'recovery'))).filter((name) => name.endsWith('.recovery'))
            .length,
      )
      .toBe(1)
    await stop(application)
    await rm(path)
    application = await launchDesktop(profile)
    page = await application.firstWindow()
    await expect(page.getByRole('heading', { name: 'Recover your writing' })).toBeVisible()
    await expect(page.locator('.restore-failure')).toContainText('missing.md')
    await page.getByRole('button', { name: 'Restore draft: Untitled', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveText(
      'interrupted draft',
    )
    await writeFile(path, 'returned file')
    await page
      .locator('.restore-failure')
      .getByRole('button', { name: 'Try again', exact: true })
      .click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveText(
      'interrupted draft',
    )
    await expect(page.locator('.restore-failure')).toHaveCount(0)
    await stop(application)
    await rm(path)
    application = await launchDesktop(profile)
    page = await application.firstWindow()
    await expect(page.locator('.restore-failure')).toContainText('missing.md')
    await page.getByRole('button', { name: 'Remove from session', exact: true }).click()
    await expect(page.locator('.restore-failure')).toHaveCount(0)
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(profile, 'workspace-state.json'), 'utf8')).documents,
      )
      .toEqual([])
    await expect(page.getByRole('heading', { name: 'Recover your writing' })).toBeVisible()
  } finally {
    await cleanup(application, directory)
  }
})

test('workspace bridge rejects paths and unowned IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-workspace-boundary-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open folder…', exact: true })).toBeEnabled()
    const result = await page.evaluate(async () => {
      const denied = async (action: () => Promise<unknown>): Promise<boolean> => {
        try {
          const result = await action()
          return (
            typeof result === 'object' && result !== null && 'ok' in result && result.ok === false
          )
        } catch {
          return true
        }
      }
      return Promise.all([
        denied(() => window.manuslip.openWorkspaceFile('C:/private.md')),
        denied(() => window.manuslip.listWorkspace('00000000-0000-0000-0000-000000000000')),
        denied(() =>
          window.manuslip.rememberDocuments(['00000000-0000-0000-0000-000000000000'], null),
        ),
        denied(() => window.manuslip.restoreSessionFile('00000000-0000-0000-0000-000000000000')),
      ])
    })
    expect(result).toEqual([true, true, true, true])
    const denied = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents) throw new Error('No window')
      return await contents.executeJavaScriptInIsolatedWorld(999, [
        { code: `new Promise(resolve => { const result = typeof require; resolve(result) })` },
      ])
    })
    expect(denied).toBe('undefined')
  } finally {
    await cleanup(application, directory)
  }
})
