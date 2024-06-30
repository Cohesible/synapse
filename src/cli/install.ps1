#!/usr/bin/env pwsh
param(
  [String]$Version = "latest",
  [String]$InstallLocation,
  [Switch]$NoPathUpdate = $false,
  [Switch]$NoRegisterInstallation = $false,
  [Switch]$Uninstall = $false
);

# This script is based on Bun's install script

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  Write-Output "Synapse is currently only available for x86 64-bit Windows.`n"
  return 1
}

$ErrorActionPreference = "Stop"
$RegistryKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Synapse"  

# These three environment functions are roughly copied from https://github.com/prefix-dev/pixi/pull/692
# They are used instead of `SetEnvironmentVariable` because of unwanted variable expansions.
function Publish-Env {
  if (-not ("Win32.NativeMethods" -as [Type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
  }
  $HWND_BROADCAST = [IntPtr] 0xffff
  $WM_SETTINGCHANGE = 0x1a
  $result = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST,
    $WM_SETTINGCHANGE,
    [UIntPtr]::Zero,
    "Environment",
    2,
    5000,
    [ref] $result
  ) | Out-Null
}

function Write-Env {
  param([String]$Key, [String]$Value)

  $RegisterKey = Get-Item -Path 'HKCU:'

  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment', $true)
  if ($null -eq $Value) {
    $EnvRegisterKey.DeleteValue($Key)
  } else {
    $RegistryValueKind = if ($Value.Contains('%')) {
      [Microsoft.Win32.RegistryValueKind]::ExpandString
    } elseif ($EnvRegisterKey.GetValue($Key)) {
      $EnvRegisterKey.GetValueKind($Key)
    } else {
      [Microsoft.Win32.RegistryValueKind]::String
    }
    $EnvRegisterKey.SetValue($Key, $Value, $RegistryValueKind)
  }

  Publish-Env
}

function Get-Env {
  param([String] $Key)

  $RegisterKey = Get-Item -Path 'HKCU:'
  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment')
  $EnvRegisterKey.GetValue($Key, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Install-Synapse {
  param(
    [string]$Version
  );

  $IsArchive = $false
  $IsUrl = $false

  if ($Version -match "^\d+\.\d+\.\d+$") {
    $Version = "v$Version"
  }
  elseif ($Version -match "^v\d+\.\d+\.\d+$") {
    # noop
  }
  elseif ($Version -match "^https:") {
    $IsUrl = $true
  }
  else {
    $IsArchive = $Version -ne "latest"
  }

  $Arch = "x64"
  $DefaultInstallDir = if ($env:SYNAPSE_INSTALL) { $env:SYNAPSE_INSTALL } else { "${Home}\.synapse" }
  $InstallDir = if ($InstallLocation) { $InstallLocation } else { $DefaultInstallDir }
  mkdir -Force "${InstallDir}"

  try {
    Remove-Item "${InstallDir}\app" -Force -Recurse
  } catch [System.Management.Automation.ItemNotFoundException] {
    # ignore
  } catch [System.UnauthorizedAccessException] {
    $openProcesses = Get-Process -Name synapse | Where-Object { $_.Path -eq "${InstallDir}\bin\synapse.exe" }
    if ($openProcesses.Count -gt 0) {
      Write-Output "Failed to remove existing installation because Synapse is running. Stop all processes and try again."
      return 1
    }
    Write-Output "An unknown error occurred while trying to remove the existing installation"
    Write-Output $_
    return 1
  } catch {
    Write-Output "An unknown error occurred while trying to remove the existing installation"
    Write-Output $_
    return 1
  }

  if (-not $IsArchive) {
    $Target = "synapse-windows-$Arch"
    $BaseURL = "https://github.com/Cohesible/synapse/releases"
    $URL = if ($IsUrl) { $Version } else {
        "$BaseURL/$(if ($Version -eq "latest") { "latest/download" } else { "download/$Version" })/$Target.zip"
    }

    $ZipPath = "${InstallDir}\$Target.zip"

    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue

    try {
      curl.exe "-#SfLo" "$ZipPath" "$URL" 
    } catch {
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "The command 'curl.exe' exited with code ${LASTEXITCODE}`nTrying an alternative download method..."
        }

        try {
            Invoke-RestMethod -Uri $URL -OutFile $ZipPath
        } catch {
            Write-Output "Install Failed - could not download $URL"
            Write-Output "The command 'Invoke-RestMethod $URL -OutFile $ZipPath' exited with code ${LASTEXITCODE}`n"
            return 1
        }
    }
  } 
  else {
    $ZipPath = $Version
  }


  if (!(Test-Path $ZipPath)) {
    Write-Output "Install Failed - could not download $URL"
    Write-Output "The file '$ZipPath' does not exist.`n"
    return 1
  }

  $Target = "synapse-windows-$Arch"
  $Node = ""

  try {
    $lastProgressPreference = $global:ProgressPreference
    $global:ProgressPreference = 'SilentlyContinue';
    Expand-Archive "$ZipPath" "$InstallDir" -Force
    $global:ProgressPreference = $lastProgressPreference
    Rename-Item -Path "$InstallDir\$Target" -NewName "app"
    if (Test-Path "${InstallDir}\app\bin\synapse.exe") {
        $Node = "${InstallDir}\app\bin\synapse.exe"
    }
    elseif (Test-Path "${InstallDir}\app\bin\node.exe") { # Bootstrap
        $Node = "${InstallDir}\app\bin\node.exe"
    }
    else {
        throw "The file '${InstallDir}\app\bin\synapse.exe' does not exist. Download might be corrupt or intercepted by antivirus.`n"
    }
  } catch {
    Write-Output "Install Failed - could not unzip $ZipPath"
    Write-Error $_
    return 1
  }

  if (!$IsArchive) {
    Remove-Item $ZipPath -Force
  }

  $proc = Start-Process -Wait -PassThru -NoNewWindow -FilePath "$Node" -ArgumentList "${InstallDir}\app\dist\install.js","$InstallDir","$InstallDir\app"
  if ($proc.ExitCode -ne 0) {
    if ($proc.ExitCode -eq 2) {
      throw "Failed to finish install due to insufficient permissions. Try running as adminstrator."
    }
    throw "Failed to finish install"
  }

  # if (($LASTEXITCODE -eq 3221225781) -or ($LASTEXITCODE -eq -1073741515)) # STATUS_DLL_NOT_FOUND
  # if ($LASTEXITCODE -eq 1073741795) { # STATUS_ILLEGAL_INSTRUCTION

  $installedVersion = "$(& "${InstallDir}\bin\synapse.exe" --version)"

  if (-not $NoRegisterInstallation) {
    $rootKey = $null
    try {
      $rootKey = New-Item -Path $RegistryKey -Force
      New-ItemProperty -Path $RegistryKey -Name "Publisher" -Value "Cohesible, Inc." -PropertyType String -Force | Out-Null
      # New-ItemProperty -Path $RegistryKey -Name "EstimatedSize" -Value 0 -PropertyType DWord -Force | Out-Null
      # $currentDate = Get-Date -Format FileDate
      # New-ItemProperty -Path $RegistryKey -Name "InstallDate" -Value $currentDate -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $RegistryKey -Name "DisplayName" -Value "Synapse" -PropertyType String -Force | Out-Null
      # Set-ItemProperty -Path $RegistryKey -Name "DisplayVersion" -Value "${installedVersion}" -PropertyType String -Force | Out-Null
      New-ItemProperty -Path $RegistryKey -Name "InstallLocation" -Value "${InstallDir}" -PropertyType String -Force | Out-Null
      # New-ItemProperty -Path $RegistryKey -Name "DisplayIcon" -Value "$InstallDir\bin\synapse.exe" -PropertyType String -Force | Out-Null

      # New-ItemProperty -Path $RegistryKey -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
      # New-ItemProperty -Path $RegistryKey -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null

      if (Test-Path "${InstallDir}\app\dist\install.ps1") {
        Copy-Item "${InstallDir}\app\dist\install.ps1" -Destination "$InstallDir" -Force
        New-ItemProperty -Path $RegistryKey -Name "UninstallString" -Value "powershell -c `"& `'$InstallDir\install.ps1`' -Uninstall -PauseOnError`"" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $RegistryKey -Name "QuietUninstallString" -Value "powershell -c `"& `'$InstallDir\install.ps1`' -Uninstall -PauseOnError`"" -PropertyType String -Force | Out-Null
      }
    } catch {
      Write-Output "Failed to install to registry:"
      Write-Output $_
      if ($rootKey -ne $null) {
        Remove-Item -Path $RegistryKey -Force
      }
    }
  } else {
    Write-Output "Skipped registering installation`n" 
  }

  try {
    $cmd = Get-Command synapse
    $previousInstall = Split-Path -Parent $cmd.Source
  } catch {}

  $Path = (Get-Env -Key "Path") -split ';'
  if ($previousInstall) {
      $Path = $Path | where { $_ -ne $previousInstall }
  }
  if ($Path -notcontains "$InstallDir\bin") {
    if (-not $NoPathUpdate) {
      $Path += "$InstallDir\bin"
      Write-Env -Key 'Path' -Value ($Path -join ';')
      # $env:PATH = ($Path -join ';');
    } else {
      Write-Output "Skipped adding '${InstallDir}\bin' to %PATH%`n"
    }
  }

  $C_RESET = [char]27 + "[0m"
  $C_GREEN = [char]27 + "[1;32m"

  Write-Output ""
  Write-Output "${C_GREEN}Installed ${installedVersion}${C_RESET}"
  if (!$previousInstall) {
    Write-Output "Restart your editor/terminal and type `"synapse`" to get started`n"
  } elseif ($previousInstall -ne "${InstallDir}\bin") {
    Write-Output "The install directory has changed. Restart your editor/terminal to apply these changes.`n"
  }

  $LASTEXITCODE = 0;
}

function Uninstall-Synapse {
  Write-Output "Uninstalling..."

  $cmd = Get-Command synapse
  $previousInstall = Split-Path -Parent $cmd.Source
  $Path = (Get-Env -Key "Path") -split ';'
  $Path = $Path | where { $_ -ne $previousInstall }
  Write-Env -Key 'Path' -Value ($Path -join ';')

  $installDir = Get-ItemPropertyValue -Path $RegistryKey -Name "InstallLocation"
  Remove-Item -Force -Recurse $installDir

  Remove-Item -Path $RegistryKey -Force
}

if ($Uninstall -eq $true) {
  Uninstall-Synapse
} else {
  Install-Synapse -Version $Version
}
