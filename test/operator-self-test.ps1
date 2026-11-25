# Invoke-OperatorSelfTest, dot-sourced by the installer, MSI and runtime tests: opens and closes the
# installed WPF window (DriveIt.Operator.exe --self-test) and returns what it reported. Every run
# checks the settings drawer (spec #23): the main window without the time limit (AC-3), and the
# drawer opened and closed by Close, Esc and a click outside (AC-1). -DrawerWrites adds AC-2 and
# AC-6; it saves limits, so run it only with DRIVE_IT_DATA_DIR set to a throwaway directory.
# -Screenshots <dir> saves the window and the open drawer in each theme as PNGs.
# -DetectAgents adds AC-11: it presses Detect agents, which writes the current user's MCP client
# configurations, so pass -ClientProfile <dir> (a throwaway APPDATA and CODEX_HOME for the window's
# operator.js: Claude Desktop, both builds, and Codex/ChatGPT) unless the caller has put stand-in client
# files in place. USERPROFILE is not redirected: Windows expands the window's own LocalAppData from it,
# where the window reads the install mode, so Claude Code's ~\.claude.json stays the real one, which the
# install itself already registers.
# -StagedActions adds spec #13 AC-18's window half and the Require dry run switch: it turns the setting on
# and off, fails a save, and writes dry-run receipts into run history, so run it only with DRIVE_IT_DATA_DIR
# set to a throwaway directory. With -Screenshots it also saves the switch and Staged Actions mode.

