#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$script:StartupTestFailures = 0
$script:StartupTestCount = 0
$script:StartupTestCimProcesses = @()

# Dot-sourcing must only define helpers; these guards prevent real side effects.
function Start-Process { throw 'Startup tests must not start processes.' }
function Invoke-RestMethod { throw 'Startup tests must not contact services.' }
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Process') { throw "Unexpected CIM class: $ClassName" }
    return $script:StartupTestCimProcesses
}

$source = Join-Path $PSScriptRoot 'start-windows.ps1'
if (-not (Test-Path -LiteralPath $source)) { throw 'Missing scripts/start-windows.ps1 (expected before implementation).' }
. $source

function Assert-StartupTest($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-StartupTest([string]$Name, [scriptblock]$Body) {
    $script:StartupTestCount++
    try {
        & $Body
        Write-Host "PASS $Name"
    } catch {
        $script:StartupTestFailures++
        Write-Host "FAIL $Name : $($_.Exception.Message)"
    }
}

Invoke-StartupTest 'Select only the configured account from multiple QQ accounts' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = [pscustomobject]@{ uin = '1111111111' } },
        [pscustomobject]@{ pid = 102; account = [pscustomobject]@{ uin = '3333333333' } },
        [pscustomobject]@{ pid = 103; account = [pscustomobject]@{ uin = '2222222222' } }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333'
    Assert-StartupTest ($selected.pid -eq 102) 'The configured account was not selected.'
}

Invoke-StartupTest 'Do not trust a top-level UIN without confirmed login or detected account evidence' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = $null; uin = '3333333333' },
        [pscustomobject]@{ pid = 102; account = [pscustomobject]@{ uin = '' } },
        [pscustomobject]@{ pid = 103; account = [pscustomobject]@{ uin = '1111111111' } }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333'
    Assert-StartupTest ($null -eq $selected) 'A process without matching account evidence was selected.'
    Assert-StartupTest ($null -eq (Select-StartupQqProcess -Processes @() -AccountUin '3333333333')) 'An empty process list produced a selection.'
}

Invoke-StartupTest 'Select an already-injected logged-in process even when account discovery is null' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = $null; loggedIn = $true; uin = '1111111111'; injected = $true; connected = $true; status = 'online' },
        [pscustomobject]@{ pid = 102; account = $null; loggedIn = $true; uin = '3333333333'; injected = $true; connected = $true; status = 'online' },
        [pscustomobject]@{ pid = 103; account = $null; loggedIn = $false; uin = '3333333333'; injected = $false; connected = $false; status = 'available' }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333'
    Assert-StartupTest ($selected.pid -eq 102) 'Confirmed hook login identity must work without filesystem account discovery.'
}

Invoke-StartupTest 'Ignore invalid PIDs for the configured account' {
    $processes = @(
        [pscustomobject]@{ pid = 0; account = [pscustomobject]@{ uin = '3333333333' } },
        [pscustomobject]@{ pid = -1; account = [pscustomobject]@{ uin = '3333333333' } },
        [pscustomobject]@{ pid = 2.5; account = [pscustomobject]@{ uin = '3333333333' } },
        [pscustomobject]@{ pid = 'invalid'; account = [pscustomobject]@{ uin = '3333333333' } }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333'
    Assert-StartupTest ($null -eq $selected) 'An invalid PID was selected.'
}

Invoke-StartupTest 'Identify a cold QQ process through ownership of only the configured account database' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = $null; loggedIn = $false; uin = '0' },
        [pscustomobject]@{ pid = 102; account = $null; loggedIn = $false; uin = '0' }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333' -AccountProcessIds @(102)
    Assert-StartupTest ($selected.pid -eq 102) 'Only the known database holder should be selected before hook login.'
}

Invoke-StartupTest 'Reject conflicting live account identity even if a database handle remains open' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = $null; loggedIn = $true; uin = '1111111111' },
        [pscustomobject]@{ pid = 102; account = [pscustomobject]@{ uin = '2222222222' }; loggedIn = $false; uin = '0' }
    )
    $selected = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333' -AccountProcessIds @(101, 102)
    Assert-StartupTest ($null -eq $selected) 'Explicit other-account identity must not be overridden.'
}

