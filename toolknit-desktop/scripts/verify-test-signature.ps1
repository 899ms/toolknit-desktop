[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SignedPath,
    [Parameter(Mandatory)][string]$UnsignedPath,
    [string]$ExpectedThumbprint,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Run this verifier with PowerShell 7.' }

function Get-PeLayout([byte[]]$Bytes) {
    if ($Bytes.Length -lt 512 -or [BitConverter]::ToUInt16($Bytes, 0) -ne 0x5a4d) { throw 'Invalid DOS header.' }
    $pe = [BitConverter]::ToInt32($Bytes, 0x3c)
    if ($pe -lt 64 -or $pe -gt $Bytes.Length - 256 -or [BitConverter]::ToUInt32($Bytes, $pe) -ne 0x4550) {
        throw 'Invalid PE header.'
    }
    $optional = $pe + 24
    $magic = [BitConverter]::ToUInt16($Bytes, $optional)
    $directory = switch ($magic) { 0x10b { $optional + 96 } 0x20b { $optional + 112 } default { throw 'Unknown PE format.' } }
    $security = $directory + 32
    $headers = [BitConverter]::ToUInt32($Bytes, $optional + 60)
    $sectionTable = $optional + [BitConverter]::ToUInt16($Bytes, $pe + 20)
    $sectionCount = [BitConverter]::ToUInt16($Bytes, $pe + 6)
    if ($headers -gt $Bytes.Length -or $security + 8 -gt $sectionTable -or $sectionTable + 40 * $sectionCount -gt $headers) {
        throw 'Truncated PE headers.'
    }
    $sections = @(for ($i = 0; $i -lt $sectionCount; $i++) {
        $entry = $sectionTable + 40 * $i
        $size = [BitConverter]::ToUInt32($Bytes, $entry + 16)
        if ($size -gt 0) { [pscustomobject]@{ Offset = [BitConverter]::ToUInt32($Bytes, $entry + 20); Size = $size } }
    })
    # Contiguous raw sections let us hash the exact PE image and NSIS overlay in file order.
    $end = [long]$headers
    foreach ($section in ($sections | Sort-Object Offset)) {
        if ($section.Offset -ne $end) { throw 'Unsupported non-contiguous PE section layout.' }
        $end += $section.Size
        if ($end -gt $Bytes.Length) { throw 'Truncated PE section.' }
    }
    return @{
        Checksum = $optional + 64
        Security = $security
        CertificateOffset = [BitConverter]::ToUInt32($Bytes, $security)
        CertificateSize = [BitConverter]::ToUInt32($Bytes, $security + 4)
        ImageEnd = $end
    }
}

function Get-ImageDigest([byte[]]$Bytes, [hashtable]$Layout, [int]$End, [int]$Padding = 0) {
    $hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $hash.AppendData($Bytes, 0, $Layout.Checksum)
        $hash.AppendData($Bytes, $Layout.Checksum + 4, $Layout.Security - $Layout.Checksum - 4)
        $hash.AppendData($Bytes, $Layout.Security + 8, $End - $Layout.Security - 8)
        if ($Padding -gt 0) { $hash.AppendData([byte[]]::new($Padding)) }
        return [Convert]::ToHexString($hash.GetHashAndReset())
    } finally { $hash.Dispose() }
}

$signed = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $SignedPath).Path)
$unsigned = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $UnsignedPath).Path)
$layout = Get-PeLayout $signed
$original = Get-PeLayout $unsigned
if ($original.CertificateOffset -ne 0 -or $original.CertificateSize -ne 0) { throw 'Reference installer must be unsigned.' }
if ($layout.Checksum -ne $original.Checksum -or $layout.Security -ne $original.Security) { throw 'PE layout changed during signing.' }
$certOffset = [int]$layout.CertificateOffset
$certSize = [int]$layout.CertificateSize
if ($certOffset -lt $layout.ImageEnd -or $certOffset % 8 -ne 0 -or $certSize -lt 8 -or [long]$certOffset + $certSize -ne $signed.Length) {
    throw 'Invalid or missing PE certificate table.'
}
$padding = $certOffset - $unsigned.Length
if ($padding -lt 0 -or $padding -gt 7) { throw 'Signing changed the installer payload length.' }
for ($i = $unsigned.Length; $i -lt $certOffset; $i++) {
    if ($signed[$i] -ne 0) { throw 'Nonzero bytes inserted before the certificate.' }
}
$digest = Get-ImageDigest $signed $layout $certOffset
$originalDigest = Get-ImageDigest $unsigned $original $unsigned.Length $padding
if ($digest -ne $originalDigest) { throw 'Signed installer payload differs from the unsigned build.' }

