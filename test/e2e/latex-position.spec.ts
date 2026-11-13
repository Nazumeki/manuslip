import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, type Locator, test } from '@playwright/test'
import { launchDesktop } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const inline = String.raw`x_x^x + \frac{x+x}{x+x} + 123`
const display = [
  String.raw`\begin{aligned}`,
  String.raw`f(x) &= x^2 + 1 \\`,
  String.raw`g(x) &= \frac{x+x}{x+x}`,
  String.raw`\end{aligned}`,
].join('\n')
const notations = [
  { markup: String.raw`Parenthesized \(a_1 + a_2\) equation.`, value: 'a_1 + a_2' },
  { markup: '$$v^2$$', value: 'v^2' },
  { markup: '\\[\nw^2\n\\]', value: '\nw^2\n' },
  { markup: '```math\nu^2\n```', value: 'u^2' },
]
const source = [
  '# Equations',
  '',
  `Before $${inline}$ after.`,
  '',
  'A longer introduction with 中文 and several words before $y_i^2$ in a wrapping paragraph.',
  '',
  '  $p_i^2$  ',
  '',
  '$$',
  display,
  '$$',
  '',
  ...notations.flatMap(({ markup }) => [markup, '']),
  'End.',
  '',
].join('\n')

async function clickToken(math: Locator, from: number, to = from + 1): Promise<void> {
  const token = math.locator(`[data-source-from="${from}"][data-source-to="${to}"]`).last()
  const box = await token.boundingBox()
  if (!box) throw new Error('Missing mapped equation token')
  // Stay on the right stroke of an x, so this is an actual glyph hit rather than
  // a synthetic event or a source-position attribute used to set the selection.
  await token.click({ position: { x: box.width * 0.8, y: box.height * 0.25 } })
}

async function sourceCaret(raw: Locator): Promise<number> {
  return raw.evaluate((element) => {
    const selection = getSelection()
    if (!selection?.focusNode || !element.contains(selection.focusNode)) return -1
    const range = document.createRange()
    range.selectNodeContents(element)
    range.setEnd(selection.focusNode, selection.focusOffset)
    return range.toString().length
  })
}

