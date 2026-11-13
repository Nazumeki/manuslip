import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

for (const width of [1144, 400]) {
  test(`task toggles keep mixed semantic content still at ${width}px throughout the preview update`, async () => {
    await mkdir('test/e2e/result', { recursive: true })
    const directory = await mkdtemp(resolve('test/e2e/result/task-controls-stability-'))
    const application = await launchDesktop(resolve(directory, 'profile'))
    try {
      await application.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]
        window?.setMinimumSize(0, 0)
        window?.setContentSize(width, 850)
      }, width)
      const page = await application.firstWindow()
      await page.setViewportSize({ width, height: 850 })
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      await page.getByRole('button', { name: 'New document', exact: true }).first().click()
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      const source = [
        '# Stable tasks',
        '',
        '"Keep this prose -- and its punctuation -- still."',
        '',
        '$$E=mc^2$$',
        '',
        '| Column | Value |',
        '| --- | --- |',
        '| A | B |',
        '',
        '- [ ] Inline task',
        '  - [x] Nested task',
        '',
        '  3. [ ] Ordered task with $x^2$',
        '  4. [x] Next ordered task',
        '',
        '  > - [ ] "Quoted" task',
        '',
        'End',
        '',
      ].join('\n')
      await editor.fill(source)
      await editor.press(`${modifier}+Home`)
      const checks = page.getByRole('checkbox', { name: 'Toggle task', exact: true })
      await expect(checks).toHaveCount(5)
      await expect(page.locator('.cm-live-math svg')).toHaveCount(1)
      await expect(page.locator('.cm-live-table table')).toHaveCount(1)
      const nestedMath = page.locator('.cm-live-list [data-render-kind="inlineMath"] svg')
      await expect(nestedMath).toHaveCount(1)
      const formula = await nestedMath.elementHandle()
      const observations = []
      for (const index of [0, 1, 2, 4]) {
        const check = checks.nth(index)
        await check.scrollIntoViewIfNeeded()
        await check.focus()
        await page.evaluate(() => {
          const samples: { y: number; height: number; scroll: number }[] = []
          const state = window as typeof window & {
            taskStability?: Promise<typeof samples>
          }
          const started = performance.now()
          state.taskStability = new Promise((resolve) => {
            const sample = () => {
              const task = document.activeElement
              const scroller = document.querySelector('.cm-scroller')
              if (task instanceof HTMLInputElement && scroller)
                samples.push({
                  y: task.getBoundingClientRect().y,
                  height: scroller.scrollHeight,
                  scroll: scroller.scrollTop,
                })
              if (performance.now() - started < 600) requestAnimationFrame(sample)
              else resolve(samples)
            }
            sample()
          })
        })
        if (index === 0 || index === 4) await check.click()
        else await page.keyboard.press('Space')
        const samples = await page.evaluate(async () => {
          const state = window as typeof window & {
            taskStability?: Promise<{ y: number; height: number; scroll: number }[]>
          }
          return await state.taskStability
        })
        observations.push({ index, samples })
        await expect(check).toBeFocused()
        expect(await formula?.evaluate((svg) => svg.isConnected)).toBe(true)
        expect(samples?.length).toBeGreaterThan(2)
        for (const property of ['y', 'height', 'scroll'] as const) {
          const values = samples?.map((sample) => sample[property]) || []
          expect(Math.max(...values) - Math.min(...values), `${index}: ${property}`).toBeLessThan(1)
        }
      }
      await test.info().attach('task-toggle-layout', {
        body: JSON.stringify(observations),
        contentType: 'application/json',
      })
      await page.screenshot({ path: test.info().outputPath('task-toggle-stable.png') })
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect
        .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(
          source
            .replace('[ ] Inline', '[x] Inline')
            .replace('[x] Nested', '[ ] Nested')
            .replace('[ ] Ordered', '[x] Ordered')
            .replace('[ ] "Quoted"', '[x] "Quoted"'),
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
}

test('task targets replace unordered bullets and remain usable in light, dark and narrow layouts', async () => {
  await mkdir('test/e2e/result', { recursive: true })
  const directory = await mkdtemp(resolve('test/e2e/result/task-controls-layout-'))
  const application = await launchDesktop(resolve(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    const source =
      '# Tasks\n\n- [ ] Read the draft\n- [x] Keep the source\n- Regular item\n  - [ ] Nested task\n\n1. [ ] Ordered task\n\n> - [ ] Quoted task\n\n- [not] Ordinary bracket text\n\nEnd\n'
    await editor.fill(source)
    await editor.press(`${modifier}+Home`)
    const checks = page.getByRole('checkbox', { name: 'Toggle task', exact: true })
    await expect(checks).toHaveCount(5)
    await expect(page.locator('.cm-live-bullet')).toHaveCount(2)
    const observations: {
      theme: string
      targets: (Pick<DOMRect, 'x' | 'y' | 'width' | 'height'> & { input?: DOMRect })[]
    }[] = []
    for (const theme of ['light', 'dark']) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByLabel('Appearance', { exact: true }).selectOption(theme)
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
      if (theme === 'dark')
        await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          window?.setMinimumSize(0, 0)
          window?.setContentSize(360, 800)
        })
      // Theme updates can replace widgets; validate a complete layout in one snapshot.
      await expect(async () => {
        const targets = await page.locator('.cm-live-task').evaluateAll((labels) =>
          labels.map((label) => {
            const bounds = label.getBoundingClientRect()
            const input = label.querySelector('input')?.getBoundingClientRect()
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, input }
          }),
        )
        expect(targets).toHaveLength(5)
        for (const target of targets) {
          expect(target.width).toBeGreaterThanOrEqual(24)
          expect(target.height).toBeGreaterThanOrEqual(24)
          expect(target.input?.width).toBe(18)
        }
        for (let index = 1; index < targets.length; index++) {
          const previous = targets[index - 1]
          const next = targets[index]
          expect(next?.y).toBeGreaterThanOrEqual((previous?.y || 0) + (previous?.height || 0))
        }
        observations.push({ theme, targets })
      }).toPass({ timeout: 5_000 })
      await checks.first().uncheck()
      // The label edge is outside the visible 18px input, but remains a native target.
      await page
        .locator('.cm-live-task')
        .first()
        .click({ position: { x: 1, y: 12 } })
      await expect(checks.first()).toBeChecked()
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect
        .poll(async () => (await editor.locator('.cm-line').allTextContents()).join('\n'))
        .toBe(source.replace('- [ ] Read the draft', '- [x] Read the draft'))
      await editor.press(`${modifier}+Home`)
      await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
      await expect(checks).toHaveCount(5)
      await expect(page.locator('.cm-live-bullet')).toHaveCount(2)
    }
    await test.info().attach('task-targets', {
      body: JSON.stringify(observations),
      contentType: 'application/json',
    })
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
  }
})

