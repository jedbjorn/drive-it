<#
  verify-signatures.ps1 - check the Authenticode signatures of a Drive-It MSI and its
  first-party binaries (Windows only).
  Adapted from splash-it installer/verify-signatures.ps1 (splash-it commit ad7796d).
  Changes: Drive-It's first-party pattern (DriveIt.*); folders instead of zips (the release
  zip is packed later, on Linux, from the staged folder checked here); the bundled runtimes
  under app\runtimes\ (Node.js, Python, any private .NET) keep their vendors' signatures and
  are excluded from the first-party rule.

    powershell -File installer/verify-signatures.ps1 -Msi <DriveIt.msi> -Folders <stage>
    powershell -File installer/verify-signatures.ps1 -Msi <DriveIt.msi> -Folders <stage> -Unsigned

  Checks the MSI itself, then every DLL and EXE inside it (extracted with an administrative
  install, msiexec /a: unpacks files only, installs nothing) and inside each folder. Outside
  app\runtimes\, every DLL and EXE must be Drive-It's own (DriveIt.*): any other binary fails
  the check, so none can ship without a decision about signing it.

  Default (a signing tag release): fails unless the MSI and each first-party binary has a
  Valid signature (chain, file hash) whose signer is CN=AnJ Arch-Tech LLC (the sibling
  companions' signer) and which carries an RFC 3161 timestamp.

  -Unsigned (every other build, including a tag release while signing is switched off,
  see RELEASING.md): fails if any of them carries a signature, so a build that did not
  sign can never pass off signed bytes. It also exercises the extraction on every build.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [string[]] $Folders = @(),
  [switch] $Unsigned
)

$ErrorActionPreference = 'Stop'
$Signer = 'AnJ Arch-Tech LLC'
$FirstParty = 'DriveIt.*'

$problems = New-Object System.Collections.Generic.List[string]
$checked = 0

function Test-File([string] $path, [string] $label) {
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  $cn = if ($sig.SignerCertificate) {
    $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { '' }
  $ts = if ($sig.TimeStamperCertificate) {
    $sig.TimeStamperCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } else { '' }
  Write-Host ("  {0,-10} signer '{1}'  timestamp '{2}'  {3}" -f $sig.Status, $cn, $ts, $label)
  $script:checked++
  if ($Unsigned) {
    if ($sig.Status -ne 'NotSigned') { $script:problems.Add("$label is signed (status $($sig.Status), signer '$cn'); this build must be unsigned") }
    return
  }
  if ($sig.Status -ne 'Valid') { $script:problems.Add("$label signature status is $($sig.Status): $($sig.StatusMessage)") }
  if ($cn -ne $Signer) { $script:problems.Add("$label is signed by '$cn', expected '$Signer'") }
  if (-not $ts) { $script:problems.Add("$label has no timestamp") }
}

# Every DLL/EXE under $root outside a runtimes\ folder: each must be first-party, each is checked.
function Test-Tree([string] $root, [string] $label) {
  $rootFull = (Resolve-Path -LiteralPath $root).Path.TrimEnd('\') + '\'
  $pe = @(Get-ChildItem -LiteralPath $root -Recurse -File |
    Where-Object { $_.Extension -in '.dll', '.exe' } | Sort-Object FullName)
  $excluded = 0
  $firstParty = 0
  foreach ($f in $pe) {
    $rel = $f.FullName.Substring($rootFull.Length)
    if ($rel -match '(^|\\)runtimes\\') { $excluded++; continue }
    if ($f.Name -notlike $FirstParty) {
      $script:problems.Add("$label\$rel is not a Drive-It binary ($FirstParty); decide whether it ships and is signed")
      continue
    }
    $firstParty++
    Test-File $f.FullName "$label\$rel"
  }
  Write-Host "  ($excluded bundled runtime binaries under runtimes\ excluded)"
  if ($firstParty -eq 0) { $script:problems.Add("$label holds no Drive-It DLL or EXE") }
}

$mode = if ($Unsigned) { 'unsigned (no signing on this build)' } else { "signed by CN=$Signer, timestamped" }
Write-Host "Expecting: $mode"

$msiFull = (Resolve-Path -LiteralPath $Msi).Path
$msiName = Split-Path -Leaf $msiFull
Write-Host 'MSI:'
Test-File $msiFull $msiName

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('dis-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $extract = Join-Path $work 'msi'
  $log = Join-Path $work 'msi-extract.log'
  $p = Start-Process -FilePath 'msiexec.exe' -Wait -PassThru -ArgumentList @(
    '/a', "`"$msiFull`"", '/qn', "TARGETDIR=`"$extract`"", '/l*v', "`"$log`"")
  if ($p.ExitCode -ne 0) {
    $problems.Add("administrative extract (msiexec /a) of $msiName failed with exit code $($p.ExitCode)")
    if (Test-Path $log) { Get-Content $log -Tail 40 | Write-Host }
  } else {
    Write-Host "Binaries in ${msiName}:"
    Test-Tree $extract $msiName
  }

  foreach ($folder in $Folders) {
    $folderName = Split-Path -Leaf (Resolve-Path -LiteralPath $folder).Path
    Write-Host "Binaries in ${folderName}:"
    Test-Tree $folder $folderName
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "$checked files checked: $mode."
