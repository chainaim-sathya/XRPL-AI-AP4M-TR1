<#
.SYNOPSIS
  Sends one document through the local gateway's private chat and checks that none of its known
  identifiers reached the model, Jev or the decision ledger.

.DESCRIPTION
  1. Posts the document (with -Question in front) to the gateway's /v1/chat/completions with the local key.
  2. Reads what the stand-in OpenRouter container recorded since the call ("MODEL RECEIVED" and
     "JEV RECEIVED" lines) and the gateway's newest ledger lines.
  3. Looks for every value in -ValuesFile (one per line, # for comments) in that text.
  Prints the HTTP status, how many bodies left, and PASS or FAIL with the leaked VALUES ONLY by line
  number in the values file (the values themselves are synthetic, but the script never prints them).
  A 422 means the residual check refused the request: nothing was sent; its message names kinds only.

  Exit codes: 0 PASS, 1 FAIL (a value leaked, or nothing reached the model), 2 setup error.

.EXAMPLE
  test-console\leak-check.ps1
  test-console\leak-check.ps1 -Document test-console\samples\sample-prescription.txt -ValuesFile my-values.txt
#>
param(
  [string]$Document = (Join-Path $PSScriptRoot "samples\sample-bank-statement.txt"),
  [string]$ValuesFile = (Join-Path $PSScriptRoot "samples\sample-bank-statement.values.txt"),
  [string]$Question = "Summarise this bank statement: who was paid, and how much in total?",
  [string]$GatewayUrl = "http://127.0.0.1:8720",
  [string]$KeyFile = (Join-Path $PSScriptRoot "local-gateway-key.txt"),
  [string]$SpyContainer = "ca-openrouter-stub",
  [string]$GatewayContainer = "ca-gateway",
  [int]$LedgerLines = 3,
  [int]$SettleSeconds = 2
)
$ErrorActionPreference = "Stop"

foreach ($p in @($Document, $ValuesFile, $KeyFile)) {
  if (-not (Test-Path -LiteralPath $p)) { Write-Host "setup: not found: $p"; exit 2 }
}
$key = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
$text = Get-Content -LiteralPath $Document -Raw
$values = @(Get-Content -LiteralPath $ValuesFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
if ($values.Count -eq 0) { Write-Host "setup: $ValuesFile lists no values"; exit 2 }

$body = @{ messages = @(@{ role = "user"; content = "$Question`n`n$text" }) } | ConvertTo-Json -Depth 5
$since = (Get-Date).ToUniversalTime().AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")

$status = 0
$errorMessage = ""
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "$GatewayUrl/v1/chat/completions" -Method Post `
    -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
  $status = [int]$r.StatusCode
} catch {
  if ($_.Exception.Response) {
    $status = [int]$_.Exception.Response.StatusCode
    $errorMessage = $_.ErrorDetails.Message
  } else {
    Write-Host "setup: could not reach the gateway at $GatewayUrl ($($_.Exception.Message))"
    exit 2
  }
}
Write-Host "HTTP $status from the gateway"
if ($status -eq 422) {
  # The residual check's message holds kinds and counts, never values.
  try { Write-Host "refused by the residual check: $((($errorMessage | ConvertFrom-Json).error.message))" } catch { Write-Host "refused: $errorMessage" }
}

Start-Sleep -Seconds $SettleSeconds
$spy = (docker logs $SpyContainer --since $since 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { Write-Host "setup: docker logs $SpyContainer failed"; exit 2 }
$left = @($spy -split "`n" | Where-Object { $_ -match "^(MODEL|JEV) RECEIVED " })
$modelBodies = @($left | Where-Object { $_ -match "^MODEL RECEIVED " }).Count
$jevBodies = @($left | Where-Object { $_ -match "^JEV RECEIVED " }).Count
$ledger = (docker exec $GatewayContainer sh -c "tail -q -n $LedgerLines /data/ledger/*.jsonl" 2>&1 | Out-String)
Write-Host "left the gateway: $modelBodies model body(ies), $jevBodies Jev body(ies); ledger lines read: $LedgerLines"

$haystack = ($left -join "`n") + "`n" + $ledger
$leaks = @()
for ($i = 0; $i -lt $values.Count; $i++) {
  $v = $values[$i]
  $escaped = ($v | ConvertTo-Json).Trim('"')
  if ($haystack.Contains($v) -or $haystack.Contains($escaped)) { $leaks += ($i + 1) }
}

if ($leaks.Count -gt 0) {
  Write-Host "FAIL: $($leaks.Count) of $($values.Count) values reached the model, Jev or the ledger (value numbers in $(Split-Path $ValuesFile -Leaf), not counting # lines): $($leaks -join ', ')"
  exit 1
}
if ($status -eq 200 -and $modelBodies -eq 0) {
  Write-Host "FAIL: HTTP 200 but the spy recorded no model body since $since; is $SpyContainer the model the gateway called?"
  exit 1
}
if ($status -eq 200) { Write-Host "PASS: none of the $($values.Count) values left; the model got masked text only" }
elseif ($status -eq 422) { Write-Host "PASS (refused): none of the $($values.Count) values left, and masking missed something the residual check caught; report the kinds above" }
else { Write-Host "no leak, but the call did not succeed (HTTP $status): $errorMessage" }
exit 0
