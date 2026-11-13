import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { launchDesktop, openMarkdownExtensions, plainPasteShortcut } from './helpers'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function documentFixture(
  source: string,
  run: (page: Page, application: ElectronApplication, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-raw-rendering-'))
  const path = join(directory, 'document.md')
  await writeFile(path, source)
  let application: ElectronApplication | undefined
  try {
    application = await launchDesktop(join(directory, 'profile'), [path])
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1100, height: 1000 })
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await expect(editor).toBeVisible()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await editor.press(`${modifier}+End`)
    await run(page, application, path)
    expect(errors).toEqual([])
  } finally {
    await application
      ?.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

async function saved(page: Page, path: string, expected: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Markdown source' }).press(`${modifier}+s`)
  await expect.poll(() => readFile(path, 'utf8')).toBe(expected)
}

for (const mode of ['Source', 'Live Preview']) {
  test(`${mode} pairs brackets, keeps prose markers literal and continues Markdown indentation`, async () => {
    await documentFixture('', async (page, _application, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source' })
      for (const literal of ['(', '[', '{', '"', "'", '`', '<i>']) {
        await editor.press(`${modifier}+a`)
        await editor.press('Backspace')
        await page.keyboard.type(literal)
        await saved(
          page,
          path,
          ({ '(': '()', '[': '[]', '{': '{}' } as Record<string, string>)[literal] ?? literal,
        )
      }
      for (const prefix of ['    text', '- item', '1. item', '> quote'] as const) {
        // Native Select All includes source hidden behind CodeMirror's widgets.
        await editor.press(`${modifier}+a`)
        await page.keyboard.insertText(prefix)
        await editor.press(`${modifier}+End`)
        await editor.press('Enter')
        await page.keyboard.type('next')
        await editor.press('Tab')
        await page.keyboard.type('tab')
        const continuation = { '    text': '', '- item': '- ', '1. item': '2. ', '> quote': '> ' }[
          prefix
        ]
        const expected =
          prefix === '- item' || prefix === '1. item'
            ? `${prefix}\n${' '.repeat(continuation.length)}${continuation}nexttab`
            : `${prefix}\n${continuation}next\ttab`
        await saved(page, path, expected)
      }
    })
  })

  test(`${mode} pastes the exact plain text from mixed clipboard formats through every Paste command`, async () => {
    const text = '## Plain heading\n\n**bold** &amp; \\*literal\\* <i>raw</i> 中文😀\t \n\nEnd'
    await documentFixture('', async (page, application, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source' })
      await application.evaluate(async ({ clipboard, ClipboardItem }, text) => {
        await clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob(['<h1>Different rich text</h1><p><b>converted</b></p>'], {
              type: 'text/html',
            }),
          }),
        ])
      }, text)
      for (const command of ['keyboard', 'plain', 'toolbar']) {
        await editor.fill('Before\n\n')
        await editor.press(`${modifier}+End`)
        if (command === 'toolbar') {
          await page.getByRole('button', { name: 'Edit', exact: true }).click()
          await page.getByRole('button', { name: /^Paste/ }).click()
        } else await editor.press(command === 'plain' ? plainPasteShortcut : `${modifier}+v`)
        await saved(page, path, `Before\n\n${text}`)
        await editor.press(`${modifier}+z`)
        await saved(page, path, 'Before\n\n')
      }
    })
  })

  test(`${mode} pastes a URL over selected text without creating a Markdown link`, async () => {
    await documentFixture('replace this', async (page, application, path) => {
      await page.getByRole('button', { name: mode, exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Markdown source' })
      await editor.press(`${modifier}+a`)
      await application.evaluate(({ clipboard }) =>
        clipboard.writeText('https://example.invalid/raw'),
      )
      await editor.press(`${modifier}+v`)
      await saved(page, path, 'https://example.invalid/raw')
      await editor.press(`${modifier}+z`)
      await saved(page, path, 'replace this')
    })
  })
}

test('large mixed-format paste retains raw text and commits as one undo step', async () => {
  const text = `${'中文😀 &amp; **literal**\t\r\n'.repeat(16000)}End`
  await documentFixture('Before\n', async (page, application, path) => {
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await application.evaluate(async ({ clipboard, ClipboardItem }, text) => {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob(['<h1>Wrong representation</h1>'], { type: 'text/html' }),
        }),
      ])
    }, text)
    await editor.press(`${modifier}+v`)
    await saved(page, path, `Before\n${text.replaceAll('\r\n', '\n')}`)
    await editor.press(`${modifier}+z`)
    await saved(page, path, 'Before\n')
  })
})

