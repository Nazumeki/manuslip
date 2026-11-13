import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { launchDesktop } from './helpers'

test('one toolbar keeps tabs and native editing aligned across window sizes', async () => {
  const directory = await mkdtemp(resolve('test/e2e/result/navigation-toolbar-'))
  const folder = join(directory, 'Notes')
  await mkdir(folder)
  const paths = ['First.md', '第二个文档.md'].map((name) => join(folder, name))
  for (const path of paths) await writeFile(path, '# A local document\n\nKeep this writing.\n')
  const application = await launchDesktop(join(directory, 'profile'), paths)
  try {
    const page = await application.firstWindow()
    const toolbar = page.getByRole('navigation', { name: 'Application toolbar', exact: true })
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await expect(editor).toContainText('Keep this writing.')
    await expect(page.locator('.sidebar')).toBeHidden()
    if (process.platform !== 'darwin')
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMenuBarVisible(),
        ),
      ).toBe(false)
    const source = page.getByRole('button', { name: 'Source', exact: true })
    await source.click()
    await expect(source).toHaveAttribute('aria-pressed', 'true')
    await editor.fill('A draft with history.')
    await editor.press('ControlOrMeta+End')
    await page.keyboard.type(' Another thought.')
    const action = async (name: string) => {
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page
        .getByRole('group', { name: 'Edit', exact: true })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click()
    }
    await action('Undo')
    await expect(editor).toHaveText('A draft with history.')
    await action('Redo')
    await expect(editor).toContainText('Another thought.')
    await action('Select all')
    await action('Copy')
    await expect
      .poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('A draft with history. Another thought.')
    await action('Cut')
    await expect(editor).toHaveText('')
    await application.evaluate(({ clipboard }) => clipboard.writeText('Pasted from the toolbar.'))
    await action('Paste')
    await expect(editor).toHaveText('Pasted from the toolbar.')
    await action('Undo')
    await expect(editor).toHaveText('')
    await action('Find and replace')
    await expect(page.locator('.cm-search input[name="search"]')).toBeFocused()
    await page.keyboard.press('Escape')
    await application.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    }, folder)
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click()
    await page.getByRole('button', { name: 'Open folder…', exact: true }).click()
    await expect(
      page.getByRole('navigation', { name: 'Workspace files', exact: true }),
    ).toContainText('First.md')
    await expect(
      page.getByRole('navigation', { name: 'Document headings', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Hide workspace', exact: true }).click()
    for (const width of [1440, 820, 390, 320]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window?.setMinimumSize(0, 0)
        window?.setContentSize(width, 850)
      }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      await expect(toolbar).toHaveCSS('height', '48px')
      for (const name of [
        'Show workspace',
        'Edit',
        'Source',
        'Live Preview',
        'Translated preview',
        'Save',
        'Document actions',
        'Preferences',
      ])
        await expect(toolbar.getByRole('button', { name, exact: true })).toBeInViewport({
          ratio: 1,
        })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      const tabs = page.getByRole('tab')
      await tabs.last().focus()
      await page.keyboard.press('Home')
      await expect(tabs.first()).toBeFocused()
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('End')
      await expect(tabs.last()).toBeFocused()
      await expect(tabs.last()).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.tab-close.selected')).toBeInViewport({ ratio: 1 })
    }
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByLabel('Appearance', { exact: true }).selectOption('dark')
    await page.getByLabel('Interface language', { exact: true }).selectOption('zh-CN')
    await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
    await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.evaluate(axe.source)
    const violations = await page.evaluate(
      async () =>
        (
          await (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
        ).violations,
    )
    expect(violations).toEqual([])
  } finally {
    await application
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => {
          window.destroy()
        }),
      )
      .catch(() => {})
    await application.close()
  }
})
