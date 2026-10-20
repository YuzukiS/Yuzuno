<#
T-137: who may run guest-accept.ps1. prepare.py runs Get-IdentityDigests on
the host it prepares from and records the result; guest-accept.ps1 runs
Get-Admission before it writes anything. Get-IdentityDigests and
Get-Admission are pure, so they are tested on the host with given facts only
(test_admission.py); only Get-GuestFacts reads the machine, and it only reads.

A username, a mapped folder or the token in params.json proves nothing: the
token is also in the host's lab folder. So a run is admitted only if
  - every identity fact (MachineGuid, SMBIOS UUID, computer name) is present
    and differs from the host's recorded one, and
  - the machine is Windows Sandbox (its account on a Hyper-V virtual machine)
    or is the one-time guest registered in params.json, and
  - no Yuzuno install or data exists yet.
Anything missing or unclear refuses.
#>
$IdentityFacts = @('machineGuid', 'smbiosUuid', 'computerName')

# Read-only. [Environment] asks Windows, not environment variables a process could set.
function Get-GuestFacts {
    $product = Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction SilentlyContinue
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
    $crypto = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue
    [ordered]@{ userName = [Environment]::UserName; computerName = [Environment]::MachineName
        machineGuid = "$($crypto.MachineGuid)"; smbiosUuid = "$($product.UUID)"
        manufacturer = "$($system.Manufacturer)"; model = "$($system.Model)" }
}

# A fact salted with the run's token, so params.json holds no raw host identifier.
# An empty value, or a GUID of only zeros or only Fs (a placeholder), is no fact.
function Get-FactDigest([string]$Token, [string]$Name, [string]$Value) {
    $v = "$Value".Trim().ToLowerInvariant()
    if (-not $Token -or -not $v) { return $null }
    if ($Name -ne 'computerName' -and ($v -replace '-', '') -match '^(0+|f+)$') { return $null }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(('{0}:{1}:{2}' -f $Token, $Name, $v)))
        -join ($hash | ForEach-Object { $_.ToString('x2') })
    }
    finally { $sha.Dispose() }
}

function Get-IdentityDigests($Facts, [string]$Token) {
    $digests = [ordered]@{}
    foreach ($name in $IdentityFacts) { $digests[$name] = Get-FactDigest $Token $name $Facts.$name }
    $digests
}

function Get-Admission($Facts, $Params, [bool]$Blank) {
    $reasons = New-Object System.Collections.ArrayList
    $mine = Get-IdentityDigests $Facts $Params.token
    foreach ($name in $IdentityFacts) {
        $hostDigest = "$($Params.hostIdentity.$name)"
        if ($hostDigest -notmatch '^[0-9a-f]{64}$') { [void]$reasons.Add("the host's $name is not recorded") }
        elseif (-not $mine[$name]) { [void]$reasons.Add("this machine's $name is missing") }
        elseif ($mine[$name] -eq $hostDigest) { [void]$reasons.Add("$name is the host's: this is the host or a copy of it") }
    }
    $sandbox = $Facts.userName -eq 'WDAGUtilityAccount' -and $Facts.manufacturer -eq 'Microsoft Corporation' -and
        $Facts.model -eq 'Virtual Machine'
    $guest = $Params.guestIdentity
    $registered = [bool]($guest -and $mine.machineGuid -and $mine.smbiosUuid -and
        $mine.machineGuid -eq "$($guest.machineGuid)" -and $mine.smbiosUuid -eq "$($guest.smbiosUuid)")
    if (-not ($sandbox -or $registered)) {
        [void]$reasons.Add('neither Windows Sandbox (its account on a Hyper-V virtual machine) nor the guest registered in params.json')
    }
    if (-not $Blank) { [void]$reasons.Add('Yuzuno is already installed or has data here') }
    [ordered]@{ admitted = ($reasons.Count -eq 0)
        kind = if ($registered) { 'registered' } elseif ($sandbox) { 'sandbox' } else { $null }
        reasons = @($reasons) }
}
