# Windows 起步与云服务器部署

本文先给出 Windows 本机部署，再给出 Linux 云服务器长驻步骤。所需外部软件见[准备清单](PREREQUISITES.md)，字段和 Key 的精确位置见[配置说明](CONFIGURATION.md)。官方安装入口与版本信息核验于 **2026-10-26**。

**验证边界：本次发布进行了离线代码/配置测试，没有在新的云服务器上登录真实 QQ 或调用付费模型、ASR、TTS 完成端到端验收。** SnowLuma 上游提供 Linux 版本，与本项目在你的 Linux/QQ/模型组合上实际运行成功，是两件需要分别确认的事。文末提供实际验收步骤。

## 1. 进程和端口

```text
QQ 客户端 / SnowLuma
    ├─ OneBot HTTP :3000 ─┐
    └─ OneBot WS   :3001 ─┤
                         ▼
                    QQ bridge :3100（本机控制台）
                         │
                         ▼
                       DSH :3080 ── 你配置的模型服务
                         └─ stdio MCP ── bridge / 搜索

可选：bridge ── 火山 ASR/TTS 或本地推理服务 :9880
可选：bridge ── MemOS embedding / rerank 服务
```

端口是本教程默认值，网关可自行更改。SnowLuma 的 WebUI 通常为 `5099`，官方 Docker 示例的 noVNC 通常为 `6081`；以你选用的发行版和配置为准。它们与 OneBot API 不同。

本教程让 **DSH 与 bridge 在同机、同一非 root 用户、同一个 `DSH_HOME` 下运行**，使用本机 Cookie 鉴权。不要让一个由 root 运行、另一个由普通用户运行，然后期待自动读取相同凭据。

## 2. Windows 快速配置

### 2.1 安装并初始化 DSH

