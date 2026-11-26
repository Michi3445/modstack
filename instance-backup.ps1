$ErrorActionPreference = 'Stop'
$job = $env:MODSTACK_BACKUP_JOB | ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-Regular($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point in backup path' }
}

function Add-BackupEntry($archive, $item, [string] $name) {
    Assert-Regular $item
    if ($item.PSIsContainer) {
        [void] $archive.CreateEntry($name + '/')
        foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
            Add-BackupEntry $archive $child ($name + '/' + $child.Name)
        }
    } elseif ($item.Name -ne 'session.lock') {
        [void] [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $item.FullName, $name, [IO.Compression.CompressionLevel]::Fastest)
    }
}

$locks = [Collections.Generic.List[IDisposable]]::new()
try {
    if ($job.mode -eq 'create' -or $job.mode -eq 'locks') {
        $saves = Join-Path $job.dir 'saves'
        if (Test-Path -LiteralPath $saves -PathType Container) {
            Assert-Regular (Get-Item -LiteralPath $saves -Force)
            foreach ($world in Get-ChildItem -LiteralPath $saves -Directory -Force) {
                Assert-Regular $world
                $lock = Join-Path $world.FullName 'session.lock'
                if (!(Test-Path -LiteralPath $lock -PathType Leaf)) { continue }
                Assert-Regular (Get-Item -LiteralPath $lock -Force)
                try {
                    $locks.Add([IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None))
                } catch { throw 'MODSTACK_WORLD_LOCK' }
            }
        }
    }
    if ($job.mode -eq 'create') {
        $archive = [IO.Compression.ZipFile]::Open($job.zip, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($name in $job.paths) {
                Add-BackupEntry $archive (Get-Item -LiteralPath (Join-Path $job.dir $name) -Force) $name
            }
        } finally { $archive.Dispose() }
    } elseif ($job.mode -eq 'restore') {
        $archive = [IO.Compression.ZipFile]::OpenRead($job.zip)
        try {
            foreach ($entry in $archive.Entries) {
                $name = $entry.FullName.TrimEnd('/')
                $parts = $name.Split('/')
                if ($parts[0] -cnotin $job.paths -or $name -match '[\\:]' -or
                    @($parts | Where-Object { !$_ -or $_ -match '[. ]$' -or $_ -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)' }).Count -or
                    ($parts[0] -eq 'options.txt' -and ($parts.Length -ne 1 -or $entry.FullName.EndsWith('/')))) {
                    throw 'Unexpected archive entry'
                }
            }
            [IO.Compression.ZipFile]::ExtractToDirectory($job.zip, $job.incoming)
        } finally { $archive.Dispose() }
    }
} finally {
    foreach ($lock in $locks) { $lock.Dispose() }
}
