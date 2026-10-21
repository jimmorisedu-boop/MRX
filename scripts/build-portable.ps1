[CmdletBinding()]
param(
  [string]$OutDir = '',
  [string]$NodeVersion = '22.23.4',
  [string]$NodeSha = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20',
  [string]$ElectronVersion = '44.9.0',
  [string]$FfmpegSource = '',
  # SHA-256 of the pinned BtbN win64-lgpl ffmpeg.exe described in
  # vendor-sources\FFmpeg-BUILD-PROVENANCE.txt. Change it only together with
  # a new source archive and provenance file.
  [string]$FfmpegSha = '6e01b300cbe8d18d0586fb953a14659572132da94160b3bc3e850253ff8cdc2a',
  [string]$ElectronSource = '',
  [string]$VCRedistDir = '',
  [string]$FfmpegSourceArchive = '',
  [switch]$SkipZip
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $Root 'dist\MRX' }
if ([string]::IsNullOrWhiteSpace($FfmpegSource)) { $FfmpegSource = Join-Path $Root 'tools\ffmpeg-staging\ffmpeg-master-latest-win64-lgpl\bin' }
$Out = [IO.Path]::GetFullPath($OutDir)
if ($Out -eq $Root -or -not $Out.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutDir must be below the source root: $Out"
}

$NodeZip = Join-Path $Root ".cache\node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$ElectronZip = Join-Path $Root ".cache\electron-v$ElectronVersion-win32-x64.zip"
$ElectronSha = '88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931'
$ElectronUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
$Model = Join-Path $Root 'weights\mrx\mrx.int8.onnx'
$ModelSha = 'd876c92d224f5d8cd2207d528b23369da895a6de71fb24132416fcb16f9f8424'
$ModelRevision = 'dedc823a0bea2ed085d19e8b7f32589d35169ee8'
$ModelUrl = "https://huggingface.co/audiojs/mrx/resolve/$ModelRevision/mrx.int8.onnx"
$Ffmpeg = Join-Path $FfmpegSource 'ffmpeg.exe'

function Ensure-Hash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label not found: $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "$Label SHA-256 mismatch: $actual (expected $Expected)" }
}

function Copy-FileIfPresent([string]$Source, [string]$Destination) {
  if (Test-Path -LiteralPath $Source -PathType Leaf) { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
}

if (-not (Test-Path -LiteralPath $NodeZip -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NodeZip) | Out-Null
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}
Ensure-Hash $NodeZip $NodeSha 'Node.js archive'
if ([string]::IsNullOrWhiteSpace($ElectronSource)) { $ElectronSource = $ElectronZip }
if (-not (Test-Path -LiteralPath $ElectronSource -PathType Leaf)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ElectronSource) | Out-Null
  Invoke-WebRequest -Uri $ElectronUrl -OutFile $ElectronSource
}
Ensure-Hash $ElectronSource $ElectronSha 'Electron archive'
if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) {
  # The model is pinned to a Hugging Face revision and verified below.
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Model) | Out-Null
  $modelPart = "$Model.part"
  Invoke-WebRequest -Uri $ModelUrl -OutFile $modelPart
  Ensure-Hash $modelPart $ModelSha 'Downloaded MRX model'
  Move-Item -LiteralPath $modelPart -Destination $Model -Force
}
Ensure-Hash $Model $ModelSha 'MRX model'
if (-not (Test-Path -LiteralPath $Ffmpeg -PathType Leaf)) {
  throw "LGPL FFmpeg binary not found: $Ffmpeg. Unpack the pinned BtbN build listed in vendor-sources\FFmpeg-BUILD-PROVENANCE.txt there, or pass -FfmpegSource."
}
Ensure-Hash $Ffmpeg $FfmpegSha 'FFmpeg binary (see vendor-sources\FFmpeg-BUILD-PROVENANCE.txt)'

