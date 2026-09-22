$ErrorActionPreference = 'Stop'
$verifier = Join-Path $PSScriptRoot 'verify-test-signature.ps1'
$directory = Join-Path ([IO.Path]::GetTempPath()) ('toolknit-signature-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
    # An installed, signed PowerShell binary is a fixture only; never execute modified copies.
    $fixturePath = (Get-Command pwsh).Source
    $signature = Get-AuthenticodeSignature -LiteralPath $fixturePath
    if ($signature.Status -ne 'Valid') { throw 'The installed PowerShell fixture must have a valid signature.' }
    $signed = [IO.File]::ReadAllBytes($fixturePath)
    $pe = [BitConverter]::ToInt32($signed, 0x3c)
    $optional = $pe + 24
    $directoryOffset = if ([BitConverter]::ToUInt16($signed, $optional) -eq 0x20b) { 112 } else { 96 }
    $security = $optional + $directoryOffset + 32
    $certificateOffset = [BitConverter]::ToInt32($signed, $security)
    if ($certificateOffset -le 0) { throw 'The fixture must have an embedded Authenticode signature.' }
    $unsigned = [byte[]]::new($certificateOffset)
    [Array]::Copy($signed, $unsigned, $unsigned.Length)
    [Array]::Clear($unsigned, $security, 8)
    [Array]::Clear($unsigned, $optional + 64, 4)
    $unsignedPath = Join-Path $directory 'unsigned.exe'
    [IO.File]::WriteAllBytes($unsignedPath, $unsigned)
    $thumbprint = $signature.SignerCertificate.Thumbprint

    function Expect-Rejected([string]$Name, [scriptblock]$Action, [string]$Pattern) {
        $caught = $null
        try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
        if (-not $caught -or $caught -notmatch $Pattern) { throw "${Name}: expected rejection matching '$Pattern'; got '$caught'" }
        Write-Output "PASS: $Name"
    }

    $result = & $verifier -SignedPath $fixturePath -UnsignedPath $unsignedPath -ExpectedThumbprint $thumbprint | ConvertFrom-Json
    if (-not $result.cmsSignatureVerified -or -not $result.authenticodeDigestVerified -or -not $result.payloadUnchanged) { throw 'Verification report is incomplete.' }
    Write-Output 'PASS: valid signature, original payload and certificate'
    Expect-Rejected 'unsigned input' { & $verifier -SignedPath $unsignedPath -UnsignedPath $unsignedPath } 'certificate table'
    Expect-Rejected 'wrong certificate' { & $verifier -SignedPath $fixturePath -UnsignedPath $unsignedPath -ExpectedThumbprint ('0' * 40) } 'thumbprint'

    $tampered = [byte[]]$signed.Clone()
    $tampered[$certificateOffset - 1] = $tampered[$certificateOffset - 1] -bxor 1
    $tamperedPath = Join-Path $directory 'tampered.exe'
    [IO.File]::WriteAllBytes($tamperedPath, $tampered)
    Expect-Rejected 'changed payload' { & $verifier -SignedPath $tamperedPath -UnsignedPath $unsignedPath } 'payload differs'

    $tamperedUnsigned = [byte[]]$unsigned.Clone()
    $tamperedUnsigned[$certificateOffset - 1] = $tamperedUnsigned[$certificateOffset - 1] -bxor 1
    $tamperedUnsignedPath = Join-Path $directory 'tampered-unsigned.exe'
    [IO.File]::WriteAllBytes($tamperedUnsignedPath, $tamperedUnsigned)
    Expect-Rejected 'matching modified inputs still fail signed digest' { & $verifier -SignedPath $tamperedPath -UnsignedPath $tamperedUnsignedPath } 'digest does not match'

    $damaged = [byte[]]$signed.Clone()
    $damaged[$certificateOffset + 8] = 0
    $damagedPath = Join-Path $directory 'damaged-cms.exe'
    [IO.File]::WriteAllBytes($damagedPath, $damaged)
    Expect-Rejected 'damaged signature' { & $verifier -SignedPath $damagedPath -UnsignedPath $unsignedPath } 'ASN1|ASN.1|Decode|编码|解码'
} finally {
    # This exact, newly created temporary directory contains generated fixtures only.
    $resolvedDirectory = [IO.Path]::GetFullPath($directory)
    $resolvedParent = [IO.Path]::GetDirectoryName($resolvedDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolvedParent -ne $expectedParent -or [IO.Path]::GetFileName($resolvedDirectory) -notmatch '^toolknit-signature-test-[0-9a-f]{32}$') {
        throw 'Refusing to clean a path outside the generated test directory.'
    }
    Remove-Item -LiteralPath $resolvedDirectory -Recurse -Force
}
