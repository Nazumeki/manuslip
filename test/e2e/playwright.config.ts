import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

export const fixtureSpecs = ['**/indexed-reading.spec.ts', '**/widget-lifetime.spec.ts']

export default defineConfig({
  testDir: '.',
  grepInvert: /@pandoc/,
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  globalSetup: './setup.mjs',
  outputDir: fileURLToPath(new URL('./result', import.meta.url)),
  use: { trace: 'retain-on-failure' },
})
