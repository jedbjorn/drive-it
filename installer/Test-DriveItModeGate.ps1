# The install mode check the MSI runs before InstallValidate (spec #10 "Mode Selection"), so a
# refusal comes before RemoveExistingProducts removes an older version and leaves any existing
# install unchanged. $Mode is DRIVEIT_MODE, set by the command line in DriveIt.wxs ('' when not
# given). It refuses (exit 1) an invalid value, and dev without an elevated administrator token,
# dev being the named mode or else the installed version's recorded mode, read through that
# version's own resolver (server/mode.js). Install-DriveIt.ps1 makes the same checks again for
# script installs and as the MSI's last line of defence. Build-DriveItMsi.ps1 embeds this file
# with comment lines removed, so keep '#' to whole-line comments.
if (-not [string]::IsNullOrEmpty($Mode) -and $Mode -cnotin @('standard', 'dev')) {
    Write-Output "DRIVEIT_MODE (-Mode) must be 'standard' or 'dev', not '$Mode'."
    exit 1
}
$requested = $Mode
$source = 'named'
if ([string]::IsNullOrEmpty($requested)) {
    $requested = 'standard'
    $source = 'recorded'
    $app = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'DriveIt\app'
    $node = Join-Path $app 'runtimes\node\node.exe'
    $resolver = Join-Path $app 'server\mode.js'
    if ([IO.File]::Exists($node) -and [IO.File]::Exists($resolver)) {
        $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
        $env:ProgramData = [Environment]::GetFolderPath('CommonApplicationData')
        $recorded = & $node $resolver 2>$null | Out-String
        try {
            if ($LASTEXITCODE -eq 0 -and ($recorded | ConvertFrom-Json).mode -ceq 'dev') {
                $requested = 'dev'
            }
        } catch {
            $requested = 'standard'
        }
    }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$integrity = [regex]::Match((& whoami.exe /groups 2>$null | Out-String), 'S-1-16-\d+').Value
Write-Output "Drive-It mode check: $requested ($source), user $($identity.Name), integrity $integrity, elevated administrator $elevated"
if ($requested -eq 'dev' -and -not $elevated) {
    $leave = if ($source -eq 'recorded') { ' This install is in Dev Mode; upgrade or repair it elevated, or install with DRIVEIT_MODE=standard to leave Dev Mode.' } else { '' }
    Write-Output "Dev Mode must be installed from an elevated administrator prompt.$leave"
    exit 1
}
exit 0
