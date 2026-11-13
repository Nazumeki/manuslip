import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import axe from 'axe-core'
import { launchDesktop } from './helpers'

async function audit(page: Page, directory: string, name: string): Promise<void> {
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
    }
  })
  await writeFile(join(directory, `${name}-axe.json`), `${JSON.stringify(result, null, 2)}\n`)
  expect(
    result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
  ).toEqual([])
}

test('document tabs keep close actions outside the tab list and preserve keyboard, modal and pointer access', async () => {
  await mkdir('test/e2e/result', { recursive: true })
  const directory = await mkdtemp(resolve('test/e2e/result/tab-accessibility-'))
  const firstName = 'First document.md',
    secondName = '第二个文档 — long notes and references.md'
  const first = join(directory, firstName),
    second = join(directory, secondName)
  await writeFile(first, '# First document\n\nOriginal text.\n')
  await writeFile(second, '# 第二个文档\n\nOther text.\n')
  const application = await launchDesktop(join(directory, 'profile'), [first, second])
  try {
    const page = await application.firstWindow()
    const tabs = page.getByRole('tablist', { name: 'Open documents', exact: true })
    const firstTab = page.getByRole('tab', { name: firstName, exact: true })
    const secondTab = page.getByRole('tab', { name: secondName, exact: true })
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(tabs.getByRole('button')).toHaveCount(0)
    await audit(page, directory, 'two-tabs')
    const client = await page.context().newCDPSession(page)
    try {
      const tree = await client.send('Accessibility.getFullAXTree')
      await writeFile(join(directory, 'tabs-ax.json'), `${JSON.stringify(tree, null, 2)}\n`)
      const list = tree.nodes.find((node) => node.role?.value === 'tablist')
      expect(list).toBeDefined()
      const children = tree.nodes.filter(
        (node) => list?.childIds?.includes(node.nodeId) && !node.ignored,
      )
      expect(children.map((node) => node.role?.value)).toEqual(['tab', 'tab'])
    } finally {
      await client.detach()
    }
    await secondTab.focus()
    await page.keyboard.press('Home')
    await expect(firstTab).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(secondTab).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(firstTab).toBeFocused()
    await page.keyboard.press('End')
    await expect(secondTab).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('button', { name: `Close ${secondName}`, exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(secondTab).toBeFocused()

    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await expect(secondTab).toHaveAttribute('aria-selected', 'true')
    await editor.fill('# 第二个文档\n\nEdited text stays in this tab.\n')
    const preferences = page.getByRole('button', { name: 'Preferences', exact: true })
    await preferences.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Preferences', exact: true })
    await expect(dialog).toBeVisible()
    await audit(page, directory, 'preferences')
    await page.getByRole('button', { name: 'Close preferences', exact: true }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('checkbox', { name: 'Check spelling', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Close preferences', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(preferences).toBeFocused()

    for (const width of [320, 1160]) {
      await page.setViewportSize({ width, height: 850 })
      await firstTab.focus()
      await page.keyboard.press('End')
      const close = page.getByRole('button', { name: `Close ${secondName}`, exact: true })
      const tabBounds = await secondTab.boundingBox(),
        closeBounds = await close.boundingBox()
      expect(tabBounds).not.toBeNull()
      expect(closeBounds).not.toBeNull()
      expect(
        Math.abs((tabBounds?.x ?? 0) + (tabBounds?.width ?? 0) - (closeBounds?.x ?? 0)),
      ).toBeLessThan(1)
      expect(Math.abs((tabBounds?.y ?? 0) - (closeBounds?.y ?? 0))).toBeLessThan(1)
      await page.screenshot({ path: join(directory, `tabs-${width}.png`) })
      await audit(page, directory, `editing-${width}`)
      // Reach the editor through the actual Tab sequence, including when it starts below the fold.
      await secondTab.focus()
      for (let stop = 0; stop < 30; stop++) {
        await page.keyboard.press('Tab')
        if (await editor.evaluate((element) => element === document.activeElement)) break
      }
      await expect(editor).toBeFocused()
      const editorBounds = await editor.boundingBox()
      expect(editorBounds?.y).toBeLessThan(850)
      expect((editorBounds?.y ?? 0) + (editorBounds?.height ?? 0)).toBeGreaterThan(0)
    }
    // Pointer closing an inactive document must preserve the active document and its text.
    await page.getByRole('button', { name: `Close ${firstName}`, exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect(editor).toContainText('Edited text stays in this tab.')
    await expect(secondTab).toHaveAttribute('aria-selected', 'true')
    await expect(secondTab).toBeFocused()
    await page.getByRole('button', { name: `Close ${secondName}`, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('main')).toBeFocused()
    await audit(page, directory, 'welcome')

    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    await editor.fill('An unsaved draft must survive a canceled close.')
    const draftClose = page.getByRole('button', { name: /^Close Untitled / })
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false })
    })
    await draftClose.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(draftClose).toBeFocused()
    await expect(editor).toHaveText('An unsaved draft must survive a canceled close.')

    // Model a pending native decision, then deliberately move focus into Preferences.
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        await new Promise<void>((resolve) => {
          ;(globalThis as typeof globalThis & { finishClose?: () => void }).finishClose = resolve
        })
        return { response: 2, checkboxChecked: false }
      }
    })
    await page.keyboard.press('Enter')
    await expect
      .poll(() =>
        application.evaluate(
          () => typeof (globalThis as typeof globalThis & { finishClose?: () => void }).finishClose,
        ),
      )
      .toBe('function')
    await preferences.click()
    await expect(dialog).toBeVisible()
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { finishClose?: () => void }
      state.finishClose?.()
      delete state.finishClose
    })
    await expect(draftClose).toBeEnabled()
    await expect(page.getByLabel('Appearance', { exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(preferences).toBeFocused()
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    await draftClose.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('main')).toBeFocused()
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
  }
})
