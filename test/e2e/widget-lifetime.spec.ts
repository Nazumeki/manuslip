import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Route,
  test,
} from '@playwright/test'
import { build, type InlineConfig, type PreviewServer, preview } from 'vite'
import type {} from './fixtures/preview-lifetime/fixture'

async function setup() {
  await mkdir('test/e2e/result', { recursive: true })
  const profile = await mkdtemp(resolve('test/e2e/result/widget-lifetime-'))
  let application: ElectronApplication | undefined
  let server: PreviewServer | undefined
  const cleanup = async () => {
    try {
      await application?.close()
    } finally {
      try {
        await server?.close()
      } finally {
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  }
  const config: InlineConfig = {
    configFile: false,
    root: resolve('test/e2e/fixtures/preview-lifetime'),
    clearScreen: false,
    logLevel: 'silent',
    base: './',
    build: {
      outDir: resolve('test/e2e/result/widget-lifetime-build'),
      emptyOutDir: false,
      manifest: true,
    },
    worker: { format: 'es' },
    resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] },
  }
  try {
    await build(config)
    const manifest = JSON.parse(
      await readFile('test/e2e/result/widget-lifetime-build/.vite/manifest.json', 'utf8'),
    ) as Record<string, { file: string }>
    const pythonGrammar = Object.entries(manifest).find(([key]) =>
      key.endsWith('@codemirror/lang-python/dist/index.js'),
    )?.[1].file
    if (!pythonGrammar) throw new Error('Missing Python grammar fixture asset')
    server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } })
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture server')
    application = await electron.launch({
      args: [resolve('test/e2e/fixtures/preview-lifetime/main.cjs')],
      env: {
        ...process.env,
        MANUSLIP_WIDGET_TEST_PROFILE: profile,
        MANUSLIP_WIDGET_TEST_URL: `http://127.0.0.1:${address.port}/index.html`,
      },
    })
    const page = await application.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.waitForFunction(() => Boolean(window.previewLifetime), undefined, { timeout: 10000 })
    return {
      page,
      application,
      pythonGrammar,
      errors,
      async close() {
        try {
          await page.evaluate(() => window.previewLifetime.dispose())
        } finally {
          await cleanup()
        }
      },
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

test('a rendered paragraph maps its first click before native selection reveals the source', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = 'Before **Same**\nand <b>Same &amp; Same</b> after.\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const point = await page.locator('.cm-live-paragraph b').evaluate((element) => {
      const node = element.firstChild
      if (!node) throw new Error('Missing rendered text')
      const range = document.createRange()
      range.setStart(node, (node.textContent?.lastIndexOf('Same') ?? 0) + 2)
      range.collapse(true)
      const box = range.getBoundingClientRect()
      return { x: box.left, y: box.top + box.height / 2 }
    })
    await page.mouse.click(point.x, point.y)
    const at = text.lastIndexOf('Same') + 2
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(at)
    await page.keyboard.insertText('Q')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(
      `${text.slice(0, at)}Q${text.slice(at)}`,
    )
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('clicking math inside a projected paragraph preserves its own source and preview', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = 'Before <b>the</b> expression.\n$x^2$ then $x^2$\nAfter the expression.\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    await expect(page.locator('.cm-live-paragraph [role="math"]')).toHaveCount(2)
    const math = page.getByRole('math', { name: 'x^2', exact: true }).last()
    await expect(math.locator('svg')).toBeVisible()
    const point = await math
      .locator('[data-source-from="2"]')
      .last()
      .evaluate((element) => {
        const box = element.getBoundingClientRect()
        return { x: box.left + box.width * 0.8, y: box.top + box.height / 2 }
      })
    await page.mouse.click(point.x, point.y)
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.lastIndexOf('^2') + 2,
    )
    await expect(page.locator('.cm-live-edit-preview [role="math"]')).toHaveAttribute(
      'aria-label',
      'x^2',
    )
    await page.keyboard.insertText('Q')
    const at = text.lastIndexOf('^2') + 2
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(
      `${text.slice(0, at)}Q${text.slice(at)}`,
    )
    await page.evaluate(() => window.previewLifetime.owned())
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.press('Escape')
    const changedMath = page.getByRole('math', { name: 'x^2Q', exact: true })
    await changedMath.focus()
    await changedMath.press('Enter')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.lastIndexOf('$x^2$') + 1,
    )
    await expect(page.locator('.cm-live-inline-math-source')).toHaveText('$x^2Q$')
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('a diagram inside a quote keeps its own source position and companion preview', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const value = 'flowchart LR\nA[Same] --> B[Other]'
    const text =
      '> Intro\n>\n> ```mermaid\n> flowchart LR\n> A[Same] --> B[Other]\n> ```\n>\n> End\n\nAfter'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.deferDiagrams())
    await page.evaluate(() => window.previewLifetime.owned())
    const svg = `<svg viewBox="0 0 200 80" width="200" height="80"><text x="20" y="30" data-source-from="${value.indexOf('Other')}" data-source-to="${value.indexOf('Other') + 5}">Other</text></svg>`
    await page.evaluate((value) => {
      window.previewLifetime.settleDiagrams({ ok: true, value })
      window.previewLifetime.settleCancellations()
    }, svg)
    const label = page.locator('.cm-live-blockquote [data-render-kind="diagram"] text')
    await expect(label).toHaveText('Other')
    await label.click({ position: { x: 1, y: 2 } })
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.indexOf('Other'),
    )
    await expect(page.locator('.cm-live-edit-preview.cm-live-diagram')).toBeVisible()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.press('Escape')
    const diagram = page.locator('.cm-live-blockquote [data-render-kind="diagram"]')
    await diagram.focus()
    await diagram.press('Enter')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.indexOf('flowchart'),
    )
    await editor.press('ArrowDown')
    await editor.press('End')
    await editor.press('ArrowLeft')
    await page.keyboard.insertText('Q')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(
      text.replace('Other]', 'OtherQ]'),
    )
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('an HTML click retains its authored position when preview layout changes during the press', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '<div title="Same"><span>Same</span><b>Same &amp; Same</b></div>\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const point = await page.locator('.cm-live-html b').evaluate((element) => {
      const range = document.createRange()
      const node = element.firstChild
      if (!node) throw new Error('Missing HTML text')
      range.setStart(node, 9)
      range.collapse(true)
      const box = range.getBoundingClientRect()
      return { x: box.left, y: box.top + box.height / 2 }
    })
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.locator('.cm-live-html .cm-live-rendered').evaluate((element) => {
      element.style.paddingTop = '120px'
      element.style.paddingLeft = '200px'
    })
    await page.mouse.up()
    await expect(page.getByRole('textbox', { name: 'Markdown source', exact: true })).toBeFocused()
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.lastIndexOf('Same') + 2,
    )
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('reused HTML and math previews resolve source positions after edits before the widget', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    for (const kind of ['html', 'math'] as const) {
      const text = `Intro\n\n${kind === 'html' ? '<div><b>Same &amp; Same</b></div>' : '$$\nx+y\n$$'}\n\nEnd`
      await page.evaluate((text) => window.previewLifetime.setSource(text), text)
      await page.evaluate(() => window.previewLifetime.owned())
      const rendered = page.locator(`.cm-live-${kind}`)
      if (kind === 'math') await expect(rendered.locator('svg')).toBeVisible()
      await rendered.evaluate((element) => {
        element.dataset.retained = 'true'
      })
      await page.evaluate(() => window.previewLifetime.select([[0, 0]]))
      await page.keyboard.insertText('Prefix ')
      await expect(rendered).toHaveAttribute('data-retained', 'true')
      const point = await rendered.evaluate((element, kind) => {
        if (kind === 'html') {
          const range = document.createRange()
          const node = element.querySelector('b')?.firstChild
          if (!node) throw new Error('Missing retained HTML text')
          range.setStart(node, 9)
          range.collapse(true)
          const box = range.getBoundingClientRect()
          return { x: box.left, y: box.top + box.height / 2 }
        }
        const symbol = [...element.querySelectorAll('[data-source-from="0"]')].at(-1)
        if (!symbol) throw new Error('Missing retained math symbol')
        const box = symbol.getBoundingClientRect()
        return { x: box.left + box.width * 0.8, y: box.top + box.height / 2 }
      }, kind)
      await page.mouse.click(point.x, point.y)
      const at = 7 + (kind === 'html' ? text.lastIndexOf('Same') + 2 : text.indexOf('x+y') + 1)
      expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(at)
    }
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('HTML editing releases its renderer and preserves teardown ownership without a preview panel', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    await page.setViewportSize({ width: 600, height: 550 })
    await page.locator('#editor').evaluate((element) => {
      element.style.height = '440px'
      element.style.transform = 'scale(0.85)'
      element.style.transformOrigin = 'top left'
    })
    const text = `<div><b>Same</b>\n${'<!-- hidden -->\n'.repeat(100)}</div>\n\nEnd`
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const collapsed = page.locator('.cm-live-html:not(.cm-live-edit-preview)')
    await collapsed.focus()
    await collapsed.press('Enter')
    const panel = page.locator('.cm-live-preview-panel')
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.cm-live-edit-preview')).toHaveCount(0)
    // The following paragraph is outside CodeMirror's virtualized viewport.
    await expect.poll(() => page.evaluate(() => window.previewLifetime.counts().connected)).toBe(0)
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.press('ArrowDown')
    await expect(editor).toBeFocused()
    await page.evaluate(() => window.previewLifetime.sourceMode())
    await expect(panel).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.previewLifetime.counts()))
      .toMatchObject({ holds: 2, connected: 0 })
    const counts = await page.evaluate(() => window.previewLifetime.counts())
    expect(counts.aborted).toBe(counts.mounts)
    await page.evaluate(() => window.previewLifetime.clear())
    await expect.poll(() => page.evaluate(() => window.previewLifetime.counts().holds)).toBe(0)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('live selections reveal selected syntax across characters, lines and multiple cursors', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '**中文😀 first** and *second*.\nEscaped \\*literal\\* &amp;.\n- [ ] Task\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.select([[2, 12]]))
    await expect(page.locator('.cm-live-strong')).toHaveText('中文😀 first')
    await expect(page.locator('.cm-line').first()).toContainText('**中文😀 first**')

    for (const position of [0, 1, 2, 8, 12, 14]) {
      await page.evaluate(
        (position) => window.previewLifetime.select([[position, position]]),
        position,
      )
      await expect(page.locator('.cm-line').first()).toHaveText('**中文😀 first** and second.')
    }
    // Each selected body and insertion caret exposes only its own paired markers.
    await page.evaluate(() =>
      window.previewLifetime.select([
        [3, 2],
        [22, 22],
      ]),
    )
    await expect(page.locator('.cm-line').first()).toHaveText('**中文😀 first** and *second*.')

    const entity = text.indexOf('&amp;')
    await page.evaluate(
      (entity) => window.previewLifetime.select([[entity + 2, entity + 2]]),
      entity,
    )
    await expect(page.locator('.cm-live-source-hint')).toHaveText('&amp;')
    await page.evaluate(
      (entity) =>
        window.previewLifetime.select([
          [0, 2],
          [entity, entity + 5],
        ]),
      entity,
    )
    await expect(page.locator('.cm-line').first()).toContainText('**中文😀 first**')
    await expect(page.locator('.cm-content')).toContainText('&amp;')
    expect(await page.evaluate(() => window.previewLifetime.selections())).toEqual([
      [0, 2],
      [entity, entity + 5],
    ])

    for (const [anchor, head] of [
      [0, text.length],
      [text.length, 0],
    ] as const) {
      await page.evaluate(({ anchor, head }) => window.previewLifetime.select([[anchor, head]]), {
        anchor,
        head,
      })
      await expect
        .poll(() =>
          page
            .locator('.cm-line')
            .allTextContents()
            .then((lines) => lines.join('\n')),
        )
        .toBe(text)
      await expect(page.locator('.cm-live-task')).toHaveCount(0)
      expect(await page.evaluate(() => window.previewLifetime.selections())).toEqual([
        [anchor, head],
      ])
    }
    await page.evaluate((end) => window.previewLifetime.select([[end, end]]), text.length)
    await expect(page.locator('.cm-live-task')).toHaveCount(1)
    await expect(page.locator('.cm-line').first()).not.toContainText('**')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(text)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('inline source exposes quiet paired markers at the caret and preserves native selections', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const first = page.locator('.cm-line').first()
    for (const [raw, rendered, from, to, active] of [
      ['**title**', 'title', 2, 5, '**title**'],
      ['*title*', 'title', 1, 4, '*title*'],
      ['~~title~~', 'title', 2, 5, '~~title~~'],
      ['`title`', 'title', 1, 4, '`title`'],
      ['# title', 'title', 2, 5, '# title'],
      ['> title', 'title', 2, 5, '> title'],
      ['- title', '• title', 2, 5, '- title'],
      ['- [ ] title', 'title', 6, 9, '-  title'],
      ['&amp;', '&', 1, 3, '&&amp;'],
      ['---', '', 0, 2, '---'],
    ] as const) {
      await page.evaluate((raw) => window.previewLifetime.setSource(`${raw}\n\nEnd`), raw)
      for (const position of [0, from, from + 1, raw.length]) {
        await page.evaluate(
          (position) => window.previewLifetime.select([[position, position]]),
          position,
        )
        await expect(first).toHaveText(active)
      }
      for (const [anchor, head] of [
        [from, to],
        [to, from],
      ]) {
        await page.evaluate(([anchor, head]) => window.previewLifetime.select([[anchor, head]]), [
          anchor,
          head,
        ] as [number, number])
        await expect(first).toHaveText(raw)
      }
      await page.evaluate((from) => window.previewLifetime.select([[from, from]]), from)
      await expect(first).toHaveText(active)
      await page.evaluate((end) => window.previewLifetime.select([[end, end]]), raw.length + 5)
      await expect(first).toHaveText(rendered)
      expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(
        `${raw}\n\nEnd`,
      )
    }
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('projected quotes and lists preserve prose newlines without adding serialized block breaks', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = [
      '> Quote first',
      '> second.',
      '>',
      '> ```text',
      '> literal first',
      '> literal second',
      '> ```',
      '>',
      '> Last quote paragraph.',
      '',
      '- List first',
      '  second.  ',
      '  Hard line.',
      '',
      '  ```text',
      '  literal list',
      '  ```',
      '',
      '- Last item.',
      '',
      'End',
    ].join('\n')
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const quote = page.locator('.cm-live-blockquote'),
      list = page.locator('.cm-live-list')
    await expect(quote.locator('p')).toHaveCount(2)
    await expect(quote.locator('p').first()).toHaveText('Quote firstsecond.')
    await expect(quote.locator('p br')).toHaveCount(1)
    await expect(quote.locator('pre code')).toHaveText('literal first\nliteral second\n')
    await expect(quote.locator('blockquote > br')).toHaveCount(0)
    await expect(list.locator('p').first()).toHaveText('List firstsecond.Hard line.')
    await expect(list.locator('p').first().locator('br')).toHaveCount(2)
    await expect(list.locator('li > br')).toHaveCount(0)
    await expect(list.locator('pre code')).toHaveText('literal list\n')
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(text)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('revealing a rendered block handles its click once and restores source focus', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '# Heading\n\n~~~js\nconst x = 1\n~~~\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const source = page.locator('.cm-live-code pre > code')
    await expect(source).toBeVisible()
    await source.click()
    await expect(page.locator('.cm-live-block')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeFocused()
    const selections = await page.evaluate(() => window.previewLifetime.selections())
    expect(selections).toHaveLength(1)
    expect(selections[0]?.[0]).toBe(selections[0]?.[1])
    expect(selections[0]?.[0]).toBeGreaterThanOrEqual(text.indexOf('~~~js'))
    expect(selections[0]?.[0]).toBeLessThanOrEqual(text.lastIndexOf('~~~') + 3)
    await page.getByRole('textbox', { name: 'Markdown source' }).press('ArrowRight')
    await expect(page.locator('.cm-live-edit-source')).toHaveCount(3)
    await page.getByRole('textbox', { name: 'Markdown source' }).press('Escape')
    await expect(page.locator('.cm-live-code pre')).toHaveText('const x = 1\n')
    await page.getByRole('textbox', { name: 'Markdown source' }).press('ArrowLeft')
    await expect(page.locator('.cm-live-code pre')).toHaveText('const x = 1\n')
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('escape, entity and emoji source hints follow the caret after their rendered character', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = 'Escaped \\* and &amp; with :smile: nearby.\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    const paragraph = page.locator('.cm-live-paragraph')
    if (await paragraph.count()) await paragraph.click()
    for (const [raw, rendered] of [
      ['\\*', '*'],
      ['&amp;', '&'],
      [':smile:', '😄'],
    ] as const) {
      const from = text.indexOf(raw)
      for (const head of [from, from + 1, from + raw.length]) {
        await page.evaluate((head) => window.previewLifetime.select([[head, head]]), head)
        const hint = page.locator('.cm-live-source-hint')
        await expect(hint).toHaveText(raw)
        const before = hint.locator(
          'xpath=preceding-sibling::*[not(contains(@class, "cm-widgetBuffer"))][1]',
        )
        await expect(before).toHaveText(rendered)
      }
      await page.evaluate(
        (end) => window.previewLifetime.select([[end, end]]),
        text.indexOf('nearby'),
      )
      await expect(page.locator('.cm-live-source-hint')).toHaveCount(0)
    }
    await page.screenshot({ path: test.info().outputPath('inline-hints.png') })
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(text)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('inline widgets and projected multiline prose use exclusive endpoints for every selection', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = 'Before [one](https://example.invalid) after.\n\nMath $a+\nb$ after.\n\nEnd'
    const link = text.indexOf('[one]'),
      math = text.indexOf('$'),
      mathEnd = text.lastIndexOf('$') + 1
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate((end) => window.previewLifetime.select([[end, end]]), text.length)
    await page.evaluate(() => window.previewLifetime.owned())
    const renderedLink = page.locator('[data-kind="link"]')
    const renderedMath = page.locator('.cm-content [role="math"]')
    await expect(renderedLink).toHaveCount(1)
    await expect(renderedMath).toHaveCount(1)
    for (const position of [link, link + 1, link + 8, math, math + 1, mathEnd]) {
      await page.evaluate(
        (position) => window.previewLifetime.select([[position, position]]),
        position,
      )
      await expect(renderedLink).toHaveCount(1)
      await expect(renderedMath).toHaveCount(1)
    }
    await page.evaluate((link) => window.previewLifetime.select([[0, link]]), link)
    await expect(renderedLink).toHaveCount(1)
    await page.evaluate((link) => window.previewLifetime.select([[link + 4, link + 1]]), link)
    await expect(renderedLink).toHaveCount(0)
    await expect(renderedMath).toHaveCount(1)
    await page.evaluate(
      ({ link, math, mathEnd }) =>
        window.previewLifetime.select([
          [link + 1, link + 3],
          [mathEnd - 1, math + 1],
        ]),
      { link, math, mathEnd },
    )
    await expect(renderedLink).toHaveCount(0)
    await expect(renderedMath).toHaveCount(0)
    await page.evaluate((end) => window.previewLifetime.select([[end, end]]), text.length)
    await expect(renderedLink).toHaveCount(1)
    await expect(renderedMath).toHaveCount(1)
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(text)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('image loading, failure and retry states remain readable and release their pending work', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '# Heading\n\n![Picture](https://example.invalid/image.png)\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.deferImages())
    await page.evaluate(() => window.previewLifetime.owned())
    const image = page.locator('.cm-live-inline-widget img')
    await expect(image).toHaveAttribute('data-render-state', 'loading')
    await expect(image).toHaveAttribute('aria-busy', 'true')
    await expect(page.locator('.cm-image-placeholder')).toBeVisible()
    await expect(page.locator('.cm-live-image-error')).toContainText('Loading image')
    await page.evaluate(() =>
      window.previewLifetime.settleImages({ ok: false, error: 'Unavailable', code: 'image-load' }),
    )
    await expect(image).toHaveAttribute('data-render-state', 'error')
    await expect(image).not.toHaveAttribute('aria-busy')
    await expect(page.getByRole('img', { name: 'Picture', exact: true })).toBeVisible()
    const retry = page.locator('.cm-live-image-retry')
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect(retry).toBeDisabled()
    await expect(image).toHaveAttribute('data-render-state', 'loading')
    expect(await page.evaluate(() => window.previewLifetime.counts().images)).toBe(1)
    // A successful bridge response is still an error when the browser cannot decode it.
    await page.evaluate(() =>
      window.previewLifetime.settleImages({
        ok: true,
        value: 'data:image/png;base64,aW52YWxpZA==',
      }),
    )
    await expect(image).toHaveAttribute('data-render-state', 'error')
    await expect(retry).toBeVisible()
    await retry.click()
    await expect(image).toHaveAttribute('data-render-state', 'loading')
    await page.evaluate(() =>
      window.previewLifetime.settleImages({
        ok: true,
        value:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2cAAAAASUVORK5CYII=',
      }),
    )
    await expect(image).toHaveAttribute('data-render-state', 'ready')
    await expect(image).not.toHaveAttribute('aria-busy')
    await expect(retry).toBeHidden()
    await expect(page.locator('.cm-live-image-error')).toBeHidden()
    await expect(page.locator('.cm-image-placeholder')).toBeHidden()
    expect(await page.evaluate(() => window.previewLifetime.counts().images)).toBe(0)
    expect(await page.evaluate(() => window.previewLifetime.snapshot().text)).toBe(text)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('equivalent widget DOM reuse retains one renderer lifetime and final removal aborts it', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '# Heading\n\n~~~js\nconst x = 1\n~~~\n\n~~~js\nconst x = 1\n~~~\n'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    const first = text.indexOf('~~~js'),
      second = text.lastIndexOf('~~~js')
    const block = {
      id: 'stable',
      from: first,
      to: second - 2,
      kind: 'code',
      html: '<pre><code>const x = 1</code></pre><a href="https://example.invalid/">Open</a>',
      value: 'const x = 1',
      lines: 3,
    }
    await page.evaluate((block) => window.previewLifetime.native([block]), block)
    const widget = page.locator('.cm-live-code')
    await expect(widget).toHaveCount(1)
    const element = await widget.elementHandle()
    await page.evaluate(
      ({ block, second, end }) =>
        window.previewLifetime.native([{ ...block, from: second, to: end }]),
      { block, second, end: text.length - 1 },
    )
    await expect(widget).toHaveCount(1)
    expect(await widget.evaluate((node, previous) => node === previous, element)).toBe(true)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 1,
      aborted: 0,
    })
    await widget.locator('a').click({ modifiers: ['ControlOrMeta'] })
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      links: ['https://example.invalid/'],
    })
    await page.evaluate(() => window.previewLifetime.clear())
    await expect(widget).toHaveCount(0)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 1,
      aborted: 1,
    })
    // Detached DOM retained by a browser/tool must no longer dispatch editor actions.
    await element?.evaluate((node) => {
      node.querySelector<HTMLButtonElement>('button')?.click()
      node
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      links: ['https://example.invalid/'],
      aborted: 1,
    })
    await element?.dispose()
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('React status keeps old packed outlines charged until delayed commits or unmount acknowledge them', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const client = await page.context().newCDPSession(page)
    await page.evaluate(async () => {
      const api = window.previewLifetime
      api.setSource('# First outline\n\nSome prose.')
      await api.owned()
      api.reactStatus.mount()
      api.reactStatus.publish()
    })
    const primary = page.locator('[data-status-reader="primary"]'),
      secondary = page.locator('[data-status-reader="secondary"]')
    await expect(primary).toHaveText('First outline')
    await expect(secondary).toHaveText('First outline')
    await page.evaluate(() => {
      window.previewLifetime.observeCurrent()
      window.previewLifetime.reactStatus.abandon()
      window.previewLifetime.reactStatus.pause()
    })
    expect(await page.evaluate(() => window.previewLifetime.reactStatus.counts())).toMatchObject({
      consumers: 2,
      publications: 1,
      pending: false,
    })
    await page.evaluate(async () => {
      const api = window.previewLifetime
      api.setSource('# Second outline\n\nChanged prose.')
      await api.owned()
      api.reactStatus.publish()
    })
    await expect(primary).toHaveText('Second outline')
    await expect(secondary).toHaveText('First outline')
    await client.send('HeapProfiler.collectGarbage')
    const held = await page.evaluate(() => window.previewLifetime.collected())
    expect(held).toMatchObject({ observed: 5, alive: 5 })
    expect(await page.evaluate(() => window.previewLifetime.reactStatus.counts())).toMatchObject({
      publications: 2,
      consumers: 2,
    })
    await page.evaluate(() => window.previewLifetime.reactStatus.resume())
    await expect(secondary).toHaveText('Second outline')
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() => window.previewLifetime.collected().alive)
      })
      .toBe(0)
    const afterCommit = await page.evaluate(() => window.previewLifetime.collected())
    await page.evaluate(() => {
      window.previewLifetime.reactStatus.pause()
      window.previewLifetime.reactStatus.close()
    })
    await expect(primary).toHaveText('Empty')
    await expect(secondary).toHaveText('Second outline')
    expect(await page.evaluate(() => window.previewLifetime.reactStatus.counts())).toMatchObject({
      publications: 1,
      closed: true,
    })
    await page.evaluate(() => {
      window.previewLifetime.reactStatus.unmountSecondary()
      window.previewLifetime.clear()
    })
    expect(await page.evaluate(() => window.previewLifetime.reactStatus.counts())).toMatchObject({
      publications: 0,
      consumers: 1,
    })
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      holds: 0,
      readers: 0,
      bytes: 256,
    })
    console.log(
      'React status lifetime probe:',
      JSON.stringify({
        observed: held.observed,
        aliveWhileDelayed: held.alive,
        aliveAfterCommit: afterCommit.alive,
        afterClose: await page.evaluate(() => window.previewLifetime.reactStatus.counts()),
        owner: await page.evaluate(() => window.previewLifetime.counts()),
      }),
    )
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('changing a widget kind replaces its DOM and closes each renderer once', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text = '# Heading\n\n~~~js\nconst x = 1\n~~~\n'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    const block = {
      id: 'stable',
      from: text.indexOf('~~~js'),
      to: text.length - 1,
      kind: 'code',
      html: '<pre><code>const x = 1</code></pre>',
      value: 'const x = 1',
      lines: 3,
    }
    await page.evaluate((block) => window.previewLifetime.native([block]), block)
    await expect(page.locator('.cm-live-code')).toHaveCount(1)
    await page.evaluate(
      (block) => window.previewLifetime.native([{ ...block, kind: 'html' }]),
      block,
    )
    await expect(page.locator('.cm-live-code')).toHaveCount(0)
    await expect(page.locator('.cm-live-html')).toHaveCount(1)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 2,
      aborted: 1,
    })
    await page.evaluate(() => window.previewLifetime.clear())
    await page.evaluate(() => window.previewLifetime.clear())
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 2,
      aborted: 2,
    })
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('owned packed models render sanitized widgets and release native model data after actual DOM teardown', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text =
      '# Heading 世界\n\n~~~js\nconst x = 1\n~~~\n\n<div><strong>Safe text</strong><script>window.compromised=true</script><img src="https://example.invalid/private.png" onerror="window.compromised=true"></div>\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    await expect(page.locator('.cm-live-code')).toContainText('const x = 1')
    await expect(page.locator('.cm-live-html strong')).toHaveText('Safe text')
    await expect(
      page.locator(
        '.cm-live-rendered script, .cm-live-rendered [onerror], .cm-live-rendered img[src]',
      ),
    ).toHaveCount(0)
    await expect(page.locator('#status')).toContainText(
      `${[...text].length} characters; Heading 世界`,
    )
    const observed = await page.evaluate(() => window.previewLifetime.observeCurrent())
    expect(observed).toBe(7)
    const client = await fixture.application.context().newCDPSession(page)
    const before = await page.evaluate(() => window.previewLifetime.snapshot())
    await page.evaluate(() => window.previewLifetime.sourceMode())
    await expect(page.locator('.cm-live-block')).toHaveCount(0)
    await expect
      .poll(async () => (await page.evaluate(() => window.previewLifetime.counts())).holds)
      .toBe(2)
    const counts = await page.evaluate(() => window.previewLifetime.counts())
    expect(counts.aborted).toBe(counts.mounts)
    expect(counts.holds).toBe(2)
    // Replace only after all old DOM consumers have ended. This fixture's status is
    // plain text; React status consumers need their own acknowledged lifetime.
    await page.evaluate(() => window.previewLifetime.owned())
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() => window.previewLifetime.collected())
      })
      .toMatchObject({ observed, alive: 0 })
    const replacementObserved = await page.evaluate(() => window.previewLifetime.observeCurrent())
    expect(replacementObserved).toBe(14)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({ holds: 2 })
    await page.evaluate(() => window.previewLifetime.liveMode())
    await expect(page.locator('.cm-live-code')).toContainText('const x = 1')
    expect(await page.evaluate(() => window.previewLifetime.snapshot())).toEqual(before)
    expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
      observed: replacementObserved,
      alive: 7,
    })
    await page.evaluate(() => window.previewLifetime.clear())
    await expect(page.locator('.cm-live-block')).toHaveCount(0)
    await expect
      .poll(async () => (await page.evaluate(() => window.previewLifetime.counts())).holds)
      .toBe(0)
    const cleared = await page.evaluate(() => window.previewLifetime.counts())
    expect(cleared).toMatchObject({
      holds: 0,
      readers: 0,
      bytes: 256,
      connected: 0,
    })
    expect(cleared.aborted).toBe(cleared.mounts)
    try {
      await expect
        .poll(async () => {
          await client.send('HeapProfiler.collectGarbage')
          return page.evaluate(() => window.previewLifetime.collected())
        })
        .toMatchObject({ observed: replacementObserved, alive: 0 })
    } catch (error) {
      console.log(
        'Retained fixture values:',
        await page.evaluate(() => window.previewLifetime.collected()),
      )
      const chunks: string[] = []
      client.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => chunks.push(chunk))
      await client.send('HeapProfiler.takeHeapSnapshot')
      await writeFile('test/e2e/result/widget-lifetime.heapsnapshot', chunks.join(''))
      throw error
    }
    expect(await page.evaluate(() => 'compromised' in window)).toBe(false)
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('reused DOM keeps the released predecessor charged until its renderer is destroyed', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    const text =
      '# Heading\n\n~~~js\nconst x = 1\n~~~\n\n<div><strong>Safe text</strong></div>\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    await expect(page.locator('.cm-live-code .tok-keyword')).toHaveText('const')
    await expect
      .poll(async () => (await page.evaluate(() => window.previewLifetime.counts())).holds)
      .toBe(6)
    expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(7)
    const before = await page.evaluate(() => window.previewLifetime.snapshot())
    const element = await page.locator('.cm-live-code').elementHandle()
    const initial = await page.evaluate(() => window.previewLifetime.counts())
    await page.evaluate(() => window.previewLifetime.owned())
    expect(
      await page.locator('.cm-live-code').evaluate((node, previous) => node === previous, element),
    ).toBe(true)
    await element?.dispose()
    expect(await page.evaluate(() => window.previewLifetime.snapshot())).toEqual(before)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: initial.mounts,
      aborted: 0,
      holds: 6,
    })
    expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(14)
    const client = await fixture.application.context().newCDPSession(page)
    await client.send('HeapProfiler.collectGarbage')
    expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
      observed: 14,
      alive: 14,
    })
    await page.evaluate(() => window.previewLifetime.sourceMode())
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() =>
          window.previewLifetime.collected().retained.map(({ index }) => index),
        )
      })
      .toEqual([7, 8, 9, 10, 11, 12, 13])
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({ holds: 2 })
    await page.evaluate(() => window.previewLifetime.liveMode())
    await expect(page.locator('.cm-live-code .tok-keyword')).toHaveText('const')
    expect(await page.evaluate(() => window.previewLifetime.snapshot())).toEqual(before)
    await page.evaluate(() => window.previewLifetime.clear())
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() => window.previewLifetime.collected().alive)
      })
      .toBe(0)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      holds: 0,
      bytes: 256,
    })
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.close()
  }
})

