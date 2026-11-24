# Invoke-OperatorSelfTest, dot-sourced by the installer, MSI and runtime tests: opens and closes the
# installed WPF window (DriveIt.Operator.exe --self-test) and returns what it reported. Every run
# checks the settings drawer (spec #23): the main window without the time limit (AC-3), and the
# drawer opened and closed by Close, Esc and a click outside (AC-1). -DrawerWrites adds AC-2 and
# AC-6; it saves limits, so run it only with DRIVE_IT_DATA_DIR set to a throwaway directory.
# -Screenshots <dir> saves the window and the open drawer in each theme as PNGs.

function Invoke-OperatorSelfTest {
    # Opens and closes the installed WPF window in both themes against the installed operator.js.
    # With -Dotnet, $Exe is the window's DLL, run through that dotnet.exe.
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Report, [string]$Dotnet, [switch]$DrawerWrites, [string]$Screenshots)
    if ([IO.File]::Exists($Report)) {
        Remove-Item -LiteralPath $Report -Force
    }
    $file = $Exe
    $arguments = @('--self-test', ('"' + $Report + '"'))
    if ($DrawerWrites) {
        $arguments += '--drawer-writes'
    }
    if ($Screenshots) {
        $arguments += @('--screenshots', ('"' + $Screenshots + '"'))
    }
    if ($Dotnet) {
        $file = $Dotnet
        $arguments = @(('"' + $Exe + '"')) + $arguments
    }
    $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(180000)) {
        $process.Kill()
        throw 'The operator window self-test did not finish.'
    }
    $text = if ([IO.File]::Exists($Report)) { [IO.File]::ReadAllText($Report) } else { '(no report)' }
    if ($process.ExitCode -ne 0) {
        throw "The operator window self-test failed ($($process.ExitCode)): $text"
    }
    $result = $text | ConvertFrom-Json
    if (-not $result.passed -or @($result.windows).Count -ne 2) {
        throw "The operator window self-test did not open both themes: $text"
    }
    foreach ($window in @($result.windows)) {
        if ($window.title -ne 'Drive-It' -or $null -ne $window.error) {
            throw "The operator window reported a problem: $text"
        }
        Assert-OperatorDrawer -Window $window -Text $text
        if ($DrawerWrites) {
            Assert-OperatorDrawerWrites -Window $window -Text $text
        }
    }
    if ($Screenshots) {
        foreach ($name in @('light-main', 'light-settings', 'dark-main', 'dark-settings')) {
            if (-not [IO.File]::Exists((Join-Path $Screenshots "$name.png"))) {
                throw "The self-test did not save the $name screenshot in $Screenshots."
            }
        }
    }
    return $result
}

function Assert-OperatorDrawer {
    # AC-3: the main window lost only the time limit. AC-1 (and AC-5 under a Dev Mode install): the
    # drawer opened, showed the stored limit and closed each way, with focus back on Settings.
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Text)
    $sections = @($Window.mainWindowSections)
    $expected = @('Workspace root', 'Run history')
    if ($Window.requestsShown) {
        $expected += 'Outside-root requests'
    }
    foreach ($name in $expected) {
        if ($sections -notcontains $name) {
            throw "The main window ($($Window.theme)) is missing '$name': $Text"
        }
    }
    if ($sections -contains 'Script time limit' -or -not $Window.mcpPathShown -or $null -eq $Window.scriptTimeLimitSeconds) {
        throw "The main window ($($Window.theme)) still shows the time limit, lost the MCP path or did not read the limit: $Text"
    }
    $cycles = @($Window.drawer)
    $routes = @($cycles | ForEach-Object { $_.closedBy })
    if (($routes -join ',') -ne 'closeButton,escape,outsideClick') {
        throw "The settings drawer ($($Window.theme)) was not closed each way: $Text"
    }
    $limit = [string]$Window.scriptTimeLimitSeconds
    foreach ($cycle in $cycles) {
        $checks = [ordered]@{
            settingsButtonEnabled = [bool]$cycle.settingsButtonEnabled
            opened                = [bool]$cycle.opened
            focusInDrawer         = [bool]$cycle.focusInDrawer
            timeLimitRow          = @($cycle.rows) -contains 'Script time limit'
            storedLimitShown      = [string]$cycle.shownLimit -eq $limit
            noError               = $null -eq $cycle.error
            closed                = [bool]$cycle.closed
            focusOnSettingsButton = [bool]$cycle.focusOnSettingsButton
        }
        $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
        if ($failed.Count -gt 0) {
            throw "The settings drawer ($($Window.theme), closed by $($cycle.closedBy)) failed $($failed -join ', ') (window limit [$limit]): $($cycle | ConvertTo-Json -Compress -Depth 5)"
        }
    }
}

function Assert-OperatorDrawerWrites {
    # AC-2: 60 saves; 5 and abc show the drawer's error, write nothing and leave 60; a typed value is
    # discarded on close. AC-6: a limit set by operator.js while the drawer is closed shows on reopen.
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Text)
    $writes = $Window.drawerWrites
    if ($null -eq $writes) {
        throw "The self-test did not run the drawer writes ($($Window.theme)): $Text"
    }
    $saved = $writes.saved
    if ($saved.stored -ne 60 -or $saved.shown -ne '60' -or $null -ne $saved.error) {
        throw "The drawer did not save 60 ($($Window.theme)): $($writes | ConvertTo-Json -Compress -Depth 5)"
    }
    $rejected = @($writes.rejected)
    if ((@($rejected | ForEach-Object { $_.text }) -join ',') -ne '5,abc') {
        throw "The drawer did not try 5 and abc ($($Window.theme)): $($writes | ConvertTo-Json -Compress -Depth 5)"
    }
    foreach ($attempt in $rejected) {
        if ([string]::IsNullOrEmpty($attempt.error) -or -not $attempt.unchanged -or $attempt.stored -ne 60 -or $attempt.shown -ne '60') {
            throw "The drawer accepted or wrote '$($attempt.text)' ($($Window.theme)): $($writes | ConvertTo-Json -Compress -Depth 5)"
        }
    }
    if ($writes.typed.shownOnReopen -ne '60' -or $writes.typed.stored -ne 60) {
        throw "The drawer kept a typed, unsaved value ($($Window.theme)): $($writes | ConvertTo-Json -Compress -Depth 5)"
    }
    if ($writes.reread.setByCommandLine -ne 90 -or $writes.reread.shownOnReopen -ne '90' -or $null -ne $writes.reread.error -or -not $writes.closed) {
        throw "The drawer did not re-read the limit on open ($($Window.theme)): $($writes | ConvertTo-Json -Compress -Depth 5)"
    }
}