Invoke-StartupTest 'Reject ambiguous matching account processes' {
    $processes = @(
        [pscustomobject]@{ pid = 101; account = [pscustomobject]@{ uin = '3333333333' } },
        [pscustomobject]@{ pid = 102; account = [pscustomobject]@{ uin = '3333333333' } }
    )
    $rejected = $false
    try { $null = Select-StartupQqProcess -Processes $processes -AccountUin '3333333333' }
    catch { $rejected = $true }
    Assert-StartupTest $rejected 'Duplicate target account processes must not be guessed between.'
}

$executable = 'C:\Apps\Node\node.exe'
$commandPattern = '[\\/]src[\\/]bridge\.js(?:["\s]|$)'
Invoke-StartupTest 'An existing matching executable and command prevents duplicate startup' {
    $script:StartupTestCimProcesses = @(
        [pscustomobject]@{ ProcessId = 101; Name = 'node.exe'; ExecutablePath = $executable; CommandLine = '"C:\Apps\Node\node.exe" "C:\Apps\qq-bridge\src\bridge.js"' }
    )
    $found = Test-StartupProcess -Executable $executable -CommandPattern $commandPattern
    Assert-StartupTest ($found -eq $true) 'The already-running bridge was not detected.'
}

Invoke-StartupTest 'The same command under a different executable is not this installation' {
    $script:StartupTestCimProcesses = @(
        [pscustomobject]@{ ProcessId = 101; Name = 'node.exe'; ExecutablePath = 'C:\Other\node.exe'; CommandLine = '"C:\Other\node.exe" "C:\Apps\qq-bridge\src\bridge.js"' }
    )
    $found = Test-StartupProcess -Executable $executable -CommandPattern $commandPattern
    Assert-StartupTest ($found -eq $false) 'A different executable was treated as the configured one.'
}

