#requires -Version 5.1
param([int]$WaitSeconds = 300)
$ErrorActionPreference = 'Stop'

function Select-StartupQqProcess {
    param([object[]]$Processes, [string]$AccountUin, [int[]]$AccountProcessIds = @())
    $targets = @($Processes | Where-Object {
        $identifiedUin = if ($_.loggedIn -eq $true) { [string]$_.uin } else { [string]$_.account.uin }
        ($identifiedUin -ceq $AccountUin -or
         (-not $identifiedUin -and $AccountProcessIds -contains $_.pid)) -and
        [string]$_.pid -match '^[1-9][0-9]*$' -and [long]$_.pid -le 4194304
    })
    if ($targets.Count -gt 1) { throw 'Multiple processes match the configured QQ account.' }
    if ($targets.Count -eq 1) { return $targets[0] }
    return $null
}

function Test-StartupProcess {
    param([string]$Executable, [string]$CommandPattern = '.')
    $found = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $Executable -and $_.CommandLine -match $CommandPattern
    })
    return $found.Count -gt 0
}

function Write-StartupLog {
    param([string]$Root, [string]$Message)
    Add-Content -LiteralPath (Join-Path $Root 'state\windows-startup.log') -Encoding UTF8 -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
}

function Start-StartupApp {
    param([string]$Root, [string]$Name, [string]$Executable, [string]$Directory,
        [string]$Arguments = '', [string]$CommandPattern = '.', [switch]$CaptureOutput)
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Missing executable for $Name." }
    if (Test-StartupProcess -Executable $Executable -CommandPattern $CommandPattern) {
        Write-StartupLog $Root "$Name is already running."
        return
    }
    $options = @{ FilePath = $Executable; WorkingDirectory = $Directory; WindowStyle = 'Hidden'; PassThru = $true }
    if ($Arguments) { $options.ArgumentList = $Arguments }
    if ($CaptureOutput) {
        $options.RedirectStandardOutput = Join-Path $Root "state\startup-$Name.out.log"
        $options.RedirectStandardError = Join-Path $Root "state\startup-$Name.err.log"
    }
    $child = Start-Process @options
    Write-StartupLog $Root ("Started {0}, PID {1}." -f $Name, $child.Id)
}

function Start-StartupLocalVoice {
    param([string]$Root, [object]$Config)
    if ($Config.localVoice.enabled -ne $true) { return $null }
    $configPath = [string]$Config.localVoice.configPath
    if (-not [IO.Path]::IsPathRooted($configPath)) { $configPath = Join-Path $Root $configPath }
    $configPath = [IO.Path]::GetFullPath($configPath)
    $voice = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ffmpeg = [IO.Path]::GetFullPath([string]$voice.asr.ffmpeg)
    $ffprobe = Join-Path (Split-Path $ffmpeg) 'ffprobe.exe'
    foreach ($file in @($ffmpeg, $ffprobe)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing fixed local voice file: $file" }
    }
    if ([string]$voice.tts.provider -eq 'volcengine-icl-2.0') {
        # Cloud synthesis still uses local ASR and QQ audio conversion tools.
        return [pscustomobject]@{
            Ffmpeg = $ffmpeg; Ffprobe = $ffprobe; BinDirectory = (Split-Path $ffmpeg)
            TtsBaseUrl = $null; HealthUrl = $null; ExpectedModel = $null
        }
    }
    if ([string]$voice.tts.provider -eq 'indextts-2.5') {
        $ttsDirectory = Join-Path (Split-Path $configPath) 'indextts-2.5'
        $commandPattern = '(?:^|[\\/\s"])local-indextts-server\.py(?:["\s]|$)'
        $healthPath = '/health'
        $expectedModel = 'IndexTTS-2.5'
    } else {
        $ttsDirectory = Join-Path (Split-Path $configPath) 'tts'
        $commandPattern = '(?:^|[\\/\s"])api_v2\.py(?:["\s]|$)'
        $healthPath = '/openapi.json'
        $expectedModel = $null
    }
    $python = Join-Path $ttsDirectory 'runtime\python.exe'
    $launcher = Join-Path $ttsDirectory 'start-tts.ps1'
    foreach ($file in @($python, $launcher)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing fixed local voice file: $file" }
    }
    if (Test-StartupProcess -Executable $python -CommandPattern $commandPattern) {
        Write-StartupLog $Root 'LocalTTS is already running.'
    } else {
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-StartupApp -Root $Root -Name LocalTTS -Executable $powershell -Directory $ttsDirectory -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $launcher) -CommandPattern ([regex]::Escape($launcher) + '(?:["\s]|$)') -CaptureOutput
    }
    $ttsBaseUrl = ([string]$voice.tts.baseUrl).TrimEnd('/')
    return [pscustomobject]@{
        Ffmpeg = $ffmpeg; Ffprobe = $ffprobe; BinDirectory = (Split-Path $ffmpeg)
        TtsBaseUrl = $ttsBaseUrl; HealthUrl = $ttsBaseUrl + $healthPath; ExpectedModel = $expectedModel
    }
}

