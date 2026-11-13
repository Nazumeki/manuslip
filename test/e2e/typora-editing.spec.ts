import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { launchDesktop, selectEditorMode } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function fixture(source: string, run: (page: Page, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-typora-editing-'))
  const path = join(directory, 'input.md')
  await writeFile(path, source)
  const app = await launchDesktop(join(directory, 'profile'), [path])
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeVisible()
    await run(page, path)
    expect(errors).toEqual([])
  } finally {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await app.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function saved(page: Page, path: string, source: string) {
  await page.keyboard.press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(source)
}

for (const mode of ['Source', 'Live Preview']) {
  test(`${mode} keeps selected loose-list content when indenting and undoing`, async () => {
    const source = '- one\n\n- two'
    await fixture(source, async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+a`)
      await page.keyboard.press('Tab')
      await saved(page, path, '  - one\n\n  - two')
      await page.keyboard.press('Shift+Tab')
      await saved(page, path, source)
      await page.keyboard.press(`${modifier}+z`)
      await saved(page, path, '  - one\n\n  - two')
    })
  })
  test(`${mode} toggles bold and italic without losing the selection or undo`, async () => {
    await fixture('alpha', async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+a`)
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, '**alpha**')
      await page.keyboard.press(`${modifier}+i`)
      await saved(page, path, '***alpha***')
      await page.keyboard.press(`${modifier}+i`)
      await saved(page, path, '**alpha**')
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, 'alpha')
      await page.keyboard.press(`${modifier}+z`)
      await saved(page, path, '**alpha**')
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
      await saved(page, path, 'alpha')
      await editor.fill('')
      await page.keyboard.press(`${modifier}+b`)
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, '')
      await page.keyboard.press(`${modifier}+b`)
      await page.keyboard.type('beta')
      await saved(page, path, '**beta**')
    })
  })

  test(`${mode} formats paragraphs separately and preserves unselected emphasis`, async () => {
    await fixture('alpha\n\nbeta', async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+a`)
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, '**alpha**\n\n**beta**')
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, 'alpha\n\nbeta')
      await editor.fill('**alpha beta**')
      await editor.press(`${modifier}+Home`)
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowRight')
      await page.keyboard.press(`${modifier}+b`)
      await saved(page, path, 'alpha **beta**')
      await page.keyboard.press(`${modifier}+z`)
      await saved(page, path, '**alpha beta**')
    })
  })

  test(`${mode} retains list and quote markers when removing a code fence`, async () => {
    const source = '> - ```\n>   alpha\n>   ```'
    await fixture(source, async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      if (mode === 'Live Preview') await editor.locator('pre > code').click()
      const line = editor.locator('.cm-line').filter({ hasText: '>   alpha' })
      await expect(line).toBeVisible()
      await line.click()
      await editor.press('End')
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+c' : 'Control+Shift+k')
      await saved(page, path, '> - alpha')
      await page.keyboard.type(' beta')
      await saved(page, path, '> - alpha beta')
    })
  })

  test(`${mode} creates a code block with the formatting shortcut and preserves its content`, async () => {
    await fixture('alpha', async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+End`)
      const shortcut = process.platform === 'darwin' ? 'Meta+Alt+c' : 'Control+Shift+k'
      await page.keyboard.press(shortcut)
      await saved(page, path, '```\nalpha\n```')
      await page.keyboard.type(' beta')
      await saved(page, path, '```\nalpha beta\n```')
      await page.keyboard.press(shortcut)
      await saved(page, path, 'alpha beta')
      await page.keyboard.press(`${modifier}+z`)
      await saved(page, path, '```\nalpha beta\n```')
      await editor.fill('')
      await page.keyboard.press(shortcut)
      await page.keyboard.type('body')
      await saved(page, path, '```\nbody\n```')
    })
  })

  test(`${mode} indents and outdents list items from the text caret`, async () => {
    await fixture('- parent\n- child', async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Tab')
      await page.keyboard.type(' text')
      await saved(page, path, '- parent\n  - child text')
      await page.keyboard.press('Shift+Tab')
      await saved(page, path, '- parent\n- child text')
      await editor.fill('  - alpha')
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Shift+Tab')
      await saved(page, path, '- alpha')
      await editor.fill('plain')
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Tab')
      await saved(page, path, 'plain\t')
    })
  })

  test(`${mode} distinguishes paragraph and line breaks according to the editing mode`, async () => {
    await fixture('alpha', async (page, path) => {
      await selectEditorMode(page, mode)
      const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Enter')
      await page.keyboard.type('beta')
      await saved(page, path, mode === 'Live Preview' ? 'alpha\n\nbeta' : 'alpha\nbeta')
      await editor.fill('alpha')
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('beta')
      await saved(page, path, 'alpha\nbeta')
      if (mode === 'Live Preview') {
        await editor.fill('**alpha beta**')
        await editor.press(`${modifier}+Home`)
        for (let index = 0; index < 7; index++) await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Shift+ArrowRight')
        await page.keyboard.press('Enter')
        await page.keyboard.type('new ')
        await saved(page, path, '**alpha**\n\n**new beta**')
        await page.keyboard.press(`${modifier}+z`)
        await saved(page, path, '**alpha**\n\n**beta**')
        await page.keyboard.press(`${modifier}+z`)
        await saved(page, path, '**alpha beta**')
        for (const position of [7, 8]) {
          await editor.press(`${modifier}+Home`)
          for (let index = 0; index < position; index++) await page.keyboard.press('ArrowRight')
          await page.keyboard.press('Enter')
          await saved(page, path, '**alpha**\n\n**beta**')
          await page.keyboard.press(`${modifier}+z`)
          await saved(page, path, '**alpha beta**')
        }
      }
      await editor.fill('- item')
      await editor.press(`${modifier}+End`)
      await page.keyboard.press('Enter')
      await page.keyboard.type('next')
      await saved(page, path, '- item\n- next')
      await editor.fill('```\nalpha\n```')
      await editor.getByText('alpha', { exact: true }).click()
      await editor.press('End')
      await page.keyboard.press('Enter')
      await page.keyboard.type('beta')
      await saved(page, path, '```\nalpha\nbeta\n```')
    })
  })
}