for (const outcome of ['resolve', 'reject'] as const) {
  test(`a cancelled image remains charged until its pending loader ${outcome}s`, async () => {
    const fixture = await setup()
    try {
      const { page } = fixture
      const text =
        '# Heading\n\nBefore ![Picture](https://example.invalid/private.png) after.\n\nEnd'
      await page.evaluate((text) => window.previewLifetime.setSource(text), text)
      await page.evaluate(() => window.previewLifetime.deferImages())
      await page.evaluate(() => window.previewLifetime.owned())
      await expect(page.locator('.cm-live-inline-widget img')).toHaveCount(1)
      expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(6)
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
        images: 1,
        holds: 6,
      })
      await page.evaluate(() => window.previewLifetime.clear())
      await expect(page.locator('.cm-live-inline-widget')).toHaveCount(0)
      const waiting = await page.evaluate(() => window.previewLifetime.counts())
      expect(waiting).toMatchObject({ holds: 2, connected: 0, images: 1 })
      expect(waiting.bytes).toBeGreaterThan(256)
      const client = await fixture.application.context().newCDPSession(page)
      await client.send('HeapProfiler.collectGarbage')
      expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
        observed: 6,
        alive: 6,
      })
      await page.evaluate(
        (outcome) =>
          window.previewLifetime.settleImages(
            outcome === 'resolve'
              ? { ok: true, value: 'data:image/png;base64,AA==' }
              : { ok: false, error: 'Unavailable', code: 'image-load' },
            outcome === 'reject',
          ),
        outcome,
      )
      await expect
        .poll(async () => {
          await client.send('HeapProfiler.collectGarbage')
          return page.evaluate(() => window.previewLifetime.collected())
        })
        .toMatchObject({ observed: 6, alive: 0 })
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
        holds: 0,
        bytes: 256,
        images: 0,
      })
      expect(fixture.errors).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}

