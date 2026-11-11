import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchDesktop } from '../e2e/helpers'
import {
  closeFile,
  fixture,
  MiB,
  machine,
  measures,
  modifier,
  openFile,
  report,
  settled,
  stop,
  summary,
  waitForStartup,
} from './helpers'
import { instrumentInput } from './input'

const fill = (chunk: string) => chunk.repeat(Math.ceil(MiB / Buffer.byteLength(chunk)))
const cases = [
  {
    name: 'prose',
    budget: { freshnessMs: 500, applySliceMs: 4 },
    source: fill(
      `${'Writing leaves room for another idea. A short sentence makes the next edit easy. '.repeat(
        8,
      )}\n\n`,
    ),
  },
  {
    name: 'single-paragraph',
    budget: { freshnessMs: 500, applySliceMs: 4 },
    source: fill(
      'A long paragraph still needs responsive editing, accurate counts and current semantics. ',
    ),
  },
  {
    name: 'mixed-rtl',
    budget: { freshnessMs: 500, applySliceMs: 4 },
    source: fill(
      'English writing. 中文段落。日本語の文章。 العربية نص للقراءة. עברית לקריאה. '.repeat(8) +
        '\n\n',
    ),
  },
  {
    name: 'repeated-paragraphs',
    budget: { freshnessMs: 750, applySliceMs: 4 },
    source: fill('The same short paragraph appears again. Its occurrence must stay distinct.\n\n'),
  },
  {
    name: 'many-small-blocks',
    budget: { freshnessMs: 750, applySliceMs: 4 },
    source: fill('A small paragraph. One more short sentence for the next block.\n\n'),
  },
  {
    name: 'nested-containers',
    budget: { freshnessMs: 2500, applySliceMs: 16 },
    source: `${fill(
      `${'> > > > > > > > Nested writing with **emphasis**, `code`, a [link][r] and enough prose to keep reading. '.repeat(
        3,
      )}\n\nSeparate context.\n\n`,
    )}\n[r]: https://example.invalid/\n`,
  },
]
const selectedCase = process.env.MANUSLIP_BENCH_CASE
if (selectedCase && !cases.some((entry) => entry.name === selectedCase))
  throw new Error(`Unknown corpus case: ${selectedCase}`)
