import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import axe from 'axe-core'
import { clickDocumentAction, contrast, launchDesktop } from './helpers'

for (const theme of ['light', 'dark'])
  test(`${theme} duplicate filenames stay distinct through navigation, Save As and close`, async () => {
    const directory = await mkdtemp(resolve('test/e2e/result/tab-context-'))
    test.info().annotations.push({ type: 'tabs-context-evidence', description: directory })
    const paths = ['drafts/notes.md', 'archive/notes.md', 'book/drafts/notes.md'].map((path) =>
      join(directory, path),
    )
    const originals = paths.map(
      (_, index) => `# Draft ${index + 1}\n\nKeep the exact words in manuscript ${index + 1}.\n`,
    )
    for (const [index, path] of paths.entries()) {
      await mkdir(resolve(path, '..'), { recursive: true })
      await writeFile(path, originals[index] ?? '')
    }
    const application = await launchDesktop(join(directory, 'profile'), paths)
    try {
      const page = await application.firstWindow()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const names = ['notes.md — drafts', 'notes.md — archive', 'notes.md — book/drafts']
      const tabs = page.getByRole('tab')
      await expect(tabs).toHaveCount(3)
      const ids = await tabs.evaluateAll((nodes) => nodes.map((node) => node.id))
      const configurations = [
        { width: 1160, zoom: 1, locale: 'en', dir: 'ltr', forced: false },
        { width: 320, zoom: 1, locale: 'zh-CN', dir: 'ltr', forced: false },
        { width: 320, zoom: 2, locale: 'en', dir: 'rtl', forced: false },
        { width: 580, zoom: 2, locale: 'zh-CN', dir: 'ltr', forced: true },
      ]
      const observations = []
      for (const [index, config] of configurations.entries()) {
        await page.getByRole('button', { name: /^(Preferences|偏好设置)$/, exact: true }).click()
        await page.getByLabel(/^(Appearance|外观)$/, { exact: true }).selectOption(theme)
        await page
          .getByLabel(/^(Interface language|界面语言)$/, { exact: true })
          .selectOption(config.locale)
        await page
          .getByRole('button', { name: /^(Close preferences|关闭偏好设置)$/, exact: true })
          .click()
        await application.evaluate(({ BrowserWindow }, config) => {
          const window = BrowserWindow.getAllWindows()[0]
          window?.setMinimumSize(0, 0)
          window?.setContentSize(config.width * config.zoom, 800 * config.zoom)
          window?.webContents.setZoomFactor(config.zoom)
        }, config)
        await page.emulateMedia({ forcedColors: config.forced ? 'active' : 'none' })
        await page.evaluate((dir) => {
          document.documentElement.dir = dir
        }, config.dir)
        await expect.poll(() => page.evaluate(() => innerWidth)).toBe(config.width)
        for (const name of names)
          await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(1)
        const closeNames = await page
          .locator('.tab-close')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))
        expect(new Set(closeNames).size).toBe(3)
        await tabs.first().focus()
        await page.keyboard.press('Home')
        await expect(tabs.first()).toBeFocused()
        await page.keyboard.press(config.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight')
        await expect(tabs.nth(1)).toBeFocused()
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press(config.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft')
        await expect(tabs.first()).toBeFocused()
        await page.keyboard.press('End')
        await expect(tabs.last()).toBeFocused()
        await expect(tabs.last()).toBeInViewport({ ratio: 1 })
        await expect(page.locator('.tab-close.selected')).toBeInViewport({ ratio: 1 })
        const measured = await page.locator('.document-tabs').evaluate((strip) => {
          let canvas: string | undefined
          const background = (element: Element): string => {
            for (let current: Element | null = element; current; current = current.parentElement) {
              const value = getComputedStyle(current).backgroundColor
              const alpha = value.startsWith('rgba(')
                ? Number.parseFloat(value.slice(value.lastIndexOf(',') + 1))
                : 1
              if (alpha === 1) return value
              if (alpha !== 0) throw new Error('Unexpected translucent tab background')
            }
            if (!canvas) {
              const probe = document.createElement('div')
              probe.style.backgroundColor = 'Canvas'
              document.body.append(probe)
              canvas = getComputedStyle(probe).backgroundColor
              probe.remove()
            }
            return canvas
          }
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            contexts: Array.from(strip.querySelectorAll('.tab-context')).map((node) => ({
              text: node.textContent,
              color: getComputedStyle(node).color,
              background: background(node),
              fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
            })),
            targets: Array.from(strip.querySelectorAll('button')).map((node) => ({
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
            })),
          }
        })
        expect(measured.overflow).toBe(false)
        for (const target of measured.targets) {
          expect(target.width).toBeGreaterThanOrEqual(24)
          expect(target.height).toBeGreaterThanOrEqual(24)
        }
        for (const context of measured.contexts) {
          expect(context.fontSize).toBeGreaterThanOrEqual(12)
          expect(contrast(context.color, context.background)).toBeGreaterThanOrEqual(4.5)
        }
        if (config.forced) {
          const selected = page.getByRole('tab', { selected: true })
          await expect(selected.locator('.tab-title')).toHaveCSS(
            'text-decoration-line',
            'underline',
          )
          await expect(selected).toHaveCSS('border-bottom-width', '2px')
          await expect(selected).toHaveCSS('outline-width', '2px')
          await expect(selected).toHaveCSS('forced-color-adjust', 'auto')
        }
        // Page screenshots crop the native window when Electron zoom is above 100%.
        const capture = await application.evaluate(async ({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) throw new Error('Missing application window')
          const image = await window.webContents.capturePage()
          return {
            png: image.toPNG().toString('base64'),
            size: image.getSize(),
            contentSize: window.getContentSize(),
            zoom: window.webContents.getZoomFactor(),
          }
        })
        // macOS constrains native height to the display's work area.
        expect(capture.size.width).toBeGreaterThanOrEqual(config.width * config.zoom)
        expect(capture.contentSize[1]).toBeGreaterThan(0)
        expect(capture.size.height).toBeGreaterThanOrEqual(capture.contentSize[1] ?? 0)
        expect(capture.zoom).toBe(config.zoom)
        observations.push({ config, closeNames, measured, capture: { size: capture.size } })
        const screenshot = join(directory, `${theme}-${index}.png`)
        await writeFile(screenshot, Buffer.from(capture.png, 'base64'))
        await test
          .info()
          .attach(`${theme} tabs ${index}`, { path: screenshot, contentType: 'image/png' })
      }
      // axe-core#3978 mixes authored text-fill with forced backgrounds. The actual
      // system-color pairs/cues above are separate from this authored-palette audit.
      await page.emulateMedia({ forcedColors: 'none' })
      await expect
        .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
        .toBe(false)
      await page.evaluate(axe.source)
      const audit = await page.evaluate(async () => {
        const checker = (window as unknown as { axe: typeof import('axe-core') }).axe
        return checker.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
          },
        })
      })
      await writeFile(join(directory, 'axe.json'), `${JSON.stringify(audit, null, 2)}\n`)
      expect(audit.violations.map((row) => row.id)).toEqual([])
      const client = await page.context().newCDPSession(page)
      try {
        const ax = await client.send('Accessibility.getFullAXTree')
        await writeFile(join(directory, 'ax.json'), `${JSON.stringify(ax, null, 2)}\n`)
        const tabNames = ax.nodes
          .filter((node) => node.role?.value === 'tab')
          .map((node) => node.name?.value)
        expect(tabNames).toEqual(names)
      } finally {
        await client.detach()
      }
      await writeFile(
        join(directory, 'observations.json'),
        `${JSON.stringify(observations, null, 2)}\n`,
      )

      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window?.webContents.setZoomFactor(1)
        window?.setContentSize(1160, 800)
      })
      await page.emulateMedia({ forcedColors: 'none' })
      await page.evaluate(() => {
        document.documentElement.dir = 'ltr'
      })
      await page.getByRole('button', { name: '偏好设置', exact: true }).click()
      await page.getByLabel('界面语言', { exact: true }).selectOption('en')
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
      await tabs.first().click()
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      const edited = `${originals[0]}\nA local edit must follow the correct file.\n`
      await editor.fill(edited)
      const renamed = join(directory, 'drafts/renamed.md')
      await application.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      }, renamed)
      await clickDocumentAction(page, 'Save As…')
      await expect(page.getByRole('tab', { name: 'renamed.md', exact: true })).toBeEnabled()
      await expect(page.getByRole('tab', { name: 'notes.md — archive', exact: true })).toHaveCount(
        1,
      )
      await expect(page.getByRole('tab', { name: 'notes.md — drafts', exact: true })).toHaveCount(1)
      expect(await tabs.evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual(ids)
      expect(await readFile(renamed, 'utf8')).toBe(edited)
      expect(await readFile(paths[0] ?? '', 'utf8')).toBe(originals[0])
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await editor.focus()
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`)
      const source = () =>
        editor
          .locator('.cm-line')
          .allTextContents()
          .then((lines) => lines.join('\n'))
      await expect.poll(source).toBe(originals[0])
      await page.getByRole('button', { name: 'Close notes.md — archive', exact: true }).click()
      await expect(tabs).toHaveCount(2)
      await expect(page.getByRole('tab', { name: 'notes.md', exact: true })).toHaveCount(1)
      await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
      await expect.poll(source).toBe(originals[0])
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false })
      })
      await page.getByRole('button', { name: 'Close renamed.md', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Close renamed.md', exact: true }),
      ).toBeEnabled()
      await expect(tabs).toHaveCount(2)
      await expect.poll(source).toBe(originals[0])
      expect(await readFile(paths[1] ?? '', 'utf8')).toBe(originals[1])
      expect(await readFile(paths[2] ?? '', 'utf8')).toBe(originals[2])
      expect(errors).toEqual([])
    } finally {
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      })
      await application.close()
    }
  })