for (const first of ['render', 'cancellation'] as const) {
  test(`a cancelled diagram stays charged when ${first} IPC completes first`, async () => {
    const fixture = await setup()
    try {
      const { page } = fixture
      const text = '# Heading\n\n~~~mermaid\nflowchart LR\nA-->B\n~~~\n\nEnd'
      await page.evaluate((text) => window.previewLifetime.setSource(text), text)
      await page.evaluate(() => window.previewLifetime.deferDiagrams())
      await page.evaluate(() => window.previewLifetime.owned())
      await expect(page.locator('.cm-live-diagram [aria-busy="true"]')).toHaveCount(1)
      expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(6)
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
        diagrams: 1,
        holds: 8,
      })
      await page.evaluate(() => window.previewLifetime.clear())
      await expect(page.locator('.cm-live-diagram')).toHaveCount(0)
      await expect
        .poll(async () => (await page.evaluate(() => window.previewLifetime.counts())).holds)
        .toBe(2)
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
        diagrams: 1,
        cancellations: 1,
        connected: 0,
      })
      const client = await fixture.application.context().newCDPSession(page)
      await client.send('HeapProfiler.collectGarbage')
      expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
        observed: 6,
        alive: 6,
      })
      await page.evaluate((first) => {
        if (first === 'render')
          window.previewLifetime.settleDiagrams(
            { ok: false, error: 'Stopped', code: 'diagram-process' },
            true,
          )
        else window.previewLifetime.settleCancellations()
      }, first)
      await client.send('HeapProfiler.collectGarbage')
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({ holds: 2 })
      expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
        alive: 6,
      })
      await page.evaluate((first) => {
        if (first === 'render') window.previewLifetime.settleCancellations()
        else
          window.previewLifetime.settleDiagrams({
            ok: true,
            value: '<svg><path d="M0 0L1 1"/></svg>',
          })
      }, first)
      await expect
        .poll(async () => {
          await client.send('HeapProfiler.collectGarbage')
          return page.evaluate(() => window.previewLifetime.collected().alive)
        })
        .toBe(0)
      expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
        holds: 0,
        bytes: 256,
        diagrams: 0,
        cancellations: 0,
      })
      await expect(page.locator('.cm-live-diagram')).toHaveCount(0)
      expect(fixture.errors).toEqual([])
    } finally {
      await fixture.close()
    }
  })
}

