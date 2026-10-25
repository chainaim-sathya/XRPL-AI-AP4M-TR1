<#
Builds and (re)creates the local test containers from THIS repository, and checks
that what is running matches it. ca-gateway stays owned by switch-models.ps1.

  stack.ps1                          check only (the same as -Check): changes nothing
  stack.ps1 -Rebuild paywall         build chainaim-paywall:test from services\paywall, recreate ca-paywall, check
                                     (pay-to: -PayTo, else XRPL_PAY_TO_<NET> in this window, else the running ca-paywall's own)
  stack.ps1 -Rebuild presidio        build chainaim-presidio:test (about 1.6 GB, slow the first time), recreate ca-presidio, check
  stack.ps1 -Rebuild stub            pull the stand-in's base image, recreate ca-openrouter-stub, check
  stack.ps1 -Rebuild gateway         build chainaim-gateway:test only; then run switch-models.ps1 to recreate ca-gateway
  stack.ps1 -Rebuild all             all of the above
  stack.ps1 -Recreate paywall        recreate a container from its current image (new settings, no build)
  stack.ps1 -Rebuild paywall -XrplNetwork testnet -PayTo r...

What -Check verifies, per container (ca-presidio, ca-openrouter-stub, ca-gateway, ca-paywall):
  - it exists, runs, and is on the docker network
  - it runs the CURRENT build of its image tag (a rebuilt image does not reach a container until it is recreated)
  - the image was built from this repository (label chainaim.source, set by this script; images built by hand show "unknown")
  - every folder it mounts is inside this repository (not another copy such as PRIVAI1)
  - paywall: XRPL settings present, no Algorand-era settings (AVM_PAY_TO, X402_NETWORK)
  - paywall and gateway: they hold the same gateway key as the key file (compared, never printed)
  - paywall: its live chat quote is -ExpectPrice RLUSD on the expected XRPL network, to the expected pay-to address
Exit code 0 when everything passes, 1 otherwise.

Values printed: names, states, dates, paths, public addresses. Never a key, seed or text.
#>
param(
  [ValidateSet("none", "paywall", "presidio", "stub", "gateway", "all")][string[]]$Rebuild = @("none"),
  [ValidateSet("none", "paywall", "presidio", "stub", "all")][string[]]$Recreate = @("none"),
  [switch]$Check,
  [ValidateSet("testnet", "mainnet")][string]$XrplNetwork = "testnet",
  [string]$PayTo,
  [string]$ExpectPrice = "0.01",
  [string]$ExpectCaip2,
  [string[]]$PassEnv = @("FACILITATOR_URL_TESTNET", "FACILITATOR_URL_MAINNET", "RLUSD_ISSUER_TESTNET", "RLUSD_ISSUER_MAINNET", "PRICE_SCAN", "PRICE_MASK", "PRICE_CHAT", "PUBLIC_BASE_URL"),
  [string]$KeyFile = (Join-Path $PSScriptRoot "local-gateway-key.txt"),
  [string]$Network = "chainaim-test",
  [string]$GatewayUrl = "http://gateway.railway.internal:8700",
  [string]$PresidioAlias = "presidio.railway.internal",
  [string]$StubAlias = "openrouter-stub",
  [int]$PaywallPort = 8080,
  [int]$StubPort = 5004,
  [string]$PaywallImage = "chainaim-paywall:test",
  [string]$PresidioImage = "chainaim-presidio:test",
  [string]$GatewayImage = "chainaim-gateway:test",
  [string]$StubImage = "node:24-slim",
  [string]$PaywallContainer = "ca-paywall",
  [string]$PresidioContainer = "ca-presidio",
  [string]$StubContainer = "ca-openrouter-stub",
  [string]$GatewayContainer = "ca-gateway",
  [int]$QuoteTimeoutSec = 30
)
$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))

function Expand-Set([string[]]$items, [string[]]$all) {
  $set = @($items | Where-Object { $_ -ne "none" })
  if ($set -contains "all") { return $all }
  return $set
}
$rebuildSet = Expand-Set $Rebuild @("paywall", "presidio", "stub", "gateway")
$recreateSet = Expand-Set $Recreate @("paywall", "presidio", "stub")
if ($Check -and ($rebuildSet.Count -gt 0 -or $recreateSet.Count -gt 0)) { throw "-Check changes nothing; drop it, or drop -Rebuild/-Recreate." }
# A rebuilt paywall, Presidio or stand-in image is useless until its container is recreated.
$recreateSet = @(@($recreateSet) + @($rebuildSet | Where-Object { $_ -ne "gateway" }) | Select-Object -Unique)