Invoke-StartupTest 'The configured executable running another script does not block startup' {
    $script:StartupTestCimProcesses = @(
        [pscustomobject]@{ ProcessId = 101; Name = 'node.exe'; ExecutablePath = $executable; CommandLine = '"C:\Apps\Node\node.exe" "C:\Apps\other.js"' }
    )
    $found = Test-StartupProcess -Executable $executable -CommandPattern $commandPattern
    Assert-StartupTest ($found -eq $false) 'An unrelated script was treated as the bridge.'
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('qq voice startup ' + [guid]::NewGuid().ToString('N'))
$originalFfmpeg = $env:FFMPEG_PATH
$originalFfprobe = $env:FFPROBE_PATH
$originalPath = $env:PATH
try {
    $voiceRoot = Join-Path $fixture 'voice'
    $snowluma = Join-Path $fixture 'snowluma'
    foreach ($directory in @('state', 'voice\bin', 'voice\tts\runtime', 'voice\indextts-2.5\runtime', 'snowluma\config', 'src')) {
        $null = New-Item -ItemType Directory -Path (Join-Path $fixture $directory) -Force
    }
    foreach ($file in @('dsh.exe', 'qq.exe', 'node.exe', 'state\startup-credential.xml', 'state\console-token', 'snowluma\node.exe', 'voice\bin\ffmpeg.exe', 'voice\bin\ffprobe.exe', 'voice\tts\runtime\python.exe', 'voice\tts\start-tts.ps1', 'voice\indextts-2.5\runtime\python.exe', 'voice\indextts-2.5\start-tts.ps1')) {
        Set-Content -LiteralPath (Join-Path $fixture $file) -Value 'fixture' -Encoding UTF8
    }
    $voiceConfigPath = Join-Path $voiceRoot 'voice-config.json'
    $ffmpeg = Join-Path $voiceRoot 'bin\ffmpeg.exe'
    $ffprobe = Join-Path $voiceRoot 'bin\ffprobe.exe'
    $python = Join-Path $voiceRoot 'tts\runtime\python.exe'
    $ttsScript = Join-Path $voiceRoot 'tts\start-tts.ps1'
    $indexPython = Join-Path $voiceRoot 'indextts-2.5\runtime\python.exe'
    $indexTtsScript = Join-Path $voiceRoot 'indextts-2.5\start-tts.ps1'
    @{ asr = @{ ffmpeg = $ffmpeg }; tts = @{ baseUrl = 'http://127.0.0.1:9880' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $voiceConfigPath -Encoding UTF8
    @{ webuiPort = 5099; hookAutoLoad = $false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $snowluma 'config\runtime.json') -Encoding UTF8
    @{ networks = @{ httpServers = @(@{ port = 3000; accessToken = 'fixture' }) } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $snowluma 'config\onebot_3333333333.json') -Encoding UTF8
    $fixtureConfig = @{
        startup = @{ accountUin = '3333333333'; qqExecutable = (Join-Path $fixture 'qq.exe'); nodeExecutable = (Join-Path $fixture 'node.exe') }
        dsh = @{ desktopExecutable = (Join-Path $fixture 'dsh.exe') }
        snowluma = @{ homeDir = $snowluma }
        consolePort = 17171
        localVoice = @{ enabled = $true; configPath = $voiceConfigPath }
    }
    function Write-FixtureStartupConfig {
        $fixtureConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixture 'config.json') -Encoding UTF8
        $script:StartupTestStarts = @()
        $script:StartupTestRequests = @()
    }
    function Start-Process {
        param($FilePath, $WorkingDirectory, $WindowStyle, $PassThru, $ArgumentList, $RedirectStandardOutput, $RedirectStandardError)
        $script:StartupTestStarts += [pscustomobject]@{
            FilePath = $FilePath; Arguments = $ArgumentList; WindowStyle = $WindowStyle
            Ffmpeg = $env:FFMPEG_PATH; Ffprobe = $env:FFPROBE_PATH; Path = $env:PATH
        }
        if ($script:StartupTestBridgeFailure -and $FilePath -eq (Join-Path $fixture 'node.exe')) { throw 'Fixture Bridge failed to start.' }
        return [pscustomobject]@{ Id = 12345 }
    }
    function Import-Clixml {
        param($LiteralPath)
        return New-Object System.Management.Automation.PSCredential('fixture', (ConvertTo-SecureString 'fixture' -AsPlainText -Force))
    }
    function Invoke-RestMethod {
        param($Uri, $Method, $ContentType, $Body, $Headers, $TimeoutSec, $MaximumRedirection)
        $script:StartupTestRequests += [string]$Uri
        switch -Regex ($Uri) {
            '/api/login$' { return @{ success = $true; token = 'fixture' } }
            '/api/processes$' { return @{ list = @(@{ pid = 123; loggedIn = $true; uin = '3333333333'; status = 'online' }) } }
            '/get_login_info$' { return @{ data = @{ user_id = '3333333333' } } }
            '/get_status$' { return @{ data = @{ online = $true; good = $true } } }
            '/api/status$' { return @{ dshReady = $true; snowluma = @{ connected = $true } } }
            '/openapi.json$' {
                if ($script:StartupTestTtsPending) { throw 'Fixture TTS has not finished initialization.' }
                return @{ openapi = '3.1.0' }
            }
            '/health$' { return $script:StartupTestIndexHealth }
            default { throw "Unexpected fixture request: $Uri" }
        }
    }
    function Start-Sleep { throw 'Fixture reached the existing readiness wait.' }
    $env:FFMPEG_PATH = 'previous-ffmpeg'
    $env:FFPROBE_PATH = 'previous-ffprobe'
    $env:PATH = $originalPath
    $script:StartupTestTtsPending = $false
    $script:StartupTestBridgeFailure = $false
    $script:StartupTestIndexHealth = @{ model = 'IndexTTS-2.5'; ready = $true }

    Invoke-StartupTest 'Local voice starts its fixed TTS script and passes process-only audio paths to Bridge' {
        $script:StartupTestCimProcesses = @()
        Write-FixtureStartupConfig
        Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
        Assert-StartupTest ($script:StartupTestStarts.Count -eq 5) 'Expected DSH, QQ, SnowLuma, TTS, Bridge startup.'
        Assert-StartupTest ($script:StartupTestStarts[3].Arguments -eq ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ttsScript)) 'The fixed TTS startup script path must remain quoted, including spaces.'
        Assert-StartupTest (@($script:StartupTestStarts[0..2] | Where-Object { $_.Ffmpeg -ne 'previous-ffmpeg' -or $_.Ffprobe -ne 'previous-ffprobe' -or $_.Path -ne $originalPath }).Count -eq 0) 'Voice environment changed the existing DSH, QQ, or SnowLuma startup.'
        $bridgeStart = $script:StartupTestStarts[-1]
        Assert-StartupTest ($bridgeStart.Ffmpeg -eq $ffmpeg -and $bridgeStart.Ffprobe -eq $ffprobe) 'Bridge did not inherit the configured audio executables.'
        Assert-StartupTest ($bridgeStart.Path.StartsWith((Split-Path $ffmpeg) + ';')) 'Bridge PATH must start with the fixed audio binary directory.'
        Assert-StartupTest (@($script:StartupTestStarts | Where-Object { $_.WindowStyle -ne 'Hidden' }).Count -eq 0) 'Background services must start hidden.'
        Assert-StartupTest ($env:FFMPEG_PATH -eq 'previous-ffmpeg' -and $env:FFPROBE_PATH -eq 'previous-ffprobe' -and $env:PATH -eq $originalPath) 'Audio environment leaked out of Bridge startup.'
        Assert-StartupTest ($script:StartupTestRequests -contains 'http://127.0.0.1:9880/openapi.json') 'Startup reported Ready without checking local TTS.'
    }

    Invoke-StartupTest 'The fixed runtime Python running api_v2 prevents duplicate TTS startup' {
        $script:StartupTestCimProcesses = @([pscustomobject]@{ ExecutablePath = $python; CommandLine = ('"{0}" -u api_v2.py -a 127.0.0.1 -p 9880' -f $python) })
        Write-FixtureStartupConfig
        Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
        Assert-StartupTest ($script:StartupTestStarts.Count -eq 4) 'An existing matching TTS process must be reused.'
        Assert-StartupTest ($script:StartupTestStarts[-1].Ffmpeg -eq $ffmpeg) 'Bridge still needs its audio environment when TTS already exists.'
    }

    Invoke-StartupTest 'Other Python installations and other scripts do not suppress fixed TTS startup' {
        foreach ($process in @(
            [pscustomobject]@{ ExecutablePath = 'C:\Other\python.exe'; CommandLine = 'python.exe api_v2.py' },
            [pscustomobject]@{ ExecutablePath = $python; CommandLine = ('"{0}" another_api_v2.py' -f $python) }
        )) {
            $script:StartupTestCimProcesses = @($process)
            Write-FixtureStartupConfig
            Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
            Assert-StartupTest ($script:StartupTestStarts.Count -eq 5) 'An unrelated Python process incorrectly prevented TTS startup.'
        }
    }

    Invoke-StartupTest 'An initializing TTS remains subject to the existing readiness wait' {
        $script:StartupTestTtsPending = $true
        Write-FixtureStartupConfig
        $waitReached = $false
        try { Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10 }
        catch { $waitReached = $_.Exception.Message -eq 'Fixture reached the existing readiness wait.' }
        finally { $script:StartupTestTtsPending = $false }
        Assert-StartupTest $waitReached 'Startup must not report Ready before TTS is reachable.'
    }

    Invoke-StartupTest 'Selecting IndexTTS starts only its fixed launcher even when GPT is already running' {
        @{ asr = @{ ffmpeg = $ffmpeg }; tts = @{ provider = 'indextts-2.5'; baseUrl = 'http://127.0.0.1:9880/' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $voiceConfigPath -Encoding UTF8
        $script:StartupTestCimProcesses = @([pscustomobject]@{ ExecutablePath = $python; CommandLine = ('"{0}" -u api_v2.py -p 9880' -f $python) })
        Write-FixtureStartupConfig
        Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
        Assert-StartupTest ($script:StartupTestStarts.Count -eq 5) 'The existing GPT process must not suppress selected IndexTTS startup.'
        Assert-StartupTest ($script:StartupTestStarts[3].Arguments -eq ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $indexTtsScript)) 'IndexTTS must use only its fixed quoted launcher path, including spaces.'
        Assert-StartupTest ($script:StartupTestRequests -contains 'http://127.0.0.1:9880/health') 'IndexTTS Ready requires its health endpoint.'
        Assert-StartupTest (@($script:StartupTestRequests | Where-Object { $_ -like '*/openapi.json' }).Count -eq 0) 'Selected IndexTTS must not query GPT readiness.'
        Assert-StartupTest ($script:StartupTestStarts[-1].Ffmpeg -eq $ffmpeg -and $script:StartupTestStarts[-1].Ffprobe -eq $ffprobe) 'IndexTTS selection changed the Bridge audio environment.'
    }

    Invoke-StartupTest 'The fixed IndexTTS runtime and server prevent duplicate startup' {
        $server = Join-Path $fixture 'scripts\local-indextts-server.py'
        $script:StartupTestCimProcesses = @([pscustomobject]@{ ExecutablePath = $indexPython; CommandLine = ('"{0}" -u "{1}"' -f $indexPython, $server) })
        Write-FixtureStartupConfig
        Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
        Assert-StartupTest ($script:StartupTestStarts.Count -eq 4) 'An already running IndexTTS server must be reused.'
        Assert-StartupTest ($script:StartupTestRequests -contains 'http://127.0.0.1:9880/health') 'Reused IndexTTS still requires a health check.'
    }

    Invoke-StartupTest 'Other Python installations and other scripts do not suppress IndexTTS startup' {
        foreach ($process in @(
            [pscustomobject]@{ ExecutablePath = $python; CommandLine = ('"{0}" local-indextts-server.py' -f $python) },
            [pscustomobject]@{ ExecutablePath = $indexPython; CommandLine = ('"{0}" another_local-indextts-server.py' -f $indexPython) }
        )) {
            $script:StartupTestCimProcesses = @($process)
            Write-FixtureStartupConfig
            Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
            Assert-StartupTest ($script:StartupTestStarts.Count -eq 5) 'An unrelated process incorrectly prevented IndexTTS startup.'
            Assert-StartupTest ($script:StartupTestStarts[3].Arguments -eq ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $indexTtsScript)) 'Only the selected IndexTTS service should start.'
        }
    }

    Invoke-StartupTest 'IndexTTS requires both its model identity and ready state in the existing wait' {
        foreach ($health in @(
            @{ model = 'GPT-SoVITS'; ready = $true },
            @{ model = 'IndexTTS-2.5'; ready = $false }
        )) {
            $script:StartupTestIndexHealth = $health
            Write-FixtureStartupConfig
            $waitReached = $false
            try { Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10 }
            catch { $waitReached = $_.Exception.Message -eq 'Fixture reached the existing readiness wait.' }
            finally { $script:StartupTestIndexHealth = @{ model = 'IndexTTS-2.5'; ready = $true } }
            Assert-StartupTest $waitReached 'Startup must not report Ready for another model or an initializing IndexTTS.'
        }
    }

    foreach ($cloudAsrProvider in @('whisper.cpp', 'volcengine-asr-2.0')) {
        Invoke-StartupTest "Cloud TTS with $cloudAsrProvider retains audio tools without local model startup" {
            $cloudRoot = Join-Path $fixture 'cloud-voice'
            $null = New-Item -ItemType Directory -Path $cloudRoot -Force
            $cloudConfigPath = Join-Path $cloudRoot 'voice-config.json'
            @{ asr = @{ provider = $cloudAsrProvider; ffmpeg = $ffmpeg }; tts = @{ provider = 'volcengine-icl-2.0'; endpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $cloudConfigPath -Encoding UTF8
            $fixtureConfig.localVoice = @{ enabled = $true; configPath = $cloudConfigPath }
            $script:StartupTestCimProcesses = @()
            Write-FixtureStartupConfig
            try {
                Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
                Assert-StartupTest ($script:StartupTestStarts.Count -eq 4) 'Cloud TTS must start only DSH, QQ, SnowLuma, and Bridge.'
                $bridgeStart = $script:StartupTestStarts[-1]
                Assert-StartupTest ($bridgeStart.Ffmpeg -eq $ffmpeg -and $bridgeStart.Ffprobe -eq $ffprobe) 'Cloud TTS must retain the local ASR and QQ audio environment.'
                Assert-StartupTest ($bridgeStart.Path.StartsWith((Split-Path $ffmpeg) + ';')) 'Cloud TTS must retain the fixed audio binary directory in Bridge PATH.'
                Assert-StartupTest (@($script:StartupTestRequests | Where-Object { $_ -match '/(?:openapi\.json|health)$' -or $_ -like 'https://openspeech.bytedance.com/*' }).Count -eq 0) 'Cloud TTS startup must not query a local model or synthesize cloud audio.'
                Assert-StartupTest ($env:FFMPEG_PATH -eq 'previous-ffmpeg' -and $env:FFPROBE_PATH -eq 'previous-ffprobe' -and $env:PATH -eq $originalPath) 'Cloud TTS startup leaked its audio environment.'
                $lastLog = Get-Content -LiteralPath (Join-Path $fixture 'state\windows-startup.log') -Tail 1
                Assert-StartupTest ($lastLog -like '*CloudTTS configured.*' -and $lastLog -notlike '*LocalTTS ready.*') 'Startup must distinguish cloud configuration from verified local TTS readiness.'
            } finally {
                $fixtureConfig.localVoice = @{ enabled = $true; configPath = $voiceConfigPath }
            }
        }
    }

    Invoke-StartupTest 'Disabled local voice preserves the original startup and environment' {
        $fixtureConfig.localVoice = @{ enabled = $false; configPath = 'must-not-read.json' }
        $script:StartupTestCimProcesses = @()
        Write-FixtureStartupConfig
        Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10
        Assert-StartupTest ($script:StartupTestStarts.Count -eq 4) 'Disabled voice must not add a service.'
        $bridgeStart = $script:StartupTestStarts[-1]
        Assert-StartupTest ($bridgeStart.Ffmpeg -eq 'previous-ffmpeg' -and $bridgeStart.Ffprobe -eq 'previous-ffprobe' -and $bridgeStart.Path -eq $originalPath) 'Disabled voice changed Bridge environment.'
        Assert-StartupTest (@($script:StartupTestRequests | Where-Object { $_ -match '/(?:openapi\.json|health)$' }).Count -eq 0) 'Disabled voice queried TTS.'
    }

    Invoke-StartupTest 'A Bridge launch failure restores the parent audio environment' {
        $fixtureConfig.localVoice = @{ enabled = $true; configPath = $voiceConfigPath }
        $script:StartupTestBridgeFailure = $true
        Write-FixtureStartupConfig
        $failureReported = $false
        try { Invoke-QqWindowsStartup -Root $fixture -WaitSeconds 10 }
        catch { $failureReported = $_.Exception.Message -eq 'Fixture Bridge failed to start.' }
        finally { $script:StartupTestBridgeFailure = $false }
        Assert-StartupTest $failureReported 'Bridge launch failure was not reported.'
        Assert-StartupTest ($env:FFMPEG_PATH -eq 'previous-ffmpeg' -and $env:FFPROBE_PATH -eq 'previous-ffprobe' -and $env:PATH -eq $originalPath) 'A failed launch leaked its audio environment.'
    }
} finally {
    $env:FFMPEG_PATH = $originalFfmpeg
    $env:FFPROBE_PATH = $originalFfprobe
    $env:PATH = $originalPath
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean a fixture outside the temporary directory.' }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}

Write-Host ("{0}/{1} startup checks passed" -f ($script:StartupTestCount - $script:StartupTestFailures), $script:StartupTestCount)
if ($script:StartupTestFailures -gt 0) { exit 1 }
exit 0