if ([string]::IsNullOrWhiteSpace($VCRedistDir)) {
  # Visual Studio keeps redistributable CRT folders at a fixed depth, so a
  # wildcard lookup replaces a recursive walk over all of Program Files.
  $vcPatterns = foreach ($vcRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }) {
    Join-Path $vcRoot 'Microsoft Visual Studio\*\*\VC\Redist\MSVC\*\x64\Microsoft.VC143.CRT'
  }
  $VCRedistDir = Get-ChildItem -Path $vcPatterns -Directory -ErrorAction SilentlyContinue |
    Sort-Object { $_.Parent.Parent.Name -as [version] } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if ([string]::IsNullOrWhiteSpace($VCRedistDir) -or -not (Test-Path -LiteralPath $VCRedistDir -PathType Container)) {
  throw 'Microsoft VC++ x64 redistributable files were not found. Pass -VCRedistDir to a legitimate Microsoft.VC143.CRT folder.'
}
$crtNames = @('concrt140.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'vccorlib140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll')
foreach ($crtName in $crtNames) {
  if (-not (Test-Path -LiteralPath (Join-Path $VCRedistDir $crtName) -PathType Leaf)) { throw "Required MSVC runtime file missing: $crtName" }
}

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$stage = Join-Path ([IO.Path]::GetTempPath()) ("mrx-build-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  $runtimeStage = Join-Path $stage 'runtime'
  Expand-Archive -LiteralPath $NodeZip -DestinationPath $stage
  $nodeRoot = Get-ChildItem -LiteralPath $stage -Directory | Where-Object Name -like "node-v$NodeVersion-win-x64" | Select-Object -First 1
  if (-not $nodeRoot) { throw 'Node archive layout is unexpected' }
  Move-Item -LiteralPath $nodeRoot.FullName -Destination $runtimeStage
  # The app only runs node.exe; npm, npx and corepack from the archive are
  # not shipped.
  New-Item -ItemType Directory -Force -Path (Join-Path $Out 'runtime') | Out-Null
  foreach ($runtimeFile in @('node.exe', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $runtimeStage $runtimeFile) -Destination (Join-Path $Out "runtime\$runtimeFile") -Force
  }
  foreach ($crtName in $crtNames) { Copy-Item -LiteralPath (Join-Path $VCRedistDir $crtName) -Destination (Join-Path $Out "runtime\$crtName") -Force }

  $electronStage = Join-Path $stage 'electron'
  New-Item -ItemType Directory -Force -Path $electronStage | Out-Null
  Expand-Archive -LiteralPath $ElectronSource -DestinationPath $electronStage
  $electronExe = Join-Path $electronStage 'electron.exe'
  if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) { throw 'Electron archive layout is unexpected' }
  Copy-Item -LiteralPath $electronExe -Destination (Join-Path $Out 'MRX.exe') -Force
  # MRX version metadata and Electron fuses; needs the root devDependencies
  # installed by `npm ci`.
  & node (Join-Path $Root 'scripts\finalize-exe.mjs') (Join-Path $Out 'MRX.exe') '1.0.0'
  if ($LASTEXITCODE -ne 0) { throw "finalize-exe.mjs failed with exit code $LASTEXITCODE" }
  Get-ChildItem -LiteralPath $electronStage -Force | Where-Object Name -ne 'electron.exe' | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Out $_.Name) -Recurse -Force
  }

  # Electron's application directory is self-contained. Runtime data stays at
  # the portable root and is injected through MRX_DATA_DIR by main.cjs.
  $appRoot = Join-Path $Out 'resources\app'
  New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'app') -Destination (Join-Path $appRoot 'app') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Root 'desktop') -Destination (Join-Path $appRoot 'desktop') -Recurse -Force
  # Production dependencies come from a clean install of package-lock.json,
  # not from whatever the developer's node_modules happens to contain. Install
  # scripts are skipped: onnxruntime-node ships its Windows binaries in the
  # package and its postinstall only fetches optional CUDA files.
  $depsStage = Join-Path $stage 'deps'
  New-Item -ItemType Directory -Force -Path $depsStage | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination $depsStage -Force
  Copy-Item -LiteralPath (Join-Path $Root 'package-lock.json') -Destination $depsStage -Force
  Push-Location -LiteralPath $depsStage
  try {
    & npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  Copy-Item -LiteralPath (Join-Path $depsStage 'node_modules') -Destination (Join-Path $appRoot 'node_modules') -Recurse -Force
  $ortBin = Join-Path $appRoot 'node_modules\onnxruntime-node\bin\napi-v6'
  foreach ($unused in @('darwin', 'linux')) { Remove-Item -LiteralPath (Join-Path $ortBin $unused) -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $ortBin 'win32\arm64') -Recurse -Force -ErrorAction SilentlyContinue
  # The production app does not load the Node events package test suite.
  # Prune it from the portable payload so no dependency test fixtures ship.
  Remove-Item -LiteralPath (Join-Path $appRoot 'node_modules\events\tests') -Recurse -Force -ErrorAction SilentlyContinue
  $electronPackage = @{
    name = 'mrx-desktop'; version = '1.0.0'; private = $true; main = 'desktop/main.cjs'
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $appRoot 'package.json') -Value $electronPackage -Encoding utf8

  foreach ($folder in @('weights\mrx', 'tools', 'data\uploads', 'data\outputs', 'data\cache', 'data\logs')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Out $folder) | Out-Null
  }
  $sourceRoot = Join-Path $Out 'source'
  New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root 'app') -Destination (Join-Path $sourceRoot 'app') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Root 'desktop') -Destination (Join-Path $sourceRoot 'desktop') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Root 'scripts') -Destination (Join-Path $sourceRoot 'scripts') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination (Join-Path $sourceRoot 'package.json') -Force
  Copy-Item -LiteralPath (Join-Path $Root 'package-lock.json') -Destination (Join-Path $sourceRoot 'package-lock.json') -Force
  Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination (Join-Path $sourceRoot 'README.md') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $Model -Destination (Join-Path $Out 'weights\mrx\mrx.int8.onnx') -Force
  Copy-Item -LiteralPath $Ffmpeg -Destination (Join-Path $Out 'tools\ffmpeg.exe') -Force
  foreach ($gitkeep in @('uploads', 'outputs', 'cache', 'logs')) { Set-Content -LiteralPath (Join-Path $Out "data\$gitkeep\.gitkeep") -Value '' -NoNewline }
  Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination (Join-Path $Out 'README.md') -Force -ErrorAction SilentlyContinue

  New-Item -ItemType Directory -Force -Path (Join-Path $Out 'LICENSES') | Out-Null
  $ffLicense = Join-Path $FfmpegSource '..\LICENSE.txt'
  Copy-FileIfPresent $ffLicense (Join-Path $Out 'LICENSES\FFmpeg-LGPL-3.0.txt')
  Copy-FileIfPresent (Join-Path $Out 'runtime\LICENSE') (Join-Path $Out 'LICENSES\Node-MIT.txt')
  Copy-FileIfPresent (Join-Path $electronStage 'LICENSE') (Join-Path $Out 'LICENSES\Electron.txt')
  if (-not (Test-Path -LiteralPath (Join-Path $Out 'LICENSES\Electron.txt') -PathType Leaf)) {
    Copy-FileIfPresent (Join-Path $electronStage 'LICENSE.electron.txt') (Join-Path $Out 'LICENSES\Electron.txt')
  }
  Copy-FileIfPresent (Join-Path $electronStage 'LICENSES.chromium.html') (Join-Path $Out 'LICENSES\Electron-Chromium.html')
  Copy-Item -LiteralPath (Join-Path $Root 'package-lock.json') -Destination (Join-Path $Out 'package-lock.json') -Force
  Copy-Item -LiteralPath (Join-Path $Root 'package.json') -Destination (Join-Path $Out 'package.json') -Force

  $ffErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $ffVersion = (& $Ffmpeg -version 2>&1 | Select-Object -First 1)
  $ffBuildConf = (& $Ffmpeg -buildconf 2>&1 | Out-String)
  $ErrorActionPreference = $ffErrorPreference
  $ffSha = (Get-FileHash -LiteralPath $Ffmpeg -Algorithm SHA256).Hash.ToLowerInvariant()
  $ffCommit = if ($ffVersion -match 'g([0-9a-f]{9,})') { $Matches[1] } else { 'unknown' }
  $ffSourceUrl = if ($ffCommit -ne 'unknown') { "https://github.com/FFmpeg/FFmpeg/commit/$ffCommit" } else { 'https://github.com/FFmpeg/FFmpeg' }
  $ffBuildNote = @"
