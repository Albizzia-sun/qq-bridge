# 配置、API Key 与本地数据的位置

本页说明实际代码支持的配置接口。先复制仓库根目录的 `config.example.json` 为 `config.json`，只修改所需字段。以下 JSON 都是需要**合并到已有配置中的片段**，不是完整配置。所有占位符都必须换成自己的值；代码不会自动替换占位符。

本项目不自动加载 `.env`。环境变量必须在启动进程前由 PowerShell/Bash、进程管理器或 systemd 的 `EnvironmentFile` 注入。只创建 `.env` 文件不会生效。

## 1. 各种 Key、令牌与读取它们的进程

| 用途 | 是否必需 | 精确配置/存储位置 | 由谁读取 |
| --- | --- | --- | --- |
| 主对话模型 API Key | 使用需要鉴权的模型服务时必需 | 在 DSH Settings → Models 配置；DSH 凭据位于 `$DSH_HOME/.credentials.yaml`，provider 配置引用该凭据 | DSH |
| DSH 连接凭据 | 本机通常无需手填 | 首选同一 OS 用户、同一 `DSH_HOME` 自动使用 DSH 浏览器会话签名；显式方式为环境变量 `DSH_LAUNCH_TOKEN` 或 `config.json` 的 `dsh.authToken` | bridge 的 DSH 客户端 |
| OneBot HTTP/WS 访问令牌 | 网关启用鉴权时必需 | bridge 的 `snowluma.accessToken`；对应网关 `config/onebot_<uin>.json` 的 `networks.httpServers[].accessToken`、`networks.wsServers[].accessToken` | bridge / SnowLuma MCP / 网关 |
| 桥接控制台管理令牌 | 需要，但可自动生成 | `consoleToken`；留空时生成到 `state/console-token` | bridge 控制台、调用它的 MCP |
| SnowLuma WebUI 登录凭据 | 使用其管理界面时需要 | 由 SnowLuma 生成/管理，见它的启动日志和官方配置 | SnowLuma WebUI；不是 OneBot 令牌 |
| DeepSeek 网页搜索 Key | 使用该搜索后端时需要 | 优先 `webSearch.apiKey`；其次环境变量 `webSearch.apiKeyEnv` 指定的名称，默认 `DEEPSEEK_API_KEY`；最后 DSH `.credentials.yaml` 中同名 `refs` | 搜索 MCP，通常是 DSH 的子进程 |
| Bing 搜索 Key | 不需要 | `webSearch.provider:"bing"` | 搜索 MCP |
| MemOS embedding Key | 启用 Shadow 时必需 | `socialV2.longMemory.shadow.embedding.apiKeyEnv` 指定的环境变量 | **bridge** |
| MemOS rerank Key | 启用重排时必需 | `socialV2.longMemory.shadow.reranker.apiKeyEnv` 指定的环境变量 | **bridge** |
| 火山 ASR API Key | 选择火山 ASR 时必需 | 独立语音 JSON 的 `asr.apiKeyFile` 指向 UTF-8 凭据文件 | **bridge** 启动时读取 |
| 火山 TTS API Key | 选择火山 TTS 时必需 | 独立语音 JSON 的 `tts.apiKeyFile` 指向 UTF-8 凭据文件 | **bridge** 启动时读取 |
| whisper.cpp / 本地 TTS / 日记 | 不需要云 Key | 需要本地程序、模型和文件路径，见下文 | bridge、独立推理服务或日记 MCP |

**`dsh.authToken` 不是大模型 API Key。** 模型 Key 放 DSH 的模型设置；DSH 连接令牌用于访问 DSH 进程。如果 DSH 已能对话而 bridge 报 401，先检查用户、`DSH_HOME` 和连接鉴权，不能把模型 Key 填入 `authToken` 试错。

DSH 默认目录是当前用户的 `~/.dsh`。Windows 的 `~` 对应用户主目录。若改了 `DSH_HOME`，必须让 DSH、`setup-dsh.mjs` 和 bridge 使用同一个绝对路径。连接自动读取的浏览器会话签名记录与模型服务凭据不是同一项。