for (const { width, theme, zoom } of [
  { width: 1144, theme: 'light', zoom: 1 },
  { width: 420, theme: 'dark', zoom: 1.25 },
]) {
  test(`${theme} LaTeX clicks follow authored tokens and preserve focus during refresh`, async () => {
    const directory = await mkdtemp(resolve('test/e2e/result/latex-position-'))
    const profile = join(directory, 'profile')
    const path = join(directory, 'equations.md')
    await mkdir(profile)
    await writeFile(
      join(profile, 'preferences.json'),
      JSON.stringify({ schemaVersion: 1, locale: 'en', theme }),
    )
    await writeFile(path, source)
    const application = await launchDesktop(profile, [path])
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.setViewportSize({ width, height: 1000 })
      await application.evaluate(({ BrowserWindow }, factor) => {
        BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor)
      }, zoom)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      const math = editor.getByRole('math', { name: inline, exact: true })
      const preview = editor.locator('.cm-live-inlineMath.cm-live-edit-preview')
      const raw = editor.locator('.cm-live-inline-math-source')
      await expect(math.locator('svg')).toBeVisible()

      for (const offset of [2, 4, inline.indexOf('}{x') + 2]) {
        await clickToken(math, offset)
        await expect(editor).toBeFocused()
        await expect(raw).toHaveText(`$${inline}$`)
        await expect.poll(() => sourceCaret(raw)).toBe(offset + 2)
        await page.keyboard.insertText('Q')
        const changed = `${inline.slice(0, offset + 1)}Q${inline.slice(offset + 1)}`
        await expect(
          preview.getByRole('math', { name: changed, exact: true }).locator('svg'),
        ).toBeVisible()
        await expect(editor).toBeFocused()
        await expect.poll(() => sourceCaret(raw)).toBe(offset + 3)
        await editor.press(`${modifier}+s`)
        await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace(inline, changed))
        await editor.press(`${modifier}+z`)
        await editor.press('Escape')
        await expect(math.locator('svg')).toBeVisible()
      }

      const numeral = inline.indexOf('123')
      const digit = math
        .locator(`[data-source-from="${numeral}"][data-source-to="${numeral + 3}"] path`)
        .nth(1)
      const digitBox = await digit.boundingBox()
      if (!digitBox) throw new Error('Missing second numeral')
      await page.mouse.click(digitBox.x + digitBox.width * 0.8, digitBox.y + digitBox.height * 0.25)
      await expect.poll(() => sourceCaret(raw)).toBe(numeral + 3)
      await page.keyboard.insertText('Q')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('123', '12Q3'))
      await editor.press(`${modifier}+z`)
      await editor.press('Escape')
      await math.focus()
      await math.press('Space')
      await expect(editor).toBeFocused()
      await expect.poll(() => sourceCaret(raw)).toBe(1)
      await editor.press('Escape')

      await math.focus()
      await math.press('Enter')
      await expect(editor).toBeFocused()
      await expect.poll(() => sourceCaret(raw)).toBe(1)
      await expect(preview.getByRole('math')).toHaveAttribute('tabindex', '-1')
      await editor.press('ArrowRight')
      await editor.press('ArrowRight')
      await editor.press('ArrowRight')
      await editor.press('Shift+ArrowRight')
      await editor.press('Shift+ArrowRight')
      const selected = await page.evaluate(() => getSelection()?.toString())
      expect(selected).toBe('^x')
      await preview.locator('svg').click()
      await expect(editor).toBeFocused()
      expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected)
      await page.keyboard.insertText('^7')
      await expect(
        preview.getByRole('math', { name: inline.replace('^x', '^7'), exact: true }).locator('svg'),
      ).toBeVisible()
      await expect.poll(() => sourceCaret(raw)).toBe(6)
      await editor.press(`${modifier}+z`)
      await editor.press('Escape')

      const neighbor = editor.getByRole('math', { name: 'y_i^2', exact: true })
      await clickToken(math, 4)
      await clickToken(neighbor, 4)
      await expect(raw).toHaveText('$y_i^2$')
      await expect.poll(() => sourceCaret(raw)).toBe(6)
      await page.screenshot({ path: test.info().outputPath(`latex-source-${width}.png`) })
      await editor.press('Escape')
      await page.keyboard.insertText('Q')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('$y_i^2$', '$y_i^2$Q'))
      await editor.press(`${modifier}+z`)

      const padded = editor.getByRole('math', { name: 'p_i^2', exact: true })
      await clickToken(padded, 4)
      await page.keyboard.insertText('Q')
      await expect(
        preview.getByRole('math', { name: 'p_i^2Q', exact: true }).locator('svg'),
      ).toBeVisible()
      await expect(raw).toHaveText('$p_i^2Q$')
      await expect(editor).toBeFocused()
      await expect.poll(() => sourceCaret(raw)).toBe(7)
      await editor.press(`${modifier}+z`)
      await expect(
        preview.getByRole('math', { name: 'p_i^2', exact: true }).locator('svg'),
      ).toBeVisible()
      await editor.press('Escape')
      await page.keyboard.insertText('Q')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace('$p_i^2$', '$p_i^2$Q'))
      await editor.press(`${modifier}+z`)

      const equation = editor.getByRole('math', { name: display, exact: true })
      await equation.scrollIntoViewIfNeeded()
      const denominator = display.lastIndexOf('}{x') + 2
      await clickToken(equation, denominator)
      await expect(editor).toBeFocused()
      await expect(editor.locator('.cm-live-edit-source').filter({ hasText: 'g(x)' })).toBeVisible()
      await page.keyboard.insertText('Q')
      const changed = `${display.slice(0, denominator + 1)}Q${display.slice(denominator + 1)}`
      await expect(
        editor.getByRole('math', { name: changed, exact: true }).locator('svg'),
      ).toBeVisible()
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source.replace(display, changed))
      await editor.press(`${modifier}+z`)
      await editor.press('Escape')
      await editor.press(`${modifier}+s`)
      await expect.poll(() => readFile(path, 'utf8')).toBe(source)
      for (const notation of notations) {
        const rendered = editor.getByRole('math', { name: notation.value, exact: true })
        await rendered.scrollIntoViewIfNeeded()
        const offset = notation.value.lastIndexOf('2')
        await clickToken(rendered, offset)
        if (notation.markup.includes('\\(')) await expect(raw).toHaveText(String.raw`\(a_1 + a_2\)`)
        await page.keyboard.insertText('Q')
        const changed = `${notation.value.slice(0, offset + 1)}Q${notation.value.slice(offset + 1)}`
        await expect(
          editor.getByRole('math', { name: changed, exact: true }).locator('svg'),
        ).toBeVisible()
        await expect(editor).toBeFocused()
        await editor.press(`${modifier}+s`)
        await expect
          .poll(() => readFile(path, 'utf8'))
          .toBe(source.replace(notation.value, changed))
        await editor.press(`${modifier}+z`)
        await editor.press('Escape')
        await expect(rendered.locator('svg')).toBeVisible()
        await rendered.focus()
        await rendered.press('Enter')
        await page.keyboard.insertText('Q')
        await editor.press(`${modifier}+s`)
        const start = notation.markup.includes('\\(') ? 0 : Math.max(0, notation.value.search(/\S/))
        const entered = `${notation.value.slice(0, start)}Q${notation.value.slice(start)}`
        await expect
          .poll(() => readFile(path, 'utf8'))
          .toBe(source.replace(notation.value, entered))
        await editor.press(`${modifier}+z`)
        await editor.press('Escape')
      }
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
