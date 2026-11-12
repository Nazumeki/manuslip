import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, type Locator, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const source = [
  '# Preview positions',
  'Text before the table.',
  '| Left | Center | Right |\n| :--- | :---: | ---: |\n| **alpha same alpha** | prefix [label](https://example.invalid/label) suffix | `a\\|b` |\n| 中文😀 &amp; text | | A longer cell that wraps across several lines in a narrow window. |\n| Emoji :smile: :heart: after | Before $x^2$ after | Last |',
  '```js\nconst first = "repeat"\nconst second = "repeat"\nconsole.log(second)\n```',
  'Before $x_i^2$ after.',
  '$$\nz^2\n$$',
  '7. **Repeated label**\n2. Another [label](https://example.invalid/) repeated.',
  'End.',
].join('\n\n')

/** Click the trailing half of a glyph, as a user would, without setting selection. */
async function textPoint(locator: Locator, text: string, offset: number) {
  await locator.scrollIntoViewIfNeeded()
  return locator.evaluate(
    (element, { text, offset }) => {
      const from = element.textContent?.indexOf(text) ?? -1
      if (from < 0) throw new Error(`Missing rendered text: ${text}`)
      let remaining = from + offset
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0
        if (remaining > length) {
          remaining -= length
          continue
        }
        if (remaining === 0) continue
        const range = document.createRange()
        range.setStart(node, remaining - 1)
        range.setEnd(node, remaining)
        const box = range.getBoundingClientRect()
        return { x: box.right - 0.1, y: box.top + box.height / 2 }
      }
      throw new Error(`Missing rendered text: ${text}`)
    },
    { text, offset },
  )
}

