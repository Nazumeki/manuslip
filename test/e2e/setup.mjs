import { mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'

export default async function setup() {
  // Match the canonical paths returned by native file dialogs on Windows and macOS.
  const temporary = await realpath(tmpdir())
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = temporary
  await mkdir(new URL('./result/', import.meta.url), { recursive: true })
}
