param([switch]$Apply)

$ErrorActionPreference = "Continue"
$association = "{9e6136e0-57ab-4949-b57a-3627be142855},100"

function Get-VoiceDevices {
  @(Get-PnpDevice -Class AudioProcessingObject -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match "VocaEffectPack" })
}

function Get-CaptureLinks {
  $found = @()
  $root = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture"
  if (-not (Test-Path $root)) { return $found }
  foreach ($endpoint in Get-ChildItem $root -ErrorAction SilentlyContinue) {
    $fx = Join-Path $endpoint.PSPath "FxProperties"
    if (-not (Test-Path $fx)) { continue }
    $item = Get-Item $fx
    if ($item.GetValueNames() -notcontains $association) { continue }
    $value = [string]$item.GetValue($association)
    if ($value -notmatch "VocaEffectPack") { continue }
    $found += [pscustomobject]@{
      SubKey = "SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\" + $endpoint.PSChildName + "\FxProperties"
      Value = $value
    }
  }
  return $found
}

$devices = @(Get-VoiceDevices)
$live = $devices | Where-Object { $_.Status -eq "OK" } | Select-Object -First 1
$liveId = if ($live) { [string]$live.InstanceId } else { "" }
$broken = @(Get-CaptureLinks | Where-Object {
  $value = $_.Value
  -not ($devices | Where-Object { $_.Status -eq "OK" -and $_.InstanceId -eq $value })
})

if (-not $Apply) {
  if ($broken.Count -gt 0 -and $liveId) { exit 10 }
  exit 0
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { exit 5 }
if (-not $liveId -or $broken.Count -eq 0) { exit 0 }

# KEY_WRITE also requests CreateSubKey. This key only grants SetValue, so open with that right alone.
$rights = [System.Security.AccessControl.RegistryRights]::SetValue -bor [System.Security.AccessControl.RegistryRights]::QueryValues
foreach ($link in $broken) {
  try {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($link.SubKey, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rights)
    if ($null -eq $key) { throw "Registrierung nicht schreibbar." }
    $key.SetValue($association, $liveId, [Microsoft.Win32.RegistryValueKind]::String)
    $key.Close()
  } catch {
    exit 6
  }
}

try {
  Restart-Service Audiosrv -Force -ErrorAction Stop
} catch {
  exit 6
}
Start-Sleep -Seconds 2
exit 0
