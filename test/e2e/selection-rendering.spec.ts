import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Locator, type Page, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const source = 'prefix alpha beta\nshort\n\nfourth final tail\nlast unselected'

async function workspace(
  run: (page: Page, application: ElectronApplication, editor: Locator) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-selection-'))
  const path = join(directory, 'selection.md')
  await writeFile(path, source)
  const application = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 850, height: 700 })
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toBeVisible()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await run(page, application, editor)
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
}

async function selectLines(editor: Locator, backward: boolean) {
  await editor.press(`${modifier}+Home`)
  const length = 'refix alpha beta\nshort\n\nf'.length
  await editor.press('ArrowRight')
  if (backward) {
    for (let index = 0; index < length; index++) await editor.press('ArrowRight')
  }
  // Vertical movement follows visual columns, which differ with proportional fonts.
  for (let index = 0; index < length; index++)
    await editor.press(backward ? 'Shift+ArrowLeft' : 'Shift+ArrowRight')
}

async function checkPaint(page: Page, application: ElectronApplication) {
  const sample = await page.locator('.cm-content').evaluate((content) => {
    const lines = [...content.querySelectorAll('.cm-line')]
    const selected = content.querySelector('.cm-selectedText')
    if (!selected || lines.length !== 5) throw new Error('Missing multiline selection')
    const tail = (line: Element | undefined) => {
      if (!line) throw new Error('Missing selected line')
      const rect = line.getBoundingClientRect()
      return { x: rect.right - 40, y: (rect.top + rect.bottom) / 2 }
    }
    const walker = document.createTreeWalker(selected, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    if (!text) throw new Error('Missing selected text')
    const space = (text.textContent ?? '').indexOf(' ')
    const range = document.createRange()
    range.setStart(text, space)
    range.setEnd(text, space + 1)
    const rect = range.getBoundingClientRect()
    return {
      points: [
        tail(lines[0]),
        tail(lines[1]),
        tail(lines[2]),
        tail(lines[3]),
        tail(lines[4]),
        { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 },
      ],
      paper: getComputedStyle(document.documentElement).backgroundColor,
      selection: getComputedStyle(selected).backgroundColor,
      lineBackgrounds: lines.map((line) => getComputedStyle(line).backgroundColor),
      width: innerWidth,
      height: innerHeight,
    }
  })
  const png = await page.screenshot({ path: test.info().outputPath('paint-check.png') })
  const pixels = await application.evaluate(
    ({ nativeImage }, { png, sample }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png))
      const size = image.getSize(),
        bitmap = image.toBitmap()
      return sample.points.map((point) => {
        const x = Math.floor((point.x * size.width) / sample.width),
          y = Math.floor((point.y * size.height) / sample.height),
          offset = (y * size.width + x) * 4
        return `rgb(${bitmap[offset + 2]}, ${bitmap[offset + 1]}, ${bitmap[offset]})`
      })
    },
    { png: [...png], sample },
  )
  expect(sample.lineBackgrounds).toEqual(Array(5).fill('rgba(0, 0, 0, 0)'))
  expect(pixels.slice(0, 5)).toEqual(Array(5).fill(sample.paper))
  expect(pixels[5]).toBe(sample.selection)
  expect(sample.selection).not.toBe(sample.paper)
}

