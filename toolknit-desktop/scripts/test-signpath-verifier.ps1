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

    # Generate a self-signed fixture in memory; never install a certificate or run the fixture.
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $testCertificate = $null
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
            'CN=ToolKnit verifier test', $rsa, [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $usages = [Security.Cryptography.OidCollection]::new()
        $null = $usages.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $true))
        $testCertificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1), [DateTimeOffset]::UtcNow.AddDays(1))
        $originalCms = [Security.Cryptography.Pkcs.SignedCms]::new()
        $originalLength = [BitConverter]::ToInt32($signed, $certificateOffset)
        $originalCms.Decode([byte[]]$signed[($certificateOffset + 8)..($certificateOffset + $originalLength - 1)])
        $testCms = [Security.Cryptography.Pkcs.SignedCms]::new($originalCms.ContentInfo)
        $signer = [Security.Cryptography.Pkcs.CmsSigner]::new($testCertificate)
        $signer.IncludeOption = 'EndCertOnly'
        $testCms.ComputeSignature($signer)
        $encoded = $testCms.Encode()
        $recordLength = $encoded.Length + 8
        $recordSize = [int]([Math]::Ceiling($recordLength / 8.0) * 8)
        $selfSigned = [byte[]]::new($unsigned.Length + $recordSize)
        [Array]::Copy($unsigned, $selfSigned, $unsigned.Length)
        [BitConverter]::GetBytes([uint32]$unsigned.Length).CopyTo($selfSigned, $security)
        [BitConverter]::GetBytes([uint32]$recordSize).CopyTo($selfSigned, $security + 4)
        [BitConverter]::GetBytes([uint32]$recordLength).CopyTo($selfSigned, $unsigned.Length)
        [BitConverter]::GetBytes([uint16]0x200).CopyTo($selfSigned, $unsigned.Length + 4)
        [BitConverter]::GetBytes([uint16]2).CopyTo($selfSigned, $unsigned.Length + 6)
        $encoded.CopyTo($selfSigned, $unsigned.Length + 8)
        $testPath = Join-Path $directory 'self-signed.exe'
        [IO.File]::WriteAllBytes($testPath, $selfSigned)

        $result = & $verifier -SignedPath $testPath -UnsignedPath $unsignedPath -ExpectedThumbprint $testCertificate.Thumbprint | ConvertFrom-Json
        if (-not $result.expectedThumbprintMatched -or -not $result.testCertificateTrustWarning -or
            $result.certificateChainStatus.Count -ne 1 -or $result.certificateChainStatus[0] -ne 'UntrustedRoot') {
            throw 'The self-signed fixture must report only a pinned untrusted root.'
        }
        Write-Output 'PASS: pinned self-signed certificate with untrusted root'
        Expect-Rejected 'unpinned untrusted certificate' { & $verifier -SignedPath $testPath -UnsignedPath $unsignedPath } 'explicitly pinned'
        Expect-Rejected 'different self-signed certificate' { & $verifier -SignedPath $testPath -UnsignedPath $unsignedPath -ExpectedThumbprint $thumbprint } 'thumbprint'

        $simulatedState = @{
            Certificate = (Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $testPath).SignerCertificate
            Status = 'UnknownError'
        }
        $mockSignature = {
            param([string]$LiteralPath)
            [pscustomobject]@{ Status = $simulatedState.Status; StatusMessage = 'Unrelated trust failure'; SignerCertificate = $simulatedState.Certificate }
        }.GetNewClosure()
        Set-Item Function:\Get-AuthenticodeSignature -Value $mockSignature
        try {
            Expect-Rejected 'arbitrary UnknownError' { & $verifier -SignedPath $testPath -UnsignedPath $unsignedPath -ExpectedThumbprint $testCertificate.Thumbprint } 'Authenticode validation failed'
            $simulatedState.Status = 'NotTrusted'
            Expect-Rejected 'explicit distrust' { & $verifier -SignedPath $testPath -UnsignedPath $unsignedPath -ExpectedThumbprint $testCertificate.Thumbprint } 'Authenticode validation failed'
        } finally { Remove-Item Function:\Get-AuthenticodeSignature }
    } finally {
        if ($testCertificate) { $testCertificate.Dispose() }
        $rsa.Dispose()
    }
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