function Invoke-QqWindowsStartup {
    param([string]$Root = (Split-Path -Parent $PSScriptRoot), [int]$WaitSeconds = 300)
    $config = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $accountUin = [string]$config.startup.accountUin
    if ($accountUin -notmatch '^[1-9][0-9]+$') { throw 'Configure startup.accountUin before enabling startup.' }
    $credentialPath = Join-Path $Root 'state\startup-credential.xml'
    if (-not (Test-Path -LiteralPath $credentialPath)) { throw 'Run set-startup-credential.ps1 first.' }
    $credential = Import-Clixml -LiteralPath $credentialPath
    $snowlumaHome = [IO.Path]::GetFullPath([string]$config.snowluma.homeDir)
    $runtime = Get-Content -LiteralPath (Join-Path $snowlumaHome 'config\runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $webPort = 5099
    if ($null -ne $runtime.webuiPort) { $webPort = [int]$runtime.webuiPort }
    if ($webPort -lt 1 -or $webPort -gt 65535) { throw 'Invalid SnowLuma WebUI port.' }
    $scheme = 'http'
    if ($runtime.webuiTls.enabled -eq $true) { $scheme = 'https' }
    $webBase = '{0}://127.0.0.1:{1}' -f $scheme, $webPort
    if ($runtime.hookAutoLoad -eq $true) { throw 'Disable SnowLuma global hookAutoLoad to keep account-scoped startup.' }
    Write-StartupLog $Root 'Starting QQ reply services in the current Windows user session.'
    Start-StartupApp -Root $Root -Name DSH -Executable $config.dsh.desktopExecutable -Directory (Split-Path $config.dsh.desktopExecutable)
    Start-StartupApp -Root $Root -Name QQ -Executable $config.startup.qqExecutable -Directory (Split-Path $config.startup.qqExecutable)
    # Only the selected account may be loaded, including when a machine-level
    # environment variable would otherwise enable SnowLuma's all-account mode.
    $previousAutoLoad = $env:SNOWLUMA_HOOK_AUTOLOAD
    try {
        $env:SNOWLUMA_HOOK_AUTOLOAD = 'false'
        Start-StartupApp -Root $Root -Name SnowLuma -Executable (Join-Path $snowlumaHome 'node.exe') -Directory $snowlumaHome -Arguments './index.mjs' -CommandPattern '(?:^|[\\/\s"])index\.mjs(?:["\s]|$)' -CaptureOutput
    } finally { $env:SNOWLUMA_HOOK_AUTOLOAD = $previousAutoLoad }
    $localVoice = Start-StartupLocalVoice -Root $Root -Config $config
    # bridge.lock belongs to this checkout; its own single-instance guard is
    # retained. An unrelated node process must not count as this bridge.
    $bridgeRunning = $false
    $lockFile = Join-Path $Root 'state\bridge.lock'
    if (Test-Path -LiteralPath $lockFile) {
        $lockPid = (Get-Content -LiteralPath $lockFile -Raw).Trim()
        if ($lockPid -match '^[1-9][0-9]*$') {
            $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid"
            $bridgeRunning = $existing.ExecutablePath -eq $config.startup.nodeExecutable -and $existing.CommandLine -match 'src[\\/]bridge\.js(?:["\s]|$)'
        }
    }
    if ($bridgeRunning) { Write-StartupLog $Root 'Bridge is already running.' }
    else {
        $entry = Join-Path $Root 'src\bridge.js'
        $previousFfmpeg = $env:FFMPEG_PATH
        $previousFfprobe = $env:FFPROBE_PATH
        $previousPath = $env:PATH
        try {
            if ($null -ne $localVoice) {
                $env:FFMPEG_PATH = $localVoice.Ffmpeg
                $env:FFPROBE_PATH = $localVoice.Ffprobe
                $env:PATH = $localVoice.BinDirectory + ';' + $previousPath
            }
            Start-StartupApp -Root $Root -Name Bridge -Executable $config.startup.nodeExecutable -Directory $Root -Arguments ('"{0}"' -f $entry) -CommandPattern ([regex]::Escape($entry)) -CaptureOutput
        } finally {
            $env:FFMPEG_PATH = $previousFfmpeg
            $env:FFPROBE_PATH = $previousFfprobe
            $env:PATH = $previousPath
        }
    }

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $headers = $null
    $loadedPid = $null
    $stage = 'SnowLuma WebUI'
    while ((Get-Date) -lt $deadline) {
        if ($null -eq $headers) {
            $body = @{ password = $credential.GetNetworkCredential().Password } | ConvertTo-Json -Compress
            try {
                $login = Invoke-RestMethod -Uri "$webBase/api/login" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5 -MaximumRedirection 0
            } catch {
                $code = 0
                if ($null -ne $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
                if ($code -in @(401, 403, 429)) { throw "SnowLuma login rejected (HTTP $code). Update the encrypted startup credential." }
                Start-Sleep -Seconds 2
                continue
            } finally { $body = $null }
            if (-not $login.success -or $login.needsTotp -or $login.mustChangePassword -or -not $login.token) { throw 'SnowLuma login requires user interaction.' }
            $headers = @{ 'x-snowluma-token' = $login.token }
            $login = $null
            $credential = $null
            $stage = 'the configured QQ account to log in'
        }
        $processList = Invoke-RestMethod -Uri "$webBase/api/processes" -Headers $headers -TimeoutSec 5 -MaximumRedirection 0
        $target = Select-StartupQqProcess -Processes $processList.list -AccountUin $accountUin
        if ($null -eq $target) {
            # SnowLuma 2.1.1 reads UserDataInfo.ini as UTF-8, but QQ can write
            # GBK. Query its native read-only file-holder API with the verified
            # account path instead; do not alter QQ's shared INI or load first.
            $holderJson = & (Join-Path $snowlumaHome 'node.exe') (Join-Path $Root 'scripts\qq-startup-process.mjs')
            if ($LASTEXITCODE -ne 0) { throw 'Could not identify the configured QQ database holder.' }
            # Windows PowerShell 5.1 preserves a JSON array as one pipeline
            # object; wrapping that pipeline in @() would create a nested array.
            $holderPids = ConvertFrom-Json -InputObject ($holderJson -join "`n")
            $target = Select-StartupQqProcess -Processes $processList.list -AccountUin $accountUin -AccountProcessIds $holderPids
        }
        if ($null -eq $target) { Start-Sleep -Seconds 2; continue }
        if ($target.status -ne 'online' -and $target.pid -ne $loadedPid) {
            $load = Invoke-RestMethod -Uri "$webBase/api/processes/$($target.pid)/load" -Method Post -Headers $headers -TimeoutSec 30 -MaximumRedirection 0
            if (-not $load.success) { throw 'SnowLuma could not load the selected QQ process. See its local log.' }
            $loadedPid = $target.pid
            Write-StartupLog $Root ("Loaded only configured QQ account {0}, PID {1}." -f $accountUin, $target.pid)
        }
        $stage = 'OneBot and DSH to become ready'
        try {
            $onebot = Get-Content -LiteralPath (Join-Path $snowlumaHome "config\onebot_$accountUin.json") -Raw -Encoding UTF8 | ConvertFrom-Json
            $httpServer = $onebot.networks.httpServers[0]
            $onebotBase = 'http://127.0.0.1:{0}' -f [int]$httpServer.port
            $onebotHeaders = @{ Authorization = ('Bearer ' + $httpServer.accessToken) }
            $identity = Invoke-RestMethod -Uri "$onebotBase/get_login_info" -Method Post -Headers $onebotHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 5
            $health = Invoke-RestMethod -Uri "$onebotBase/get_status" -Method Post -Headers $onebotHeaders -ContentType 'application/json' -Body '{}' -TimeoutSec 5
            $consoleToken = (Get-Content -LiteralPath (Join-Path $Root 'state\console-token') -Raw).Trim()
            $bridge = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/api/status' -f $config.consolePort) -Headers @{ 'x-console-token' = $consoleToken } -TimeoutSec 5
            if ([string]$identity.data.user_id -ceq $accountUin -and $health.data.online -eq $true -and $health.data.good -eq $true -and $bridge.dshReady -eq $true -and $bridge.snowluma.connected -eq $true) {
                if ($null -ne $localVoice -and $localVoice.HealthUrl) {
                    $stage = 'local TTS to finish initialization'
                    $ttsHealth = Invoke-RestMethod -Uri $localVoice.HealthUrl -TimeoutSec 5
                    if ($localVoice.ExpectedModel -and ($ttsHealth.model -cne $localVoice.ExpectedModel -or $ttsHealth.ready -isnot [bool] -or -not $ttsHealth.ready)) {
                        throw 'Selected local TTS has not finished initialization.'
                    }
                }
                $voiceReady = if ($null -ne $localVoice -and $localVoice.HealthUrl) { ' LocalTTS ready.' }
                    elseif ($null -ne $localVoice) { ' CloudTTS configured.' } else { '' }
                Write-StartupLog $Root (("Ready: QQ {0} online, OneBot healthy, DSH ready." -f $accountUin) + $voiceReady)
                return
            }
        } catch { }
        Start-Sleep -Seconds 2
    }
    throw "Startup timed out waiting for $stage."
}

if ($MyInvocation.InvocationName -ne '.') {
    $root = Split-Path -Parent $PSScriptRoot
    try { Invoke-QqWindowsStartup -Root $root -WaitSeconds $WaitSeconds }
    catch {
        Write-StartupLog $root ('FAILED: ' + $_.Exception.Message)
        exit 1
    }
}
