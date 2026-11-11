// Exploratory development-build probe, not a packaged performance gate.
// npm run build:app; node test/benchmark/input-lifecycle.mjs [output.json]
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import { _electron } from 'playwright'
import { installInputAudit } from './input-lifecycle-browser.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cases = new Set((process.env.MANUSLIP_INPUT_CASES ?? '').split(',').filter(Boolean))
const output = resolve(process.argv[2] ?? join(root, 'test/benchmark/result/input-lifecycle.json'))
await mkdir(dirname(output), { recursive: true })
const directory = await realpath(await mkdtemp(join(tmpdir(), 'manuslip-input-lifecycle-')))
const file = join(directory, 'input.md')
await writeFile(file, 'Initial document')
const application = await _electron.launch({
  args: [join(root, 'apps/desktop'), file],
  env: { ...process.env, MANUSLIP_TEST_PROFILE: join(directory, 'profile') },
})
const result = {
  recordedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environment: {
    platform: process.platform,
    os: release(),
    cpu: cpus()[0]?.model,
    node: process.version,
    build: 'unpackaged electron-vite production bundle; fresh isolated profile',
    viewport: { width: 1200, height: 900 },
    backgroundThrottling: false,
  },
  limitations: [
    'No Typora binary or Typora timings; official behavior documentation is separate.',
    'Debugger-driven IME, not an OS candidate-window or keyboard-layout test.',
    'DOM event selection offsets are node-local UTF-16 offsets, not source positions.',
    'Main-editor DOM text is a truncated projection, never the saved-source oracle.',
    'Frame callbacks are scheduling proxies, not compositor presentation timestamps.',
    'editor-update measures the document callback, not the entire CodeMirror transaction.',
    'Synthetic clipboard events exercise handlers, not the operating-system clipboard.',
    'Performance includes instrumentation; one machine, one run, sequential cases.',
  ],
  traces: [],
  performance: [],
  errors: [],
}
const page = await application.firstWindow()
await application.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0]
  window.webContents.setBackgroundThrottling(false)
})
page.on('pageerror', (error) => result.errors.push(error.message))
await page.setViewportSize(result.environment.viewport)
const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms))
const selectMode = async (mode) => {
  const button = page.getByRole('button', { name: mode, exact: true })
  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 })
}
const seed = async (source, mode = 'Source') => {
  await selectMode('Source')
  await editor.fill(source)
  await editor.press('Control+s')
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 15000 }).toBe(source)
  if (mode !== 'Source') await selectMode(mode)
  await pause(1100)
  await editor.focus()
  await page.keyboard.press('Control+End')
  await pause(80)
}
const savedSource = async () => {
  await page.keyboard.press('Control+s')
  await pause(350)
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible({ timeout: 15000 })
  return readFile(file, 'utf8')
}
const ime = (method, params) =>
  application.evaluate(
    async ({ BrowserWindow }, command) => {
      const debug = BrowserWindow.getAllWindows()[0].webContents.debugger
      if (!debug.isAttached()) debug.attach('1.3')
      await debug.sendCommand(command.method, command.params)
    },
    { method, params },
  )
const paste = (text, html) =>
  page.evaluate(
    ({ text, html }) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      if (html) data.setData('text/html', html)
      document.activeElement.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { text, html },
  )
