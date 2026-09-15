<#
.SYNOPSIS
    Stage 2 of the live-testing ramp: a throwaway Paper server on your own box
    that the bot is allowed to join. Windows/PowerShell twin of
    scripts/live/local_mc_server.sh.

.DESCRIPTION
    Why this exists: the FakeBot benchmark only proves planner/recovery logic,
    and a public SMP is not a test server. So you get a real server, with real
    chunk streaming, pathfinding and inventory transactions, on a host you own.

    Defaults: loopback-only bind, online-mode=false (offline auth is acceptable
    ONLY here), whitelist restricted to the one bot account, small view distance
    so chunk-loading problems still surface quickly, no spawn protection.

    Refuses to start if the configuration would expose an offline-mode server
    beyond loopback, or before you accept the Mojang EULA.

.PARAMETER Username
    Minecraft account the bot will join as. Whitelisted.

.PARAMETER AcceptEula
    Asserts you have read and accept the Minecraft EULA. Required to write anything.

.PARAMETER Lan
    Bind 0.0.0.0 so other machines can join. Requires -OnlineMode $true.

.EXAMPLE
    ./scripts/live/local_mc_server.ps1 -DryRun -Username "nickgurrcrafter5"
.EXAMPLE
    ./scripts/live/local_mc_server.ps1 -AcceptEula -Username "nickgurrcrafter5"
#>
[CmdletBinding()]
param(
    [string]$Username = "",
    [string]$Version = "1.21.6",
    [int]$Port = 55916,
    [string]$DataDir = "",
    [bool]$OnlineMode = $false,
    [string[]]$ExtraWhitelist = @(),
    [string]$Heap = "2G",
    [switch]$Lan,
    [switch]$AcceptEula,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Stop-WithReason([string]$message) {
    Write-Host "local_mc_server: $message" -ForegroundColor Red
    exit 1
}

if (-not $DataDir) {
    $envDir = $env:MINDCRAFT_LIVE_SERVER_DIR
    $DataDir = if ($envDir) { $envDir } else { Join-Path ".live" "mc-server" }
}
# Resolve once, before any download or Java invocation. This keeps the Windows
# path native and independent of Git Bash/MSYS path conversion or repository
# line-ending settings.
if (-not [System.IO.Path]::IsPathRooted($DataDir)) {
    $DataDir = Join-Path (Get-Location).Path $DataDir
}
$DataDir = [System.IO.Path]::GetFullPath($DataDir)

# ---- safety checks (configuration first, consent last) --------------------
# -OnlineMode is typed [bool], so the coercion is enforced by the parameter binder.
if ($Port -lt 1 -or $Port -gt 65535) {
    Stop-WithReason "-Port must be between 1 and 65535"
}
if ($Lan -and -not $OnlineMode) {
    Stop-WithReason "refusing to bind 0.0.0.0 with online-mode=false: an unauthenticated server on your LAN can be joined and controlled by anyone on that network. Use -OnlineMode `$true, or drop -Lan."
}
if (-not $Username -and -not $DryRun) {
    Stop-WithReason "-Username is required (the bot account to whitelist)"
}
if ($Username -and $Username -notmatch '^[A-Za-z0-9_]{3,16}$') {
    Stop-WithReason "invalid Minecraft username '$Username' (3-16 chars, [A-Za-z0-9_])"
}
if (-not $AcceptEula -and -not $DryRun) {
    Stop-WithReason "refusing to start a server before you accept the Mojang EULA: rerun with -AcceptEula"
}

$Bind = if ($Lan) { "0.0.0.0" } else { "127.0.0.1" }
$BotAuth = if ($OnlineMode) { "microsoft" } else { "offline" }
$names = @()
if ($Username) { $names += $Username }
$names += $ExtraWhitelist | Where-Object { $_ }
$names = $names | Where-Object { $_ } | Select-Object -Unique
$Whitelist = $names -join ","

function Get-OfflinePlayerUuid([string]$name) {
    # Standard Java offline UUID: MD5("OfflinePlayer:<name>") with version 3 and
    # the IETF variant bits set, so the server recognises the account.
    $bytes = [System.Security.Cryptography.MD5]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes("OfflinePlayer:$name"))
    $bytes[6] = [byte](($bytes[6] -band 0x0F) -bor 0x30)
    $bytes[8] = [byte](($bytes[8] -band 0x3F) -bor 0x80)
    $hex = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    return @(
        $hex.Substring(0, 8), $hex.Substring(8, 4), $hex.Substring(12, 4),
        $hex.Substring(16, 4), $hex.Substring(20, 12)
    ) -join "-"
}

