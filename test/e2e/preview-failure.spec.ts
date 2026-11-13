import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './helpers'

test('repeated worker failure falls back to Source without losing editing or undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-worker-failure-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    let workers = 0
    page.on('worker', (worker) => {
      if (!worker.url().includes('semantic.worker')) return
      workers++
      if (workers > 4) return
      void worker
        .evaluate(() => {
          setTimeout(() => {
            throw new Error('Injected worker failure')
          }, 100)
        })
        .catch(() => {})
    })
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source' })
    await editor.fill('# Keep this draft\n\nMy writing survives a preview failure.')
    await expect(
      page.getByText('The preview worker stopped. Continue in Source mode or retry.', {
        exact: true,
      }),
    ).toBeVisible()
    expect(workers).toBe(4)
    const failures = await page.evaluate(() =>
      performance
        .getEntriesByName('manuslip:semantic-failure')
        .map((entry) => (entry as PerformanceMeasure).detail),
    )
    expect(failures).toHaveLength(4)
    expect(failures.every((failure) => failure.reason === 'worker-error')).toBe(true)
    expect(JSON.stringify(failures)).not.toContain('Injected worker failure')
    expect(JSON.stringify(failures)).not.toContain('My writing survives')
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(editor).toContainText('My writing survives')
    await editor.focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
    await page.keyboard.type(' More.')
    await expect(editor).toContainText('More.')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(editor).not.toContainText('More.')
    await page.getByRole('button', { name: 'Retry preview', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Live Preview', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Retry preview', exact: true })).toHaveCount(0)
    expect(workers).toBe(5)
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

test('unavailable diagnostic measurements preserve healthy preview work and latest edits', async () => {
  await mkdir('test/e2e/result', { recursive: true })
  const directory = await mkdtemp(resolve('test/e2e/result/worker-metric-failure-'))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    let workers = 0
    page.on('worker', (worker) => {
      if (worker.url().includes('semantic.worker')) workers++
    })
    await page.evaluate(() => {
      const measure = performance.measure.bind(performance)
      Reflect.set(window, '__manuslipDiagnosticThrows', 0)
      performance.measure = (name, ...args) => {
        if (name.startsWith('manuslip:')) {
          Reflect.set(
            window,
            '__manuslipDiagnosticThrows',
            Reflect.get(window, '__manuslipDiagnosticThrows') + 1,
          )
          throw new Error('Injected unavailable diagnostic timing API')
        }
        return measure(name, ...args)
      }
    })
    await page.getByRole('button', { name: 'New document', exact: true }).first().click()
    const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    await editor.fill('# Healthy\n\n**Preview remains available.**')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home')
    await expect(page.locator('.cm-live-strong')).toHaveText('Preview remains available.')
    await expect(page.getByText('4 words', { exact: true })).toBeVisible()
    const source = page.getByRole('button', { name: 'Source', exact: true })
    await source.click()
    await expect(source).toHaveAttribute('aria-pressed', 'true')
    await editor.fill('# Changed\n\n**Latest revision renders.**')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home')
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Live Preview', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('.cm-live-strong')).toHaveText('Latest revision renders.')
    await expect(page.getByText('4 words', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry preview', exact: true })).toHaveCount(0)
    await expect(page.getByText('Updating preview…', { exact: true })).toHaveCount(0)
    expect(workers).toBe(1)
    expect(
      await page.evaluate(() => Reflect.get(window, '__manuslipDiagnosticThrows')),
    ).toBeGreaterThan(0)
  } finally {
    await application
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await application.close()
  }
})

test('documents beyond the Live Preview cap stay editable in Source mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manuslip-preview-limit-'))
  const path = join(directory, 'large.md')
  await writeFile(path, 'a'.repeat(2 * 1024 * 1024 + 1))
  const application = await launchDesktop(join(directory, 'profile'))
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
    await page.getByRole('button', { name: 'Open file…', exact: true }).first().click()
    await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable()
    await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      page.workers().filter((worker) => worker.url().includes('semantic.worker')),
    ).toHaveLength(0)
    await page.getByRole('button', { name: 'Live Preview', exact: true }).click()
    await expect(
      page.getByText('Preview exceeds its resource limit. Continue editing in Source mode.', {
        exact: true,
      }),
    ).toBeVisible()
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
