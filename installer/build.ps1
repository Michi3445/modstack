param([Parameter(Mandatory = $true)][string] $Output)

$ErrorActionPreference = 'Stop'
$Output = [IO.Path]::GetFullPath($Output)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Der .NET-Framework-C#-Compiler fehlt.' }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$workspace = Join-Path $tempRoot ("modstack-setup-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace | Out-Null
try {
    $dependency = Join-Path $workspace 'bouncycastle.nupkg'
    $version = '2.7.0'
    $package = 'bouncycastle.cryptography'
    $uri = "https://api.nuget.org/v3-flatcontainer/$package/$version/$package.$version.nupkg"
    Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $dependency
    if ((Get-FileHash -LiteralPath $dependency -Algorithm SHA256).Hash -ne 'F091FFCCAB4D03993E660BACE277659A79DEE0972F54D7F1F4BD46D680966241') {
        throw 'Die Prüfsumme der Bouncy-Castle-Abhängigkeit stimmt nicht.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($dependency, (Join-Path $workspace 'nuget'))
    $crypto = Join-Path $workspace 'nuget\lib\net461\BouncyCastle.Cryptography.dll'
    $license = Join-Path $workspace 'nuget\LICENSE.md'
    $embedded = Join-Path $workspace 'BouncyCastle.dll.gz'
    $inputFile = [IO.File]::OpenRead($crypto)
    $outputFile = [IO.File]::Create($embedded)
    $gzip = New-Object IO.Compression.GZipStream($outputFile, [IO.Compression.CompressionMode]::Compress)
    try { $inputFile.CopyTo($gzip) } finally { $gzip.Dispose(); $outputFile.Dispose(); $inputFile.Dispose() }
    $key = Join-Path $workspace 'update-public.der'
    $pem = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\update-public.pem') -Raw
    [IO.File]::WriteAllBytes($key, [Convert]::FromBase64String(($pem -replace '-----[^\r\n]+-----|\s', '')))
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Output)) -Force | Out-Null
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$Output" `
        "/resource:$embedded,BouncyCastle.dll.gz" "/resource:$license,BouncyCastle-LICENSE.md" "/resource:$key,Modstack.update-public.der" `
        "/reference:$crypto" /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll `
        /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll `
        (Join-Path $PSScriptRoot 'Setup.cs') (Join-Path $PSScriptRoot 'InstallPackage.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Modstack-Setup.exe konnte nicht erstellt werden.' }
    Get-Item -LiteralPath $Output | Select-Object Name, Length
} finally {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($workspace)) -eq $tempRoot -and
        [IO.Path]::GetFileName($workspace) -match '^modstack-setup-build-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $workspace -Recurse -Force
    }
}