test('cancellation releases queued code immediately and retains running grammar loads until they settle', async () => {
  const fixture = await setup()
  const held: Route[] = []
  try {
    const { page } = fixture
    await page.route(`**/${fixture.pythonGrammar}`, (route) => {
      held.push(route)
    })
    const text =
      '# Heading\n\n' +
      Array.from({ length: 4 }, (_, index) => `~~~python\nx = ${index}\n~~~\n\n`).join('')
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    await expect(page.locator('.cm-live-code')).toHaveCount(4)
    await expect.poll(() => held.length).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(9)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 4,
      holds: 18,
    })
    await page.evaluate(() => window.previewLifetime.clear())
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      mounts: 4,
      aborted: 4,
      connected: 0,
      holds: 6,
    })
    const client = await fixture.application.context().newCDPSession(page)
    await client.send('HeapProfiler.collectGarbage')
    expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
      observed: 9,
      alive: 9,
    })
    for (const route of held.splice(0)) await route.continue()
    await page.unroute(`**/${fixture.pythonGrammar}`)
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() => window.previewLifetime.collected().alive)
      })
      .toBe(0)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      holds: 0,
      bytes: 256,
    })
    expect(fixture.errors).toEqual([])
  } finally {
    for (const route of held.splice(0)) await route.continue().catch(() => {})
    await fixture.close()
  }
})