test('keyboard task toggles preserve focus and undo, and follow a pending document lock', async () => {
  await mkdir('test/e2e/result', { recursive: true })
  const directory = await mkdtemp(resolve('test/e2e/result/task-controls-keyboard-'))
  const application = await launchDesktop(resolve(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    const source =
      '# Tasks\n\n- [ ] First task\n- [x] Second task\n\n1. [ ] Ordered task\n\n> - [ ] "Quoted" task\n\nEnd\n'
    await editor.fill(source)
    await editor.press(`${modifier}+Home`)
    const checks = page.getByRole('checkbox', { name: 'Toggle task', exact: true })
    await expect(checks).toHaveCount(4)
    await checks.first().focus()
    await page.keyboard.press('Space')
    await expect(checks.first()).toBeChecked()
    await expect(checks.first()).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(checks.nth(1)).toBeFocused()
    await page.keyboard.press('Space')
    await expect(checks.nth(1)).not.toBeChecked()
    await expect(checks.nth(1)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(checks.first()).toBeFocused()
    await page.keyboard.press('Space')
    await expect(checks.first()).not.toBeChecked()
    await expect(checks.first()).toBeFocused()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const text = async () => (await editor.locator('.cm-line').allTextContents()).join('\n')
    await expect.poll(text).toBe(source.replace('[x] Second', '[ ] Second'))
    await editor.focus()
    await page.keyboard.press(`${modifier}+z`)
    await expect
      .poll(text)
      .toBe(source.replace('[ ] First', '[x] First').replace('[x] Second', '[ ] Second'))
    await page.keyboard.press(`${modifier}+z`)
    await expect.poll(text).toBe(source.replace('[ ] First', '[x] First'))
    await page.keyboard.press(`${modifier}+z`)
    await expect.poll(text).toBe(source)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
    const toggled = source.replace('[ ] First', '[x] First')
    await expect.poll(text).toBe(toggled)
    await editor.press(`${modifier}+Home`)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-live-list input[type="checkbox"]')).toHaveCount(1)
    await expect(page.locator('.cm-live-blockquote input[type="checkbox"]')).toHaveCount(1)
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        await new Promise<void>((resolve) => {
          ;(globalThis as typeof globalThis & { finishTaskClose?: () => void }).finishTaskClose =
            resolve
        })
        return { response: 2, checkboxChecked: false }
      }
    })
    await page.getByRole('button', { name: /^Close Untitled / }).click()
    await expect
      .poll(() =>
        application.evaluate(
          () =>
            typeof (globalThis as typeof globalThis & { finishTaskClose?: () => void })
              .finishTaskClose,
        ),
      )
      .toBe('function')
    for (const check of await checks.all()) await expect(check).toBeDisabled()
    await application.evaluate(() => {
      const state = globalThis as typeof globalThis & { finishTaskClose?: () => void }
      state.finishTaskClose?.()
      delete state.finishTaskClose
    })
    for (const check of await checks.all()) await expect(check).toBeEnabled()
    await expect(checks.first()).toBeChecked()
    await expect(checks.nth(1)).toBeChecked()
    await page.emulateMedia({ forcedColors: 'active' })
    await checks.first().focus()
    await page.keyboard.press('Tab')
    await expect(checks.nth(1)).toBeFocused()
    expect(
      await checks.nth(1).evaluate((element) => {
        const style = getComputedStyle(element)
        return (
          element.matches(':focus-visible') &&
          style.outlineStyle !== 'none' &&
          Number.parseFloat(style.outlineWidth) >= 2
        )
      }),
    ).toBe(true)
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect.poll(text).toBe(toggled)
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        const state = globalThis as typeof globalThis & { finishTaskClose?: () => void }
        state.finishTaskClose?.()
        delete state.finishTaskClose
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
  }
})