test('1 MiB corpus input, callbacks, freshness and mode changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-corpus-'))
  const application = await launchDesktop(join(directory, 'profile'))
  const results = []
  try {
    const page = await application.firstWindow()
    await waitForStartup(page)
    await instrumentInput(page)
    for (const entry of cases.filter((entry) => !selectedCase || entry.name === selectedCase)) {
      const source = `# ${entry.name}\n\n${entry.source}`
      const path = await fixture(directory, entry.name, source)
      const openMs = await openFile(application, page, path)
      const initial = await settled(page)
      let fallback = initial === 'fallback' ? 1 : 0
      let appended = ''
      const cold = (await measures(page))
        .filter((metric) => metric.name === 'manuslip:semantic-apply')
        .at(-1)
      if (!fallback) {
        await page.getByRole('textbox', { name: 'Markdown source' }).focus()
        await page.keyboard.press(`${modifier}+End`)
        for (let index = 0; index < 20; index++) {
          const previous =
            (await measures(page))
              .filter((metric) => metric.name === 'manuslip:semantic-apply')
              .at(-1)?.startTime ?? 0
          const character = String.fromCharCode(97 + index)
          await page.keyboard.type(character)
          appended += character
          if ((await settled(page, previous)) === 'fallback') {
            fallback++
            break
          }
        }
        for (let index = 0; index < 10; index++) {
          await page.keyboard.press('ArrowLeft')
          await page.keyboard.press('ArrowRight')
        }
        const position = await page.locator('.editor-status > span').first().textContent()
        if (!position) throw new Error('Cursor status is missing')
        for (let index = 0; index < 10; index++) {
          await page.keyboard.press(`${modifier}+1`)
          await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
          )
          await expect
            .poll(() =>
              page.evaluate(
                () => performance.getEntriesByName('manuslip:benchmark-mode-paint').length,
              ),
            )
            .toBe(index * 2 + 1)
          await page.keyboard.press(`${modifier}+2`)
          await expect(
            page.getByRole('button', { name: 'Live Preview', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true')
          await expect
            .poll(() =>
              page.evaluate(
                () => performance.getEntriesByName('manuslip:benchmark-mode-paint').length,
              ),
            )
            .toBe(index * 2 + 2)
        }
        await expect(page.locator('.editor-status > span').first()).toHaveText(position)
        await page.keyboard.press(`${modifier}+s`)
        await expect(page.getByText('All changes saved', { exact: true })).toBeVisible()
        expect(await readFile(path, 'utf8')).toBe(`${source}${appended}`)
      }
      const metrics = await measures(page)
      // Retain raw evidence even if strict aggregation rejects a timing sample.
      await report(test.info(), `${entry.name}-metrics`, { metrics })
      const phase = (name: string) =>
        metrics
          .filter((metric) => metric.name === `manuslip:${name}`)
          .map((metric) => metric.duration)
      const warmed = metrics.filter((metric) => metric.name === 'manuslip:semantic-apply').slice(1)
      const result = {
        name: entry.name,
        budget: entry.budget,
        bytes: Buffer.byteLength(source),
        sha256: createHash('sha256').update(source).digest('hex'),
        openMs,
        initial,
        fallback,
        cold,
        inputPaint: summary(phase('benchmark-input-paint')),
        modePaint: summary(phase('benchmark-mode-paint')),
        editorUpdate: summary(phase('editor-update')),
        selectionUpdate: summary(
          metrics
            .filter(
              (metric) =>
                metric.name === 'manuslip:editor-update' &&
                metric.detail?.selection &&
                !metric.detail.changed,
            )
            .map((metric) => metric.duration),
        ),
        request: summary(phase('semantic-request')),
        validate: summary(phase('semantic-validate')),
        apply: summary(phase('semantic-apply')),
        applySlice: summary(
          metrics
            .filter((metric) => metric.name === 'manuslip:semantic-apply')
            .map((metric) => Number(metric.detail?.maxSliceMs)),
        ),
        applyActive: summary(
          metrics
            .filter((metric) => metric.name === 'manuslip:semantic-apply')
            .map((metric) => Number(metric.detail?.activeMs)),
        ),
        freshness: summary(warmed.map((metric) => Number(metric.detail?.freshnessMs))),
        worker: Object.fromEntries(
          [
            'parseMs',
            'describeMs',
            'renderMs',
            'serializeMs',
            'transportInMs',
            'transportOutMs',
          ].map((phase) => [
            phase,
            summary(warmed.map((metric) => Number(metric.detail?.[phase]))),
          ]),
        ),
        metrics,
      }
      results.push(result)
      console.log(
        `${entry.name}:`,
        JSON.stringify({ ...result, metrics: undefined, cold: undefined }),
      )
      await closeFile(page, path)
    }
    await report(test.info(), 'corpus', {
      machine: await machine(application),
      method:
        'Each file opens cold in this process, then 20 settled edits, 20 selection moves and 20 Source/Live transitions. Browser keydown to the second animation frame estimates the next painted frame; compositor presentation is not measured. The worker/cache is cold only for the first file. Freshness budgets account for complete native parsing and snapshot size: 500 ms for prose, 750 ms for dense block lists, 2500 ms for nested containers. Nested application allows one 16 ms frame; other slices stay within 4 ms. No fallback counts as a passed Live Preview latency gate.',
      results,
    })
    for (const result of results) {
      expect.soft(result.fallback, `${result.name} fallback`).toBe(0)
      expect.soft(result.openMs, `${result.name} editable open`).toBeLessThan(1000)
      expect
        .soft(result.freshness.n, `${result.name} freshness sample count`)
        .toBeGreaterThanOrEqual(20)
      expect.soft(result.modePaint.n, `${result.name} mode sample count`).toBeGreaterThanOrEqual(20)
      expect
        .soft(result.inputPaint.n, `${result.name} input sample count`)
        .toBeGreaterThanOrEqual(20)
      expect
        .soft(result.inputPaint.p95 ?? Infinity, `${result.name} input-to-frame p95`)
        .toBeLessThan(50)
      expect
        .soft(result.editorUpdate.p95 ?? Infinity, `${result.name} callback p95`)
        .toBeLessThan(8)
      expect.soft(result.request.p95 ?? Infinity, `${result.name} request p95`).toBeLessThan(25)
      expect
        .soft(result.applySlice.max ?? Infinity, `${result.name} apply max slice`)
        .toBeLessThanOrEqual(result.budget.applySliceMs)
      expect.soft(result.apply.max ?? Infinity, `${result.name} apply total`).toBeLessThan(150)
      expect
        .soft(result.freshness.p95 ?? Infinity, `${result.name} freshness p95`)
        .toBeLessThan(result.budget.freshnessMs)
      expect
        .soft(result.modePaint.p95 ?? Infinity, `${result.name} mode transition p95`)
        .toBeLessThan(100)
    }
  } finally {
    await stop(application)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