test('cancelled math remains charged until its worker and queued promises settle', async () => {
  const fixture = await setup()
  const held: Route[] = []
  const pattern = '**/assets/math.worker-*.js'
  try {
    const { page } = fixture
    // Freeze the existing watchdog while the test deliberately delays the real worker.
    // This is an ownership check, not a timing or watchdog acceptance measurement.
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
    await page.clock.pauseAt(new Date('2026-01-02T00:00:00Z'))
    await page.context().route(pattern, (route) => {
      held.push(route)
    })
    const text = '# Heading\n\n$$\nx^2\n$$\n\n$$\ny^2\n$$\n\nEnd'
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.owned())
    await expect(page.locator('.cm-live-math')).toHaveCount(2)
    await expect.poll(() => held.length).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.previewLifetime.observeCurrent())).toBe(7)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({ holds: 10 })
    await page.evaluate(() => window.previewLifetime.clear())
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      holds: 4,
      connected: 0,
    })
    const client = await fixture.application.context().newCDPSession(page)
    await client.send('HeapProfiler.collectGarbage')
    expect(await page.evaluate(() => window.previewLifetime.collected())).toMatchObject({
      observed: 7,
      alive: 7,
    })
    for (const route of held.splice(0)) await route.continue()
    await page.context().unroute(pattern)
    await page.clock.resume()
    await expect
      .poll(async () => {
        await client.send('HeapProfiler.collectGarbage')
        return page.evaluate(() => window.previewLifetime.collected().alive)
      })
      .toBe(0)
    expect(await page.evaluate(() => window.previewLifetime.counts())).toMatchObject({
      holds: 0,
      bytes: 256,
    })
    await expect(page.locator('.cm-live-math')).toHaveCount(0)
    expect(fixture.errors).toEqual([])
  } finally {
    for (const route of held.splice(0)) await route.continue().catch(() => {})
    await fixture.page.clock.resume().catch(() => {})
    await fixture.close()
  }
})