# ---- dry run ---------------------------------------------------------------
if ($DryRun) {
    $secure = if ($OnlineMode) { "true" } else { "false" }
    Write-Host @"
would:
  1. create $DataDir/
  2. resolve the latest Paper build for $Version from https://api.papermc.io/v2/projects/paper
  3. download that server.jar into $DataDir/paper-$Version.jar
  4. write $DataDir/server.properties:
       server-port=$Port
       server-ip=$Bind
       online-mode=$($OnlineMode.ToString().ToLower())
       whitelist=$Whitelist
       white-list=true
       spawn-protection=0
       view-distance=8
       simulation-distance=6
       max-players=3
       pvp=false
       enforce-secure-profile=$secure
       motd=mindcraft-live-test
  5. write $DataDir/eula.txt -> eula=true (only with -AcceptEula)
  6. java -Xmx$Heap -jar paper-$Version.jar --nogui
  7. print the matching harness command:
       node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port $Port --auth $BotAuth --username $(if ($Username) { $Username } else { "<bot-name>" }) --features direct

nothing was downloaded, written or started (-DryRun).
"@
    exit 0
}

# ---- real run --------------------------------------------------------------
$java = Get-Command java -ErrorAction SilentlyContinue
if (-not $java) { Stop-WithReason "java not found on PATH (Paper 1.20.5+ needs a JDK 21+)" }

# java writes its version banner to stderr; under ErrorActionPreference=Stop a
# native command's stderr can be turned into a terminating error in Windows
# PowerShell, so route it through cmd and relax the preference just for this call.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$javaVersion = (cmd /c "java -version 2>&1" | Select-Object -First 1)
$ErrorActionPreference = $prevEap
if ("$javaVersion" -match '"([0-9]+)') {
    $major = [int]$Matches[1]
    if ($major -eq 1 -and "$javaVersion" -match '"1\.(\d+)') { $major = [int]$Matches[1] }
    if ($major -lt 21) { Stop-WithReason "Paper for $Version requires Java 21+ (found $major)" }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$jar = Join-Path $DataDir "paper-$Version.jar"

if (-not (Test-Path $jar)) {
    Write-Host "resolving latest Paper build for $Version ..."
    try {
        $api = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds"
        $build = ((Invoke-RestMethod -Uri $api -TimeoutSec 30).builds | Select-Object -Last 1).build
        $url = "https://api.papermc.io/v2/projects/paper/versions/$Version/builds/$build/downloads/paper-$Version-$build.jar"
        Write-Host "downloading Paper build $build"
        Invoke-WebRequest -Uri $url -OutFile "$jar.part" -TimeoutSec 300
        Move-Item "$jar.part" $jar -Force
    }
    catch {
        Stop-WithReason "could not download Paper for $Version ($_). Check the version exists and that the network is reachable."
    }
}

Set-Content -Path (Join-Path $DataDir "eula.txt") -Value "eula=true"   # -AcceptEula required above

$secureProfile = if ($OnlineMode) { "true" } else { "false" }
$properties = @(
    "# generated by scripts/live/local_mc_server.ps1 - mindcraft live integration test",
    "online-mode=$($OnlineMode.ToString().ToLower())",
    "server-port=$Port",
    "server-ip=$Bind",
    "enforce-secure-profile=$secureProfile",
    "white-list=true",
    "whitelist=$Whitelist",
    "max-players=3",
    "view-distance=8",
    "simulation-distance=6",
    "spawn-protection=0",
    "pvp=false",
    "broadcast-console-to-ops=true",
    "broadcast-rcon-to-ops=false",
    "enable-command-block=false",
    "level-seed=mindcraft-live",
    "motd=mindcraft-live-test"
)
Set-Content -Path (Join-Path $DataDir "server.properties") -Value $properties -Encoding ascii

# Whitelist file, so white-list=true is actually honoured.
$entries = @()
foreach ($n in $names) {
    $uuid = $null
    if ($OnlineMode) {
        try {
            $mojang = Invoke-RestMethod -Uri "https://api.mojang.com/users/profiles/minecraft/$n" -TimeoutSec 10
            $raw = $mojang.id
            $uuid = @(
                $raw.Substring(0, 8), $raw.Substring(8, 4), $raw.Substring(12, 4),
                $raw.Substring(16, 4), $raw.Substring(20, 12)
            ) -join "-"
        }
        catch { $uuid = $null }
    }
    else {
        $uuid = Get-OfflinePlayerUuid $n
    }
    if ($uuid) {
        $entries += [ordered]@{ uuid = $uuid; name = $n }
    }
    else {
        Write-Warning "$n needs a real Mojang UUID: run '/whitelist add $n' from the server console"
    }
}
$whitelistJson = [ordered]@{ owned = @(); pending = @(); entries = [object[]]$entries } | ConvertTo-Json -Depth 5
Set-Content -Path (Join-Path $DataDir "whitelist.json") -Value $whitelistJson -Encoding ascii

Write-Host @"

Ready. Starting Paper $Version on ${Bind}:$Port (whitelist: $Whitelist, online-mode=$($OnlineMode.ToString().ToLower())).
World files live in $DataDir\ and are safe to delete afterwards.

Then, from a second terminal:

  node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port $Port --auth $BotAuth --username $(if ($Username) { $Username } else { "<bot-name>" }) --features direct

Leave this terminal open. Ctrl-C stops the server.

"@

Push-Location $DataDir
try {
    # The server logs to stderr as well; keep it from becoming a terminating error.
    $ErrorActionPreference = "Continue"
    & java "-Xmx$Heap" -jar (Split-Path -Leaf $jar) --nogui
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