async function readContinuousPaint(page: Page, application: ElectronApplication) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.locator('.cm-textSelectionBackground').first()).toBeVisible()
  await expect
    .poll(() =>
      page.locator('.cm-content').evaluate((content) => {
        const right = content.getBoundingClientRect().right
        return [...document.querySelectorAll('.cm-textSelectionBackground')].every(
          (marker) => marker.getBoundingClientRect().right <= right + 1,
        )
      }),
    )
    .toBe(true)
  const sample = await page.locator('.cm-textSelectionBackground').evaluateAll((elements) => {
    const rows = elements
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.top - b.top)
    const seams: { x: number; y: number }[] = []
    const gaps: number[] = []
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1],
        next = rows[index]
      if (!previous || !next) continue
      const left = Math.max(previous.left, next.left),
        right = Math.min(previous.right, next.right)
      if (Math.abs(next.top - previous.bottom) > 2 || right - left < 12) continue
      gaps.push(next.top - previous.bottom)
      for (const offset of [-1, 0, 1])
        seams.push({ x: (left + right) / 2, y: Math.floor(previous.bottom) + offset })
    }
    return {
      points: [
        ...seams,
        ...rows.map((row) => ({ x: row.right + 4, y: (row.top + row.bottom) / 2 })),
      ],
      seams: seams.length,
      gaps,
      selection: elements[0] && getComputedStyle(elements[0]).backgroundColor,
      paper: getComputedStyle(document.documentElement).backgroundColor,
      width: innerWidth,
      height: innerHeight,
    }
  })
  await test
    .info()
    .attach('selection-geometry', { body: JSON.stringify(sample), contentType: 'application/json' })
  expect(sample.seams).toBeGreaterThan(9)
  expect(sample.gaps.every((gap) => Math.abs(gap) <= 0.02)).toBe(true)
  const png = await page.screenshot({ path: test.info().outputPath('continuous-paint-check.png') })
  const pixels = await application.evaluate(
    ({ nativeImage }, { png, sample }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png))
      const size = image.getSize(),
        bitmap = image.toBitmap()
      return sample.points.map((point) => {
        const x = Math.floor((point.x * size.width) / sample.width),
          y = Math.floor((point.y * size.height) / sample.height),
          offset = (y * size.width + x) * 4
        return `rgb(${bitmap[offset + 2]}, ${bitmap[offset + 1]}, ${bitmap[offset]})`
      })
    },
    { png: [...png], sample },
  )
  expect(pixels.slice(0, sample.seams)).toEqual(Array(sample.seams).fill(sample.selection))
  expect(pixels.slice(sample.seams)).toEqual(Array(pixels.length - sample.seams).fill(sample.paper))
}

async function checkContinuousPaint(page: Page, application: ElectronApplication) {
  // Layout, CodeMirror's measured layers and Electron's compositor settle independently.
  await expect(async () => readContinuousPaint(page, application)).toPass({ timeout: 5000 })
}

