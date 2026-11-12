param(
  [Parameter(Mandatory=$true)][ValidateSet('Initialize','Read','Write')][string]$Action,
  [Parameter(Mandatory=$true)][string]$VaultPath
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$project='mlqbmtycvlbfbszyrsqd'
$entropy=[Text.Encoding]::UTF8.GetBytes('SETscope v1.6.5 Dev '+$project)
$fullPath=[IO.Path]::GetFullPath($VaultPath)
$repoRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if($fullPath.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or !($fullPath.EndsWith('.dpapi'))){throw 'Dev vault must be outside the repository'}
for($parent=[IO.Path]::GetDirectoryName($fullPath);$parent;$parent=[IO.Path]::GetDirectoryName($parent)){
  if(Test-Path -LiteralPath (Join-Path $parent '.git')){throw 'Dev vault must be outside every Git checkout'}
}
if($Action -eq 'Read'){
  $cipher=[IO.File]::ReadAllBytes($fullPath)
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))}
  finally {[Array]::Clear($plain,0,$plain.Length)}
  exit
}
if($Action -eq 'Write'){
  $text=[Console]::In.ReadToEnd()
  try {$bundle=$text|ConvertFrom-Json -ErrorAction Stop} catch {throw 'Dev vault payload invalid'}
  if($bundle.projectId -ne $project -or $bundle.version -ne 1){throw 'Dev vault target rejected'}
  $oldPlain=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($fullPath),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {$old=[Text.Encoding]::UTF8.GetString($oldPlain)|ConvertFrom-Json}finally{[Array]::Clear($oldPlain,0,$oldPlain.Length)}
  if($bundle.encryptionKey -cne $old.encryptionKey -or $bundle.tls.pfx -cne $old.tls.pfx -or $bundle.tls.passphrase -cne $old.tls.passphrase){throw 'Existing Dev encryption and TLS keys must be preserved'}
  $plain=[Text.Encoding]::UTF8.GetBytes($text)
  try {$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($plain,0,$plain.Length)}
  $temporary=$fullPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
  try {[IO.File]::WriteAllBytes($temporary,$cipher);[IO.File]::Move($temporary,$fullPath,$true)}finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
  Write-Output 'Dev vault updated; values suppressed'
  exit
}
if(Test-Path -LiteralPath $fullPath){throw 'Existing Dev vault will not be overwritten'}
$sessionKey=New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionKey)
$pfxPasswordBytes=New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($pfxPasswordBytes)
$pfxPassword=[Convert]::ToBase64String($pfxPasswordBytes)
$rsa=[Security.Cryptography.RSA]::Create(2048)
try {
  $request=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('localhost');$san.AddIpAddress([Net.IPAddress]::Loopback)
  $request.CertificateExtensions.Add($san.Build())
  $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false,$false,0,$true))
  $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddDays(30))
  try {
    $bundle=@{version=1;projectId=$project;encryptionKey=[Convert]::ToBase64String($sessionKey);tls=@{pfx=[Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$pfxPassword));passphrase=$pfxPassword};database=$null}
    $plain=[Text.Encoding]::UTF8.GetBytes(($bundle|ConvertTo-Json -Depth 5 -Compress))
    try {$cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
    finally {[Array]::Clear($plain,0,$plain.Length)}
    $stream=[IO.File]::Open($fullPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {$stream.Write($cipher,0,$cipher.Length)}finally{$stream.Dispose()}
    # Only a public certificate is exported separately. No machine trust changes.
    [IO.File]::WriteAllBytes($fullPath+'.crt',$cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    Write-Output 'Dev keys initialized: DPAPI CurrentUser; database credential absent; no trust-store changes'
  } finally {$cert.Dispose()}
} finally {$rsa.Dispose();[Array]::Clear($sessionKey,0,$sessionKey.Length);[Array]::Clear($pfxPasswordBytes,0,$pfxPasswordBytes.Length)}
