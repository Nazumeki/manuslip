param([Parameter(Mandatory = $true)][string]$AppGuid)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($AppGuid -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Invalid installer GUID' }

function File-Hash([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Read-Values($Key, [bool]$ExcludeAdvert = $false) {
  $values = [ordered]@{}
  if ($null -eq $Key) { return $values }
  foreach ($name in ($Key.GetValueNames() | Sort-Object)) {
    if ($ExcludeAdvert -and $name -eq 'Manuslip.Markdown') { continue }
    $value = $Key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($value -is [byte[]]) { $value = [Convert]::ToBase64String($value) }
    $values[$name] = @{ kind = $Key.GetValueKind($name).ToString(); value = $value }
  }
  return $values
}

function Read-Tree($Base, [string]$Path, [bool]$ExcludeAdvert = $false) {
  $rows = [ordered]@{}
  $key = $Base.OpenSubKey($Path)
  if ($null -eq $key) { return $rows }
  try {
    $values = Read-Values $key $ExcludeAdvert
    # Treat absent and empty shared keys alike; preserve every actual unrelated value.
    if ($values.Count) { $rows[''] = $values }
    foreach ($name in ($key.GetSubKeyNames() | Sort-Object)) {
      $child = Read-Tree $key $name $ExcludeAdvert
      foreach ($path in $child.Keys) { $rows["$name\$path"] = $child[$path] }
    }
    return $rows
  } finally { $key.Dispose() }
}

function Read-RegistrySnapshot {
  $owned = [ordered]@{}
  $associations = [ordered]@{}
  $advertisements = [ordered]@{}
  $registrations = @()
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry64', 'Registry32')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
      try {
        foreach ($path in @(
          "Software\$AppGuid",
          "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid",
          'Software\Classes\Manuslip.Markdown',
          'Software\Classes\Applications\Manuslip.exe',
          'Software\Classes\AppUserModelId\org.manuslip.desktop',
          'Software\Microsoft\Windows\CurrentVersion\App Paths\Manuslip.exe'
        )) {
          $key = $base.OpenSubKey($path)
          if ($null -ne $key) {
            $key.Dispose()
            $owned["$hive/$view/$path"] = Read-Tree $base $path
          }
        }
        foreach ($ext in @('.md', '.markdown', '.mdown')) {
          $associations["$hive/$view/$ext/classes"] = Read-Tree $base "Software\Classes\$ext" $true
          $associations["$hive/$view/$ext/userChoice"] = Read-Tree $base "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice"
          $adverts = $base.OpenSubKey("Software\Classes\$ext\OpenWithProgids")
        try {
          $advertisements["$hive/$view/$ext"] = $null -ne $adverts -and $adverts.GetValueNames().Contains('Manuslip.Markdown')
        } finally { if ($null -ne $adverts) { $adverts.Dispose() } }
        }
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -ne $uninstall) {
          try {
            foreach ($name in $uninstall.GetSubKeyNames()) {
              $entry = $uninstall.OpenSubKey($name)
              if ($null -eq $entry) { continue }
              try {
                $displayName = $entry.GetValue('DisplayName')
                if ($name -eq $AppGuid -or $displayName -eq 'Manuslip' -or $displayName -match '^Manuslip \d') {
                  $registrations += @{ hive = $hive; view = $view; key = $name; values = (Read-Values $entry) }
                }
              } finally { $entry.Dispose() }
            }
          } finally { $uninstall.Dispose() }
        }
      } finally { $base.Dispose() }
    }
  }
  return @{
    owned = $owned
    associations = $associations
    advertisements = $advertisements
    registrations = $registrations
  }
}

function Read-StableRegistrySnapshot {
  for ($attempt = 0; ; $attempt++) {
    try { return Read-RegistrySnapshot }
    catch {
      # NSIS can delete a key after it is opened. Discard the entire partial
      # snapshot and reopen all handles; unrelated registry errors still fail.
      $exception = $_.Exception
      $deleted = $false
      while ($null -ne $exception) {
        if (($exception.HResult -band 0xffff) -eq 1018) { $deleted = $true }
        $exception = $exception.InnerException
      }
      if (-not $deleted -or $attempt -ge 4) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}
$registry = Read-StableRegistrySnapshot

$shortcuts = [ordered]@{}
foreach ($folder in @('DesktopDirectory', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')) {
  $directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::$folder)
  $path = Join-Path $directory 'Manuslip.lnk'
  $shortcuts[$folder] = @{
    path = $path
    exists = (Test-Path -LiteralPath $path)
    sha256 = $(if (Test-Path -LiteralPath $path) { File-Hash $path } else { $null })
    target = $(if (Test-Path -LiteralPath $path) { (New-Object -ComObject WScript.Shell).CreateShortcut($path).TargetPath } else { $null })
  }
}

$processes = @(Get-Process -Name Manuslip -ErrorAction SilentlyContinue | ForEach-Object {
  @{ pid = $_.Id; path = $_.Path }
})
@{
  owned = $registry.owned
  associations = $registry.associations
  advertisements = $registry.advertisements
  registrations = $registry.registrations
  shortcuts = $shortcuts
  processes = $processes
} | ConvertTo-Json -Depth 30 -Compress
