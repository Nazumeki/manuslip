$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'windows-installer-state.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Invalid registry snapshot helper' }
foreach ($definition in $ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @('Read-Values', 'Read-StableRegistrySnapshot')
}, $false)) {
  . ([scriptblock]::Create($definition.Extent.Text))
}

$script:attempts = 0
$script:mode = 'transient'
$testPath = "Software\ManuslipRegistrySnapshotTest-$([Guid]::NewGuid())"
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
  [Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $key = $base.CreateSubKey($testPath)
  $key.SetValue('sentinel', 'unrelated value')
  # Reproduce ERROR_KEY_DELETED with a real handle, isolated from application keys.
  $base.DeleteSubKeyTree($testPath)
  function Read-RegistrySnapshot {
    $script:attempts++
    if ($script:mode -eq 'denied') { throw [UnauthorizedAccessException]::new('denied') }
    if ($script:mode -eq 'permanent' -or $script:attempts -eq 1) { return Read-Values $key }
    return @{ owned = @{ sentinel = 'fresh snapshot' } }
  }
  $result = Read-StableRegistrySnapshot
  if ($script:attempts -ne 2 -or $result.owned.sentinel -ne 'fresh snapshot') {
    throw 'Deleted key did not trigger a fresh snapshot'
  }
  foreach ($mode in @('permanent', 'denied')) {
    $script:mode = $mode
    $script:attempts = 0
    $failure = $null
    try { $null = Read-StableRegistrySnapshot } catch { $failure = $_ }
    $expected = if ($mode -eq 'permanent') { 5 } else { 1 }
    if ($null -eq $failure -or $script:attempts -ne $expected) {
      throw "Unexpected retry behavior for $mode"
    }
  }
  Write-Output 'Registry snapshots retry deleted keys, stop after five attempts and preserve other errors'
} finally {
  if ($null -ne $key) { $key.Dispose() }
  $base.DeleteSubKeyTree($testPath, $false)
  $base.Dispose()
}
