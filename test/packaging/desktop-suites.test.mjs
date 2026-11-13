import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../..', import.meta.url))
const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url))
const packagedConfig = 'test/e2e/playwright.packaged.config.ts'
const options = {
  cwd: root,
  env: { ...process.env, MANUSLIP_PACKAGED_EXECUTABLE: process.execPath },
  maxBuffer: 4 * 1024 * 1024,
}

async function discover(config) {
  const { stdout } = await execute(
    process.execPath,
    [cli, 'test', '--config', config, '--list', '--reporter=json'],
    options,
  )
  const report = JSON.parse(stdout)
  assert.deepEqual(report.errors, [])
  const cases = new Set()
  const collect = (suite) => {
    for (const spec of suite.specs ?? [])
      cases.add([spec.file, spec.line, spec.column, spec.title].join(':'))
    for (const child of suite.suites ?? []) collect(child)
  }
  for (const suite of report.suites) collect(suite)
  return cases
}

test('packaged application and source fixture discovery partition every common desktop case', async () => {
  const common = await discover('test/e2e/playwright.config.ts')
  const packaged = await discover(packagedConfig)
  const fixtures = await discover('test/e2e/playwright.fixtures.config.ts')
  assert.ok(packaged.size > 0 && fixtures.size > 0)
  assert.equal(packaged.intersection(fixtures).size, 0)
  assert.deepEqual(packaged.union(fixtures), common)
})

test('packaged discovery refuses a missing built executable instead of falling back to source', async () => {
  const env = { ...process.env }
  delete env.MANUSLIP_PACKAGED_EXECUTABLE
  await assert.rejects(
    execute(process.execPath, [cli, 'test', '--config', packagedConfig, '--list'], {
      cwd: root,
      env,
    }),
    (error) => {
      assert.match(error.stderr, /Packaged tests require the built application/)
      return true
    },
  )
})
