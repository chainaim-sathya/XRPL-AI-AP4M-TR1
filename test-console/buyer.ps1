<#
A TestNet buyer wallet for the paid private chat, without a browser wallet, and the end-to-end run.
Every step is one command. The seed file and the wallet prefix are parameters with no default: the
script never assumes a file name. Seeds are never printed; addresses are derived from them.

  buyer.ps1 -Step create    -Prefix XRPL_SEED_B02 -EnvFile C:\PRIV-AI-SECRETS\mywallets.env   new wallet; its seed is appended to -EnvFile
  buyer.ps1 -Step address   -Prefix XRPL_SEED_B02 -EnvFile <file>                             show the address (no seed)
  buyer.ps1 -Step fund      -Prefix XRPL_SEED_B02 -EnvFile <file>                             TestNet XRP from the faucet API
  buyer.ps1 -Step trustline -Prefix XRPL_SEED_B02 -EnvFile <file>                             open the RLUSD trust line
  buyer.ps1 -Step buy       -Prefix XRPL_SEED_B02 -EnvFile <file> [-Amount 1] [-MaxXrp 13]   quote, confirm, buy RLUSD with XRP
  buyer.ps1 -Step balances  -Prefix XRPL_SEED_B02 -EnvFile <file>                             buyer and seller XRP / RLUSD
  buyer.ps1 -Step e2e       -Prefix XRPL_SEED_B02 -EnvFile <file> [-File <.txt>] [-Question "..."]   BEFORE, masked paid ask, AFTER, VERDICT
  buyer.ps1 -Step setup     -Prefix XRPL_SEED_B02 -EnvFile <file>                             create, fund, trustline, buy, balances in one go

