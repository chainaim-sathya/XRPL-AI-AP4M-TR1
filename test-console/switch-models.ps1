<#
Restarts the local test gateway (container ca-gateway) in one model mode.

A mode is a JSON file in test-console\modes\ (stub, hosted, ollama, or any file
you add). It says which model source the gateway uses, which catalog, which
secrets to ask for, and any extra gateway flags. Which models exist and where
they are served lives in the catalog JSON under config\. This script holds no
model names or model URLs.

  switch-models.ps1 -To ollama     local models from config\local-models.json (generated into config\generated, mounted, no rebuild)
  switch-models.ps1 -To hosted     OpenRouter free models; asks for OPENROUTER_API_KEY hidden unless already set
  switch-models.ps1 -To stub       the stand-in that echoes; no key
  switch-models.ps1 -To ollama -Catalog config\catalog.local.json
  switch-models.ps1 -List

"real" still works and means "hosted".

Mode file fields:
  description     text shown by -List
  modelSource     catalog | openrouter-free            (gateway --model-source)
  catalog         repo-relative path under config\     (catalog mode only)
  localModels     repo-relative model registry, e.g. config\local-models.json: the catalog, scores and
                  --max-output-tokens are generated from it (scripts\local-models.ts) on every switch
  mountConfig     true = mount config\ read-only at /config, so catalog edits need no image rebuild
  secretEnv       env var NAMES the mode needs; asked for hidden when not set; never written to a file
  staticEnv       non-secret env values, { "NAME": "value" }
  flags           extra gateway flags, appended last (they override the base flags)
  testTimeoutSec  how long the test question may take
  doneMessage     printed when the test question succeeds

