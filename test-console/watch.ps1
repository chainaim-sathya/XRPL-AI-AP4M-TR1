<#
.SYNOPSIS
  Opens one PowerShell window per backend view while you use the test console. Close a window to stop that view.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File test-console\watch.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File test-console\watch.ps1 -Views ledger,gpu -IntervalSec 1

  Views:
    ledger     one compact line per finished request (time, prompt size, each attempt's outcome and ms, status)
    gateway    the gateway container's log
    ollama     `ollama ps` every -IntervalSec seconds (PROCESSOR must say 100% GPU)
    gpu        GPU load and memory every -IntervalSec seconds (nvidia-smi)
    ollamalog  Ollama's own server log (-OllamaLog; the default path is the usual Windows location, unverified)
#>
param(
  # Comma list. With "powershell -File", -Views a,b,c arrives as ONE string, so the script splits it itself.
  [string[]]$Views = @("ledger", "gateway", "ollama", "gpu"),
  [string]$Container = "ca-gateway",
  [string]$LedgerGlob = "/data/ledger/*.jsonl",
  [ValidateRange(1, 3600)][int]$IntervalSec = 2,
  [ValidateRange(0, 10000)][int]$Tail = 10,
  [switch]$RawLedger,
  [string]$OllamaLog = (Join-Path $env:LOCALAPPDATA "Ollama\server.log")
)
$ErrorActionPreference = "Stop"
$known = @("ledger", "gateway", "ollama", "gpu", "ollamalog")
$Views = @($Views | ForEach-Object { $_ -split "[,\s]+" } | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
$unknown = @($Views | Where-Object { $known -notcontains $_ })
if ($unknown.Count -or -not $Views.Count) { throw "-Views takes a comma list of: $($known -join ', '). Unknown: $($unknown -join ', ')" }

# The ledger holds classes, counts and model names only (never text), so showing it is safe.
$ledgerFormat = if ($RawLedger) { "" } else { @'
 | ForEach-Object {
  try {
    $j = $_ | ConvertFrom-Json
    $tries = ($j.attempts | ForEach-Object { "$($_.model) $($_.outcome) $($_.ms)ms" }) -join " -> "
    "{0}  {1,-5} chars={2,-6} status={3}  {4}" -f $j.ts.Substring(11, 8), $j.endpoint, $j.promptChars, $j.status, $tries
  } catch { $_ }
}
'@ }

$commands = @{
  ledger    = "docker exec $Container sh -c 'tail -n $Tail -f $LedgerGlob'$ledgerFormat"
  gateway   = "docker logs -f --tail $Tail $Container"
  ollama    = "while (`$true) { Clear-Host; Get-Date -Format T; ollama ps; Start-Sleep -Seconds $IntervalSec }"
  gpu       = "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv -l $IntervalSec"
  ollamalog = "if (Test-Path -LiteralPath '$OllamaLog') { Get-Content -LiteralPath '$OllamaLog' -Tail $Tail -Wait } else { 'Not found: $OllamaLog (pass -OllamaLog <path>)' }"
}

foreach ($view in $Views) {
  $script = "`$Host.UI.RawUI.WindowTitle = 'watch: $view'; $($commands[$view])"
  # -EncodedCommand avoids every quoting problem between Start-Process and the child shell.
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  Start-Process powershell -ArgumentList "-NoExit", "-NoProfile", "-EncodedCommand", $encoded
}
Write-Host "Opened: $($Views -join ', '). Close a window to stop that view."
