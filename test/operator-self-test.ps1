# Invoke-OperatorSelfTest, dot-sourced by the installer, MSI and runtime tests: opens and closes the
# installed WPF window (DriveIt.Operator.exe --self-test) and returns what it reported.

function Invoke-OperatorSelfTest {
    # Opens and closes the installed WPF window in both themes against the installed operator.js.
    # With -Dotnet, $Exe is the window's DLL, run through that dotnet.exe.
    param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Report, [string]$Dotnet)
    if ([IO.File]::Exists($Report)) {
        Remove-Item -LiteralPath $Report -Force
    }
    $file = $Exe
    $arguments = @('--self-test', ('"' + $Report + '"'))
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
    }
    return $result
}