async function trace(id, source, mode, action, expected) {
  if (cases.size && !cases.has(id)) return
  await seed(source, mode)
  await page.evaluate((id) => window.__inputAudit.begin(id), id)
  await action()
  await page.evaluate(() => window.__inputAudit.checkpoint('action-returned'))
  await pause(250)
  await page.evaluate(() => window.__inputAudit.checkpoint('after-250ms'))
  await pause(1000)
  const record = await page.evaluate(() => window.__inputAudit.finish())
  record.sourceBefore = source
  record.sourceAfter = await savedSource()
  record.expected = expected ?? null
  record.matched = expected === undefined ? null : expected === record.sourceAfter
  result.traces.push(record)
  process.stdout.write(`${id}: ${record.matched === false ? 'MISMATCH' : 'recorded'}\n`)
}
const quantiles = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const q = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null
  return { count: sorted.length, median: q(0.5), p95: q(0.95), max: q(1) }
}
try {
  await editor.waitFor()
  result.environment.browser = await page.evaluate(() => navigator.userAgent)
  await page.evaluate(installInputAudit)
  await trace('ascii', 'alpha ', 'Source', () => page.keyboard.type('x'), 'alpha x')
  await trace(
    'unicode-insert',
    'alpha ',
    'Source',
    () => page.keyboard.insertText('e\u0301👩🏽‍💻'),
    'alpha e\u0301👩🏽‍💻',
  )
  await trace('enter', 'alpha', 'Source', () => page.keyboard.press('Enter'), 'alpha\n')
  await trace(
    'shift-enter',
    '    alpha',
    'Source',
    () => page.keyboard.press('Shift+Enter'),
    '    alpha\n    ',
  )
  await trace('backspace', 'alpha', 'Source', () => page.keyboard.press('Backspace'), 'alph')
  await trace('unpaired-bracket', 'alpha ', 'Source', () => page.keyboard.type('('), 'alpha (')
  await trace(
    'paste-plain-over-html',
    'alpha ',
    'Live Preview',
    () => paste('raw **bold**\r\nnext', '<b>different</b>'),
    'alpha raw **bold**\nnext',
  )
  await trace(
    'synthetic-beforeinput',
    'alpha',
    'Source',
    () =>
      page.evaluate(() => {
        document.activeElement.dispatchEvent(
          new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: 'NEVER_INSERTED',
            bubbles: true,
            cancelable: true,
          }),
        )
      }),
    'alpha',
  )
  await trace(
    'native-ime',
    'alpha ',
    'Live Preview',
    async () => {
      await ime('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 })
      await page.evaluate(() => window.__inputAudit.checkpoint('preedit-latin'))
      await ime('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
      await page.evaluate(() => window.__inputAudit.checkpoint('preedit-candidate'))
      await ime('Input.insertText', { text: '世界' })
    },
    'alpha 世界',
  )
  await trace(
    'inline-emphasis-completion',
    'before **bold*',
    'Live Preview',
    () => page.keyboard.type('*'),
    'before **bold**',
  )
  await trace(
    'smart-punctuation-unactivated',
    'Quoted "word',
    'Live Preview',
    () => page.keyboard.type('"'),
    'Quoted "word',
  )
  await trace('fence-enter', '```js', 'Live Preview', () => page.keyboard.press('Enter'), '```js\n')
  await trace(
    'math-delimiter-completion',
    'Equation $x',
    'Live Preview',
    () => page.keyboard.type('$'),
    'Equation $x$',
  )
  const table = '| A | B |\n| --- | --- |\n| one | two |\n\nafter'
  const openCell = async () => {
    await page.locator('.cm-live-table td').first().click()
    const cell = page.locator('[data-table-cell-editor]')
    await cell.waitFor()
    await page.keyboard.press('Control+a')
    return cell
  }
  await trace(
    'table-pipe-newline',
    table,
    'Live Preview',
    async () => {
      await openCell()
      await page.keyboard.insertText('a|b\nc')
    },
    table.replace('one', 'a\\|b c'),
  )
  await trace(
    'table-enter',
    table,
    'Live Preview',
    async () => {
      await openCell()
      await page.keyboard.press('Enter')
    },
    table,
  )
  await trace(
    'table-pipe-boundary',
    table,
    'Live Preview',
    async () => {
      await openCell()
      await page.keyboard.insertText('|'.repeat(4096))
      await page.evaluate(() => window.__inputAudit.checkpoint('4096-pipes-accepted'))
      await page.keyboard.type('x')
    },
    table.replace('one', '\\|'.repeat(4096)),
  )
  await trace(
    'task-checkbox',
    '- [ ] task\n\nafter',
    'Live Preview',
    async () => {
      await page.locator('.cm-content input[type=checkbox]').first().click()
    },
    '- [x] task\n\nafter',
  )
  await trace(
    'reference-destination-linked',
    '[shown][id]\n\n[id]: https://example.com/base',
    'Live Preview',
    () => page.keyboard.type('/new'),
    '[shown][id]\n\n[id]: https://example.com/base/new',
  )
  await trace(
    'footnote-definition-unactivated',
    'Call[^n].\n\n[^n]: original',
    'Live Preview',
    () => page.keyboard.type(' changed'),
    'Call[^n].\n changed\n[^n]: original',
  )
  await trace(
    'html-unactivated',
    '<div>text',
    'Live Preview',
    () => page.keyboard.type('</div>'),
    '<div>text',
  )
  await trace(
    'undo-redo',
    'alpha ',
    'Source',
    async () => {
      await page.keyboard.type('xyz')
      await pause(600)
      await page.keyboard.press('Control+z')
      await page.evaluate(() => window.__inputAudit.checkpoint('undone'))
      await page.keyboard.press('Control+y')
    },
    'alpha xyz',
  )
  const paragraph = 'Plain paragraph with **strong**, a [link](https://example.com), and words.\n\n'
  const extension =
    '# Section\n\nQuoted "words" -- ellipsis...\n\n$x^2$\n\n| A | B |\n| --- | --- |\n| x | y |\n\nCall[^n].\n\n[^n]: note\n\n'
  for (const [name, source] of cases.size
    ? []
    : [
        ['small-prose', paragraph.repeat(20)],
        ['medium-prose', paragraph.repeat(1500)],
        ['extension-projections', extension.repeat(30)],
      ]) {
    for (const mode of ['Source', 'Live Preview']) {
      await seed(`${source}\nInput: `, mode)
      // Warm the active view, then let the semantic queue settle before collecting.
      await page.keyboard.type('warmup')
      await pause(1500)
      await page.evaluate((id) => window.__inputAudit.begin(id), `${name}:${mode}`)
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyz'.repeat(3), { delay: 25 })
      await pause(1600)
      const record = await page.evaluate(() => window.__inputAudit.finish())
      const changed = record.measures.filter(
        (m) => m.name === 'manuslip:editor-update' && m.detail?.changed,
      )
      const semantic = record.measures.filter((m) => m.name === 'manuslip:semantic-apply')
      result.performance.push({
        name,
        mode,
        sourceUtf16: source.length,
        sourceUtf8: Buffer.byteLength(source),
        samples: 78,
        delayMs: 25,
        keyEventPropagationMs: quantiles(
          record.events
            .filter((e) => e.type === 'keydown' && e.key?.length === 1)
            .map((e) => e.bubbleMs),
        ),
        actualMode: record.before.mode,
        firstFrameMs: quantiles(record.events.map((e) => e.firstFrameMs)),
        secondFrameMs: quantiles(record.events.map((e) => e.secondFrameMs)),
        editorCallbackMs: quantiles(changed.map((m) => m.duration)),
        semanticApplyMs: quantiles(semantic.map((m) => m.duration)),
        semanticFreshnessMs: quantiles(semantic.map((m) => m.detail?.freshnessMs)),
        semantic: semantic.map((m) => ({ time: m.start, duration: m.duration, detail: m.detail })),
        longtasks: record.longtasks,
        measureCounts: Object.fromEntries(
          [...new Set(record.measures.map((m) => m.name))].map((key) => [
            key,
            record.measures.filter((m) => m.name === key).length,
          ]),
        ),
        sourceSuffixMatched: (await savedSource()).endsWith(
          `Input: warmup${'abcdefghijklmnopqrstuvwxyz'.repeat(3)}`,
        ),
      })
      process.stdout.write(`performance ${name} ${mode}: recorded\n`)
    }
  }
  await trace(
    'smart-punctuation-activated',
    'Quoted "word',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-block').filter({ hasText: 'Quoted' }).first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('"')
    },
    'Quoted "word"',
  )
  await trace(
    'footnote-definition-activated',
    'Call[^n].\n\n[^n]: original',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-block').filter({ hasText: 'original' }).first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type(' changed')
    },
    'Call[^n].\n\n[^n]: original changed',
  )
  await trace(
    'html-activated',
    '<div>text',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-block').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('</div>')
    },
    '<div>text</div>div>',
  )
  await trace(
    'html-activated-slow',
    '<div>text',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-block').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('</div>', { delay: 80 })
    },
    '<div>text</div>div>',
  )
  await trace(
    'html-activated-chunk',
    '<div>text',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-block').first().click()
      await page.keyboard.press('Control+End')
      await page.keyboard.insertText('</div>')
    },
    '<div>text</div>',
  )
  await trace(
    'html-source',
    '<div>text',
    'Source',
    () => page.keyboard.type('</div>'),
    '<div>text</div>div>',
  )
  await trace('html-opening-tag', '', 'Source', () => page.keyboard.type('<div>'), '<div></div>')
  await trace(
    'display-math-activated',
    '$$\nx+y\n$$\n\nafter',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-math:not(.cm-live-edit-preview) [role=math]').focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Home')
      await page.keyboard.type('Q')
    },
    '$$\nQx+y\n$$\n\nafter',
  )
  await trace(
    'diagram-activated',
    '```mermaid\nflowchart LR\nA[One] --> B[Two]\n```\n\nafter',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-diagram:not(.cm-live-edit-preview)').focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Home')
      await page.keyboard.insertText('%% note\n')
    },
    '```mermaid\n%% note\nflowchart LR\nA[One] --> B[Two]\n```\n\nafter',
  )
  await trace(
    'code-activated',
    '```js\nconst one = 1\n```\n\nafter',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-code:not(.cm-live-edit-preview)').focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Home')
      await page.keyboard.insertText('// note\n')
    },
    '```js\n// note\nconst one = 1\n```\n\nafter',
  )
  const preferences = async () => {
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  }
  await preferences()
  await page.getByRole('checkbox', { name: 'Typora', exact: true }).check()
  await page.getByRole('checkbox', { name: 'GitHub', exact: true }).check()
  await page.getByLabel('Render sanitized HTML', { exact: true }).check()
  await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
  const toc = '[TOC]\n\n# First\n\n# Last'
  await trace(
    'heading-toc-linked',
    toc,
    'Live Preview',
    () => page.keyboard.type(' changed'),
    `${toc} changed`,
  )
  await trace(
    'yaml-metadata-input',
    '---\ntitle: Book\n---\n\nafter',
    'Live Preview',
    async () => {
      await page.keyboard.press('Control+Home')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('End')
      await page.keyboard.type(' changed')
    },
    '---\ntitle: Book changed\n---\n\nafter',
  )
  await trace(
    'sanitized-html-activated',
    '<div>text</div>\n\nafter',
    'Live Preview',
    async () => {
      await page.locator('.cm-live-html:not(.cm-live-edit-preview)').click()
      await page.keyboard.press('Home')
      await page.keyboard.type('Q')
    },
    'Q<div>text</div>\n\nafter',
  )
  await trace(
    'hidden-outline-source',
    '# Heading\n\nplain ',
    'Source',
    async () => {
      const outline = page.locator('#workspace-outline')
      if (!(await outline.evaluate((element) => element.hidden)))
        await page.locator('.sidebar-toggle').click()
      await editor.focus()
      await page.keyboard.press('Control+End')
      await page.keyboard.type('changed')
    },
    '# Heading\n\nplain changed',
  )
  await trace(
    'grammar-change-without-input',
    'Equation $x$\n\nafter',
    'Live Preview',
    async () => {
      await preferences()
      await page.getByRole('checkbox', { name: 'LaTeX', exact: true }).uncheck()
      await page.getByRole('button', { name: 'Close preferences', exact: true }).click()
    },
    'Equation $x$\n\nafter',
  )
} finally {
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    .catch(() => {})
  await application.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
if (result.traces.some((trace) => trace.matched === false) || result.errors.length)
  process.exitCode = 1
