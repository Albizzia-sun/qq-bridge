# 部署前需要准备什么

本文适用于本仓库的公开发布版。仓库提供桥接程序、DSH 集成插件及配置示例；角色卡正文、私人聊天和记忆、语音参考素材、音色和推理预设、账号登录状态及真实凭据均由使用者自行准备。

外部版本和官方文档核验日期：**2026-10-26**。版本核验只说明当日上游提供的产品和安装入口，不代表本项目完成了每种组合的真实部署验收。本次发布的验证范围为离线代码和配置检查；云服务器、QQ 登录与真实模型/语音服务仍需按[部署教程](CLOUD_DEPLOYMENT.md)验收。

## 1. 先完成文字聊天所需的清单

| 准备项 | 是否必需 | 需要自行提供什么 | 获取或配置位置 |
| --- | --- | --- | --- |
| Windows 或 Linux 运行环境 | 必需 | 能持续联网、运行 Node 和 QQ 网关的计算机；云服务器还需要 SSH 或远程桌面登录方式 | Linux 云、Windows 云和混合部署见[部署教程](CLOUD_DEPLOYMENT.md) |
| Node.js 与 npm | 必需 | 本仓库最低 Node `22.13.0`；新部署建议 Node 24 LTS。当日官网版本为 `24.22.1` | [Node.js 官方下载](https://nodejs.org/en/download) |
| Git | 使用 git clone 时必需 | Git 客户端；下载源码 ZIP 时可不用 Git，但升级和版本核对更不方便 | [Git 官方安装](https://git-scm.com/downloads) |
| DeepSeek Harness（DSH） | 必需，独立软件 | 能运行 `dsh web --no-open` 的 CLI 和初始化后的 `web` profile | [DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)、[CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) |
| 对话模型服务 | 必需 | 能在 DSH 中成功对话的 provider、model 和所需 API Key；自托管模型则准备对应服务地址 | DSH 的 Settings → Models；凭据和桥接选模字段见[配置说明](CONFIGURATION.md) |
| SnowLuma 和它要求的 QQ 运行环境 | 必需，独立软件 | 按上游说明安装对应平台版本，启用 OneBot HTTP 和 WebSocket 服务 | [SnowLuma 官方部署说明](https://snowluma.github.io/zh/docs/guide/deploy)、[v2.2.0 发布页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.0) |
| 可登录的 QQ 账号 | 必需 | 在自己的网关中扫码/登录；准备允许联系的 QQ 号、群号 | SnowLuma 登录界面；桥接 `ownerQQ`、`allow.private`、`allow.groups` |
| OneBot 访问令牌 | 网关启用鉴权时必需 | 自己设置的 HTTP/WS 访问令牌；它不是购买的模型 API Key | SnowLuma 网络配置与桥接 `snowluma.accessToken` 保持一致 |
| 自己的角色卡 | 需要指定人设时必需 | 自行编写的人设、语气与边界；公开版不附带私人角色内容 | `roles/<角色名>.md`，再在桥接控制台选择角色 |
| 可写的持久化目录 | 必需 | 保存 DSH profile/凭据、桥接状态、网关登录状态；不能把所有目录都放在临时容器层 | 具体目录见[部署教程的备份段落](CLOUD_DEPLOYMENT.md#6-重启升级与备份) |

`ownerQQ` 是管理员 QQ 号；它不能代替消息白名单。默认 `allowAllWhenEmpty:false`，白名单为空时不会响应 QQ 消息。把要参与的私聊/群分别加入 `allow.private`、`allow.groups` 后再测试。

本仓库的 `npm ci` 只安装仓库声明的 Node 依赖，**不会替你安装 DSH CLI、QQ/SnowLuma、语音模型、Python/CUDA 或配置任何账号**。DSH 的初次初始化与插件安装也需要网络。

## 2. 按需要添加可选能力

| 能力 | 额外准备 | API Key | 备注 |
| --- | --- | --- | --- |
| Bing 网页搜索 | 可访问 Bing 的网络 | 不需要 | `webSearch.provider:"bing"`；可用性取决于网络和上游页面 |
| DeepSeek 网页搜索 | 支持本项目搜索请求协议的服务、模型和账户额度 | 该搜索服务的 Key | `webSearch.apiKeyEnv` 指定名称；通常注入 **DSH 进程**，由它启动搜索 MCP |
| 普通长期记忆、人物摘要 | 已配置的 DSH 模型与可写状态目录 | 通常复用已有对话服务凭据 | 不必为了开启普通记忆另买向量服务 |
| MemOS Shadow 对比索引 | OpenAI-compatible embedding 服务；需要重排时再准备兼容 rerank 服务 | embedding 必需；rerank 只在启用时必需 | 由 **bridge 进程**读取指定环境变量；不是自动替换现有记忆系统 |
| 本地语音识别 | FFmpeg、whisper.cpp 可执行文件和模型权重 | 不需要云 Key | 本适配器调用 CPU 路径；模型和路径均需自行配置 |
| 火山引擎语音识别 | FFmpeg、已开通的对应 ASR 服务、endpoint/resourceId | ASR 的 API Key 文件 | 使用 `volcengine-asr-2.0` 适配器 |
| 火山引擎语音合成 | 已开通的 TTS 服务、endpoint/resourceId、自己有权使用的 speaker 和模型 | TTS 的 API Key 文件 | 使用 `volcengine-icl-2.0` 适配器；不提供预设音色 |
| 本地 GPT-SoVITS 兼容 TTS | 独立推理服务、模型权重、参考音频/文本、推理参数 | 本适配器不提供 HTTP 鉴权字段 | 接口需满足本项目 `/tts` 请求/响应格式；不是任意 TTS 服务都能直接接入 |
| 本地 IndexTTS-2.5 | 独立 Python 环境、对应源码/权重、CUDA 且支持 BF16 的 GPU、自己的参考音频和推理配置 | 不需要云 Key | 仓库仅有固定配置适配脚本，不含模型或个人配置 |
| 场景语气配置 | 自己编写的 `voice-styles.json` | 不另需要 Key | 当前只支持火山 `seed-tts-2.0-expressive`；空模板不包含可用语气预设 |
| 日记 MCP | 手动向 DSH 注册 `src/mcp-diary.js`，允许相应工具 | 不需要 | 默认安装脚本不注册日记；数据存于 `data/日记/diary.jsonl` |
| 外部 voice-tool GUI/CLI | 独立的 `voice-tool` 项目 | 取决于那个外部项目 | 不在本仓库交付内，也不是文字聊天或本仓库语音适配器的必需依赖 |

**SiliconFlow 不是本项目独立实现的语音后端。** 它可以在协议相容时作为 DSH 的模型服务，或 MemOS 的 embedding/rerank 服务；具体模型和权限由服务方决定。本项目没有读取某个固定 `SILICONFLOW_API_KEY` 的通用机制，需在实际功能对应的配置位置填写/引用。

## 3. 平台选择与运行资源

- **Windows 同机部署**：DSH、bridge、QQ/SnowLuma 在同一 Windows 用户下运行，便于先验证登录和接口，再决定是否迁移。
- **Linux 同机云部署**：SnowLuma `v2.2.0` 上游已发布 Linux x64/arm64 版本，因此不能再按旧文档把它描述为“只支持 Windows”。按官方教程准备 Linux QQ 和显示/登录环境，或使用官方说明中的容器方案；这仍然需要实际登录 QQ。
- **Windows 云服务器**：适合保留 Windows QQ 网关运行环境；先通过远程桌面完成登录，确认断开远程桌面后所用网关仍能运行。
- **混合部署**：可让网关运行在另一台 Windows/Linux 主机，DSH 与 bridge 同机。需自己提供双方的私网/VPN/端口转发；另一台机器的 `127.0.0.1` 不会自动指向网关。

纯文字和云端推理不要求本地 GPU。本地 TTS 的 GPU/显存需求取决于选用的模型；本项目没有给出经过压测的最低云服务器规格。应为 QQ 客户端、DSH、Node 依赖、日志与持久化数据预留资源，再依据实际聊天量与模型开销调整。

SnowLuma 完整发行包包含其所需 Node；Lite 包按 `v2.2.0` 发布说明要求 Node `24.22.1` / `26.12.1` 或相应后续版本。**这是 SnowLuma Lite 的要求，不等同于本仓库的最低 Node 版本。** 官方 Docker 教程中有较早版本镜像/基础镜像示例，安装时应以选定发行版说明为准，不把旧镜像当成 `v2.2.0`。

## 4. 官方资料与分发边界

- [DSH 安装、运行与模型配置](https://github.com/deepseek-ai/deepseek-harness)、[provider 配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。当日 npm `latest` 核验为 `0.2.1-rc.2`；本项目对接 DSH Cookie 鉴权、slash RPC 与 remote.mux 协议，升级 DSH 后需重新验收连接。
- [SnowLuma v2.2.0](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.2.0)、[官方 Docker 说明](https://snowluma.github.io/zh/docs/guide/deploy/docker)。独立取得软件并按其 [LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE) 和 [EULA](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md) 使用；上游对私有组件的第三方打包、容器分发和自动化部署另有授权要求。本仓库不重新打包这些组件。
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)、[FFmpeg](https://ffmpeg.org/download.html)、[IndexTTS](https://github.com/index-tts/index-tts)、[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)。代码、模型权重和音频素材分别遵循其授权条件。
- [火山 TTS HTTP 流式协议](https://docs.volcengine.com/docs/DoubaoVoice/HTTPChunkedSSEUnidirectionalStreaming-V3?lang=zh)、[火山 ASR WebSocket 协议](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh)。账户需开通与实际 endpoint、resourceId、speaker/model 相匹配的能力。

公开仓库可直接克隆，不需要 GitHub PAT。只有你要向自己的仓库写入代码时才需要 GitHub 登录/写权限；这不属于运行 QQ bridge 所需的 API Key。