test('multiline math and image syntax both render after leaving the insertion point', async () => {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2cAAAAASUVORK5CYII='
  const source = `Before $a +\nb$ after.\n\n![First\nsecond](${image})\n\nEnd`
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-content [role="math"] svg')).toBeVisible()
    const renderedImage = page.getByRole('img', { name: 'First second' })
    await expect(renderedImage).toHaveAttribute('alt', /First\s+second/)
    await expect
      .poll(() =>
        renderedImage.evaluate(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true)
    await saved(page, path, source)
  })
})

test('multiline code spans and setext headings use the complete semantic formatting', async () => {
  const source = 'Heading first\nsecond\n======\n\nCode ` first\nsecond ` after.\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    // Live prose uses br elements for source newlines; compare the rendered rows.
    await expect(page.locator('.cm-live-rendered h1')).toHaveText('Heading first\nsecond', {
      useInnerText: true,
    })
    await expect(page.locator('.cm-live-rendered h1 br')).toHaveCount(1)
    await expect(page.locator('.cm-live-rendered code')).toHaveText('first second')
    await saved(page, path, source)
  })
})

test('definition lists render their nested formulas, highlighted code and diagrams', async () => {
  const source =
    'Term\n: Formula $x^2$.\n\n    ```js\n    const nested = 1\n    ```\n\n    ```mermaid\n    flowchart LR\n    A-->B\n    ```\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const definition = page.locator('.cm-live-defList')
    await expect(definition.locator('[role="math"] svg')).toBeVisible()
    await expect(definition.locator('pre .tok-keyword')).toHaveText('const')
    await expect(definition.locator('svg')).toHaveCount(2)
    await page.screenshot({ path: test.info().outputPath('nested-rendering-wide.png') })
    await page.setViewportSize({ width: 720, height: 1000 })
    await expect(definition.locator('[role="math"] svg')).toBeVisible()
    await expect(definition.locator('svg')).toHaveCount(2)
    await page.screenshot({ path: test.info().outputPath('nested-rendering-narrow.png') })
    await saved(page, path, source)
  })
})

test('blockquotes and lists render nested fenced code and tables', async () => {
  const source =
    '> Quote\n>\n> ```js\n> const quoted = 1\n> ```\n>\n> | A | B |\n> | - | - |\n> | 1 | 2 |\n\n- Item\n\n    ```text\n    nested list code\n    ```\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-live-rendered blockquote pre code')).toContainText(
      'const quoted = 1',
    )
    await expect(page.locator('.cm-live-rendered blockquote table')).toContainText('A')
    await expect(page.locator('.cm-live-rendered li pre code')).toContainText('nested list code')
    await saved(page, path, source)
  })
})

test('footnote references and their rich definitions render from the complete document', async () => {
  const source =
    'A note[^one] and another call[^one].\n\n[^one]: A **formatted** note with $x$.\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-content [data-footnote-ref]')).toHaveText(['1', '1'])
    await expect(page.locator('.cm-live-footnoteDefinition strong')).toHaveText('formatted')
    await expect(page.locator('.cm-live-footnoteDefinition [role="math"] svg')).toBeVisible()
    await saved(page, path, source)
  })
})

test('task controls inside rendered lists still update raw source and undo once', async () => {
  const source = '- [ ] Task\n\n    ```js\n    const nested = 1\n    ```\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const task = page
      .locator('.cm-live-list')
      .getByRole('checkbox', { name: 'Toggle task', exact: true })
    await expect(task).toBeEnabled()
    await task.check()
    await saved(page, path, source.replace('[ ]', '[x]'))
    await page.getByRole('textbox', { name: 'Markdown source' }).press(`${modifier}+z`)
    await saved(page, path, source)
  })
})

test('bounded editor parsing still renders emphasis and code in a long paragraph', async () => {
  const source = `${'word '.repeat(7000)}**long emphasis** and \`literal &amp;\`\n\nEnd`
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    const strong = page
      .locator('.cm-live-strong, .cm-live-rendered strong')
      .filter({ hasText: 'long emphasis' })
    await expect(strong).toBeAttached()
    await strong.scrollIntoViewIfNeeded()
    await expect(strong).toBeVisible()
    await expect(
      page.locator('.cm-live-rendered code').filter({ hasText: 'literal &amp;' }),
    ).toHaveText('literal &amp;')
    await saved(page, path, source)
  })
})

