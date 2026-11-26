$ErrorActionPreference = 'Stop'
$stage = [IO.Path]::GetFullPath($env:MODSTACK_UPDATER_STAGE)
$root = [IO.Path]::GetFullPath($env:MODSTACK_UPDATER_ROOT)
$parent = [IO.Path]::GetDirectoryName($root)
$exe = Join-Path $root 'Modstack.exe'
$receipt = Join-Path $stage 'app-ready'
$mode = $env:MODSTACK_UPDATER_MODE
$archive = Join-Path $root 'resources\app.asar'
$backup = Join-Path $stage 'previous'
$newApp = $null
$exited = $false
$changed = $false
$discardStage = $false

function Retry([scriptblock] $Action) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try { & $Action; return } catch {
      if ($attempt -eq 39) { throw }
      Start-Sleep -Milliseconds 200
    }
  }
}

try {
  if ([IO.Path]::GetDirectoryName($stage) -ne $parent -or
      [IO.Path]::GetFileName($stage) -notmatch '^\.modstack-update-[A-Za-z0-9]+$' -or
      ((Get-Item -LiteralPath $stage).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      -not (Test-Path -LiteralPath $exe -PathType Leaf) -or
      $mode -notin @('asar', 'full')) { throw 'Ungültiger Modstack-Updateordner.' }
  [Environment]::CurrentDirectory = $parent
  Set-Location -LiteralPath $parent
  $discardStage = $true
  $exited = $true
  $artifact = Join-Path $stage $(if ($mode -eq 'asar') { 'app.asar' } else { 'Modstack-win.zip' })
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($artifact)
  try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $sha.Dispose() }
  if ($hash -ne $env:MODSTACK_UPDATER_HASH) {
    throw 'Die Update-Datei wurde nach dem Download verändert.'
  }
  if ($mode -eq 'asar') {
    Retry { [IO.File]::Replace($artifact, $archive, $backup) }
    $changed = $true
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $unpacked = Join-Path $stage 'unpacked'
    $zip = [IO.Compression.ZipFile]::OpenRead($artifact)
    try {
      $expanded = 0L
      foreach ($entry in $zip.Entries) {
        $entryName = $entry.FullName.Replace('\', '/').TrimEnd('/')
        if ($entryName -notmatch '^Modstack-win32-x64(/[^/:]+)*$' -or $entryName -match '(^|/)\.{1,2}(/|$)') {
          throw 'Ungültiger Dateipfad im Windows-Paket.'
        }
        $expanded += $entry.Length
        if ($expanded -gt 1200MB) { throw 'Das Windows-Paket ist zu groß.' }
      }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($artifact, $unpacked)
    $newRoot = Join-Path $unpacked 'Modstack-win32-x64'
    if (-not (Test-Path -LiteralPath (Join-Path $newRoot 'Modstack.exe') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $newRoot 'resources\app.asar') -PathType Leaf) -or
        (Get-Content -LiteralPath (Join-Path $newRoot 'version') -Raw).Trim() -ne $env:MODSTACK_UPDATER_ELECTRON) {
      throw 'Das Windows-Paket ist unvollständig.'
    }
    Retry { [IO.Directory]::Move($root, $backup) }
    $changed = $true
    Retry { [IO.Directory]::Move($newRoot, $root) }
  }

  $env:MODSTACK_UPDATE_RECEIPT = $receipt
  try { $newApp = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru }
  finally { Remove-Item Env:MODSTACK_UPDATE_RECEIPT -ErrorAction SilentlyContinue }
  for ($attempt = 0; $attempt -lt 150 -and -not $newApp.HasExited; $attempt++) {
    if ((Test-Path -LiteralPath $receipt) -and (Get-Content -LiteralPath $receipt -Raw).Trim() -eq $env:MODSTACK_UPDATER_VERSION) {
      if ($mode -eq 'full') {
        $discardStage = $false
        $previousRoot = $root + '.previous-' + [IO.Path]::GetFileName($stage).Substring(17)
        try { [IO.Directory]::Move($backup, $previousRoot); $discardStage = $true } catch {}
      }
      return
    }
    Start-Sleep -Milliseconds 200
  }
  throw 'Die neue Modstack-Version konnte nicht gestartet werden.'
} catch {
  $message = $_.Exception.Message
  try {
    if ($newApp -and -not $newApp.HasExited) {
      if (-not $newApp.CloseMainWindow() -or -not $newApp.WaitForExit(3000)) {
        $newApp.Kill()
        $newApp.WaitForExit()
      }
    }
    if ($changed) {
      $discardStage = $false
      if ($mode -eq 'asar') {
        Retry { [IO.File]::Replace($backup, $archive, (Join-Path $stage 'failed.asar')) }
      } else {
        if (Test-Path -LiteralPath $root) { Retry { [IO.Directory]::Move($root, (Join-Path $stage 'failed')) } }
        Retry { [IO.Directory]::Move($backup, $root) }
      }
      $discardStage = $true
    }
  } catch { $message += ' Wiederherstellung fehlgeschlagen. Sicherung: ' + $stage }
  [IO.File]::WriteAllText($env:MODSTACK_UPDATER_LOG, $message)
  if ($exited -and (Test-Path -LiteralPath $exe)) { Start-Process -FilePath $exe -WorkingDirectory $root }
} finally {
  if ($discardStage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