for (const mode of ['Source', 'Live Preview']) {
  for (const theme of ['light', 'dark']) {
    test(`${mode} ${theme} paints selected characters without line tails or a differently colored final line`, async () => {
      await workspace(async (page, application, editor) => {
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
        await page.getByRole('button', { name: mode, exact: true }).click()
        for (const backward of [false, true]) {
          await selectLines(editor, backward)
          await expect
            .poll(() => page.evaluate(() => getSelection()?.toString()))
            .toBe('refix alpha beta\nshort\n\nf')
          await checkPaint(page, application)
        }
        await page.getByRole('button', { name: 'Save', exact: true }).focus()
        await checkPaint(page, application)
        await page.screenshot({ path: test.info().outputPath('selection.png') })
        await editor.press('ArrowRight')
        await expect(editor.locator('.cm-selectedText')).toHaveCount(0)
        if (mode === 'Source')
          await expect(editor.locator('.cm-activeLine')).not.toHaveCSS(
            'background-color',
            'rgba(0, 0, 0, 0)',
          )
      })
    })

    test(`${mode} ${theme} joins selection backgrounds across wrapped rows and mixed fonts at normal and 200% zoom`, async () => {
      await workspace(async (page, application, editor) => {
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
        await editor.fill(
          'Select plain **bold words** and `inline code` ' +
            'wrapped words '.repeat(24) +
            '\nSecond selected line\nEnd',
        )
        await page.getByRole('button', { name: mode, exact: true }).click()
        await editor.press(`${modifier}+a`)
        for (const zoom of [1, 2]) {
          await page.setViewportSize({ width: 480 * zoom, height: 760 * zoom })
          await application.evaluate(({ BrowserWindow }, zoom) => {
            BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(zoom)
          }, zoom)
          await checkContinuousPaint(page, application)
        }
        await page.screenshot({ path: test.info().outputPath('continuous-selection.png') })
      })
    })
  }

  test(`${mode} preserves exact mouse selections, multiple cursors and undo`, async () => {
    await workspace(async (page, _application, editor) => {
      await editor.fill('Start alpha beta gamma tail\ntoken keep token')
      await page.getByRole('button', { name: mode, exact: true }).click()
      await expect(page.getByRole('button', { name: mode, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const points = await editor
        .locator('.cm-line')
        .first()
        .evaluate((line) => {
          const node = line.firstChild
          if (!node) throw new Error('Missing line text')
          const point = (offset: number) => {
            const range = document.createRange()
            range.setStart(node, offset)
            range.collapse(true)
            const rect = range.getBoundingClientRect()
            return { x: rect.x, y: (rect.top + rect.bottom) / 2 }
          }
          return [point(6), point(16)]
        })
      const start = points[0],
        end = points[1]
      if (!start || !end) throw new Error('Missing drag coordinates')
      await page.mouse.dblclick(start.x + 3, start.y)
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('alpha')
      await expect(editor.locator('.cm-selectedText')).toHaveText('alpha')
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 12 })
      await page.mouse.up()
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('alpha beta')
      await expect
        .poll(() => editor.locator('.cm-selectedText').allTextContents())
        .toEqual(['alpha beta'])
      await editor.press('Z')
      await editor.press(`${modifier}+z`)
      await expect
        .poll(() =>
          editor
            .locator('.cm-line')
            .allTextContents()
            .then((lines) => lines.join('\n')),
        )
        .toBe('Start alpha beta gamma tail\ntoken keep token')
      await editor.press(`${modifier}+End`)
      await editor.press(`${process.platform === 'darwin' ? 'Alt' : 'Control'}+Shift+ArrowLeft`)
      await editor.press(`${modifier}+d`)
      await expect
        .poll(() => editor.locator('.cm-selectedText').allTextContents())
        .toEqual(['token', 'token'])
      await editor.press('X')
      await expect(editor).toContainText('X keep X')
      await editor.press(`${modifier}+z`)
      await expect(editor).toContainText('token keep token')
    })
  })

  test(`${mode} selection follows wrapped Unicode, bidi text, tabs and syntax in forced colors`, async () => {
    await workspace(async (page, _application, editor) => {
      const text =
        '\u4e2d\u6587\u{1f600} e\u0301 **bold** and `code` ' +
        'wrapped words '.repeat(30) +
        '\n\u0645\u0631\u062d\u0628\u0627 \u05e9\u05dc\u05d5\u05dd\n\tindented\nEnd'
      await editor.fill(text)
      await page.getByRole('button', { name: mode, exact: true }).click()
      await page.setViewportSize({ width: 480, height: 850 })
      await editor.press(`${modifier}+a`)
      await expect
        .poll(() =>
          editor
            .locator('.cm-selectedText')
            .allTextContents()
            .then((parts) => parts.join('')),
        )
        .toBe(text.replaceAll('\n', ''))
      await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(text)
      await page.emulateMedia({ forcedColors: 'active' })
      await expect
        .poll(() =>
          editor
            .locator('.cm-selectedText')
            .evaluateAll((elements) =>
              elements.every((element) => getComputedStyle(element).forcedColorAdjust === 'none'),
            ),
        )
        .toBe(true)
      expect(
        await editor
          .locator('.cm-selectedText')
          .evaluateAll((elements) =>
            elements.every(
              (element) =>
                getComputedStyle(element, '::selection').color === getComputedStyle(element).color,
            ),
          ),
      ).toBe(true)
      await page.screenshot({ path: test.info().outputPath('selection-forced-colors.png') })
      await editor.press('ArrowLeft')
      await expect(editor.locator('.cm-selectedText')).toHaveCount(0)
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect
        .poll(() =>
          editor
            .locator('.cm-line')
            .allTextContents()
            .then((lines) => lines.join('\n')),
        )
        .toBe(text)
    })
  })
}
