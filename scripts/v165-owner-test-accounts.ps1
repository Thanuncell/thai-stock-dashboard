param([Parameter(Mandatory=$true)][string]$VaultPath,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$stage='preflight'
trap {
  if($VaultPath){[IO.File]::WriteAllText($VaultPath+'.test-accounts.ready.json',(@{saved=$false;stage=$stage;errorType=$_.Exception.GetType().Name}|ConvertTo-Json -Compress))}
  Write-Host 'Test account entry did not complete. Secret values are suppressed.'
  if(!$CheckOnly){Read-Host 'Press Enter to close'|Out-Null}
  exit 1
}
Add-Type -AssemblyName System.Security
$project='mlqbmtycvlbfbszyrsqd'
$full=[IO.Path]::GetFullPath($VaultPath)
if(!$full.EndsWith('.dpapi')){throw 'External DPAPI vault required'}
for($parent=[IO.Path]::GetDirectoryName($full);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){
  if(Test-Path -LiteralPath (Join-Path $parent '.git')){throw 'Vault must be outside Git'}
}
$entropy=[Text.Encoding]::UTF8.GetBytes('SETscope v1.6.5 Dev '+$project)
function Read-DevBundle {
  $plain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($full),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {$value=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json}finally{[Array]::Clear($plain,0,$plain.Length)}
  if($value.projectId -ne $project -or $value.version -ne 1 -or !$value.database){throw 'Dev vault prerequisite unavailable'}
  return $value
}
$bundle=Read-DevBundle
if($CheckOnly){Write-Output 'Synthetic account prompt preflight PASS';exit 0}
$bundle=$null
Write-Host 'SETscope - Owner-created test accounts - DEVELOPMENT ONLY'
Write-Host 'Project: setscope-v165-dev / mlqbmtycvlbfbszyrsqd'
Write-Host 'Create and confirm these two synthetic users in Dev Auth first.'
Write-Host 'This prompt does not create users, change passwords, or request an admin key.'
Write-Host 'Input is hidden. Existing DB, encryption and TLS credentials are preserved.'
$accounts=@()
foreach($email in @('v165-a-01@example.test','v165-b-01@example.test')){
  $stage='awaiting-test-account-password'
  do {
    $secure=Read-Host ('Existing test password for '+$email) -AsSecureString
    if(!$secure.Length){Write-Host 'Enter the existing test password; input cannot be empty.'}
  }while(!$secure.Length)
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {$password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$secure.Dispose()}
  $accounts+=@{email=$email;password=$password}
  $password=$null
}
$stage='saving-test-accounts'
# Reload after Owner input so connection settings saved meanwhile are preserved.
$bundle=Read-DevBundle
$bundle|Add-Member -NotePropertyName testAccounts -NotePropertyValue $accounts -Force
$plain=[Text.Encoding]::UTF8.GetBytes(($bundle|ConvertTo-Json -Depth 8 -Compress))
try {$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($plain,0,$plain.Length)}
$temporary=$full+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
try {[IO.File]::WriteAllBytes($temporary,$cipher);[IO.File]::Move($temporary,$full,$true)}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
[IO.File]::WriteAllText($full+'.test-accounts.ready.json',(@{saved=$true;projectId=$project;count=2}|ConvertTo-Json -Compress))
$bundle=$null;$accounts=$null
Write-Host 'Test account passwords saved to DPAPI successfully. No values were printed.'
Read-Host 'Press Enter to close'|Out-Null