-EnvFile    the .env-format file holding PREFIX_TESTNET=s... lines. Keep it outside every repository and sync folder.
-Prefix     the seed variable's prefix, e.g. XRPL_SEED_B02 (read as PREFIX_TESTNET).
-Paywall    the paywall (default http://127.0.0.1:8080): the seller is taken from its live quote.
-Amount     RLUSD to buy (default 1). -MaxXrp the most XRP the buy may spend (default 13).
-File       document for e2e (default rig\tenants\t03\docs\shipment-kyc.txt). -Question what to ask.
-SettleWaitSec  how long e2e waits for the ledger (default 30). -Yes skips the buy confirmation.
-Model      chat model for e2e (default chainaim/auto: the gateway picks), e.g. hosted/nemotron-nano-reasoning.
-FaucetUrl  TestNet faucet API (default https://faucet.altnet.rippletest.net/accounts). TestNet only.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("create", "address", "fund", "trustline", "buy", "balances", "e2e", "setup")][string]$Step,
  [Parameter(Mandatory = $true)][ValidateScript({ if ($_ -cmatch '^[A-Z][A-Z0-9_]*$') { $true } else { throw "-Prefix must be capital letters, digits and _, starting with a letter (e.g. XRPL_SEED_B02)" } })][string]$Prefix,
  [Parameter(Mandatory = $true)][string]$EnvFile,
  [string]$Paywall = "http://127.0.0.1:8080",
  [string]$Amount = "1",
  [string]$MaxXrp = "13",
  [string]$File,
  [string]$Question = "Address a short reply to the buyer by name. Should we accept the request to change the remittance account by phone? Why not?",
  [ValidateRange(0, 300)][int]$SettleWaitSec = 30,
  [ValidateScript({ if ($_ -cmatch '^[\w.-]+/[\w.:-]+$') { $true } else { throw "-Model must look like provider/name, e.g. hosted/nemotron-nano-reasoning" } })][string]$Model = "chainaim/auto",
  [string]$FaucetUrl = "https://faucet.altnet.rippletest.net/accounts",
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$paywallDir = Join-Path $repo "services\paywall"
$var = "${Prefix}_TESTNET"
$envPath = [IO.Path]::GetFullPath($EnvFile)
$envFwd = $envPath.Replace("\", "/")   # Node's loadEnvFile takes forward slashes on Windows too
if (-not $File) { $File = Join-Path $repo "rig\tenants\t03\docs\shipment-kyc.txt" }
if ($envPath.ToLower().StartsWith($repo.ToLower())) { throw "-EnvFile is inside the repository ($repo). Keep seeds outside every repository." }
if (-not (Test-Path (Join-Path $paywallDir "node_modules\xrpl"))) { throw "services\paywall has no node_modules: run  npm --prefix services/paywall install  in $repo first." }

function Invoke-Node([string[]]$NodeArgs) {
  Push-Location $paywallDir
  try { & node @NodeArgs; if ($LASTEXITCODE -ne 0) { throw "node $($NodeArgs[0]) failed (exit $LASTEXITCODE); see the message above." } }
  finally { Pop-Location }
}

function Test-HasVar {
  if (-not (Test-Path $envPath)) { return $false }
  foreach ($line in Get-Content $envPath) { if ($line -match "^\s*$([regex]::Escape($var))\s*=") { return $true } }
  return $false
}

function Get-Address {
  if (-not (Test-HasVar)) { throw "$envPath has no $var line. Run -Step create first, or check -Prefix / -EnvFile." }
  $js = "process.loadEnvFile('$envFwd'); import('xrpl').then(({Wallet}) => process.stdout.write(Wallet.fromSeed(process.env['$var'].trim()).classicAddress))"
  Push-Location $paywallDir
  try { $a = & node -e $js; if ($LASTEXITCODE -ne 0) { throw "could not derive the address from $var in $envPath (a BOM, a typo, or not a family seed)" } }
  finally { Pop-Location }
  $a = ([string]$a).Trim()
  if ($a -notmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$') { throw "derived address '$a' is not an XRPL classic address" }
  return $a
}

function Step-Create {
  if (Test-HasVar) { throw "$envPath already has a $var line. Pick another -Prefix (e.g. the next B number); nothing was changed." }
  $dir = Split-Path $envPath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  Push-Location $paywallDir
  try { $out = @(& node scripts/new-account.ts); if ($LASTEXITCODE -ne 0) { throw "new-account.ts failed" } }
  finally { Pop-Location }
  # new-account.ts prints: "address r...", a label line, then the seed. Only the address is shown here.
  $address = ([string]$out[0]) -replace '^address\s+', ''
  $seed = ([string]$out[2]).Trim()
  if ($address -notmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$' -or $seed -notmatch '^s[1-9A-HJ-NP-Za-km-z]{20,40}$') { throw "unexpected output from new-account.ts; nothing was written" }
  $utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM: a BOM hides the first variable from Node
  $lead = ""
  if ((Test-Path $envPath) -and (Get-Item $envPath).Length -gt 0) {
    $bytes = [IO.File]::ReadAllBytes($envPath)
    if ($bytes[$bytes.Length - 1] -ne 10) { $lead = "`n" }
  }
  [IO.File]::AppendAllText($envPath, "$lead# address $address`n$var=$seed`n", $utf8)
  $seed = $null; $out = $null
  Write-Host "created $var  address $address"
  Write-Host "seed appended to $envPath (not shown). Keep a second copy in a password manager."
}

function Step-Fund {
  $a = Get-Address
  Write-Host "funding $a from the TestNet faucet ..."
  $r = Invoke-RestMethod -Method Post -Uri $FaucetUrl -ContentType "application/json" -Body (@{ destination = $a; userAgent = "xrpl.js" } | ConvertTo-Json)
  Write-Host ("faucet: account {0}, amount {1}" -f $r.account.classicAddress, $r.amount)
}

function Step-Trustline {
  $null = Get-Address
  $js = "process.loadEnvFile('$envFwd'); process.stdout.write(process.env['$var'].trim())"
  try {
    Push-Location $paywallDir
    try { $env:XRPL_BUYER_SEED_TESTNET = (& node -e $js) } finally { Pop-Location }
    Invoke-Node @("scripts/trust-line.ts")
  } finally {
    Remove-Item Env:XRPL_BUYER_SEED_TESTNET -ErrorAction SilentlyContinue
  }
}

function Step-Buy {
  Invoke-Node @("scripts/buy-rlusd.ts", "--env-file", $envFwd, "--seed-prefix", $Prefix, "--amount", $Amount, "--max-xrp", $MaxXrp, "--dry-run")
  if (-not $Yes) {
    $ans = Read-Host "Buy $Amount RLUSD at that price (at most $MaxXrp XRP)? (y/N)"
    if ($ans -notmatch '^(y|yes)$') { Write-Host "not bought"; return }
  }
  Invoke-Node @("scripts/buy-rlusd.ts", "--env-file", $envFwd, "--seed-prefix", $Prefix, "--amount", $Amount, "--max-xrp", $MaxXrp)
}

function Step-Balances {
  Invoke-Node @("scripts/balances.ts", "--title", "NOW", "--env-file", $envFwd, "--buyer-seed-prefix", $Prefix, "--seller-from-paywall", $Paywall)
}

function Step-E2E {
  if (-not (Test-Path $File)) { throw "-File $File not found" }
  $File = (Resolve-Path $File).Path   # node runs from services\paywall, so a relative -File must become a full path here
  Remove-Item "Env:$var" -ErrorAction SilentlyContinue   # the file, not a leftover variable in this window, must supply the seed
  Invoke-Node @("scripts/e2e-private-ask.ts", "--file", $File, "--env-file", $envFwd, "--seed-prefix", $Prefix, "--url", $Paywall, "--settle-wait-sec", "$SettleWaitSec", "--model", $Model, "--question", $Question)
}

switch ($Step) {
  "create" { Step-Create }
  "address" { Write-Host "$var  address $(Get-Address)" }
  "fund" { Step-Fund }
  "trustline" { Step-Trustline }
  "buy" { Step-Buy }
  "balances" { Step-Balances }
  "e2e" { Step-E2E }
  "setup" {
    if (-not (Test-HasVar)) { Step-Create }
    Step-Fund
    Write-Host "waiting 10 s for the funding to validate ..."; Start-Sleep -Seconds 10
    Step-Trustline
    Step-Buy
    Step-Balances
  }
}
