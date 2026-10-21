<#
T-137: the Yuzuno desktop's install, upgrade and uninstall, run INSIDE a
disposable Windows guest prepared by prepare.py (README). It writes nothing
before guest-lib.ps1's Get-Admission passes: this machine's identity is present
and is not the host's that prepare.py recorded; it is Windows Sandbox or the
guest registered in params.json; and it has no Yuzuno install or data yet.

  powershell -NoProfile -File C:\t137\harness\guest-accept.ps1 -Params C:\t137\config\params.json

Steps: check both packages (SHA-256, version) and that the WebView2 runtime is
there (the offline guest cannot download it); install the old package silently;
seed a test connection (core.json) and a marker in each app data folder;
install the new package over it; check the version changed,
the seeded data is unchanged and nothing new is named "-next"; uninstall with
the registered uninstaller; record what is left. Every step is recorded in
C:\t137\out\result.json, the first failure included; the exit status is 0
only if every check passed. Nothing here bypasses a signature, SmartScreen or
another protection: a prompt is recorded as what happened.
#>
param([Parameter(Mandatory = $true)][string]$Params)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'guest-lib.ps1')
$p = Get-Content -Raw -LiteralPath $Params | ConvertFrom-Json
$out = $p.results
# Steps 2-7 and the helpers they use: shared with identity-check.ps1.
$Names = 'yuzuno'
. (Join-Path $PSScriptRoot 'upgrade-steps.ps1')
function Save {
    $failed = @($steps | Where-Object { -not $_.ok })
    $result = [ordered]@{ product = $p.product; old = $p.old; new = $p.new
        passed = ($failed.Count -eq 0 -and $steps.Count -gt 0)
        firstFailure = if ($failed.Count) { $failed[0].name } else { $null }; steps = $steps }
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding UTF8
    return $result.passed
}

# 1. Only in a disposable guest that is not the host, from a blank start. Up to
# here everything only read; nothing is written unless this passes.
$facts = Get-GuestFacts
$before = Snapshot
$blank = ($before.files.Count -eq 0 -and $before.keys.Count -eq 0 -and $before.entries.Count -eq 0)
$admission = Get-Admission $facts $p $blank
# No raw identifier or path is recorded on a refusal: it may be on the host.
$seen = [ordered]@{ kind = $admission.kind; manufacturer = $facts.manufacturer; model = $facts.model
    executionPolicy = "$(Get-ExecutionPolicy)" }
if (-not $admission.admitted) {
    $counts = [ordered]@{ files = $before.files.Count; keys = $before.keys.Count; entries = $before.entries.Count }
    Step 'admission' $false ([ordered]@{ reasons = $admission.reasons; seen = $seen; baselineCounts = $counts })
    # Only into a results folder that already exists (the guest's mapped one); none is created.
    if (Test-Path -LiteralPath $out -PathType Container) { [void](Save) }
    # Not Write-Error: with ErrorActionPreference Stop it would end the script with 1.
    [Console]::Error.WriteLine('Refusing: ' + ($admission.reasons -join '; '))
    exit 2
}
Step 'admission' $true $seen

try {
    # 2-7: upgrade-steps.ps1.
    Invoke-UpgradeSteps
}
catch {
    Step 'stopped' $false "$($_.Exception.Message)"
}
if (Save) { exit 0 } else { exit 1 }