for (const [kind, duringPress] of [
  ['math', false],
  ['math', true],
  ['diagram', false],
  ['diagram', true],
] as const) {
  test(`a first click in pending ${kind} source keeps its position when rendering finishes ${duringPress ? 'during press' : 'after click'}`, async () => {
    const fixture = await setup()
    const held: Route[] = []
    const pattern = '**/assets/math.worker-*.js'
    try {
      const { page } = fixture
      if (kind === 'math') {
        await page.context().route(pattern, (route) => {
          held.push(route)
        })
      } else await page.evaluate(() => window.previewLifetime.deferDiagrams())
      const value = kind === 'math' ? 'x + y + z' : 'flowchart LR\nA[Alpha] --> B[Beta]'
      const source = kind === 'math' ? `$$\n${value}\n$$` : `\`\`\`mermaid\n${value}\n\`\`\``
      await page.evaluate(
        (source) => window.previewLifetime.setSource(`# Heading\n\n${source}\n\nEnd`),
        source,
      )
      await page.evaluate(() => window.previewLifetime.owned())
      const preview = page.locator(`.cm-live-${kind} .cm-live-rendered`)
      await expect(preview).toHaveAttribute('data-render-state', 'loading')
      const needle = kind === 'math' ? 'y' : 'Beta'
      const complete = async () => {
        if (kind === 'math') {
          await expect.poll(() => held.length).toBeGreaterThan(0)
          for (const route of held.splice(0)) await route.continue()
          await page.context().unroute(pattern)
        } else
          await page.evaluate(() => {
            window.previewLifetime.settleDiagrams({
              ok: true,
              value: '<svg viewBox="0 0 100 30"><text x="0" y="20">Rendered</text></svg>',
            })
            window.previewLifetime.settleCancellations()
          })
      }
      const point = await preview.evaluate((element, needle) => {
        const node = element.querySelector('pre')?.firstChild ?? element.firstChild
        const at = node?.textContent?.indexOf(needle) ?? -1
        if (!node || at < 0) throw new Error('Missing literal preview')
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 1)
        const box = range.getBoundingClientRect()
        return { x: box.left + box.width * 0.2, y: box.top + box.height / 2 }
      }, needle)
      if (duringPress) {
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
        await complete()
        await expect(preview.locator('svg')).toBeVisible()
        await page.mouse.up()
      } else await page.mouse.click(point.x, point.y)
      const at = `# Heading\n\n${source}`.indexOf(needle)
      expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(at)
      await page.keyboard.insertText('Q')
      await expect
        .poll(() => page.evaluate(() => window.previewLifetime.snapshot().text))
        .toBe(`# Heading\n\n${source}\n\nEnd`.replace(needle, `Q${needle}`))
      await page.evaluate(() => window.previewLifetime.owned())
      const selection = await page.evaluate(() => window.previewLifetime.selections())
      if (!duringPress || kind === 'diagram') await complete()
      await expect(preview.locator('svg')).toBeVisible()
      await expect(page.locator('.cm-content')).toBeFocused()
      expect(await page.evaluate(() => window.previewLifetime.selections())).toEqual(selection)
      expect(fixture.errors).toEqual([])
    } finally {
      for (const route of held.splice(0)) await route.continue().catch(() => {})
      if (kind === 'diagram')
        await fixture.page
          .evaluate(() => {
            window.previewLifetime.settleDiagrams({
              ok: false,
              error: 'Stopped',
              code: 'diagram-process',
            })
            window.previewLifetime.settleCancellations()
          })
          .catch(() => {})
      await fixture.close()
    }
  })
}

