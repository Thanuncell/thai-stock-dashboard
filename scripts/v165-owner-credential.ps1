param([Parameter(Mandatory=$true)][string]$VaultPath,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$stage='startup'
trap {
  if($VaultPath){[IO.File]::WriteAllText($VaultPath+'.entry-status.json',(@{saved=$false;stage=$stage;errorType=$_.Exception.GetType().Name}|ConvertTo-Json -Compress))}
  Write-Host 'Credential entry did not complete. Secret values are suppressed.'
  if(!$CheckOnly){Read-Host 'Press Enter to close'|Out-Null}
  exit 1
}
Add-Type -AssemblyName System.Security
$project='mlqbmtycvlbfbszyrsqd'
$full=[IO.Path]::GetFullPath($VaultPath)
if(!($full.EndsWith('.dpapi'))){throw 'DPAPI vault required'}
for($parent=[IO.Path]::GetDirectoryName($full);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){
  if(Test-Path -LiteralPath (Join-Path $parent '.git')){throw 'Vault must be outside Git'}
}
$entropy=[Text.Encoding]::UTF8.GetBytes('SETscope v1.6.5 Dev '+$project)
$stage='vault-preflight'
$oldPlain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($full),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
try {$bundle=[Text.Encoding]::UTF8.GetString($oldPlain)|ConvertFrom-Json}finally{[Array]::Clear($oldPlain,0,$oldPlain.Length)}
if($bundle.projectId -ne $project){throw 'Wrong Dev vault'}
if($CheckOnly){Write-Output 'Owner credential prompt preflight PASS';exit 0}
function Save-OwnerBundle {
  $plain=[Text.Encoding]::UTF8.GetBytes(($bundle|ConvertTo-Json -Depth 8 -Compress))
  try {$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($plain,0,$plain.Length)}
  $temporary=$full+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {[IO.File]::WriteAllBytes($temporary,$cipher);[IO.File]::Move($temporary,$full,$true)}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
}
Write-Host 'SETscope v1.6.5 - OWNER credential entry - DEVELOPMENT ONLY'
Write-Host 'Project: setscope-v165-dev / mlqbmtycvlbfbszyrsqd'
Write-Host 'First set a password for ONLY setscope_v165_dev_bff in the Dev Roles page.'
Write-Host 'Then enter that same password below. Input is hidden and is never printed.'
Write-Host 'Do not enter the postgres/admin database password.'
$stage='awaiting-bff-password'
[IO.File]::WriteAllText($full+'.entry-status.json',(@{saved=$false;stage=$stage}|ConvertTo-Json -Compress))
do {
  $secure=Read-Host 'Dev BFF role password' -AsSecureString
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {$password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
  if(!$password.Length){Write-Host 'Enter the existing Dev BFF password; input cannot be empty.'}
}while(!$password.Length)
if($bundle.database){
  $bundle.database.password=$password
}else{
  $bundle.database=[pscustomobject]@{host='aws-1-ap-southeast-1.pooler.supabase.com';user='setscope_v165_dev_bff.'+$project;port=5432;database='postgres';password=$password}
}
$stage='saving-bff-password'
Save-OwnerBundle
[IO.File]::WriteAllText($full+'.ready.json',(@{saved=$true;projectId=$project;adminKeyProvided=$false}|ConvertTo-Json -Compress))
Write-Host 'BFF password saved to DPAPI successfully.'
Write-Host 'Optional: existing Dev Auth admin API key, used only to create confirmed synthetic test users.'
Write-Host 'Leave blank if unavailable. Never enter a Production key.'
$adminSecure=Read-Host 'Existing Dev Auth admin API key (optional)' -AsSecureString
if($adminSecure.Length){
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecure)
  try {$adminKey=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
  if($adminKey.StartsWith('sb_secret_') -or $adminKey.StartsWith('eyJ')){
    $bundle|Add-Member -NotePropertyName authAdminKey -NotePropertyValue $adminKey -Force
    Save-OwnerBundle
  }else{Write-Host 'Optional admin key format not accepted; BFF password remains saved.'}
}
[IO.File]::WriteAllText($full+'.ready.json',(@{saved=$true;projectId=$project;adminKeyProvided=[bool]$bundle.authAdminKey}|ConvertTo-Json -Compress))
$password=$null;$adminKey=$null;$bundle=$null
Write-Host 'Saved to DPAPI. No password/key was printed. You may close this window.'
Read-Host 'Press Enter to close'|Out-Null