$certificateLength = [BitConverter]::ToUInt32($signed, $certOffset)
if ($certificateLength -le 8 -or $certificateLength -gt $certSize -or $certSize - $certificateLength -gt 7 -or
    [BitConverter]::ToUInt16($signed, $certOffset + 4) -ne 0x200 -or [BitConverter]::ToUInt16($signed, $certOffset + 6) -ne 2) {
    throw 'Expected one PKCS#7 Authenticode certificate.'
}
$cmsBytes = [byte[]]::new($certificateLength - 8)
[Array]::Copy($signed, $certOffset + 8, $cmsBytes, 0, $cmsBytes.Length)
$cms = [Security.Cryptography.Pkcs.SignedCms]::new()
$cms.Decode($cmsBytes)
# CheckSignature(true) verifies the CMS cryptography without adding any trusted root.
$cms.CheckSignature($true)
if ($cms.SignerInfos.Count -ne 1 -or $cms.ContentInfo.ContentType.Value -ne '1.3.6.1.4.1.311.2.1.4') {
    throw 'Unexpected Authenticode content or signer count.'
}
$reader = [System.Formats.Asn1.AsnReader]::new([ReadOnlyMemory[byte]]::new($cms.ContentInfo.Content), [System.Formats.Asn1.AsnEncodingRules]::BER)
$content = $reader.ReadSequence()
$null = $content.ReadEncodedValue()
$digestInfo = $content.ReadSequence()
$algorithm = $digestInfo.ReadSequence()
if ($algorithm.ReadObjectIdentifier() -ne '2.16.840.1.101.3.4.2.1') { throw 'Expected a SHA-256 Authenticode digest.' }
if ([Convert]::ToHexString($digestInfo.ReadOctetString()) -ne $digest) { throw 'Authenticode digest does not match the installer bytes.' }
$reader.ThrowIfNotEmpty()
$content.ThrowIfNotEmpty()
$digestInfo.ThrowIfNotEmpty()

$signature = Get-AuthenticodeSignature -LiteralPath $SignedPath
if ($signature.Status -notin @('Valid', 'NotTrusted')) { throw "Authenticode validation failed: $($signature.Status)" }
$certificate = $signature.SignerCertificate
if (-not $certificate -or $certificate.Thumbprint -ne $cms.SignerInfos[0].Certificate.Thumbprint) { throw 'Signer certificate mismatch.' }
if ($ExpectedThumbprint -and $certificate.Thumbprint -ne ($ExpectedThumbprint -replace '\s', '')) { throw 'Unexpected signing certificate thumbprint.' }
$eku = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
if ('1.3.6.1.5.5.7.3.3' -notin $eku) { throw 'Signer certificate lacks the code-signing EKU.' }
if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -lt (Get-Date)) { throw 'Test certificate is outside its validity period.' }

$report = [ordered]@{
    file = [IO.Path]::GetFileName($SignedPath)
    sha256 = (Get-FileHash -LiteralPath $SignedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    unsignedSha256 = (Get-FileHash -LiteralPath $UnsignedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    payloadUnchanged = $true
    cmsSignatureVerified = $true
    authenticodeDigestVerified = $true
    windowsTrustStatus = $signature.Status.ToString()
    signerSubject = $certificate.Subject
    signerThumbprint = $certificate.Thumbprint
    certificateExpiresUtc = $certificate.NotAfter.ToUniversalTime().ToString('o')
    productionRelease = $false
}
if ($ReportPath) { $report | ConvertTo-Json | Set-Content -LiteralPath $ReportPath -Encoding utf8 }
$report | ConvertTo-Json
