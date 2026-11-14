import { spawnSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { verifyPackage } from '../../scripts/verify-package.mjs'
import { automationPackage } from '../helpers/automation-package.mjs'
import { packagedExecutable } from '../helpers/packaged-executable.mjs'
import { smokePackage } from './hardened-smoke.mjs'

const source = packagedExecutable()
await verifyPackage(
  process.env.MANUSLIP_PACKAGE_DIRECTORY ||
    fileURLToPath(new URL('../../apps/desktop/release', import.meta.url)),
)
await smokePackage(source)
const automation = await automationPackage(source)
try {
  const executable = automation.executable
  const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '--config', 'test/e2e/playwright.packaged.config.ts', ...process.argv.slice(2)],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: 'inherit',
      env: { ...process.env, MANUSLIP_PACKAGED_EXECUTABLE: executable },
      shell: false,
    },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(automation.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
