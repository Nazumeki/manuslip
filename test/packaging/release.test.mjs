import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { createReleasePlan, validateSigningEnvironment } from '../../scripts/package-release.mjs'

const require = createRequire(import.meta.url)
const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
const metadata = JSON.parse(
  await readFile(new URL('../../apps/desktop/package.json', import.meta.url)),
)
const execute = promisify(execFile)

test('installer snapshots recover from deleted registry handles and retain other failures', {
  skip: process.platform !== 'win32',
}, async () => {
  await execute('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve('test/packaging/helpers/windows-installer-state.test.ps1'),
  ])
})

test('ordinary and release plans stay unsigned and without a feed unless explicitly requested', async () => {
  assert.equal(metadata.build.publish, null)
  assert.equal(metadata.build.win.signExecutable, false)
  assert.equal(metadata.build.mac.identity, null)
  assert.equal(metadata.build.electronFuses.runAsNode, false)
  assert.equal(metadata.build.electronFuses.enableNodeOptionsEnvironmentVariable, false)
  assert.equal(metadata.build.electronFuses.enableNodeCliInspectArguments, false)
  assert.equal(metadata.build.electronFuses.enableEmbeddedAsarIntegrityValidation, true)
  assert.equal(metadata.build.electronFuses.onlyLoadAppFromAsar, true)
  assert.equal(metadata.build.electronFuses.grantFileProtocolExtraPrivileges, false)
  const before = structuredClone(metadata.build)
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
  ]) {
    const plan = createReleasePlan(metadata.build, {
      platform,
      arch,
      env: { GH_TOKEN: 'not-a-real-token', MANUSLIP_UPDATE_URL: 'https://example.invalid/' },
    })
    assert.equal(plan.publish, 'never')
    assert.equal(plan.config.publish, null)
    assert.equal(plan.config.forceCodeSigning, false)
    assert.equal(plan.config.win.signExecutable, false)
    assert.equal(plan.config.mac.identity, null)
    assert.equal(plan.config.mac.notarize, false)
    assert.equal(plan.config.nsis.differentialPackage, false)
    assert.equal(plan.config.dmg.writeUpdateInfo, false)
    assert.equal(plan.updatesRuntimeIncluded, false)
    await validateConfiguration(plan.config, { debugLogger: null })
  }
  assert.deepEqual(metadata.build, before)
})

test('signed profiles enable required signing and macOS notarization without embedding secrets', async () => {
  const secrets = {
    CSC_LINK: 'private-certificate-placeholder',
    CSC_KEY_PASSWORD: 'private-password-placeholder',
  }
  for (const platform of ['win32', 'darwin']) {
    const plan = createReleasePlan(metadata.build, {
      platform,
      arch: 'x64',
      signed: true,
      env: secrets,
    })
    assert.equal(plan.config.forceCodeSigning, true)
    assert.equal(plan.config.win.signExecutable, true)
    if (platform === 'darwin') {
      assert.equal(Object.hasOwn(plan.config.mac, 'identity'), false)
      assert.equal(plan.config.mac.notarize, true)
      assert.equal(plan.config.mac.hardenedRuntime, true)
      assert.equal(plan.config.dmg.sign, true)
      assert.equal(plan.config.dmg.writeUpdateInfo, false)
    }
    for (const secret of Object.values(secrets))
      assert.equal(JSON.stringify(plan).includes(secret), false)
    assert.throws(() => validateSigningEnvironment(plan, {}), /requires/)
    validateSigningEnvironment(plan, {
      ...secrets,
      APPLE_ID: 'placeholder',
      APPLE_APP_SPECIFIC_PASSWORD: 'placeholder',
      APPLE_TEAM_ID: 'placeholder',
    })
    if (platform === 'darwin') {
      assert.throws(
        () => validateSigningEnvironment(plan, { ...secrets, APPLE_ID: 'incomplete' }),
        /requires/,
      )
      validateSigningEnvironment(plan, {
        ...secrets,
        APPLE_API_KEY: 'placeholder',
        APPLE_API_KEY_ID: 'placeholder',
        APPLE_API_ISSUER: 'placeholder',
      })
      validateSigningEnvironment(plan, {
        ...secrets,
        APPLE_KEYCHAIN: 'placeholder',
        APPLE_KEYCHAIN_PROFILE: 'placeholder',
      })
    }
    await validateConfiguration(plan.config, { debugLogger: null })
  }
  assert.throws(
    () => createReleasePlan(metadata.build, { platform: 'linux', arch: 'x64', signed: true }),
    /--signed/,
  )
})

test('update metadata uses an explicit HTTPS channel and includes the macOS updater archive', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = createReleasePlan(metadata.build, {
      platform,
      arch: 'x64',
      updates: true,
      env: {
        MANUSLIP_UPDATE_URL: 'https://updates.example.invalid/manuslip',
        MANUSLIP_UPDATE_CHANNEL: 'beta',
      },
    })
    assert.deepEqual(plan.config.publish, {
      provider: 'generic',
      url: 'https://updates.example.invalid/manuslip/',
      channel: 'beta',
      publishAutoUpdate: true,
    })
    assert.equal(plan.publish, 'never')
    assert.equal(plan.config.generateUpdatesFilesForAllChannels, false)
    assert.equal(plan.config.detectUpdateChannel, false)
    assert.equal(plan.config.nsis.differentialPackage, true)
    assert.equal(plan.config.dmg.writeUpdateInfo, true)
    if (platform === 'darwin') assert.deepEqual(plan.config.mac.target, ['dmg', 'zip'])
    await validateConfiguration(plan.config, { debugLogger: null })
  }
  for (const url of [
    undefined,
    'http://example.invalid/',
    'https://user:secret@example.invalid/',
    'https://example.invalid/?secret=1',
    'https://example.invalid/#secret',
    ' https://example.invalid/',
    'https://example.invalid/\n',
  ])
    assert.throws(
      () =>
        createReleasePlan(metadata.build, {
          platform: 'win32',
          arch: 'x64',
          updates: true,
          env: { MANUSLIP_UPDATE_URL: url },
        }),
      /HTTPS directory/,
    )
  assert.throws(
    () =>
      createReleasePlan(metadata.build, {
        platform: 'win32',
        arch: 'x64',
        updates: true,
        env: {
          MANUSLIP_UPDATE_URL: 'https://example.invalid/',
          MANUSLIP_UPDATE_CHANNEL: '../latest',
        },
      }),
    /channel must be/i,
  )
})

test('CLI plan makes no package and cannot accept publishing or cross-host arguments', async () => {
  const script = resolve('scripts/package-release.mjs')
  const signed = process.platform !== 'linux'
  const { stdout } = await execute(
    process.execPath,
    [script, ...(signed ? ['--signed'] : []), '--plan'],
    {
      env: {
        ...process.env,
        CSC_LINK: 'certificate-placeholder',
        CSC_KEY_PASSWORD: 'password-placeholder',
      },
    },
  )
  const plan = JSON.parse(stdout)
  assert.equal(plan.signed, signed)
  assert.equal(plan.publish, 'never')
  assert.match(plan.config.directories.output, /<new directory/)
  assert.equal(stdout.includes('certificate-placeholder'), false)
  assert.equal(stdout.includes('password-placeholder'), false)
  for (const args of [['--publish', 'always'], ['--win'], ['--plan', '--plan']])
    await assert.rejects(execute(process.execPath, [script, ...args]), /Usage:/)
})
