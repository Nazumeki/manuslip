import { defineConfig } from '@playwright/test'
import common, { fixtureSpecs } from './playwright.config'

export default defineConfig({
  ...common,
  testMatch: fixtureSpecs,
})
