// Turns the copied electron.exe into MRX.exe: replaces Electron's version
// metadata (Task Manager and file properties showed "Electron, GitHub, Inc.")
// and flips Electron fuses the app does not need.
//
// Usage: node scripts/finalize-exe.mjs <path\to\MRX.exe> <version>
import { readFile, writeFile } from 'node:fs/promises'
import * as ResEdit from 'resedit'
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

const [exePath, version = '1.0.0'] = process.argv.slice(2)
if (!exePath) throw new Error('usage: finalize-exe.mjs <MRX.exe> <version>')
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be x.y.z: ${version}`)

const exe = ResEdit.NtExecutable.from(await readFile(exePath), { ignoreCert: true })
const resources = ResEdit.NtExecutableResource.from(exe)
const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
if (!info) throw new Error('no version resource in executable')
const [major, minor, patch] = version.split('.').map(Number)
info.setFileVersion(major, minor, patch, 0)
info.setProductVersion(major, minor, patch, 0)
const languages = info.getAllLanguagesForStringValues()
for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) {
  info.setStringValues(language, {
    ProductName: 'MRX',
    FileDescription: 'MRX — разделение звука',
    CompanyName: 'MRX',
    InternalName: 'MRX',
    OriginalFilename: 'MRX.exe',
    ProductVersion: version,
    FileVersion: version,
    // Electron's copyright notice stays in LICENSES\Electron.txt.
    LegalCopyright: '',
  })
}
info.outputToResourceEntries(resources.entries)
resources.outputResource(exe)
await writeFile(exePath, Buffer.from(exe.generate()))

await flipFuses(exePath, {
  version: FuseVersion.V1,
  // MRX.exe must not double as a general Node.js runtime.
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // EnableNodeCliInspectArguments stays on: Playwright's electron.launch,
  // used by tests/native, attaches through the Node inspector.
})
process.stdout.write(`FINALIZED_EXE=${exePath}\n`)
