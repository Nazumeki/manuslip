import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { UUID } from 'builder-util-runtime'
import { verifyWindowsApplicationIcon } from './helpers/application-icons.mjs'
import { verifyInstalledDesktop } from './helpers/verify-installed-desktop.mjs'

assert.equal(process.platform, 'win32', 'Installer execution requires Windows')
const root = resolve('.')
const logs = resolve('test/packaging/result')
const directory = join(logs, `windows-installer-${randomUUID()}`)
const installed = join(directory, 'installed app')
const metadata = JSON.parse(await readFile('apps/desktop/package.json', 'utf8'))
const guid =
  metadata.build.nsis.guid ||
  UUID.v5(metadata.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
const selectedInstaller = process.env.MANUSLIP_INSTALLER_PATH
const selectedUnpacked = process.env.MANUSLIP_INSTALLER_UNPACKED
assert.equal(
  Boolean(selectedInstaller),
  Boolean(selectedUnpacked),
  'Select both installer and unpacked application',
)
const installer = resolve(
  selectedInstaller || `apps/desktop/release/Manuslip Setup ${metadata.version}.exe`,
)
const unpacked = resolve(selectedUnpacked || 'apps/desktop/release/win-unpacked')
assert.ok(installed.startsWith(`${logs}${sep}`))
await mkdir(directory, { recursive: true })
assert.ok((await realpath(directory)).startsWith(`${await realpath(logs)}${sep}`))
const report = {
  date: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch() },
  directory,
  installed,
  unpacked,
  guid,
  phases: [],
}