test('a delayed preview growing after source activation stays visible without overriding a wheel gesture', async () => {
  const fixture = await setup()
  try {
    const { page } = fixture
    await page.setViewportSize({ width: 720, height: 650 })
    await page.locator('#editor').evaluate((element) => {
      element.style.height = '500px'
      element.style.transform = 'scale(0.85)'
      element.style.transformOrigin = 'top left'
    })
    const paragraph = Array.from({ length: 20 }, (_, at) => `Paragraph ${at}.\n\n`).join('')
    const text = `${paragraph}\`\`\`mermaid\nflowchart LR\nA[Alpha] --> B[Beta]\n\`\`\`\n\n${paragraph}`
    await page.evaluate((text) => window.previewLifetime.setSource(text), text)
    await page.evaluate(() => window.previewLifetime.deferDiagrams())
    await page.evaluate(() => window.previewLifetime.owned())
    const scroller = page.locator('.cm-scroller')
    await scroller.evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
    })
    const diagram = page.locator('.cm-live-diagram')
    await diagram.scrollIntoViewIfNeeded()
    await diagram.focus()
    await diagram.press('Enter')
    const preview = page.locator('.cm-live-edit-preview')
    await expect(preview).toBeVisible()
    await page.evaluate(() => {
      window.previewLifetime.settleDiagrams({
        ok: true,
        value:
          '<svg viewBox="0 0 120 180" width="120" height="180"><text x="10" y="20">Alpha</text></svg>',
      })
      window.previewLifetime.settleCancellations()
    })
    const visible = () =>
      preview.evaluate((element) => {
        const scroller = element.closest('.cm-scroller')
        const bounds = scroller?.getBoundingClientRect(),
          source = scroller?.querySelector('.cm-live-edit-start')?.getBoundingClientRect()
        return Boolean(
          bounds &&
            source &&
            source.top >= bounds.top - 1 &&
            element.getBoundingClientRect().bottom <= bounds.bottom + 1,
        )
      })
    await expect(preview.locator('svg')).toBeVisible()
    await expect.poll(visible).toBe(true)
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.indexOf('flowchart'),
    )
    const before = await scroller.evaluate((element) => element.scrollTop)
    await scroller.hover({ position: { x: 10, y: 20 } })
    await page.mouse.wheel(0, -180)
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(before - 100)
    await preview.locator('svg').evaluate((element) => {
      element.setAttribute('height', '240')
    })
    await expect.poll(visible).toBe(false)
    expect(await page.evaluate(() => window.previewLifetime.snapshot().selection)).toBe(
      text.indexOf('flowchart'),
    )
    expect(fixture.errors).toEqual([])
  } finally {
    await fixture.page
      .evaluate(() => {
        window.previewLifetime.settleDiagrams({
          ok: false,
          error: 'Stopped',
          code: 'diagram-process',
        })
        window.previewLifetime.settleCancellations()
      })
      .catch(() => {})
    await fixture.close()
  }
})