Binary: tools/ffmpeg.exe
Build identity: $ffVersion
SHA-256: $ffSha
FFmpeg source commit: $ffSourceUrl
BtbN build project: https://github.com/BtbN/FFmpeg-Builds

Exact configure output:
$ffBuildConf
"@
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\FFmpeg-BUILD.txt') -Value $ffBuildNote -Encoding utf8
  $vendorSources = Join-Path $Root 'vendor-sources'
  Copy-FileIfPresent (Join-Path $vendorSources 'FFmpeg-BUILD-PROVENANCE.txt') (Join-Path $Out 'LICENSES\FFmpeg-BUILD-PROVENANCE.txt')
  Copy-FileIfPresent (Join-Path $vendorSources 'BtbN-FFmpeg-Builds-63ac3265b0789ea16c7b1f8351cd2ad195a28722.tar.gz') (Join-Path $Out 'LICENSES\FFmpeg-BtbN-BUILD-SOURCE.tar.gz')
  Copy-FileIfPresent (Join-Path $vendorSources 'BtbN-FFmpeg-Builds-latest-checksums.sha256') (Join-Path $Out 'LICENSES\FFmpeg-BtbN-CHECKSUMS.sha256')
  if ($FfmpegSourceArchive -and (Test-Path -LiteralPath $FfmpegSourceArchive -PathType Leaf)) {
    Copy-Item -LiteralPath $FfmpegSourceArchive -Destination (Join-Path $Out 'LICENSES\FFmpeg-SOURCE-ARCHIVE.tar.gz') -Force
  }
  $modelLicense = @"
