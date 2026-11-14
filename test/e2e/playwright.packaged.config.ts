import { defineConfig } from '@playwright/test'
import common, { fixtureSpecs } from './playwright.config'

if (!process.env.MANUSLIP_PACKAGED_EXECUTABLE)
  throw new Error('Packaged tests require the built application. Run npm run test:packaged.')

export default defineConfig({
  ...common,
  testIgnore: fixtureSpecs,
})