先安装 [Node.js 24 LTS](https://nodejs.org/en/download) 和 [Git](https://git-scm.com/downloads)，重新打开 PowerShell，确认：

```powershell
node --version
npm --version
git --version
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh --version
```

`0.2.1-rc.2` 是本文核验时的 npm `latest`，不是长期兼容承诺。也可按 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness#run)用 `npx @deepseek-ai/dsh web` 试用；本项目 setup 会调用 `dsh plugin ... install`，完整部署应确保 `dsh` 命令在 PATH 中。若 PowerShell 阻止 npm 的 `.ps1` 包装脚本，可调用 `npm.cmd` / `dsh.cmd`。

以下用通用路径演示；可改到自己的可写目录，并在后续所有终端保持一致：

```powershell
New-Item -ItemType Directory -Force -Path C:\qq-runtime\dsh | Out-Null
$env:DSH_HOME = 'C:\qq-runtime\dsh'
dsh web --no-open
```

打开本机 `http://127.0.0.1:3080`，按 DSH 初始化提示完成登录/连接，在 Settings → Models 配置自己的 provider、模型与 API Key。先在 DSH 中成功对话一次，记下 provider/model ID。然后用 Ctrl+C 停止 DSH，安装 bridge 集成。

### 2.2 安装 bridge 与 DSH 集成

在另一个 PowerShell 中：

```powershell
New-Item -ItemType Directory -Force -Path C:\qq-projects | Out-Null
Set-Location C:\qq-projects
git clone https://github.com/Albizzia-sun/qq-bridge.git
Set-Location qq-bridge
npm ci
Copy-Item -LiteralPath config.example.json -Destination config.json
$env:DSH_HOME = 'C:\qq-runtime\dsh'
node scripts/setup-dsh.mjs web
```

仅在首次安装时复制配置示例，不覆盖已有 `config.json`。`npm ci` 使用锁定的依赖并执行本仓库必要的 SDK 修补脚本，不要加 `--ignore-scripts` 后继续声称完成了安装。

setup 注册 `qq-mode-console`、`qq-agent-presets` 两个 bundle 和三个 stdio MCP，并尝试执行 `dsh plugin --profile web install`。若它报告安装失败，处理网络/PATH/文件权限问题后手动执行：

```powershell
dsh plugin --profile web install
```

成功后重新在 DSH 终端设置同一个 `DSH_HOME`，运行 `dsh web --no-open`。只重启 bridge 不能让已经运行的 DSH 自动获得新的 MCP schema。

### 2.3 独立安装网关并填写配置

1. 从 [SnowLuma 官方发行页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.0)自行取得 Windows 版本，按照[官方安装说明](https://snowluma.github.io/zh/docs/guide/deploy)准备 QQ 并启动 `launcher.bat`。
2. 在网关完成自己的 QQ 登录；打开它的 WebUI，使用启动日志提供的管理凭据。
3. 启用 OneBot HTTP 与正向 WebSocket 服务，核对监听地址和端口。显式配置桥接时，为两个服务设置相同的自定义访问令牌。
4. 编辑 `config.json`：填写 DSH provider/model、网关地址/令牌、`ownerQQ` 和私聊/群白名单；按[配置说明](CONFIGURATION.md#2-文字聊天的核心字段)处理本地发现选项。
5. 如需角色人设，将自己的文字写入 `roles/<角色名>.md`，待 bridge 启动后在控制台选择。不要复制发布前的私人角色或语音数据到公共仓库。

网关保持运行。在 bridge 终端中运行：

```powershell
$env:DSH_HOME = 'C:\qq-runtime\dsh'
npm start
```

打开 `http://127.0.0.1:3100`。控制台令牌默认在项目 `state/console-token`，在自己机器上查看并填入登录界面即可，不分享完整令牌或带令牌的 URL。进入控制台检查 DSH/网关连接、模式、白名单及角色选择，再按第 7 节验收。

## 3. Linux 云服务器前台部署

### 3.1 系统、目录与 Node

使用自己已有的非 root 部署用户登录服务器。下面 Ubuntu/Debian 命令安装 Git、常用下载工具和供原生 Node 依赖使用的构建工具；其他发行版使用自己的包管理器：

```bash
sudo apt-get update
sudo apt-get install -y git ca-certificates curl python3 build-essential
```

需要语音转换时另外安装 `ffmpeg`。从 [Node 官方安装入口](https://nodejs.org/en/download)安装 Node 24 LTS，不把发行版仓库里的旧 Node 当成满足要求。确认 `node --version`、`npm --version`。若 npm 全局安装目录不可写，按自己的 Node 安装方式修正权限/用户前缀，不切换 root 运行整套服务。

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" /srv/qq-runtime /srv/qq-bridge
mkdir -p /srv/qq-runtime/dsh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
command -v node
command -v dsh
export DSH_HOME=/srv/qq-runtime/dsh
dsh web --no-open
```

保留 `command -v` 的真实结果，后面的 systemd 需要它们。`dsh web` 是本项目需要的常驻 Web/API 服务；`dsh --profile headless "任务"` 是另一种一次性执行入口，不能作为这里的替代命令。

### 3.2 通过 SSH 初始化 DSH

在自己的电脑新开终端，建立转发；`<SSH_USER>` 和 `<SERVER_HOST>` 替换成自己的服务器用户与地址：

```bash
ssh -N -L 3080:127.0.0.1:3080 -L 3100:127.0.0.1:3100 -L 5099:127.0.0.1:5099 -L 6081:127.0.0.1:6081 <SSH_USER>@<SERVER_HOST>
```

如果只需要 DSH/bridge，可以去掉后两项网关管理端口。此后本机浏览器打开 `http://127.0.0.1:3080`，请求会到服务器 DSH；按初始化提示配置模型并完成一次对话。不要将服务端监听地址改成公网地址来解决浏览器访问问题。

若本机已占用这些端口，可改本地端口，但 bridge 控制台的 Host 校验要求所访问端口与其绑定端口一致。因此控制台 `3100` 优先保持同号转发，或同时调整 `consolePort` 后保持一致；不要仅改 SSH 的本地控制台端口。

DSH 初始化完成后，回到服务器 DSH 前台终端 Ctrl+C 停止进程，继续安装插件。

### 3.3 克隆并安装集成

```bash
git clone https://github.com/Albizzia-sun/qq-bridge.git /srv/qq-bridge
cd /srv/qq-bridge
npm ci
cp config.example.json config.json
export DSH_HOME=/srv/qq-runtime/dsh
node scripts/setup-dsh.mjs web
```

`/srv/qq-bridge` 应是新建的空目录；已有部署请按升级段落处理，不覆盖配置。检查 setup 输出；若自动安装未完成，修复原因后运行 `dsh plugin --profile web install`。这个步骤会修改所选 DSH profile、创建本机路径链接，不能直接从另一台机器复制已生成的 profile 路径代替重新安装。

重新运行 DSH：

```bash
export DSH_HOME=/srv/qq-runtime/dsh
dsh web --no-open
```

### 3.4 手动安装 SnowLuma 并登录 QQ

SnowLuma `v2.2.0` 官方提供 Linux x64 和 arm64 包，入口见[发行说明](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.0)。按你选择的架构和平台执行[官方部署教程](https://snowluma.github.io/zh/docs/guide/deploy)。普通 Linux 包使用其 `./launcher.sh`；无桌面云环境还需按上游说明准备 QQ 的显示/登录环境。

官方另有[Docker 部署教程](https://snowluma.github.io/zh/docs/guide/deploy/docker)，覆盖 Linux QQ、虚拟显示与远程登录界面。Docker 只是网关的一种部署方式；本教程的 DSH/bridge 仍在宿主机运行。镜像标签、权限、挂载与 QQ 版本请按选定发行版确认，不能把较早教程中的镜像示例当作最新发布版本。本仓库不打包网关或其私有组件，也不提供绕过上游授权条件的一键安装脚本。

部署时确认：

- 网关持久化目录包含登录状态和 OneBot 配置，重建容器后仍可保留。
- 可通过上游提供的界面完成真实扫码/登录；云服务器并不会免除这一步。
- HTTP/WS 服务从 bridge 所在宿主机可达；容器内部 `127.0.0.1` 与宿主机不同。若映射至宿主机，使用宿主机实际映射端口。
- 管理界面和 OneBot 的宿主机端口限制在本机/受保护私网内；远程管理通过前述 SSH 转发。
- bridge 不能读取容器里的网关配置时，在 `config.json` 显式填写 HTTP/WS URL 与令牌，设置 `followDiscoveredEndpoint:false`。

### 3.5 启动 bridge

编辑 `/srv/qq-bridge/config.json`，填写[核心字段](CONFIGURATION.md#2-文字聊天的核心字段)。先保持语音关闭、可选 MemOS 不启用，完成文字链路。然后在服务器另一个终端运行：

```bash
cd /srv/qq-bridge
export DSH_HOME=/srv/qq-runtime/dsh
npm start
```

通过 SSH 转发访问本机 `http://127.0.0.1:3100`，使用服务器项目 `state/console-token` 中的管理令牌。只有 DSH 与网关连接正常、白名单正确，并完成第 7 节收发测试后，再进入服务化步骤。

## 4. Windows 云服务器和跨机器网关

Windows 云服务器按第 2 节安装，通过远程桌面完成 QQ 登录和初次配置。DSH 与 bridge 仍使用同一个 Windows 用户及 `DSH_HOME`。如需登录后自动运行，可由该用户配置任务计划程序，分别启动 `dsh web --no-open` 与项目 `npm start`，指定工作目录和必要环境变量；网关的运行方式按 SnowLuma 官方说明配置。任务已创建不代表断开远程桌面或重启后的 QQ 链路已通过验收，应实际检查。

混合部署时优先将 DSH 与 bridge 保留在同机，仅把 QQ/SnowLuma 放到另一台主机。通过自己的 VPN、私网或 SSH 隧道连接 OneBot，配置真实可达的 HTTP/WS 地址和令牌。无需为了这一方案把 `dsh.allowRemote` 改成 `true`。

本项目支持显式远程 DSH 配置，但 Cookie 权限、启动令牌及 DSH Host/Origin/反向代理配置会改变，不属于本教程的同机默认方案。如确需反向代理 DSH，参照 [DSH 官方公开部署说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md)配置 `public-url`、受信任 Host、WebSocket 升级和 TLS；不能只将 3080 转发到公网就视为完成。

## 5. Linux 以前台结果为准配置 systemd

本节只给 DSH 和 bridge 建立常驻服务，SnowLuma 继续使用你按官方说明选择的运行方式。先停止前台 DSH/bridge，避免重复监听。以下是 `/etc/systemd/system/` 中的两个服务文件模板；由管理员写入。把 `<DEPLOY_USER>`、`<NODE_BIN_DIR>`、`<DSH_ABSOLUTE_PATH>`、`<NODE_ABSOLUTE_PATH>` 换成前面实际用户和 `command -v` 结果，不能原样启用。

`qq-dsh.service`：

```ini
[Unit]
Description=DSH Web for QQ bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=<DEPLOY_USER>
WorkingDirectory=/srv/qq-bridge
Environment=DSH_HOME=/srv/qq-runtime/dsh
Environment=PATH=<NODE_BIN_DIR>:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/srv/qq-runtime/dsh.env
ExecStart=<DSH_ABSOLUTE_PATH> web --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`qq-bridge.service`：

```ini
[Unit]
Description=QQ bridge
Wants=network-online.target qq-dsh.service
After=network-online.target qq-dsh.service

[Service]
Type=simple
User=<DEPLOY_USER>
WorkingDirectory=/srv/qq-bridge
Environment=DSH_HOME=/srv/qq-runtime/dsh
Environment=PATH=<NODE_BIN_DIR>:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/srv/qq-runtime/bridge.env
ExecStart=<NODE_ABSOLUTE_PATH> /srv/qq-bridge/src/bridge.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`After` 只保证启动顺序，不证明 DSH 或 QQ 已经就绪。启动后仍需检查连接日志。若 Node 安装在用户版本管理器目录，systemd 不会读取交互式 shell 初始化脚本；因此这里必须使用该版本真实的绝对路径和 PATH。切换 Node 版本后需同步更新服务文件。

环境文件按实际功能创建，不需要的 Key 不要填。示例内容仅为占位符：

```dotenv
# /srv/qq-runtime/dsh.env：仅启用相应搜索后端时需要
DEEPSEEK_API_KEY=<SEARCH_API_KEY>
```

```dotenv
# /srv/qq-runtime/bridge.env：仅启用 MemOS Shadow / rerank 时需要
QQ_EMBEDDING_API_KEY=<EMBEDDING_API_KEY>
QQ_RERANK_API_KEY=<RERANK_API_KEY>
```

这里由 **systemd 的 EnvironmentFile** 读取，不是应用自动读取 `.env`。主对话 Key 仍在 DSH Models 凭据中；火山 Key 仍按 `apiKeyFile` 读取。为这些环境文件和 `.key` 文件设置仅部署用户/管理员可读的权限，不写入仓库。示例命令假定文件已由你创建：

```bash
chmod 600 /srv/qq-runtime/dsh.env /srv/qq-runtime/bridge.env
sudo systemctl daemon-reload
sudo systemctl enable --now qq-dsh.service qq-bridge.service
sudo systemctl status qq-dsh.service qq-bridge.service
sudo journalctl -u qq-dsh.service -u qq-bridge.service -n 100 --no-pager
```

如果没有使用某环境文件，可不创建它（模板行前的 `-` 允许缺失），并省略对应的 `chmod` 参数。日志可能包含聊天或用户内容，排查后不要原样公开。

可选语音服务和网关必须先按其自身要求独立验证；本教程不替它们生成未验证的系统服务。添加云端语音时主要补齐独立 JSON 和凭据文件；本地 IndexTTS 则还需 Python/CUDA/权重环境，见[语音配置](CONFIGURATION.md#4-独立语音配置)。

## 6. 重启、升级与备份

持久化内容包括：

| 内容 | 路径/范围 | 原因 |
| --- | --- | --- |
| 桥接配置和状态 | `config.json`、`state/` | 白名单、会话映射、未读/记忆、控制台令牌、当前角色等 |
| 用户内容 | 自己的 `roles/*.md`、`data/`、音频素材 | 人设、日记、参考音频，不属于可重新克隆的源码 |
| 语音配置和 Key | `localVoice.configPath` 指向的 JSON、语气文件、`apiKeyFile` 指向的文件 | 保留自己的服务配置和素材路径 |
| DSH | 整个 `DSH_HOME` | profile、模型凭据、会话与插件注册 |
| SnowLuma/QQ | 按官方文档挂载/保存的配置、数据和登录目录 | 网关身份与运行状态 |
| 服务配置 | systemd 单元和环境文件 | 用户、路径及进程环境 |

这些是私有备份，不应作为公开 GitHub Release 附件。涉及 SQLite/运行状态时，停止相应进程后再做一致性文件备份；不要把正在写入的数据库文件随意复制后宣称备份完整。

升级前查看 `git status`，保留自己的改动。确认工作区可快进后再拉取选定版本，停止 DSH/bridge，执行 `npm ci`。仅已有 preset 正文改变时运行 `node scripts/build-agent-preset-patches.mjs`；仓库路径、bundle/MCP 注册项改变时运行 `node scripts/setup-dsh.mjs web`，再依次启动 DSH 和 bridge。MCP schema 变化也需要重启 DSH。不要再次用 `config.example.json` 覆盖运行配置，也不要清空 `state/` 作为通用升级手段。

迁移到另一台机器时：重新安装平台依赖，恢复私有配置/状态，修改旧绝对路径，在目标机器执行 `npm ci` 和 setup。Windows 的 `node_modules`、模型可执行文件、junction 与生成路径不能直接视为 Linux 可用。SnowLuma 可能要求重新登录 QQ，以目标机实测为准。

## 7. 验收与排错

按真实入口逐步确认，前一项成功后再判断下一项：

1. **DSH 独立可用**：浏览器能够登录，所选 provider/model 能完成实际对话；Key 或协议错误先在 DSH 解决。
2. **网关独立可用**：QQ 已登录，OneBot HTTP 与 WS 服务启动；管理 WebUI 能打开不能代替 OneBot 已连通。
3. **bridge 连接可用**：日志中 DSH 与网关均已连接，控制台可查看状态；没有 401、bundle 无法解析或工具缺失。
4. **QQ 收发闭环**：从白名单里的实际 QQ 私聊/群发一条消息，确认进入 bridge、触发正确 DSH 会话，并在同一 QQ 会话收到回复。空白名单或休眠/唤醒策略会影响是否回复。
5. **内容配置正确**：控制台选择自己的角色，确认运行模式和工具权限；公开版没有预装私人角色/声音，因此源码启动成功不等于人设已配置。
6. **重启后仍可用**：重启 DSH/bridge，核对同一 `DSH_HOME` 和路径；云部署再确认重启服务器后网关、DSH 与 bridge 均恢复并完成一次实际收发。
7. **可选功能逐项验收**：搜索、记忆、语音各自启用后测试。语音需同时检查入站转写、合成结果和 QQ 端可播放，不以 TTS HTTP 200 代替完整语音验收。

| 症状 | 优先核对 |
| --- | --- |
| bridge 连接 DSH 返回 401 | 两个进程的用户、`DSH_HOME`、DSH 初始化和连接凭据；`dsh.authToken` 不能填模型 API Key |
| DSH 报 bundle 无法解析或 QQ 工具不在列表 | setup 是否成功、`dsh plugin --profile web install` 是否完成、DSH 是否真正重启、仓库是否移动过 |
| WebUI 正常但 QQ 消息未到 | OneBot WS 地址/端口/令牌；Docker/跨机网络；是否仍误用另一个网络命名空间的 localhost |
| 入站可见但不回复 | `allow` 白名单、模式、角色/唤醒状态、模型调用结果；不要用“所有程序没退出”作为成功判断 |
| 搜索缺 Key，主对话却正常 | 搜索是否使用同名凭据引用，Key 是否注入了 DSH 而非仅 bridge，MCP 子进程是否已重启 |
| MemOS 缺 Key | 环境变量名是否与 `apiKeyEnv` 一致，是否注入 bridge，embedding base URL 与 rerank 完整 URL 是否混淆 |
| 语音启动失败或没有声音 | JSON/Key 文件路径、实际文件权限、FFmpeg、模型权重/服务、resourceId/speaker 权限；输出是否有效 WAV |
| SSH 能连但 bridge 控制台拒绝 Host | 控制台转发是否保持相同端口、浏览器是否使用 localhost/127.0.0.1；不要直接用公网域名访问其 loopback 控制台 |

旧版资料保留在 `docs/guides/` 供兼容背景参考。首次部署以本页、[准备清单](PREREQUISITES.md)、[配置说明](CONFIGURATION.md)及当前源码为准，尤其不要沿用旧的 Windows-only、个人绝对路径或把所有 Key 写进同一字段的做法。