MIT License

Copyright (c) 2023 Mitsubishi Electric Research Laboratories (MERL)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"@
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\MRX-MODEL-MIT.txt') -Value $modelLicense -Encoding utf8
  $modelCard = @"
MRX, ONNX (int8 weights)

Model: audiojs/mrx, pinned revision dedc823a0bea2ed085d19e8b7f32589d35169ee8
File: mrx.int8.onnx
SHA-256: $ModelSha
Source and model card: https://huggingface.co/audiojs/mrx
Original model and checkpoint: merlresearch/cocktail-fork-separation at
19b3de827ebc4bfb014570cf92dd32b4ee3b6921.
MRX by Darius Petermann, Gordon Wichern, Zhong-Qiu Wang and Jonathan Le Roux
(MERL); ONNX export and compaction by audiojs. Trained on Divide and Remaster
v2; source datasets have their own licences, including some non-commercial
terms. Paper: https://arxiv.org/abs/2110.09958
"@
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\MRX-MODEL-CARD.txt') -Value $modelCard -Encoding utf8
  $ortLicense = @"
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"@
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\ONNX-RUNTIME-MIT.txt') -Value $ortLicense -Encoding utf8
  $npmLicenseLines = [Collections.Generic.List[string]]::new()
  $npmLicenseLines.Add('MRX production npm dependency licenses (package-lock.json and package metadata)')
  $npmLicenseLines.Add('')
  # Read installed package metadata instead of materializing npm's empty root
  # package-lock key, which PowerShell 7 rejects on some platforms.
  $packageFiles = Get-ChildItem -LiteralPath (Join-Path $appRoot 'node_modules') -Filter 'package.json' -File -Recurse
  foreach ($packageFile in $packageFiles) {
    $packagePath = $packageFile.Directory.FullName
    $relativePackage = $packagePath.Substring($appRoot.Length + 1).Replace('\', '/')
    $packageMeta = Get-Content -LiteralPath $packageFile.FullName -Raw | ConvertFrom-Json
    $licenseName = if ($packageMeta.license) { [string]$packageMeta.license } else { 'license declared by package metadata' }
    $npmLicenseLines.Add("--- $relativePackage [$licenseName] ---")
    $licenseFiles = @(Get-ChildItem -LiteralPath $packagePath -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING)(\.|$)' } | Select-Object -First 6)
    if ($licenseFiles.Count) {
      foreach ($licenseFile in $licenseFiles) {
        $npmLicenseLines.Add("[$($licenseFile.Name)]")
        $npmLicenseLines.Add((Get-Content -LiteralPath $licenseFile.FullName -Raw))
      }
    } else {
      $npmLicenseLines.Add("License: $licenseName (declared in package metadata)")
    }
  }
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\NPM-LICENSES.txt') -Value ($npmLicenseLines -join "`n") -Encoding utf8
  $ffSourceArchiveNote = if ($FfmpegSourceArchive -and (Test-Path -LiteralPath $FfmpegSourceArchive -PathType Leaf)) {
    $sourceHash = (Get-FileHash -LiteralPath $FfmpegSourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    "Exact FFmpeg source archive: LICENSES/FFmpeg-SOURCE-ARCHIVE.tar.gz (SHA-256: $sourceHash)"
  } else {
    'Source archive was not supplied to this build; retain the exact build URL and binary hash above with your corresponding source offer.'
  }
  $manifest = @"
MRX Desktop Portable 1.0.0 — bundled components

Electron v$ElectronVersion (MIT / Chromium notices):
  $ElectronUrl
  SHA-256: $ElectronSha
  See LICENSES/Electron.txt and LICENSES/Electron-Chromium.html.

Node.js v$NodeVersion (MIT), official archive:
  $NodeUrl
  SHA-256: $NodeSha

Microsoft Visual C++ x64 runtime (Microsoft redistribution package):
  Files copied from: $VCRedistDir
  See https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist

FFmpeg (LGPL-3.0-or-later, win64-lgpl):
  Build identity: $ffVersion
  Binary SHA-256: $ffSha
  FFmpeg source commit: $ffSourceUrl
  BtbN source/build project: https://github.com/BtbN/FFmpeg-Builds
  FFmpeg source/build information: https://ffmpeg.org/download.html
  $ffSourceArchiveNote
  Complete LGPL text: LICENSES/FFmpeg-LGPL-3.0.txt

MRX model (MIT):
  Source/model card: https://huggingface.co/audiojs/mrx
  SHA-256: $ModelSha
  Full attribution and MIT text: LICENSES/MRX-MODEL-CARD.txt and LICENSES/MRX-MODEL-MIT.txt

JavaScript dependencies and declared licenses are fixed in package-lock.json.
The package directories contain their license/NOTICE files, including
@audio/neural-separate; an aggregate is in LICENSES/NPM-LICENSES.txt.
ONNX Runtime's complete MIT text is in LICENSES/ONNX-RUNTIME-MIT.txt.
Electron notices are included above.
"@
  Set-Content -LiteralPath (Join-Path $Out 'LICENSES\THIRD-PARTY.txt') -Value $manifest -Encoding utf8
  $version = "MRX Desktop Portable 1.0.0`nElectron $ElectronVersion`nNode $NodeVersion`nModel SHA256 $ModelSha`nFFmpeg SHA256 $ffSha`nBuilt $(Get-Date -Format o)"
  Set-Content -LiteralPath (Join-Path $Out 'VERSION.txt') -Value $version -Encoding utf8
}
finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

if (-not $SkipZip) {
  $zip = Join-Path (Split-Path -Parent $Out) ((Split-Path -Leaf $Out) + '.zip')
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $Out '*') -DestinationPath $zip -CompressionLevel Optimal
  Write-Output "PORTABLE_ZIP=$zip"
}
Write-Output "PORTABLE_DIR=$Out"