Secrets are never written to a file. While a mode that needs one is on, Docker
keeps it in the gateway container's settings on this PC.
#>
param(
  [string]$To,
  [string]$ModesDir = (Join-Path $PSScriptRoot "modes"),
  [string]$Catalog,
  [string]$Image = "chainaim-gateway:test",
  [string]$Container = "ca-gateway",
  [string]$Network = "chainaim-test",
  [string]$NetworkAlias = "gateway.railway.internal",
  [int]$HostPort = 8720,
  [string]$PresidioUrl = "http://presidio.railway.internal:3000",
  [string]$Question = "What is the capital of India?",
  [int]$TestTimeoutSec = 0,
  [switch]$SkipTest,
  [ValidateSet("on", "off")][string]$OllamaVariants = "on",
  [switch]$List
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$configDir = [IO.Path]::GetFullPath((Join-Path $repo "config"))

function Read-Mode([string]$path) {
  try { return Get-Content -Raw $path | ConvertFrom-Json }
  catch { throw "Mode file $path is not valid JSON: $($_.Exception.Message)" }
}

if ($List) {
  Get-ChildItem -Path $ModesDir -Filter *.json | Sort-Object Name | ForEach-Object {
    $m = Read-Mode $_.FullName
    Write-Host ("{0,-10} {1}" -f $_.BaseName, $m.description)
  }
  exit 0
}
if (-not $To) { throw "Give a mode: -To <name>. See the modes with -List." }
if ($To -eq "real") { $To = "hosted" }

$modePath = Join-Path $ModesDir "$To.json"
if (-not (Test-Path $modePath)) { throw "No mode file $modePath. See the modes with -List." }
$mode = Read-Mode $modePath

if ($mode.modelSource -ne "catalog" -and $mode.modelSource -ne "openrouter-free") {
  throw "$modePath : modelSource must be catalog or openrouter-free, got '$($mode.modelSource)'."
}

# Gateway key: the same local key the console and the paywall use.
$keyFile = Join-Path $PSScriptRoot "local-gateway-key.txt"
if (-not (Test-Path $keyFile)) { throw "Missing $keyFile. Create it once (setup step 3) before switching." }
$env:CHAINAIM_GATEWAY_KEY = (Get-Content -Raw $keyFile).Trim()
$envArgs = @("-e", "CHAINAIM_GATEWAY_KEY")
$volArgs = @("-v", "chainaim-test-ledger:/data")

$flags = @("--host", "::", "--port", "8700", "--api-key-env", "CHAINAIM_GATEWAY_KEY",
  "--model-source", $mode.modelSource, "--presidio-url", $PresidioUrl, "--ledger", "/data/ledger")

# Local model registry: generate the catalog and scores from the one file you edit (skipped when -Catalog is given).
$generated = $null
if ($mode.modelSource -eq "catalog" -and $mode.localModels -and -not $Catalog) {
  Write-Host "Generating local models from $($mode.localModels) (per-model context variants: $OllamaVariants)..."
  Push-Location $repo
  try {
    & node scripts/local-models.ts --in $mode.localModels --out-dir config/generated --create-variants $OllamaVariants --check-context $OllamaVariants
    $genExit = $LASTEXITCODE
  } finally { Pop-Location }
  if ($genExit -ne 0) { throw "Generating the local models failed; see the message above." }
  $generated = Get-Content -Raw (Join-Path $repo "config\generated\summary.json") | ConvertFrom-Json
}

# Catalog: resolve on this PC, check it parses, then map it to the path the container sees.
if ($mode.modelSource -eq "catalog") {
  $cat = if ($Catalog) { $Catalog } elseif ($generated) { $generated.catalog } else { $mode.catalog }
  if (-not $cat) { throw "$modePath : catalog mode needs a catalog path (or pass -Catalog)." }
  $catFull = [IO.Path]::GetFullPath((Join-Path $repo $cat))
  if (-not $catFull.StartsWith($configDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The catalog must be inside $configDir, got $catFull."
  }
  if (-not (Test-Path $catFull)) { throw "Catalog not found: $catFull" }
  try { Get-Content -Raw $catFull | ConvertFrom-Json | Out-Null }
  catch { throw "Catalog $catFull is not valid JSON: $($_.Exception.Message)" }
  $rel = $catFull.Substring($configDir.Length + 1).Replace("\", "/")
  if ($mode.mountConfig) {
    $volArgs += @("-v", "${configDir}:/config:ro")
    $flags += @("--catalog", "/config/$rel")
  } else {
    $flags += @("--catalog", "config/$rel")   # the copy baked into the image at build time
  }
  Write-Host "Catalog: $catFull"
}

# Secrets: from the environment, else a hidden prompt.
foreach ($name in @($mode.secretEnv)) {
  if (-not $name) { continue }
  if ((Get-Item -Path "env:$name" -ErrorAction SilentlyContinue).Value) {
    Write-Host "Using $name from your environment."
  } else {
    $secure = Read-Host "Paste $name and press Enter (it stays hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { Set-Item -Path "env:$name" -Value ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if (-not (Get-Item -Path "env:$name" -ErrorAction SilentlyContinue).Value) { throw "No $name entered, so nothing changed." }
  }
  # A Ctrl+V at a hidden prompt in Windows PowerShell 5.1 types one control character instead of pasting:
  # refuse a value with control characters or under 16 characters, and forget it so the next run asks again.
  $val = (Get-Item -Path "env:$name").Value
  if ($val.Length -lt 16 -or $val -match '[\x00-\x1F\x7F]') {
    Remove-Item -Path "env:$name" -ErrorAction SilentlyContinue
    throw "$name does not look like a key ($($val.Length) characters, or it holds a control character), so nothing changed. Run again and paste with a RIGHT-CLICK (Ctrl+V does not paste at a hidden prompt in Windows PowerShell)."
  }
  Remove-Variable val
  $envArgs += @("-e", $name)
}

# Non-secret values.
if ($mode.staticEnv) {
  foreach ($p in $mode.staticEnv.PSObject.Properties) {
    Set-Item -Path "env:$($p.Name)" -Value ([string]$p.Value)
    $envArgs += @("-e", $p.Name)
  }
}

if ($mode.flags) { $flags += @($mode.flags | ForEach-Object { [string]$_ }) }
# Generated values come last so they win: the matching score table and the output budget every model can serve.
if ($generated) {
  # Build each value first: inside @(...) the comma binds tighter than +, which would split a joined path into two arguments.
  $scoresInContainer = "/config/" + ($generated.scores -replace '^config/', '')
  $maxOut = [string]$generated.maxOutputTokens
  $flags += @("--scores", $scoresInContainer, "--max-output-tokens", $maxOut)
  Write-Host ("Default model: {0}; max output tokens: {1}" -f $generated.defaultModel, $generated.maxOutputTokens)
  foreach ($m in @($generated.models)) { Write-Host ("  {0} -> {1} (context {2})" -f $m.id, $m.servedModel, $m.contextWindow) }
}

Write-Host "Mode: $To - $($mode.description)"
docker rm -f $Container | Out-Null
docker run -d --name $Container --network $Network --network-alias $NetworkAlias `
  -p "127.0.0.1:${HostPort}:8700" @volArgs @envArgs $Image @flags | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker run failed; see the message above." }

Write-Host "Waiting for the gateway..."
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  if ((docker inspect -f "{{.State.Running}}" $Container) -ne "true") { docker logs --tail 20 $Container; throw "The gateway stopped." }
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:${HostPort}/healthz" | Out-Null; $ready = $true }
  catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { docker logs --tail 20 $Container; throw "The gateway is not answering." }

if ($SkipTest) { Write-Host "Gateway is up in mode $To (test question skipped)."; exit 0 }

$timeout = if ($TestTimeoutSec -gt 0) { $TestTimeoutSec } elseif ($mode.testTimeoutSec) { [int]$mode.testTimeoutSec } else { 90 }
Write-Host "Test question (up to $timeout s; a cold local model can be slow): $Question"
$body = @{ messages = @(@{ role = "user"; content = $Question }) } | ConvertTo-Json -Depth 5 -Compress
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:${HostPort}/v1/chat/completions" -TimeoutSec $timeout `
    -Headers @{ authorization = "Bearer $env:CHAINAIM_GATEWAY_KEY" } -ContentType "application/json" -Body $body
  $model = $r.Headers.Keys | Where-Object { $_ -ieq "x-chainaim-model" } | ForEach-Object { $r.Headers[$_] }
  Write-Host ("Answer from " + $model + ": " + ($r.Content | ConvertFrom-Json).choices[0].message.content)
} catch {
  $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  Write-Host "The test question failed: $detail"
  Write-Host "Gateway log: docker logs --tail 40 $Container    Back to the stand-in: use-stand-in.cmd"
  exit 1
}
if ($mode.doneMessage) { Write-Host $mode.doneMessage }
