import { resolve } from 'node:path'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
} from '@playwright/test'

export { contrast } from '../helpers/contrast'

export async function pastePlainText(application: ElectronApplication, editor: Locator) {
  if (process.platform !== 'darwin') {
    await editor.press('Control+Shift+v')
    return
  }
  // DevTools key events do not invoke Cocoa's native menu selectors.
  await expect(editor).toBeFocused()
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) throw new Error('Missing focused paste window')
    window.webContents.pasteAndMatchStyle()
  })
}

export async function launchDesktop(
  profile: string,
  paths: string[] = [],
): Promise<ElectronApplication> {
  const application = await electron.launch({
    ...(process.env.MANUSLIP_PACKAGED_EXECUTABLE
      ? { executablePath: process.env.MANUSLIP_PACKAGED_EXECUTABLE, args: paths }
      : { args: [resolve('apps/desktop'), ...paths] }),
    env: { ...process.env, MANUSLIP_TEST_PROFILE: profile },
  })
  try {
    const page = await application.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    if (process.env.MANUSLIP_PACKAGED_EXECUTABLE) {
      const runtime = await application.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        path: app.getAppPath(),
      }))
      expect(runtime.packaged, 'Packaged tests must launch the built application').toBe(true)
      expect(runtime.path).toMatch(/[/\\]app\.asar$/)
      await expect(page).toHaveURL(/^manuslip-app:/)
    }
    await application.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Missing application window')
      // Narrow layout tests deliberately exercise widths below the native minimum.
      // macOS treats a zero minimum as absent and keeps the former native constraint.
      window.setMinimumSize(1, 1)
      window.show()
      app.focus({ steal: true })
      window.focus()
    })
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    return application
  } catch (error) {
    await application.close()
    throw error
  }
}

export async function selectEditorMode(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

async function openDisclosure(page: Page, name: RegExp): Promise<Locator> {
  const trigger = page.getByRole('button', { name })
  const panel = page.getByRole('group', { name, includeHidden: true })
  // A closed native popover can remain painted during its exit transition.
  if (!(await panel.evaluate((element) => element.matches(':popover-open')))) await trigger.click()
  await expect(panel).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  return panel
}

export function openDocumentActions(page: Page): Promise<Locator> {
  return openDisclosure(page, /^(Document actions|文档操作)$/)
}

export function openReadingOptions(page: Page): Promise<Locator> {
  return openDisclosure(page, /^(Reading options|阅读选项)$/)
}

export async function waitForReading(page: Page): Promise<void> {
  await expect(page.locator('.reading-article')).toBeVisible()
  await expect(page.locator('.reading-primary-actions button.primary')).toBeEnabled()
}

export async function openMarkdownExtensions(page: Page): Promise<Locator> {
  const dialog = page.locator('.preferences-dialog')
  if (!(await dialog.evaluate((element) => element.hasAttribute('open'))))
    await page.getByRole('button', { name: /^(Preferences|偏好设置)$/, exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^(Plugins|插件)$/, exact: true }).click()
  const extensions = dialog.getByRole('group', {
    name: /^(Markdown extensions|Markdown 扩展)$/,
    exact: true,
  })
  await expect(extensions).toBeVisible()
  return extensions
}

export async function clickDocumentAction(page: Page, name: string): Promise<void> {
  const panel = await openDocumentActions(page)
  await panel.getByRole('button', { name, exact: true }).click()
}

export async function clickReadingAction(page: Page, name: string): Promise<void> {
  const panel = await openReadingOptions(page)
  await panel.getByRole('button', { name, exact: true }).click()
}

export async function selectReadingLayout(page: Page, layout: string): Promise<void> {
  const panel = await openReadingOptions(page)
  await panel.getByRole('combobox', { name: /^(Reading layout|阅读布局)$/ }).selectOption(layout)
  await page.keyboard.press('Escape')
}