function Invoke-OperatorSelfTest {
    # Opens and closes the installed WPF window in both themes against the installed operator.js.
    # With -Dotnet, $Exe is the window's DLL, run through that dotnet.exe.
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Report, [string]$Dotnet, [switch]$DrawerWrites, [string]$Screenshots,
        [switch]$DetectAgents, [string]$ClientProfile, [switch]$StagedActions)
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
    if ($DetectAgents) {
        $arguments += '--detect-agents'
    }
    if ($StagedActions) {
        $arguments += '--staged-actions'
    }
    if ($Dotnet) {
        $file = $Dotnet
        $arguments = @(('"' + $Exe + '"')) + $arguments
    }
    # The window's operator.js reads these client locations; the window itself does not.
    $saved = @{ APPDATA = $env:APPDATA; CODEX_HOME = $env:CODEX_HOME }
    if ($ClientProfile) {
        $env:APPDATA = Join-Path $ClientProfile 'roaming'
        $env:CODEX_HOME = Join-Path $ClientProfile 'codex'
        [IO.Directory]::CreateDirectory($env:APPDATA) | Out-Null
    }
    try {
        $process = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
    } finally {
        foreach ($name in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
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
        if ($DetectAgents) {
            Assert-OperatorAgents -Window $window -Text $text
        }
        if ($StagedActions) {
            Assert-OperatorStaged -Window $window -Text $text
        }
    }
    if ($Screenshots) {
        $names = @('light-main', 'light-settings', 'dark-main', 'dark-settings')
        if ($DetectAgents) {
            $names += @('light-agents', 'dark-agents')
        }
        if ($StagedActions) {
            $names += @('light-settings-require', 'light-staged', 'light-staged-failed', 'dark-settings-require', 'dark-staged', 'dark-staged-failed')
        }
        foreach ($name in $names) {
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

function Assert-OperatorAgents {
    # AC-11: the Agents row lists one result per client with the button disabled while it runs, and a
    # window naming a missing mcp.json shows the failure by the row. Callers check each client's status.
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Text)
    $agents = $Window.agents
    if ($null -eq $agents) {
        throw "The self-test did not press Detect agents ($($Window.theme)): $Text"
    }
    $results = @($agents.results)
    $clients = @($results | ForEach-Object { $_.client })
    $checks = [ordered]@{
        agentsRow            = @($agents.rows) -contains 'Agents'
        disabledWhileRunning = [bool]$agents.disabledWhileRunning
        enabledAfter         = [bool]$agents.enabledAfter
        noError              = $null -eq $agents.error
        everyClient          = ($clients -contains 'claude-desktop') -and ($clients -contains 'claude-code') -and ($clients -contains 'codex')
        plainLines           = @($results | Where-Object { $_.status -notin @('added', 'already', 'not_installed', 'failed') -or [string]::IsNullOrWhiteSpace($_.message) }).Count -eq 0
        failureByTheRow      = ([string]$agents.failure.error) -match 'mcp\.json does not exist' -and $agents.failure.results -eq 0 -and [bool]$agents.failure.enabledAfter
    }
    $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
    if ($failed.Count -gt 0) {
        throw "Detect agents ($($Window.theme)) failed $($failed -join ', '): $($agents | ConvertTo-Json -Compress -Depth 5)"
    }
}

function Assert-OperatorStaged {
    # Spec #13 AC-18 (the window's half) and "The drawer row": off shows no switcher; the switch saves on and
    # shows the switcher; Staged Actions says there is no dry run, then shows one as readable lines with no
    # JSON, the same one after Home and back, Applied after the same call ran for real, a newer failed one with
    # its error, and the dry run the add-in names once it lands; a failed save reverts the switch with the
    # error by the row; off hides the switcher and returns to Home.
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Text)
    $staged = $Window.staged
    if ($null -eq $staged) {
        throw "The self-test did not run Staged Actions ($($Window.theme)): $Text"
    }
    $firstText = @($staged.first.text)
    $failedText = @($staged.failed.text)
    $checks = [ordered]@{
        offNoSwitcher       = -not $staged.off.switcherShown -and $staged.off.mode -eq 'Home'
        switchRow           = @($staged.turnedOn.rows) -contains 'Require dry run'
        savedOn             = -not $staged.turnedOn.switchBefore -and [bool]$staged.turnedOn.switchOn -and [bool]$staged.turnedOn.stored -and $null -eq $staged.turnedOn.error
        switcherOnHome      = [bool]$staged.on.switcherShown -and $staged.on.mode -eq 'Home'
        noneYet             = $staged.none.mode -eq 'StagedActions' -and [bool]$staged.none.noneShown -and $null -eq $staged.none.error
        showsDryRun         = $staged.first.runId -eq $staged.dry -and -not $staged.first.applied -and $null -eq $staged.first.error
        readableGroups      = ($firstText -contains 'Created (3)') -and ($firstText -contains 'Modified (2)') -and ($firstText -contains 'Deleted (1)') -and ($firstText -contains 'Mark: D12 → D14')
        noJson              = [bool]$staged.first.noJson
        homeAndBack         = $staged.home -eq 'Home' -and $staged.back -eq $staged.dry
        appliedBadge        = $staged.applied.runId -eq $staged.dry -and [bool]$staged.applied.applied
        failedReplaces      = $staged.failed.runId -eq $staged.failedId -and [bool]$staged.failed.failed -and -not $staged.failed.applied -and ($failedText -contains 'The door schedule has no level 2 doors.')
        waitsForNamedRun    = $staged.waited -eq $staged.laterId
        failedSaveReverts   = -not [string]::IsNullOrEmpty($staged.failedSave.error) -and [bool]$staged.failedSave.switchOn -and [bool]$staged.failedSave.switcherShown
        savedOff            = -not $staged.turnedOff.switchOn -and -not $staged.turnedOff.stored -and $null -eq $staged.turnedOff.error
        offReturnsHome      = -not $staged.offAgain.switcherShown -and $staged.offAgain.mode -eq 'Home'
    }
    $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
    if ($failed.Count -gt 0) {
        throw "Staged Actions ($($Window.theme)) failed $($failed -join ', '): $($staged | ConvertTo-Json -Compress -Depth 6)"
    }
}

function Get-OperatorAgentStatus {
    # The statuses Detect agents reported for one client id in one window, in order.
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][string]$Client)
    return @(@($Window.agents.results) | Where-Object { $_.client -eq $Client } | ForEach-Object { $_.status })
}