test('Live table cells share inline formatting and keep document history', async () => {
  const source = '| A |\n| --- |\n| alpha |'
  await fixture(source, async (page, path) => {
    await page.locator('.cm-live-table td').click()
    const cell = page.locator('[data-table-cell-editor]')
    await expect(cell).toBeFocused()
    await cell.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+b`)
    await saved(page, path, source.replace('alpha', '**alpha**'))
    await page.keyboard.press(`${modifier}+i`)
    await saved(page, path, source.replace('alpha', '***alpha***'))
    await page.keyboard.press(`${modifier}+z`)
    await saved(page, path, source.replace('alpha', '**alpha**'))
    await page.keyboard.press(`${modifier}+z`)
    await saved(page, path, source)
    await page.keyboard.press(`${modifier}+Shift+k`)
    await saved(page, path, source)
  })
})

test('Live tight lists preserve repeated spaces without adding structural rows', async () => {
  const source = 'Anchor\n\n- alpha    beta -- gamma\n  - nested -- item\n- last -- item\n\nTail'
  await fixture(source, async (page, path) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.press(`${modifier}+Home`)
    const list = editor.locator('.cm-live-list .cm-live-rendered')
    await expect(list).toContainText('alpha    beta — gamma')
    await expect(list.locator('br')).toHaveCount(0)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      for (const width of [1100, 480]) {
        await page.setViewportSize({ width, height: 900 })
        const layout = await list.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
          const tops: number[] = []
          let four = 0,
            one = 0
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const value = text.textContent ?? ''
            if (!/alpha|nested|last/.test(value)) continue
            const range = document.createRange()
            range.selectNodeContents(text)
            tops.push(range.getBoundingClientRect().top)
            const index = value.indexOf('alpha    beta')
            if (index < 0) continue
            range.setStart(text, index + 5)
            range.setEnd(text, index + 9)
            four = range.getBoundingClientRect().width
            range.setEnd(text, index + 6)
            one = range.getBoundingClientRect().width
          }
          const nested = element.querySelector('li > ul')
          if (!nested) throw new Error('Missing nested list')
          const style = getComputedStyle(nested)
          return {
            tops,
            four,
            one,
            lineHeight: Number.parseFloat(style.lineHeight),
            before: Number.parseFloat(style.marginTop),
            after: Number.parseFloat(style.marginBottom),
          }
        })
        expect(layout.four).toBeCloseTo(layout.one * 4, 0)
        expect(layout.tops).toHaveLength(3)
        expect((layout.tops[1] ?? 0) - (layout.tops[0] ?? 0)).toBeCloseTo(
          layout.lineHeight + layout.before,
          0,
        )
        expect((layout.tops[2] ?? 0) - (layout.tops[1] ?? 0)).toBeCloseTo(
          layout.lineHeight + layout.after,
          0,
        )
        await page.screenshot({ path: test.info().outputPath(`list-${colorScheme}-${width}.png`) })
      }
    }
    await saved(page, path, source)
  })
})

test('Live Preview preserves repeated spaces when smart punctuation projects a paragraph', async () => {
  const source = 'Anchor\n\nalpha    beta\n\nalpha    beta -- gamma\n\nTail'
  await fixture(source, async (page, path) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await editor.press(`${modifier}+Home`)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const projection = editor.locator('.cm-live-paragraph p').filter({ hasText: 'gamma' })
    await expect(projection).toHaveText('alpha    beta — gamma')
    for (const width of [1100, 480]) {
      await page.setViewportSize({ width, height: 900 })
      const widths = await editor.evaluate((element) => {
        const result: number[] = []
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const index = text.textContent?.indexOf('alpha    beta') ?? -1
          if (index < 0) continue
          const range = document.createRange()
          range.setStart(text, index + 5)
          range.setEnd(text, index + 9)
          result.push(range.getBoundingClientRect().width)
        }
        return result
      })
      await page.screenshot({ path: test.info().outputPath(`spaces-${width}.png`) })
      expect(widths).toHaveLength(2)
      expect(widths[1]).toBeCloseTo(widths[0] ?? 0, 0)
    }
    await saved(page, path, source)
  })
})