async function run(executable, args, verbatim = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${executable}: exit ${code}, signal ${signal}: ${stderr}`))
      else resolveRun({ code, stdout, stderr })
    })
  })
}
async function state() {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolve('test/packaging/helpers/windows-installer-state.ps1'),
    '-AppGuid',
    guid,
  ])
  return JSON.parse(result.stdout.replace(/^\ufeff/, ''))
}
async function hash(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
async function files(path, prefix = '') {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `Unexpected linked installed file: ${entry.name}`)
    const name = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await files(join(path, entry.name), name)))
    else
      result.push({
        name,
        bytes: (await stat(join(path, entry.name))).size,
        sha256: await hash(join(path, entry.name)),
      })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

let before, uninstaller, failure
try {
  before = await state()
  report.before = before
  assert.equal(
    Object.keys(before.owned).length,
    0,
    'Existing Manuslip registration; use a clean Windows account',
  )
  assert.equal(
    before.registrations.length,
    0,
    'Existing Manuslip installation; use a clean Windows account',
  )
  assert.equal(before.processes.length, 0, 'Close Manuslip before running installer verification')
  assert.ok(
    Object.values(before.advertisements).every((advertised) => !advertised),
    'Existing Manuslip association advertisement; use a clean Windows account',
  )
  assert.ok(
    Object.values(before.shortcuts).every((shortcut) => !shortcut.exists),
    'Existing Manuslip shortcut; use a clean Windows account',
  )
  report.installer = {
    path: installer,
    bytes: (await stat(installer)).size,
    sha256: await hash(installer),
  }
  const expected = await files(unpacked)
  // NSIS requires /D last and unquoted, including spaces. No shell interprets this line.
  await run(installer, ['/S', '/currentuser', `/D=${installed}`], true)
  report.phases.push('installed')
  const afterInstall = await state()
  report.afterInstall = afterInstall
  const registration = afterInstall.registrations.find(
    (entry) => entry.hive === 'CurrentUser' && entry.view === 'Registry64',
  )
  assert.ok(registration, 'Missing per-user uninstall registration')
  const location =
    afterInstall.owned[`CurrentUser/Registry64/Software\\${guid}`]?.['']?.InstallLocation?.value
  assert.equal(resolve(location), installed)
  assert.equal(registration.values.DisplayVersion.value, metadata.version)
  assert.equal(
    registration.values.UninstallString.value,
    `"${join(installed, 'Uninstall Manuslip.exe')}" /currentuser`,
  )
  assert.deepEqual(
    afterInstall.associations,
    before.associations,
    'Installer changed unrelated associations/defaults',
  )
  for (const [name, advertised] of Object.entries(afterInstall.advertisements))
    assert.equal(
      advertised,
      name.startsWith('CurrentUser/'),
      `Unexpected Open With registration: ${name}`,
    )
  for (const folder of ['DesktopDirectory', 'Programs']) {
    assert.equal(afterInstall.shortcuts[folder].exists, true, `Missing ${folder} shortcut`)
    assert.equal(resolve(afterInstall.shortcuts[folder].target), join(installed, 'Manuslip.exe'))
  }
  assert.ok(
    Object.keys(afterInstall.owned).every((name) => name.startsWith('CurrentUser/')),
    'Installer wrote a machine registration',
  )
  const commandKey = `CurrentUser/Registry64/Software\\Classes\\Manuslip.Markdown`
  const command = afterInstall.owned[commandKey]?.['shell\\open\\command\\']?.['']?.value
  assert.equal(command, `"${join(installed, 'Manuslip.exe')}" "%1"`)
  const actual = await files(installed)
  const extras = actual.filter((entry) => !expected.some((file) => file.name === entry.name))
  assert.equal(extras.length, 1, 'Unexpected installer output')
  assert.equal(extras[0].name, 'Uninstall Manuslip.exe')
  uninstaller = join(installed, extras[0].name)
  assert.deepEqual(
    actual.filter((entry) => entry.name !== extras[0].name),
    expected,
    'Installed runtime bytes differ from verified unpacked application',
  )
  report.installedFiles = actual
  report.icons = await Promise.all(
    [installer, join(installed, 'Manuslip.exe'), uninstaller].map(verifyWindowsApplicationIcon),
  )
  report.phases.push('runtime-verified')
  report.application = await verifyInstalledDesktop(join(installed, 'Manuslip.exe'), directory)
  report.phases.push('installed-app-verified')
} catch (error) {
  report.error = String(error)
  failure = { error }
} finally {
  try {
    // Only the test's freshly created directory can supply this uninstaller. Even partial
    // installs are cleaned through their own uninstaller; no registry keys are deleted here.
    uninstaller ??= join(installed, 'Uninstall Manuslip.exe')
    if (
      await stat(uninstaller).then(
        () => true,
        () => false,
      )
    ) {
      assert.equal(dirname(uninstaller), installed)
      assert.ok((await realpath(uninstaller)).startsWith(`${await realpath(directory)}${sep}`))
      // NSIS normally spawns a temporary copy and exits before cleanup finishes.
      // Run our own copy outside the installation with _?= last and unquoted, so
      // the awaited process performs the whole uninstall and can remove its files.
      const runner = join(directory, 'run-uninstaller.exe')
      await copyFile(uninstaller, runner)
      await run(runner, ['/S', '/currentuser', `_?=${installed}`], true)
      const deadline = Date.now() + 30000
      while (
        await stat(installed).then(
          () => true,
          () => false,
        )
      ) {
        assert.ok(Date.now() < deadline, 'Uninstaller left its installation directory')
        await delay(100)
      }
      const afterUninstall = await state()
      report.afterUninstall = afterUninstall
      assert.deepEqual(
        afterUninstall,
        before,
        'Uninstaller did not restore registration/shortcut/default-association state',
      )
      report.phases.push('uninstalled-and-state-restored')
    }
  } catch (error) {
    report.cleanupError = String(error)
    report.cleanupState = await state().catch((failure) => ({ error: String(failure) }))
    failure ??= { error }
  } finally {
    await writeFile(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Installer evidence: ${relative(root, join(directory, 'report.json'))}`)
  }
}
if (failure) throw failure.error
assert.deepEqual(report.phases, [
  'installed',
  'runtime-verified',
  'installed-app-verified',
  'uninstalled-and-state-restored',
])
console.log('Windows installer, installed application and uninstaller passed')