test('inline HTML renders only when enabled and never changes the raw source', async () => {
  const source = 'Text <mark>highlight</mark> and <kbd>Esc</kbd>.\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-content mark, .cm-content kbd')).toHaveCount(0)
    const extensions = await openMarkdownExtensions(page)
    await extensions.getByLabel('Render sanitized HTML').check()
    await page.keyboard.press('Escape')
    await expect(page.locator('.cm-content mark')).toHaveText('highlight')
    await expect(page.locator('.cm-content kbd')).toHaveText('Esc')
    await saved(page, path, source)
  })
})

test('Typora toggles YAML metadata without changing its editable source', async () => {
  const source = '---\ntitle: **literal**\n---\n\n# Actual heading\n\nEnd'
  await documentFixture(source, async (page, _application, path) => {
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.locator('.cm-live-heading')).toHaveCount(2)
    await expect(page.locator('.cm-live-strong')).toHaveText('literal')
    await expect(page.locator('.cm-live-rule')).toHaveCount(1)
    for (const enabled of [true, false, true]) {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.getByRole('checkbox', { name: 'Typora', exact: true }).setChecked(enabled)
      await expect(page.getByText('Preferences saved', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
      await expect(page.locator('.cm-live-heading')).toHaveCount(enabled ? 1 : 2)
      await expect(page.locator('.cm-live-strong')).toHaveCount(enabled ? 0 : 1)
      await expect(page.locator('.cm-live-rule')).toHaveCount(enabled ? 0 : 1)
      await expect(page.locator('.cm-live-frontmatter')).toHaveCount(enabled ? 1 : 0)
      if (enabled) await expect(page.locator('.cm-content')).toContainText('title: **literal**')
    }
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await page.screenshot({
      path: test.info().outputPath('typora-yaml-frontmatter.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(page.locator('.cm-content > .cm-line')).toHaveText(source.split('\n'))
    await saved(page, path, source)
  })
})

for (const closing of ['---', '...']) {
  test(`YAML header ending with ${closing} stays editable without consuming following Markdown`, async () => {
    const title = 'title: "**literal**"'
    const metadata = [title, 'summary: |', '  ```', '  <div>']
    const source = [
      '--- \t',
      ...metadata,
      `${closing} \t`,
      '# Actual heading',
      '',
      '**Body** and `code`.',
      '',
      'End',
    ].join('\n')
    await documentFixture(source, async (page, _application, path) => {
      await page.getByRole('button', { name: 'Preferences', exact: true }).click()
      await page.getByRole('button', { name: 'Plugins', exact: true }).click()
      await page.getByRole('checkbox', { name: 'Typora', exact: true }).check()
      await expect(page.getByText('Preferences saved', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
      await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
      const header = page.locator('.cm-live-frontmatter')
      await expect(header).toHaveText(metadata)
      await expect(header.first()).toHaveCSS('font-size', '15px')
      await expect(header.first()).toHaveCSS('border-top-style', 'solid')
      await expect(header.last()).toHaveCSS('border-bottom-style', 'solid')
      await expect(page.locator('.cm-live-heading')).toHaveText('Actual heading')
      await expect(page.locator('.cm-live-strong')).toHaveText('Body')
      await expect(page.locator('.cm-live-code')).toHaveText('code')
      const editor = page.getByRole('textbox', { name: 'Markdown source' })
      await expect(editor).not.toContainText('---')
      await expect(editor).not.toContainText('...')
      await page.screenshot({
        path: test.info().outputPath('yaml-header.png'),
        animations: 'disabled',
      })

      await header.first().click()
      await editor.press('End')
      await page.keyboard.insertText(' # edited')
      await expect(header.first()).toHaveText(`${title} # edited`)
      await saved(page, path, source.replace(title, `${title} # edited`))
      await editor.press(`${modifier}+z`)
      await expect(header).toHaveText(metadata)

      // Source mode exposes both fences; editing and undo keep the same document.
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect(page.locator('.cm-content > .cm-line')).toHaveText(source.split('\n'))
      await page
        .locator('.cm-content > .cm-line')
        .nth(metadata.length + 1)
        .click()
      await editor.press('Home')
      await editor.press('Shift+End')
      await editor.press('Backspace')
      await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
      await expect(header).toHaveCount(0)
      await saved(page, path, source.replace(`\n${closing} \t\n#`, '\n\n#'))
      await editor.press(`${modifier}+z`)
      await expect(header).toHaveText(metadata)
      await expect(page.locator('.cm-live-heading')).toHaveText('Actual heading')
      await expect(page.locator('.cm-live-strong')).toHaveText('Body')
      await page.getByRole('button', { name: 'Source', exact: true }).click()
      await expect(header).toHaveCount(0)
      await expect(page.locator('.cm-content > .cm-line')).toHaveText(source.split('\n'))
      await saved(page, path, source)
    })
  })
}