test('wide table edits retain horizontal scroll, layout and the focused cell on refresh', async () => {
  const directory = await mkdtemp(resolve('test/e2e/result/preview-position-scroll-'))
  const profile = join(directory, 'profile'),
    path = join(directory, 'wide.md')
  const header = Array.from({ length: 8 }, (_, column) => `Column ${column + 1}`).join(' | ')
  const values = Array.from({ length: 8 }, (_, column) => `**value${column + 1}**`).join(' | ')
  const source = `Before.\n\n| ${header} |\n| ${' --- |'.repeat(8)}\n| ${values} |\n\nAfter.`
  await mkdir(profile)
  await writeFile(
    join(profile, 'preferences.json'),
    JSON.stringify({ schemaVersion: 1, locale: 'en' }),
  )
  await writeFile(path, source)
  const application = await launchDesktop(profile, [path])
  const page = await application.firstWindow()
  try {
    await page.setViewportSize({ width: 420, height: 900 })
    const table = page.locator('.cm-live-table')
    const scroll = table.locator('.render-table-scroll')
    const cell = page.locator('[data-table-cell-editor]')
    await expect(table.locator('th')).toHaveCount(8)
    await scroll.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    const left = await scroll.evaluate((element) => element.scrollLeft)
    expect(left).toBeGreaterThan(0)
    const point = await textPoint(table.locator('td').last().locator('strong'), 'value8', 3)
    await page.mouse.click(point.x, point.y)
    await expect(cell).toBeFocused()
    const layout = await table.locator('table').boundingBox()
    await page.keyboard.insertText('X')
    await cell.press(`${modifier}+s`)
    await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('value8', 'valXue8'))
    await expect(table.locator('td').last()).toContainText('valXue8')
    await expect(cell).toBeFocused()
    expect(await scroll.evaluate((element) => element.scrollLeft)).toBeCloseTo(left, 0)
    expect((await table.locator('table').boundingBox())?.width).toBeCloseTo(layout?.width ?? 0, 0)
    await cell.press('Escape')
    await expect(cell).toHaveCount(0)
    expect(await scroll.evaluate((element) => element.scrollLeft)).toBeCloseTo(left, 0)
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await expect(editor).toBeFocused()
    await page.keyboard.insertText('Y')
    await editor.press(`${modifier}+s`)
    await expect
      .poll(() => readFile(path, 'utf8'))
      .toBe(source.replace('value8', 'valXue8').replace('\n\nAfter.', '\nY\nAfter.'))
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

for (const width of [1144, 420]) {
  test(`${width}px preview clicks retain authored positions and table focus`, async () => {
    const directory = await mkdtemp(resolve('test/e2e/result/preview-position-'))
    const profile = join(directory, 'profile'),
      path = join(directory, 'positions.md')
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({
        schemaVersion: 1,
        locale: 'en',
        theme: width === 1144 ? 'dark' : 'light',
      }),
    )
    await writeFile(path, source)
    const application = await launchDesktop(profile, [path])
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.setViewportSize({ width, height: 900 })
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      const table = page.locator('.cm-live-table')
      const cell = page.locator('[data-table-cell-editor]')
      await expect(table.locator('strong')).toHaveText('alpha same alpha')
      await expect(table.getByRole('math', { name: 'x^2', exact: true })).toBeVisible()
      await editor.evaluate((element) => {
        element.dataset.parentFocusCount = '0'
        element.addEventListener('focusin', (event) => {
          if (event.target === element)
            element.dataset.parentFocusCount = String(Number(element.dataset.parentFocusCount) + 1)
        })
      })

      // Moving among unmodified cells retains the rest of the mounted table.
      await table
        .locator('th')
        .last()
        .evaluate((element) => {
          element.dataset.retained = 'true'
        })
      await table.locator('th').first().focus()
      await table.locator('th').first().press('F2')
      await expect(cell).toBeFocused()
      await cell.press('Tab')
      await expect(cell).toHaveText('Center')
      await cell.press('Shift+Tab')
      await expect(cell).toHaveText('Left')
      await expect(table.locator('th').last()).toHaveAttribute('data-retained', 'true')
      await expect(editor).toHaveAttribute('data-parent-focus-count', '0')
      await cell.press('Shift+Tab')
      await expect(cell).toHaveCount(0)
      await expect(editor).toBeFocused()
      await page.keyboard.insertText('X')
      await editor.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(source.replace('\n\n| Left |', '\nX\n| Left |'))
      await editor.press(`${modifier}+z`)
      await expect(table).toBeVisible()

      for (const scenario of [
        {
          target: 'strong',
          text: 'alpha same alpha',
          offset: 3,
          before: '**alpha same alpha**',
          after: '**alpXha same alpha**',
        },
        { target: 'a[href]', text: 'label', offset: 3, before: '[label]', after: '[labXel]' },
        { target: 'code', text: 'a|b', offset: 2, before: '`a\\|b`', after: '`a\\|Xb`' },
        {
          target: 'td',
          text: '中文😀 & text',
          offset: 4,
          before: '中文😀 &amp;',
          after: '中文😀X &amp;',
        },
        {
          target: 'td[data-row="3"][data-column="0"]',
          text: 'after',
          offset: 2,
          before: 'Emoji :smile: :heart: after',
          after: 'Emoji :smile: :heart: afXter',
        },
        {
          target: '.md-emoji[title=":smile:"]',
          text: '😄',
          offset: 2,
          before: 'Emoji :smile: :heart:',
          after: 'Emoji :Xsmile: :heart:',
        },
        {
          target: 'td[data-row="3"][data-column="1"]',
          text: 'after',
          offset: 2,
          before: 'Before $x^2$ after',
          after: 'Before $x^2$ afXter',
        },
      ]) {
        const target =
          scenario.target === 'td'
            ? table.locator('td').filter({ hasText: scenario.text })
            : table.locator(scenario.target)
        const point = await textPoint(target, scenario.text, scenario.offset)
        await editor.evaluate((element) => {
          element.dataset.parentFocusCount = '0'
        })
        const scroll = await editor.evaluate(
          (element) => element.closest('.cm-editor')?.querySelector('.cm-scroller')?.scrollTop ?? 0,
        )
        if (scenario.target.startsWith('.md-emoji')) await target.click()
        else await page.mouse.click(point.x, point.y)
        await expect(cell).toBeFocused()
        await expect(editor).toHaveAttribute('data-parent-focus-count', '0')
        expect(
          await editor.evaluate(
            (element) =>
              element.closest('.cm-editor')?.querySelector('.cm-scroller')?.scrollTop ?? 0,
          ),
        ).toBeCloseTo(scroll, 0)
        if (scenario.target === 'strong')
          await page.screenshot({ path: test.info().outputPath(`table-position-${width}.png`) })
        await page.keyboard.insertText('X')
        await cell.press(`${modifier}+s`)
        await expect
          .poll(() => readFile(path, 'utf8'))
          .toBe(source.replace(scenario.before, scenario.after))
        await cell.press(`${modifier}+z`)
        await cell.press('Escape')
        await expect(target).toContainText(scenario.text)
      }

      const exponent = table
        .getByRole('math', { name: 'x^2', exact: true })
        .locator('[data-source-from="2"][data-source-to="3"]')
        .last()
      await exponent.scrollIntoViewIfNeeded()
      const exponentBox = await exponent.boundingBox()
      if (!exponentBox) throw new Error('Missing table equation exponent')
      await page.mouse.click(
        exponentBox.x + exponentBox.width * 0.8,
        exponentBox.y + exponentBox.height * 0.25,
      )
      await expect(cell).toBeFocused()
      await page.keyboard.insertText('X')
      await cell.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(source.replace('Before $x^2$ after', 'Before $x^2X$ after'))
      await cell.press(`${modifier}+z`)
      await cell.press('Escape')

      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25)
      })
      const zoomed = await textPoint(table.locator('strong'), 'alpha same alpha', 13)
      await page.mouse.click(zoomed.x, zoomed.y)
      await expect(cell).toBeFocused()
      await page.keyboard.insertText('X')
      await cell.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(source.replace('same alpha', 'same alXpha'))
      await cell.press(`${modifier}+z`)
      await cell.press('Escape')
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
      })

      const code = page.locator('.cm-live-code pre code')
      const point = await textPoint(code, 'const second', 8)
      await page.mouse.click(point.x, point.y)
      await expect(editor).toBeFocused()
      await page.keyboard.insertText('X')
      await editor.press(`${modifier}+s`)
      await expect
        .poll(() => readFile(path, 'utf8'))
        .toBe(source.replace('const second', 'const seXcond'))
      await editor.press(`${modifier}+z`)
      await editor.press('Escape')

      const math = editor.getByRole('math', { name: 'x_i^2', exact: true })
      await math.focus()
      await math.press('Enter')
      await page.keyboard.insertText('X')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('$x_i^2$', '$Xx_i^2$'))
      await editor.press(`${modifier}+z`)
      await editor.press('ArrowRight')
      const before = await editor.evaluate(() => getSelection()?.anchorOffset)
      await editor.locator('.cm-live-inlineMath.cm-live-edit-preview').click()
      expect(await editor.evaluate(() => getSelection()?.anchorOffset)).toBe(before)
      await page.screenshot({ path: test.info().outputPath(`preview-position-${width}.png`) })
      await editor.press('Escape')
      const list = page.locator('.cm-live-list')
      const listPoint = await textPoint(list, 'Another label', 3)
      await page.mouse.click(listPoint.x, listPoint.y)
      await expect(editor).toBeFocused()
      await page.keyboard.insertText('X')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('Another', 'AnoXther'))
      await editor.press(`${modifier}+z`)
      await editor.press('Escape')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
      expect(errors).toEqual([])
    } finally {
      await application
        .evaluate(({ BrowserWindow }) => {
          for (const window of BrowserWindow.getAllWindows()) window.destroy()
        })
        .catch(() => {})
      await application.close()
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
