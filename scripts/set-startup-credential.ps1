#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path $root 'state\startup-credential.xml'
try {
    $config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $snowlumaHome = [string]$config.snowluma.homeDir
    if ([string]::IsNullOrWhiteSpace($snowlumaHome)) { throw 'config.json 未设置 snowluma.homeDir。' }
    $runtime = Get-Content -LiteralPath (Join-Path $snowlumaHome 'config\runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $webui = Get-Content -LiteralPath (Join-Path $snowlumaHome 'config\webui.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $port = 5099
    if ($null -ne $runtime.webuiPort) { $port = [int]$runtime.webuiPort }
    if ($port -lt 1 -or $port -gt 65535) { throw 'SnowLuma WebUI 端口无效。' }
    $scheme = 'http'
    if ($runtime.webuiTls.enabled -eq $true) { $scheme = 'https' }
    $loginUrl = '{0}://127.0.0.1:{1}/api/login' -f $scheme, $port
    if ($webui.mustChangePassword -eq $true) { throw '请先在 SnowLuma 管理页面完成首次密码设置，再运行本脚本。' }
} catch {
    [void][System.Windows.Forms.MessageBox]::Show('无法读取 SnowLuma 启动配置，请检查安装目录和管理端设置。', '自动启动凭据', 'OK', 'Error')
    exit 2
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '保存 SnowLuma 自动启动凭据'
$form.ClientSize = New-Object System.Drawing.Size(470, 225)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = "请输入现有 SnowLuma 管理密码。`r`n验证成功后仅为当前 Windows 用户加密保存。"
$label.Location = New-Object System.Drawing.Point(18, 18)
$label.Size = New-Object System.Drawing.Size(434, 42)
$form.Controls.Add($label)

$passwordBox = New-Object System.Windows.Forms.TextBox
$passwordBox.Location = New-Object System.Drawing.Point(18, 70)
$passwordBox.Size = New-Object System.Drawing.Size(434, 24)
$passwordBox.UseSystemPasswordChar = $true
$form.Controls.Add($passwordBox)

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(18, 106)
$statusLabel.Size = New-Object System.Drawing.Size(434, 56)
$form.Controls.Add($statusLabel)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = '验证并保存'
$saveButton.Location = New-Object System.Drawing.Point(254, 178)
$saveButton.Size = New-Object System.Drawing.Size(102, 30)
$form.Controls.Add($saveButton)
$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = '取消'
$cancelButton.Location = New-Object System.Drawing.Point(366, 178)
$cancelButton.Size = New-Object System.Drawing.Size(86, 30)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton

$saveButton.Add_Click({
    if ([string]::IsNullOrEmpty($passwordBox.Text)) {
        $statusLabel.Text = '请输入管理密码。'
        [void]$passwordBox.Focus()
        return
    }
    $saveButton.Enabled = $false
    $passwordBox.Enabled = $false
    $form.UseWaitCursor = $true
    $statusLabel.Text = '正在本机验证密码……'
    $form.Refresh()
    $login = $null
    $body = $null
    $securePassword = $null
    $credential = $null
    try {
        $body = @{ password = $passwordBox.Text } | ConvertTo-Json -Compress
        $login = Invoke-RestMethod -Uri $loginUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
        if ($login.needsTotp -eq $true) {
            $statusLabel.Text = '此账号启用了双重验证，不能仅保存密码用于无人值守登录。未保存。'
            return
        }
        if ($login.success -ne $true -or $login.mustChangePassword -eq $true) {
            $statusLabel.Text = '验证未完成。请先在 SnowLuma 管理页面确认密码及初始化状态。'
            return
        }
        $securePassword = ConvertTo-SecureString -String $passwordBox.Text -AsPlainText -Force
        $credential = New-Object System.Management.Automation.PSCredential('admin', $securePassword)
        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $credentialPath))
        $credential | Export-Clixml -LiteralPath $credentialPath -Encoding UTF8 -Force
        $passwordBox.Clear()
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    } catch {
        $httpStatus = 0
        if ($null -ne $_.Exception.Response) { $httpStatus = [int]$_.Exception.Response.StatusCode }
        if ($httpStatus -eq 401) {
            $statusLabel.Text = '密码不正确，请重新输入。'
        } elseif ($httpStatus -eq 429) {
            $statusLabel.Text = '登录尝试过多，请等待 15 分钟后重试。'
        } elseif ($null -ne $credential) {
            $statusLabel.Text = '密码验证成功，但加密保存失败。请检查 state 目录的写入权限。'
        } else {
            $statusLabel.Text = '无法完成验证，请确认 SnowLuma 已启动且管理端可访问，然后重试。'
        }
    } finally {
        $login = $null
        $body = $null
        $credential = $null
        if ($null -ne $securePassword) { $securePassword.Dispose() }
        $form.UseWaitCursor = $false
        $saveButton.Enabled = $true
        $passwordBox.Enabled = $true
        if (-not $form.IsDisposed) { [void]$passwordBox.Focus() }
    }
})
$form.Add_Shown({ [void]$passwordBox.Focus(); $form.Activate() })
try {
    $result = $form.ShowDialog()
} finally {
    $passwordBox.Clear()
    $form.Dispose()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 }
exit 1