# Run docker without letting its stderr stop the script; return exit code and stdout.
function Invoke-DockerQuiet([string[]]$DockerArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $out = & docker @DockerArgs 2>$null; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Code = $code; Out = ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim() }
}
function Invoke-DockerLoud([string[]]$DockerArgs, [string]$what) {
  & docker @DockerArgs
  if ($LASTEXITCODE -ne 0) { throw "$what failed; see the message above." }
}

$engine = Invoke-DockerQuiet @("version", "--format", "{{.Server.Version}}")
if ($engine.Code -ne 0 -or -not $engine.Out) { throw "Docker is not answering. Start Docker Desktop, wait for 'Engine running', then run this again." }

function Read-GatewayKey {
  if (-not (Test-Path $KeyFile)) { throw "Missing $KeyFile. Copy the existing key file here (do not make a new one while containers use the old key; see RUN-ON-ANOTHER-PC.md trap 3)." }
  $k = (Get-Content -Raw $KeyFile).Trim()
  if (-not $k) { throw "$KeyFile is empty." }
  return $k
}

function Resolve-PayTo {
  $name = "XRPL_PAY_TO_" + $XrplNetwork.ToUpper()
  $v = $PayTo
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name) }
  if (-not $v) {
    # Keep the pay-to the running paywall already has (no address is written into this script).
    $r = Invoke-DockerQuiet @("inspect", "--format", "{{json .Config.Env}}", $PaywallContainer)
    if ($r.Code -eq 0 -and $r.Out) {
      # Windows PowerShell 5.1 pipes a JSON array out of ConvertFrom-Json as ONE object, so piping it into @() gave one
      # element (the whole list) and .Substring ran on every entry at once. Assign first, then walk the entries.
      $list = ConvertFrom-Json -InputObject ([string]::Join("", @($r.Out)))
      foreach ($e in $list) { $ix = ([string]$e).IndexOf("="); if ($ix -gt 0 -and ([string]$e).Substring(0, $ix) -eq $name) { $v = ([string]$e).Substring($ix + 1) } }
    }
  }
  if (-not $v) { throw "No pay-to address for $XrplNetwork. Pass -PayTo r..., or set $name in this window (no running $PaywallContainer has one)." }
  if ($v -notmatch '^r[1-9A-HJ-NP-Za-km-z]{24,34}$') { throw "Pay-to address '$v' is not an XRPL classic address (r...)." }
  return $v
}
$caip2 = $ExpectCaip2
if (-not $caip2) { if ($XrplNetwork -eq "testnet") { $caip2 = "xrpl:1" } else { $caip2 = "xrpl:0" } }

# ---------------------------------------------------------------- build
function Build-Image([string]$tag, [string]$context, [string[]]$extra) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Write-Host "Building $tag from $context ..."
  Push-Location $repo
  try { Invoke-DockerLoud (@("build", "-t", $tag, "--label", "chainaim.source=$repo", "--label", "chainaim.built=$stamp") + @($extra) + @($context)) "Building $tag" }
  finally { Pop-Location }
}
if ($rebuildSet -contains "paywall") { Build-Image $PaywallImage "services/paywall" @() }
if ($rebuildSet -contains "presidio") { Build-Image $PresidioImage "services/presidio" @() }
if ($rebuildSet -contains "gateway") { Build-Image $GatewayImage "." @("-f", "services/gateway/Dockerfile") }
if ($rebuildSet -contains "stub") { Write-Host "Pulling $StubImage ..."; Invoke-DockerLoud @("pull", $StubImage) "Pulling $StubImage" }

# ---------------------------------------------------------------- recreate
if ($recreateSet.Count -gt 0) {
  if ((Invoke-DockerQuiet @("network", "inspect", $Network)).Code -ne 0) {
    Write-Host "Creating docker network $Network"
    Invoke-DockerLoud @("network", "create", $Network) "Creating network $Network"
  }
}
$srcLabel = @("--label", "chainaim.source=$repo", "--label", "chainaim.managed-by=stack.ps1")

