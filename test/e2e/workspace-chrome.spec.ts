import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './helpers'

for (const theme of ['light', 'dark'])
  test(`document details and long filenames remain usable in the ${theme} workspace`, async () => {
    const directory = await mkdtemp(resolve('test/e2e/result/workspace-chrome-e2e-'))
    const folder = join(directory, 'Research and drafts', 'Notes for the next edition')
    await mkdir(folder, { recursive: true })
    const name = '写作计划 — ملاحظات — Research notes and references for the next edition.md'
    const path = join(folder, name)
    const source = '\ufeff# Notes\r\n\r\nA long filename should leave room to write.\r\n'
    await writeFile(path, source)
    const application = await launchDesktop(join(directory, 'profile'), [path])
    const observations: unknown[] = []
    try {
      const page = await application.firstWindow()
      const tab = page.getByRole('tab', { name, exact: true })
      await expect(tab).toBeVisible()
      for (const state of [
        { width: 1160, height: 800, zoom: 1, locale: 'en', dir: 'ltr' },
        { width: 360, height: 800, zoom: 1, locale: 'en', dir: 'ltr' },
        { width: 320, height: 800, zoom: 1, locale: 'zh-CN', dir: 'ltr' },
        { width: 1160, height: 1000, zoom: 2, locale: 'zh-CN', dir: 'ltr' },
        { width: 360, height: 800, zoom: 1, locale: 'en', dir: 'rtl' },
      ]) {
        await page.getByRole('button', { name: /^(Preferences|偏好设置)$/, exact: true }).click()
        await page.getByLabel(/^(Appearance|外观)$/, { exact: true }).selectOption(theme)
        await page
          .getByLabel(/^(Interface language|界面语言)$/, { exact: true })
          .selectOption(state.locale)
        await page.getByRole('button', { name: /^(Close preferences|关闭偏好设置)$/ }).click()
        await application.evaluate(({ BrowserWindow }, state) => {
          const window = BrowserWindow.getAllWindows()[0]
          window?.setMinimumSize(0, 0)
          window?.webContents.setZoomFactor(state.zoom)
          window?.setContentSize(state.width, state.height)
        }, state)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(state.width / state.zoom)
        await page.evaluate((dir) => {
          document.documentElement.dir = dir
        }, state.dir)
        const chinese = state.locale === 'zh-CN'
        await page.getByRole('button', { name: chinese ? '源码' : 'Source', exact: true }).click()
        await expect(tab).toHaveAttribute('title', path)
        const details = page.getByRole('button', {
          name: chinese ? /文档详情$/ : /Document details$/,
          exact: true,
        })
        for (const control of [
          details,
          page.locator('.local-time'),
          page.getByRole('button', { name: chinese ? '保存' : 'Save', exact: true }),
          page.getByRole('button', { name: chinese ? '偏好设置' : 'Preferences', exact: true }),
        ])
          await expect(control).toBeInViewport({ ratio: 1 })
        const layout = await page.evaluate(() => {
          const editor = document.querySelector('.source-editor')?.getBoundingClientRect()
          const title = document.querySelector('.document-tab[aria-selected="true"] .tab-title')
          const header = document.querySelector('.app-toolbar')?.getBoundingClientRect()
          const status = document.querySelector('.editor-status')?.getBoundingClientRect()
          return {
            width: innerWidth,
            height: innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            editorHeight: editor?.height ?? 0,
            headerHeight: header?.height ?? 0,
            statusHeight: status?.height ?? 0,
            titleEllipsis: title ? title.scrollWidth > title.clientWidth : false,
          }
        })
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
        expect(layout.headerHeight).toBe(48)
        expect(layout.statusHeight).toBeLessThanOrEqual(41)
        expect(layout.editorHeight).toBeGreaterThanOrEqual(state.zoom === 2 ? 120 : 450)
        if (state.width <= 360) expect(layout.titleEllipsis).toBe(true)
        await details.focus()
        await page.keyboard.press('Enter')
        const panel = page.getByRole('group', {
          name: chinese ? '文档详情' : 'Document details',
          exact: true,
        })
        await expect(panel).toBeVisible()
        await expect(page.locator('.local-time')).toHaveText(/^\d{2}:\d{2}$/)
        await expect(panel).not.toContainText(
          chinese ? '按 UTF-8 和 LF 换行符计算' : 'UTF-8 with LF line endings',
        )
        await expect(details).toHaveText(chinese ? '9 个词' : '9 words')
        await expect(details).toHaveAttribute('aria-expanded', 'true')
        await expect(panel.getByText(path, { exact: true })).toBeVisible()
        await expect(panel.getByText('UTF8 · BOM', { exact: true })).toBeVisible()
        await expect(panel.getByText('CRLF', { exact: true })).toBeVisible()
        await expect(
          panel.getByText(chinese ? '词数' : 'Words', { exact: true }).locator('+ dd'),
        ).toHaveText('9')
        await expect(
          panel.getByText(chinese ? '字符数' : 'Characters', { exact: true }).locator('+ dd'),
        ).toHaveText('53')
        await expect(panel).toContainText(
          `${Buffer.byteLength(source.replace(/^\ufeff/, '').replaceAll('\r\n', '\n'))} ${chinese ? '字节' : 'bytes'}`,
        )
        expect(
          await panel.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return (
              rect.left >= 0 &&
              rect.right <= innerWidth + 1 &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight + 1 &&
              element.scrollWidth <= element.clientWidth + 1
            )
          }),
        ).toBe(true)
        const suffix = `${state.width}-${state.locale}-${state.zoom}-${state.dir}`
        await page.screenshot({ path: join(directory, `details-${suffix}.png`) })
        await page.keyboard.press('Escape')
        await expect(panel).toBeHidden()
        await expect(details).toBeFocused()
        await page.screenshot({ path: join(directory, `workspace-${suffix}.png`) })
        observations.push({ state, layout })
      }
      expect(await readFile(path, 'utf8')).toBe(source)
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify({ theme, observations }, null, 2),
      )
    } finally {
      await application
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .catch(() => {})
      await application.close()
    }
  })
