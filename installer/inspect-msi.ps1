<#
  inspect-msi.ps1 - check a built Drive-It MSI against the RST companion contract (Windows only).
  Adapted from splash-it installer/inspect-msi.ps1 (splash-it commit ad7796d), which mirrors
  rst-c companions/README.md "Re-verifying C1-C7" and installer-bundle/ci-bundle-smoke.ps1.
  Changes: Drive-It's identity; one Revit year (2026); no per-file list (the MSI harvests the
  package folder); checks the ARP icon and links, the process-stop action, and the size limit.

    powershell -File installer/inspect-msi.ps1 -Msi <path.msi> -Version 1.2.3
    powershell -File installer/inspect-msi.ps1 -Msi <path.msi> -Version 1.2.3-rc.1 -Name DriveIt-1.2.3-rc.1.msi

  Reads the MSI database through the Windows Installer COM API. Fails unless:
    - C1: per-user and no elevation: summary Word Count has bit 8, and ALLUSERS is absent from
      the Property table (or is 2 with MSIINSTALLPERUSER=1); an x64 package;
    - C2: UpgradeCode is 6561188A-BD8D-43A9-B116-BA0894F8001B; Manufacturer is Designs/OS;
    - C3: the Upgrade table holds exactly the two MajorUpgrade rows: WIX_UPGRADE_DETECTED removes
      every version up to and including this one, WIX_DOWNGRADE_DETECTED only detects newer ones;
      RemoveExistingProducts runs after InstallInitialize and before InstallFiles (inside the
      install transaction, as RST.msi: a failed upgrade rolls the removal back), and
      REINSTALLMODE is 'amus' so a file whose version went down is still installed;
    - ProductName is exactly 'Drive-It' (= ARP DisplayName = RST registry name);
    - ProductVersion is 3-part numeric and equals the numeric a.b.c of -Version (for a full
      release tag, the tag without its v);
    - ARPPRODUCTICON names an Icon row, and ARPHELPLINK, ARPURLINFOABOUT, ARPURLUPDATEINFO are
      Drive-It's links;
    - REVIT2026FOUND comes from exactly the two Revit.exe searches (uninstall-key InstallLocation,
      64-bit, and [ProgramFiles64Folder]Autodesk\Revit 2026), the LaunchCondition table holds
      'Installed OR REVIT2026FOUND' (plus at most MajorUpgrade's downgrade check), and the admin
      sequences suppress LaunchConditions;
    - C4: StopDriveItProcesses is an immediate action before InstallValidate (and so before
      RemoveExistingProducts);
    - the file is at most 450 MB (the contract limit is 512 MB; the margin is for the bundled
      Node.js and Python), and, with -Name, is named exactly that.
  CI (_build.yml) runs it on every MSI it builds, before signing and upload.
#>
param(
  [Parameter(Mandatory = $true)] [string] $Msi,
  [Parameter(Mandatory = $true)] [string] $Version,
  [string] $Name
)

$ErrorActionPreference = 'Stop'
# Drive-It's UpgradeCode (installer/DriveIt.wxs). NEVER changes.
$UpgradeCode = '{6561188A-BD8D-43A9-B116-BA0894F8001B}'
$ProductName = 'Drive-It'
$Links = [ordered]@{
  ARPHELPLINK      = 'https://github.com/jedbjorn/drive-it#install'
  ARPURLINFOABOUT  = 'https://github.com/jedbjorn/drive-it'
  ARPURLUPDATEINFO = 'https://github.com/jedbjorn/drive-it/releases/latest'
}
$LaunchCondition = 'Installed OR REVIT2026FOUND'
$MaxBytes = 450MB
$LocatorTypeDirectory64 = 16   # msidbLocatorTypeDirectory (0) + msidbLocatorType64bit (16)
$msidbCustomActionTypeInScript = 0x400

function Invoke-Com($obj, [string] $member, [System.Reflection.BindingFlags] $kind, [object[]] $argList = @()) {
  return $obj.GetType().InvokeMember($member, $kind, $null, $obj, $argList)
}
$Call = [System.Reflection.BindingFlags]::InvokeMethod
$Get = [System.Reflection.BindingFlags]::GetProperty

$msiFull = (Resolve-Path -LiteralPath $Msi).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = Invoke-Com $installer 'OpenDatabase' $Call @($msiFull, 0)

function Query([string] $sql, [int] $columns) {
  $view = Invoke-Com $db 'OpenView' $Call @($sql)
  Invoke-Com $view 'Execute' $Call | Out-Null
  $rows = @()
  while ($true) {
    $rec = Invoke-Com $view 'Fetch' $Call
    if ($null -eq $rec) { break }
    $row = @()
    for ($c = 1; $c -le $columns; $c++) { $row += , (Invoke-Com $rec 'StringData' $Get @($c)) }
    $rows += , $row
  }
  Invoke-Com $view 'Close' $Call | Out-Null
  return , $rows
}
function Test-Table([string] $table) {
  return (Query "SELECT ``Name`` FROM ``_Tables`` WHERE ``Name`` = '$table'" 1).Count -eq 1
}

$props = @{}
foreach ($r in (Query 'SELECT `Property`, `Value` FROM `Property`' 2)) { $props[$r[0]] = $r[1] }
$summary = Invoke-Com $db 'SummaryInformation' $Get @(0)
$wordCount = [int](Invoke-Com $summary 'Property' $Get @(15))
$template = Invoke-Com $summary 'Property' $Get @(7)
$size = (Get-Item -LiteralPath $msiFull).Length

Write-Host "MSI:              $msiFull ($([math]::Round($size / 1MB, 1)) MB)"
Write-Host "ProductName:      $($props['ProductName'])"
Write-Host "Manufacturer:     $($props['Manufacturer'])"
Write-Host "ProductVersion:   $($props['ProductVersion'])"
Write-Host "UpgradeCode:      $($props['UpgradeCode'])"
Write-Host "ProductCode:      $($props['ProductCode'])"
Write-Host "ALLUSERS:         '$($props['ALLUSERS'])'  MSIINSTALLPERUSER: '$($props['MSIINSTALLPERUSER'])'"
Write-Host "Template:         $template   Word Count: $wordCount (bit 8 = no elevation required)"
Write-Host "ARPPRODUCTICON:   $($props['ARPPRODUCTICON'])"
foreach ($key in $Links.Keys) { Write-Host ("{0,-17} {1}" -f "${key}:", $props[$key]) }

$problems = @()

# Identity (C2) and name.
if ($props['UpgradeCode'] -ne $UpgradeCode) { $problems += "UpgradeCode is $($props['UpgradeCode']), expected $UpgradeCode" }
if ($props['ProductName'] -cne $ProductName) { $problems += "ProductName is '$($props['ProductName'])', expected '$ProductName'" }
if ($props['Manufacturer'] -ne 'Designs/OS') { $problems += "Manufacturer is '$($props['Manufacturer'])', expected 'Designs/OS'" }

# Per-user, no elevation (C1).
if ($props.ContainsKey('ALLUSERS')) {
  if ($props['ALLUSERS'] -ne '2' -or $props['MSIINSTALLPERUSER'] -ne '1') {
    $problems += "ALLUSERS is '$($props['ALLUSERS'])' with MSIINSTALLPERUSER '$($props['MSIINSTALLPERUSER'])'; a per-user package has no ALLUSERS (or 2 with MSIINSTALLPERUSER=1)"
  }
}
if (($wordCount -band 8) -eq 0) { $problems += "summary Word Count ${wordCount}: the package requests elevation" }
if (($template -split ';')[0] -ne 'x64') { $problems += "Template is '$template', expected an x64 package" }

# Version: 3-part, equal to the numeric a.b.c of -Version.
$numeric = [regex]::Match($Version, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?=$|-)').Value
if (-not $numeric) { $problems += "-Version '$Version' does not start with a numeric a.b.c" }
if ($props['ProductVersion'] -notmatch '^\d+\.\d+\.\d+$') { $problems += "ProductVersion '$($props['ProductVersion'])' is not 3-part numeric" }
if ($props['ProductVersion'] -ne $numeric) { $problems += "ProductVersion is $($props['ProductVersion']), expected $numeric (from $Version)" }

# File name and size.
if ($Name -and (Split-Path -Leaf $msiFull) -cne $Name) { $problems += "MSI is named $(Split-Path -Leaf $msiFull), expected $Name" }
if ($size -gt $MaxBytes) { $problems += "MSI is $size bytes, over the $MaxBytes-byte (450 MB) limit" }

# Settings > Apps icon and links.
$icons = @(foreach ($r in (Query 'SELECT `Name` FROM `Icon`' 1)) { $r[0] })
if (-not $props['ARPPRODUCTICON']) {
  $problems += 'ARPPRODUCTICON is not set'
} elseif ($icons -notcontains $props['ARPPRODUCTICON']) {
  $problems += "ARPPRODUCTICON '$($props['ARPPRODUCTICON'])' is not in the Icon table ($($icons -join ', '))"
}
foreach ($key in $Links.Keys) {
  if ($props[$key] -ne $Links[$key]) { $problems += "$key is '$($props[$key])', expected '$($Links[$key])'" }
}

# Major upgrade (C3): exactly MajorUpgrade's two rows (AllowSameVersionUpgrades="yes").
$msidbUpgradeAttributesOnlyDetect = 2
$msidbUpgradeAttributesVersionMinInclusive = 256
$msidbUpgradeAttributesVersionMaxInclusive = 512
$upgrades = Query 'SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Attributes`, `ActionProperty` FROM `Upgrade`' 5
Write-Host "Upgrade rows ($($upgrades.Count)):"
$upgrades | ForEach-Object { Write-Host "  $($_[0])  min '$($_[1])'  max '$($_[2])'  attr $($_[3])  -> $($_[4])" }
$pv = $props['ProductVersion']
$older = @($upgrades | Where-Object { $_[4] -eq 'WIX_UPGRADE_DETECTED' })
$newer = @($upgrades | Where-Object { $_[4] -eq 'WIX_DOWNGRADE_DETECTED' })
if ($upgrades.Count -ne 2) { $problems += "Upgrade table has $($upgrades.Count) rows, expected 2" }
foreach ($r in $upgrades) {
  if ($r[0] -ne $UpgradeCode) { $problems += "Upgrade row for $($r[4]) has UpgradeCode $($r[0]), expected $UpgradeCode" }
}
if ($older.Count -ne 1) {
  $problems += 'Upgrade table has no single WIX_UPGRADE_DETECTED row (removal of older versions)'
} else {
  $a = [int]$older[0][3]
  if ($older[0][1] -or $older[0][2] -ne $pv -or ($a -band $msidbUpgradeAttributesVersionMaxInclusive) -eq 0 -or
      ($a -band $msidbUpgradeAttributesOnlyDetect) -ne 0) {
    $problems += "WIX_UPGRADE_DETECTED row must remove every version up to and including $pv (min '$($older[0][1])', max '$($older[0][2])', attributes $a)"
  }
}
if ($newer.Count -ne 1) {
  $problems += 'Upgrade table has no single WIX_DOWNGRADE_DETECTED row (downgrade check)'
} else {
  $a = [int]$newer[0][3]
  if ($newer[0][1] -ne $pv -or $newer[0][2] -or ($a -band $msidbUpgradeAttributesOnlyDetect) -eq 0 -or
      ($a -band $msidbUpgradeAttributesVersionMinInclusive) -ne 0) {
    $problems += "WIX_DOWNGRADE_DETECTED row must only detect versions above $pv (min '$($newer[0][1])', max '$($newer[0][2])', attributes $a)"
  }
}

$execSeq = @{}
foreach ($r in (Query 'SELECT `Action`, `Sequence` FROM `InstallExecuteSequence`' 2)) { $execSeq[$r[0]] = [int]$r[1] }
$rep = $execSeq['RemoveExistingProducts']
$stop = $execSeq['StopDriveItProcesses']
Write-Host ("InstallExecuteSequence: StopDriveItProcesses {0}, InstallValidate {1}, InstallInitialize {2}, RemoveExistingProducts {3}, InstallFiles {4}" -f `
  $stop, $execSeq['InstallValidate'], $execSeq['InstallInitialize'], $rep, $execSeq['InstallFiles'])
if ($null -eq $rep) {
  $problems += 'RemoveExistingProducts is not in InstallExecuteSequence'
} elseif (-not ($execSeq['InstallInitialize'] -lt $rep -and $rep -lt $execSeq['InstallFiles'])) {
  $problems += "RemoveExistingProducts ($rep) is not between InstallInitialize and InstallFiles, where a failed upgrade rolls it back"
}
if ($props['REINSTALLMODE'] -ne 'amus') {
  $problems += "REINSTALLMODE is '$($props['REINSTALLMODE'])', expected 'amus' (an upgrade over a higher file version would drop that file)"
}

# No-reboot upgrade and uninstall (C4): Drive-It's own processes stop before InstallValidate.
$stopAction = Query "SELECT ``Type``, ``Source``, ``Target`` FROM ``CustomAction`` WHERE ``Action`` = 'StopDriveItProcesses'" 3
if ($null -eq $stop -or $stopAction.Count -ne 1) {
  $problems += 'StopDriveItProcesses is not scheduled in InstallExecuteSequence'
} else {
  if ($stop -ge $execSeq['InstallValidate']) { $problems += "StopDriveItProcesses ($stop) does not run before InstallValidate ($($execSeq['InstallValidate']))" }
  if (([int]$stopAction[0][0] -band $msidbCustomActionTypeInScript) -ne 0) { $problems += 'StopDriveItProcesses is deferred; it must be immediate to precede RemoveExistingProducts' }
  if ($props['WixQuietExecCmdLine'] -notmatch ' -EncodedCommand [A-Za-z0-9+/=]{40,}$') { $problems += 'StopDriveItProcesses has no embedded stop command (WixQuietExecCmdLine)' }
}

# Revit 2026 detection: REVIT2026FOUND from the two Revit.exe file searches.
$appSearch = Query 'SELECT `Property`, `Signature_` FROM `AppSearch`' 2
$sigFile = @{}
foreach ($r in (Query 'SELECT `Signature`, `FileName` FROM `Signature`' 2)) { $sigFile[$r[0]] = ($r[1] -split '\|')[-1] }
$drLoc = @{}
foreach ($r in (Query 'SELECT `Signature_`, `Parent`, `Path`, `Depth` FROM `DrLocator`' 4)) {
  $drLoc[$r[0]] = @{ Parent = $r[1]; Path = $r[2]; Depth = $r[3] }
}
$regLoc = @{}
foreach ($r in (Query 'SELECT `Signature_`, `Root`, `Key`, `Name`, `Type` FROM `RegLocator`' 5)) {
  $regLoc[$r[0]] = @{ Root = [int]$r[1]; Key = $r[2]; Name = $r[3]; Type = [int]$r[4] }
}
Write-Host 'Revit detection (AppSearch):'
$prop = 'REVIT2026FOUND'
$sigs = @($appSearch | Where-Object { $_[0] -eq $prop } | ForEach-Object { $_[1] })
$uninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7346B4A0-2600-0510-0000-705C0D862004}'
$defaultPath = '[ProgramFiles64Folder]Autodesk\Revit 2026'
$viaRegistry = $false
$viaDefault = $false
foreach ($sig in $sigs) {
  $dr = $drLoc[$sig]
  if ($sigFile[$sig] -ne 'Revit.exe' -or $null -eq $dr -or "$($dr.Depth)" -notin @('', '0')) {
    $problems += "$prop search $sig is not a Revit.exe file search at depth 0"
    continue
  }
  $reg = if ($dr.Parent) { $regLoc[$dr.Parent] } else { $null }
  if ($reg -and -not $dr.Path -and $reg.Root -eq 2 -and $reg.Key -eq $uninstallKey -and
      $reg.Name -eq 'InstallLocation' -and $reg.Type -eq $LocatorTypeDirectory64) {
    $viaRegistry = $true
    Write-Host "  $prop <- Revit.exe in HKLM\$($reg.Key) InstallLocation (64-bit)"
  } elseif (-not $dr.Parent -and $dr.Path -eq $defaultPath) {
    $viaDefault = $true
    Write-Host "  $prop <- Revit.exe in $($dr.Path)"
  } else {
    $problems += "$prop search $sig looks in an unexpected place (parent '$($dr.Parent)', path '$($dr.Path)')"
  }
}
if ($sigs.Count -ne 2) { $problems += "$prop has $($sigs.Count) AppSearch rows, expected 2" }
if (-not $viaRegistry) { $problems += "$prop does not search the InstallLocation of $uninstallKey (64-bit)" }
if (-not $viaDefault) { $problems += "$prop does not search $defaultPath" }

# Launch condition: blocks a first install without Revit 2026, never a repair or uninstall.
$launch = Query 'SELECT `Condition`, `Description` FROM `LaunchCondition`' 2
Write-Host "Launch conditions ($($launch.Count)):"
$launch | ForEach-Object { Write-Host "  [$($_[0])] $($_[1])" }
if (@($launch | Where-Object { $_[0] -eq $LaunchCondition }).Count -ne 1) {
  $problems += "LaunchCondition table has no [$LaunchCondition]"
}
foreach ($r in $launch) {
  if ($r[0] -ne $LaunchCondition -and $r[0] -ne 'NOT WIX_DOWNGRADE_DETECTED') {
    $problems += "unexpected launch condition [$($r[0])] '$($r[1])'"
  }
}
if ($null -eq $execSeq['LaunchConditions']) { $problems += 'LaunchConditions is not in InstallExecuteSequence' }
foreach ($table in 'AdminExecuteSequence', 'AdminUISequence') {
  if ((Test-Table $table) -and (Query "SELECT ``Action`` FROM ``$table`` WHERE ``Action`` = 'LaunchConditions'" 1).Count -ne 0) {
    $problems += "$table runs LaunchConditions; an administrative install must not need Revit"
  }
}

if ($problems.Count) {
  $problems | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "MSI contract checks passed: $ProductName $pv, per-user, UpgradeCode $UpgradeCode."