if ($recreateSet -contains "presidio") {
  Write-Host "Recreating $PresidioContainer from $PresidioImage"
  Invoke-DockerQuiet @("rm", "-f", $PresidioContainer) | Out-Null
  Invoke-DockerLoud (@("run", "-d", "--name", $PresidioContainer, "--network", $Network, "--network-alias", $PresidioAlias) + $srcLabel + @($PresidioImage)) "Starting $PresidioContainer"
}
if ($recreateSet -contains "stub") {
  Write-Host "Recreating $StubContainer from $StubImage (mounts from $repo)"
  Invoke-DockerQuiet @("rm", "-f", $StubContainer) | Out-Null
  Invoke-DockerLoud (@("run", "-d", "--name", $StubContainer, "--network", $Network, "--network-alias", $StubAlias,
      "-p", "127.0.0.1:${StubPort}:5004",
      "-v", "$(Join-Path $repo 'scripts'):/app/scripts:ro", "-v", "$(Join-Path $repo 'test-console\spy'):/spy:ro") + $srcLabel +
    @($StubImage, "node", "/spy/spy-openrouter.ts")) "Starting $StubContainer"
}
if ($recreateSet -contains "paywall") {
  $payTo = Resolve-PayTo
  $payToName = "XRPL_PAY_TO_" + $XrplNetwork.ToUpper()
  if ($XrplNetwork -eq "mainnet" -and -not $env:RLUSD_ISSUER_MAINNET) { throw "Mainnet needs RLUSD_ISSUER_MAINNET set in this window (the paywall has no mainnet default)." }
  $set = @("XRPL_NETWORK", $payToName, "GATEWAY_URL", "CHAINAIM_GATEWAY_KEY")
  try {
    $env:CHAINAIM_GATEWAY_KEY = Read-GatewayKey
    $env:XRPL_NETWORK = $XrplNetwork
    Set-Item -Path "env:$payToName" -Value $payTo
    $env:GATEWAY_URL = $GatewayUrl
    $envArgs = @()
    foreach ($n in $set) { $envArgs += @("-e", $n) }
    foreach ($n in $PassEnv) { if ([Environment]::GetEnvironmentVariable($n)) { $envArgs += @("-e", $n); Write-Host "  passing $n from this window" } }
    Write-Host "Recreating $PaywallContainer from $PaywallImage ($XrplNetwork, pay to $payTo)"
    Invoke-DockerQuiet @("rm", "-f", $PaywallContainer) | Out-Null
    Invoke-DockerLoud (@("run", "-d", "--name", $PaywallContainer, "--network", $Network) + $envArgs + $srcLabel +
      @("-p", "127.0.0.1:${PaywallPort}:8080", $PaywallImage)) "Starting $PaywallContainer"
  } finally {
    Remove-Item Env:CHAINAIM_GATEWAY_KEY -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- check
$script:problems = 0
function Ok([string]$m) { Write-Host "  OK    $m" }
function Warn([string]$m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "  FAIL  $m" -ForegroundColor Red; $script:problems++ }

$repoTail = $repo.Substring(3).Replace("\", "/").ToLower()   # path without the drive, e.g. sathya/chainaim3003/...
function Test-InRepo([string]$source) {
  if (-not $source) { return $false }
  return $source.Replace("\", "/").ToLower().Contains($repoTail)
}
$keyForCompare = $null
if (Test-Path $KeyFile) { $keyForCompare = (Get-Content -Raw $KeyFile).Trim() }

function Check-Container([string]$name, [string]$fixHint) {
  Write-Host ""
  Write-Host "$name"
  $r = Invoke-DockerQuiet @("inspect", $name)
  if ($r.Code -ne 0 -or -not $r.Out) { Fail "not found. Fix: $fixHint"; return $null }
  $c = @($r.Out | ConvertFrom-Json)[0]
  if ($c.State.Status -eq "running") { Ok "running" } else { Fail "state '$($c.State.Status)'. Fix: docker start $name, or $fixHint" }
  if ($c.NetworkSettings.Networks.PSObject.Properties.Name -contains $Network) { Ok "on network $Network" } else { Fail "not on network $Network. Fix: $fixHint" }

  $tag = $c.Config.Image
  $img = Invoke-DockerQuiet @("image", "inspect", $tag)
  if ($img.Code -ne 0) {
    Fail "image tag $tag no longer exists. Fix: $fixHint"
  } else {
    $i = @($img.Out | ConvertFrom-Json)[0]
    if ($i.Id -eq $c.Image) { Ok "runs the current build of $tag (built $($i.Created))" }
    else { Fail "runs an OLDER build of $tag than the one tagged now (container created $($c.Created)). Fix: $fixHint" }
    $src = $null
    if ($i.Config.Labels) { $src = $i.Config.Labels.'chainaim.source' }
    if ($tag -eq $StubImage) { }
    elseif (-not $src) { Warn "image source unknown (built by hand, not by stack.ps1); rebuild with stack.ps1 to record it" }
    elseif ($src.ToLower() -eq $repo.ToLower()) { Ok "image built from this repository" }
    else { Fail "image built from $src, not this repository. Fix: $fixHint" }
  }

  foreach ($m in @($c.Mounts)) {
    if ($m.Type -ne "bind") { continue }
    if (Test-InRepo $m.Source) { Ok "mounts $($m.Destination) from this repository" }
    else { Fail "mounts $($m.Destination) from $($m.Source), outside this repository. Fix: $fixHint" }
  }
  return $c
}

function Get-EnvMap($c) {
  $map = @{}
  foreach ($e in @($c.Config.Env)) { $ix = $e.IndexOf("="); if ($ix -gt 0) { $map[$e.Substring(0, $ix)] = $e.Substring($ix + 1) } }
  return $map
}
function Check-Key($map, [string]$who) {
  if (-not $keyForCompare) { Warn "$KeyFile missing, so the $who key was not compared"; return }
  if (-not $map.ContainsKey("CHAINAIM_GATEWAY_KEY")) { Fail "$who has no CHAINAIM_GATEWAY_KEY" }
  elseif ($map["CHAINAIM_GATEWAY_KEY"] -eq $keyForCompare) { Ok "$who gateway key matches $(Split-Path $KeyFile -Leaf)" }
  else { Fail "$who gateway key differs from $(Split-Path $KeyFile -Leaf): the console will get HTTP 401" }
}

Write-Host ""
Write-Host "Checking the local stack against $repo"

Check-Container $PresidioContainer "stack.ps1 -Rebuild presidio" | Out-Null
Check-Container $StubContainer "stack.ps1 -Recreate stub" | Out-Null

$g = Check-Container $GatewayContainer "stack.ps1 -Rebuild gateway, then switch-models.ps1 -To <mode>"
if ($g) { Check-Key (Get-EnvMap $g) "ca-gateway" }

$p = Check-Container $PaywallContainer "stack.ps1 -Rebuild paywall"
if ($p) {
  $map = Get-EnvMap $p
  foreach ($old in @("AVM_PAY_TO", "X402_NETWORK")) { if ($map.ContainsKey($old)) { Fail "has Algorand-era setting $old. Fix: stack.ps1 -Rebuild paywall" } }
  $net = $map["XRPL_NETWORK"]
  if (-not $net) { Fail "no XRPL_NETWORK. Fix: stack.ps1 -Rebuild paywall" }
  elseif ($net -ne $XrplNetwork) { Fail "XRPL_NETWORK is '$net', expected '$XrplNetwork'. Fix: stack.ps1 -Recreate paywall -XrplNetwork $XrplNetwork" }
  else { Ok "XRPL_NETWORK=$net" }
  Check-Key $map "ca-paywall"
  $expectPayTo = $null
  try { $expectPayTo = Resolve-PayTo } catch { Warn $_.Exception.Message }

  # Live quote: an unpaid chat call must answer 402 with the price, network and pay-to.
  try {
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($QuoteTimeoutSec)
    $body = New-Object System.Net.Http.StringContent('{"messages":[{"role":"user","content":"hi"}]}', [Text.Encoding]::UTF8, "application/json")
    $resp = $client.PostAsync("http://127.0.0.1:$PaywallPort/v1/chat/completions", $body).GetAwaiter().GetResult()
    $vals = $null
    if ([int]$resp.StatusCode -ne 402 -or -not $resp.Headers.TryGetValues("payment-required", [ref]$vals)) {
      Fail "unpaid chat call answered HTTP $([int]$resp.StatusCode) without a payment-required quote"
    } else {
      $q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(@($vals)[0])) | ConvertFrom-Json
      $a = @($q.accepts)[0]
      $inv = [Globalization.CultureInfo]::InvariantCulture
      $amountOk = $false
      try { $amountOk = ([decimal]::Parse([string]$a.amount, $inv) -eq [decimal]::Parse($ExpectPrice, $inv)) } catch { $amountOk = $false }
      if ($amountOk) { Ok "quotes $($a.amount) RLUSD for chat" } else { Fail "quotes amount '$($a.amount)', expected $ExpectPrice (RLUSD as a decimal). Fix: stack.ps1 -Rebuild paywall" }
      if ($a.network -eq $caip2) { Ok "quote network $($a.network)" } else { Fail "quote network '$($a.network)', expected $caip2" }
      if ($expectPayTo) {
        if ($a.payTo -eq $expectPayTo) { Ok "pays to $($a.payTo)" } else { Fail "pays to $($a.payTo), expected $expectPayTo" }
      }
    }
  } catch {
    Fail "could not get a quote from http://127.0.0.1:$PaywallPort ($($_.Exception.Message))"
  }
}

Write-Host ""
if ($script:problems -eq 0) { Write-Host "All checks passed." -ForegroundColor Green; exit 0 }
Write-Host "$($script:problems) problem(s). Each FAIL line names its fix." -ForegroundColor Red
exit 1
