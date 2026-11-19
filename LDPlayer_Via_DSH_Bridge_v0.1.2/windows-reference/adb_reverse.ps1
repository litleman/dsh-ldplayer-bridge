param(
    [Parameter(Mandatory=$true)][string]$AdbPath,
    [Parameter(Mandatory=$true)][string]$Serial,
    [int]$Port = 18765
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AdbPath)) {
    throw "adb.exe not found: $AdbPath"
}

Write-Host "Checking ADB device..."
& $AdbPath devices -l
if ($LASTEXITCODE -ne 0) { throw "adb devices failed" }

Write-Host "Setting reverse port mapping..."
& $AdbPath -s $Serial reverse "tcp:$Port" "tcp:$Port"
if ($LASTEXITCODE -ne 0) {
    throw "adb reverse failed. Confirm serial, emulator and ADB version."
}

Write-Host "Current reverse mappings:"
& $AdbPath -s $Serial reverse --list