### 环境变量应注入哪个终端

以下仅演示变量赋值，值是占位符。只在启用对应可选功能时设置。

Windows：

```powershell
# 启动 DSH 的 PowerShell：搜索 MCP 会继承它。
$env:DSH_HOME = 'C:\qq-runtime\dsh'
$env:DEEPSEEK_API_KEY = '<SEARCH_API_KEY>'
dsh web --no-open
```

```powershell
# 启动 bridge 的另一个 PowerShell：MemOS 会继承它。
$env:DSH_HOME = 'C:\qq-runtime\dsh'
$env:QQ_EMBEDDING_API_KEY = '<EMBEDDING_API_KEY>'
$env:QQ_RERANK_API_KEY = '<RERANK_API_KEY>'
npm start
```

Linux：

```bash
# 启动 DSH 的 shell
export DSH_HOME=/srv/qq-runtime/dsh
export DEEPSEEK_API_KEY='<SEARCH_API_KEY>'
dsh web --no-open
```

```bash
# 启动 bridge 的另一个 shell
export DSH_HOME=/srv/qq-runtime/dsh
export QQ_EMBEDDING_API_KEY='<EMBEDDING_API_KEY>'
export QQ_RERANK_API_KEY='<RERANK_API_KEY>'
npm start
```

不要在分享的终端记录或公共脚本里保存实际赋值。服务化后的注入方式见[systemd 说明](CLOUD_DEPLOYMENT.md#5-linux-以前台结果为准配置-systemd)。

## 2. 文字聊天的核心字段

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "<DSH_PROVIDER_ID>",
    "model": "<DSH_MODEL_ID>",
    "authToken": "",
    "allowRemote": false
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<YOUR_ONEBOT_TOKEN>",
    "followDiscoveredEndpoint": false,
    "homeDir": "",
    "launcherPath": ""
  },
  "ownerQQ": null,
  "allow": { "private": [], "groups": [] },
  "allowAllWhenEmpty": false,
  "consolePort": 3100,
  "consoleToken": "",
  "localVoice": { "enabled": false, "configPath": "" }
}
```

- 将 `ownerQQ:null` 改成自己的管理员 QQ 号，将需要参与的 QQ 号/群号作为数字加入对应数组。空数组是安全的初始状态，不是“允许所有人”。
- `dsh.provider`、`dsh.model` 使用 DSH 中实际注册的 ID；显示名称不一定等于 ID。先在 DSH 本身完成一轮对话，再接入 bridge。自定义服务需选择与它匹配的 OpenAI Completions/Responses 或 Anthropic Messages 协议，见 [DSH provider 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。
- `followDiscoveredEndpoint:false` 表示明确使用上面填写的网关地址。默认示例允许本地发现；只有 bridge 可读到正确的 SnowLuma 配置时，才应依赖发现结果。
- SnowLuma 的 HTTP 和 WS 可以配置不同令牌；本例要求两端设置**同一个自定义令牌**，以匹配 bridge 单个显式 `accessToken`。本地发现可分别读取网关的两项配置，但跨机器或容器时不能假定文件可见。
- `SNOWLUMA_HOME` 可帮助定位网关目录，`SNOWLUMA_HTTP_URL`、`SNOWLUMA_TOKEN` 是部分 OneBot 辅助入口支持的环境变量；完整部署应以 `config.json` 的 HTTP/WS 地址和令牌为主，避免不同进程配置不一致。
- `sessionCwd` 留空时使用项目状态目录下的 agents 工作目录；非空时需填写本机真实可写目录。

控制台默认只监听 `127.0.0.1:3100`。`consoleToken` 留空时，完整管理令牌保存在 `state/console-token`；它不是一条可以公开的访问链接。通过控制台登录界面填入令牌，远程访问用 SSH 转发。API 支持 `x-console-token` 请求头。

### 自己的角色卡与技术预设

把自己的角色文字写入 `roles/<角色名>.md`，在控制台的人格管理中选择；选择状态存于 `state/current-role.json`。公开版保留桥接需要的技术 agent preset 和工具约束，个人角色卡与语音预设不随仓库发布。不要把 API Key、私聊记录或登录令牌写进角色卡。角色卡修改会按桥接现有注入规则生效。仅修改已有 `agent.cordis.yml` 时，运行 `node scripts/build-agent-preset-patches.mjs` 并重启 DSH 即可；首次安装、仓库路径或注册项改变时才运行 `node scripts/setup-dsh.mjs web`。MCP 工具 schema 变化后也需重启 DSH，使其重新读取。

## 3. 搜索与记忆

RAG 的完整链路、主回复与 Shadow 的区别、数据位置和验证步骤见 [RAG 与长期记忆教程](RAG_MEMORY.md)。当前主回复使用近期与关键词相关记忆；开启 MemOS Shadow 后，向量检索与可选重排结果用于对照日志，不会自动替换主回复的记忆来源。

只使用免 Key 搜索：

```json
{ "webSearch": { "provider": "bing", "apiKey": "" } }
```

使用 DeepSeek 搜索时配置 `webSearch.provider`、`baseURL`、`model` 和 `apiKeyEnv`；`provider:"auto"` 会在当前实现条件允许时使用 DeepSeek，否则回落 Bing。不是任意 OpenAI-compatible 模型都支持本项目搜索协议。`webSearch.apiKey` 虽受代码支持，公开配置应留空；使用命名环境变量或 DSH 中对应凭据引用。仅在 bridge 的终端设置搜索 Key，不会使已经运行的 DSH 子进程获得它。

普通长期记忆复用 DSH 模型。只有要启用派生的 MemOS Shadow 索引时才增加以下片段：

```json
{
  "socialV2": {
    "longMemory": {
      "shadow": {
        "enabled": true,
        "embedding": {
          "endpoint": "https://<EMBEDDING_SERVICE_HOST>/v1",
          "model": "<EMBEDDING_MODEL_ID>",
          "apiKeyEnv": "QQ_EMBEDDING_API_KEY"
        },
        "reranker": {
          "enabled": false,
          "endpoint": "",
          "model": "",
          "apiKeyEnv": ""
        }
      }
    }
  }
}
```

embedding 的 `endpoint` 是兼容服务的 **base URL**，底层会拼接 `/embeddings`；reranker 的 `endpoint` 要填写**完整重排 URL**（通常以 `/rerank` 结尾）。要启用重排，把 `enabled` 改为 `true` 并补齐 endpoint、model、apiKeyEnv；向 bridge 注入同名变量。它们可来自同一家服务，但不能因此漏掉任一配置。

Shadow 数据存于 `state/memos-shadow/memos.db`。现有索引绑定创建时的 embedding endpoint/model；不能直接改模型后假定旧向量兼容。本适配器只做派生索引与对比，不安装 DSH 的全量 MemOS 捕获/演化流程，也不会自动下载默认本地模型。

## 4. 独立语音配置

语音是可选功能。保持 `localVoice.enabled:false` 可先完成文字部署。启用时在 bridge 配置中引用独立 JSON：

```json
{
  "localVoice": {
    "enabled": true,
    "configPath": "voice-config.json"
  }
}
```

`configPath` 相对于项目根目录解析。下面语音 JSON 内的可执行文件、权重、工作目录、输出目录和凭据文件建议全部使用绝对路径；不能把它们都当成相对该 JSON 的路径。Windows JSON 使用 `C:/qq-runtime/...` 或双反斜杠。`workDir`、`outputDir` 必须可写。

### 4.1 火山 ASR + 火山 TTS 配置结构

这是字段结构示例，尚未选择任何服务资源、音色或模型，补齐前不能运行：

```json
{
  "workDir": "/srv/qq-runtime/voice-work",
  "outputDir": "/srv/qq-runtime/voice-output",
  "asr": {
    "provider": "volcengine-asr-2.0",
    "ffmpeg": "/usr/bin/ffmpeg",
    "endpoint": "<ASR_WEBSOCKET_ENDPOINT>",
    "resourceId": "<ASR_RESOURCE_ID>",
    "apiKeyFile": "/srv/qq-runtime/secrets/volc-asr.key",
    "audio": { "format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1 },
    "chunkDurationMs": 200,
    "timeoutMs": 180000
  },
  "tts": {
    "provider": "volcengine-icl-2.0",
    "endpoint": "<TTS_HTTP_ENDPOINT>",
    "resourceId": "<TTS_RESOURCE_ID>",
    "apiKeyFile": "/srv/qq-runtime/secrets/volc-tts.key",
    "speaker": "<YOUR_AUTHORIZED_SPEAKER_ID>",
    "model": "<TTS_MODEL_ID>",
    "audioParams": { "format": "pcm", "sample_rate": 24000 },
    "timeoutMs": 300000
  }
}
```

两个 `.key` 文件只写各自 API Key 文本，不要套 JSON，不要写 `KEY=`。当前适配器以 `X-Api-Key` 发送凭据；`resourceId`、`speaker` 是服务资源标识，不是 Key。代码不会从任意 `VOLC_*` 环境变量自动读取它们。文件在 bridge 启动时读取，更换后重启 bridge。

ASR 需要 FFmpeg 将网关返回的音频转换为 16 kHz/16 位/单声道原始 PCM。TTS 当前代码要求请求 PCM，收到完整数据后包装为 WAV；不要把示例 `audioParams.format` 改成别的格式后期待自动兼容。服务地址和授权参数以[火山 TTS 协议](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)、[火山 ASR 协议](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)及自己的账户配置为准。

### 4.2 本地 ASR 与本地 TTS

将语音 JSON 中对应对象换成以下结构，其他目录字段保留：

```json
{
  "asr": {
    "executable": "/opt/whisper/bin/whisper-cli",
    "model": "/opt/whisper/models/<WHISPER_MODEL_FILE>",
    "ffmpeg": "/usr/bin/ffmpeg",
    "language": "zh",
    "threads": 4,
    "timeoutMs": 180000
  },
  "tts": {
    "provider": "indextts-2.5",
    "baseUrl": "http://127.0.0.1:9880",
    "timeoutMs": 300000
  }
}
```

whisper.cpp 模型文件必须已下载，本适配器不会安装程序或权重。IndexTTS 后端只接收 `{"text":"..."}`；自己的参考音频和推理参数固定在独立服务启动配置中。也可以只替换 ASR 或 TTS 一端，组成云端/本地混合。

若使用 GPT-SoVITS 兼容服务，`tts` 使用非 `indextts-2.5`、非 `volcengine-icl-2.0` 的 provider 标识，并配置 `baseUrl`、`referenceAudio`、`referenceText`、`parameters`。代码向 `<baseUrl>/tts` 发送 `text`、`text_lang`、`ref_audio_path`、`prompt_text`、`prompt_lang`、`media_type:"wav"`、`streaming_mode:false` 等字段，要求返回 WAV。它不是通用 TTS 自动探测器，不提供服务端 API Key 字段；接口应留在本机或受保护的私网内。

### 4.3 IndexTTS-2.5 独立服务

按照 [IndexTTS 官方项目](https://github.com/index-tts/index-tts)准备包含 `indextts.infer_v2_5.IndexTTS2` 的源码、依赖和全部模型权重。本仓库脚本要求部署根目录下有 `source/`、`checkpoints/`，并将临时目录放在 `cache/temp/`。它以离线模式加载权重，需要 CUDA 和 BF16 支持，不会联网补下载缺失模型。

还需自己创建两份 JSON：`inputs` 包含 `seed`、`referenceAudio`；`parameters` 包含相同的 `seed`、`constructor`、`inference`。后两项应使用你所安装版本实际支持且自己验证过的参数；公开仓库不附带推理/音色预设。

在安装了 IndexTTS 依赖的 Python 环境运行：

```bash
python /srv/qq-bridge/scripts/local-indextts-server.py \
  --deployment-root /srv/indextts \
  --inputs-file /srv/qq-runtime/indextts-inputs.json \
  --parameters-file /srv/qq-runtime/indextts-parameters.json
```

服务默认监听 `127.0.0.1:9880`。先确认服务启动并能生成有效 WAV，再启用 bridge 的 `localVoice`。这些本地模型资源不属于 `npm ci` 的安装内容。

### 4.4 语音发送比例、工具和场景语气

语音 JSON 的 `replyPolicy.textVoiceProbability`、`replyPolicy.voiceVoiceProbability` 是 0～1 的概率；未填写时，当前代码分别使用 `0` 和 `1`。需要时由自己明确设置。它控制已启用 `localVoice` 的回复媒介选择，不等于单独打开预生成音频发送工具。

`socialV2.tools.sendVoice` 和 `socialV2.voice.enabled` 控制模型的独立语音文件工具能力；公开示例默认关闭。`socialV2.voice.dir` 是允许使用的音频目录，`socialV2.voice.ffmpegPath` 是发送音量/处理路径的 FFmpeg 设置，与语音转写的 `asr.ffmpeg` 是两个字段。

只有需要场景语气时才在语音 JSON 中增加 `styleConfigPath`。它与前述大部分文件字段不同：相对路径明确以**语音 JSON 所在目录**为基准解析。当前必须搭配 `tts.provider:"volcengine-icl-2.0"`、`tts.model:"seed-tts-2.0-expressive"`；其他组合会明确报错。自行参照 `voice-styles.example.json` 填写：`version` 为 `1`，`styles` 必须且仅有 `daily`、`comfort`、`explanation` 三个固定 ID，各自的 `label`、`whenToUse`、`instruction` 都必须是非空字符串，`defaultStyle` 选择这三个 ID 之一。空模板不是已配好的声音，直接启用会校验失败；填写完成后重启 bridge。

## 5. 日记和外部 voice-tool

`setup-dsh.mjs` 注册的三个 MCP 是 `snowluma`、`snowluma-host`、`web-search-safe`。**日记不在其中**。如需要日记，在自己的 DSH profile 的 `cordis.patch.yml` 追加独立条目，路径换成真实绝对路径，并在需要使用它的 agent preset 的工具许可中加入对应工具：

```yaml
- insert:
    - id: mcp-qq-diary
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-diary
        transport: stdio
        command: /usr/bin/node
        args:
          - /srv/qq-bridge/src/mcp-diary.js
```

不要把手动条目放进 setup 脚本维护的 `qq-bridge MCP BEGIN/END` 区块。重启 DSH 后在工具列表确认日记工具已加载。日记保存在项目 `data/日记/diary.jsonl`，不上传 GitHub。

`npm run voice-gui`、`npm run voice-cli` 指向项目同级目录 `../voice-tool/`；仓库不提供该项目。`QQ_BRIDGE_VOICE_TOOL_DIR` 是部分测试/查找脚本使用的路径提示，不会自动为 `LocalVoice` 配置一个语音服务。未安装外部项目时不要把这两个命令当作本仓库完整语音部署入口。

## 6. 升级时保留、公开时排除

应持久保存但不公开：`config.json`、`state/`、自己的 `roles/*.md`、语音 JSON/语气文件、参考音频、API Key 文件、`data/`、DSH 的 `DSH_HOME`、SnowLuma 登录与配置目录。`.gitignore` 已覆盖常见本地目录与配置名称；自行另起名称的文件仍需在提交前检查。

若将配置放在仓库外，记录真实绝对路径，并确保 DSH/bridge 的运行用户有相应读写权限。迁移时不要复制旧机器的 `node_modules` 代替安装；在目标机器执行 `npm ci`，重新运行 setup 以生成正确的绝对路径。完整步骤见[部署教程](CLOUD_DEPLOYMENT.md)。
