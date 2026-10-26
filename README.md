# QQ Bridge：QQ 与 DeepSeek Harness 桥接

本项目把 QQ 消息经 SnowLuma / OneBot v11 接入 DeepSeek Harness（DSH），在同一套会话中提供文字聊天、上下文记忆、工具调用及可选语音能力。

这是 2026-10-26 整理的公开源码版本，仓库地址：<https://github.com/Albizzia-sun/qq-bridge>。基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 继续维护，保留原项目 MIT 版权声明。

**仓库不附带 API Key、登录凭据、聊天数据、记忆、日记、个人角色卡、声音预设或个人音频。** 配置文件使用空值模板；安装者自行配置账号、服务和角色。工具协议预设 `qq-chat` / `qq-chat-v2` 是程序运行的一部分，保留在源码中。

## 先看哪份教程

| 需求 | 文档 |
| --- | --- |
| 下载代码之外还要准备什么 | [外部组件与配置准备清单](docs/PREREQUISITES.md) |
| 哪些 API Key 必需、放哪里、配置字段怎么填 | [配置与 API Key 指南](docs/CONFIGURATION.md) |
| RAG、长期记忆和向量检索怎样工作、怎样配置 | [RAG 与长期记忆教程](docs/RAG_MEMORY.md) |
| 云服务器安装、长期运行、端口和远程管理 | [云部署教程](docs/CLOUD_DEPLOYMENT.md) |
| 自己创建角色 | [角色配置说明](roles/README.md) |
| 理解管理员权限及聊天模式 | [权限规则](RULES.md) |
| 全部文档索引 | [文档目录](docs/README.md) |

## 能做什么

- 私聊和群聊分别映射到 DSH 会话，保留上下文；访问和发送由白名单控制。
- `reserved2` 模式通过 QQ 工具自主读取、回复、等待、确认已读与设置下次唤醒。
- Web 控制台用于模式、角色、会话、记忆和权限管理，默认只监听本机。
- 可选的联网搜索、网页抓取、图片/表情理解、语音识别与语音合成。
- 可选长期记忆、MemOS shadow、日记 MCP、设备语音接入；各自所需外部组件见清单。

本版包含近期修复：等待时补接已到达但尚未展示的消息；回应后读取新消息时更新分条建议；角色卡按真实投递确认更新并定期重注入；私聊自然延续和分享自己的想法，减少对同一件事连续追问，让表达完整；已搁置的话题不再反复作为当前状态注入。角色和语音仍由用户自行设置。

记忆有两条现成链路：主回复使用近期与关键词相关的长期记忆；MemOS 的向量检索和可选 Rerank 目前处于 **Shadow 对照模式**，结果写入比较日志，不直接注入主回复。代码、依赖和配置方法均已公开，启用方式与限制见 [RAG 教程](docs/RAG_MEMORY.md)。

## 最小文字聊天部署

链路：`QQ ↔ SnowLuma ↔ qq-bridge ↔ DSH ↔ 模型服务`。

1. 安装 Git、Node.js；项目最低要求以 package.json 为准。若同时使用 SnowLuma Lite，需满足它更高的 Node 版本要求，见准备清单。
2. 自行安装并登录 SnowLuma，启用 OneBot HTTP 与正向 WebSocket，记录端口与访问令牌。本仓库不分发或自动安装 SnowLuma。
3. 安装 DSH，配置可用的模型服务与模型 API Key。主模型 Key 放在 DSH 的凭据管理中。
4. 克隆本仓库、安装依赖、复制空白模板：

   ```bash
   git clone https://github.com/Albizzia-sun/qq-bridge.git
   cd qq-bridge
   npm ci
   cp config.example.json config.json
   ```

   Windows PowerShell 最后一行使用 `Copy-Item config.example.json config.json`。

5. 编辑 config.json：填写自己的 ownerQQ、allow.private / allow.groups、SnowLuma 端点与令牌、DSH provider/model。未配置白名单时默认不开放聊天；不要把模型 API Key 放进 dsh.authToken。
6. 使用同一系统用户和同一个 DSH_HOME，按教程运行 `node scripts/setup-dsh.mjs` 注册桥接插件与三个 MCP，重启相应 DSH profile，再运行 `npm start`。
7. 打开本机 `http://127.0.0.1:3100`，使用本机生成或自己配置的 consoleToken 登录控制台。选择模式、核对白名单，从一个允许的私聊开始验收。

DSH 安装/profile/启动命令、SnowLuma Linux 支持范围，以及服务器后台运行步骤请按 [云部署教程](docs/CLOUD_DEPLOYMENT.md) 执行；不要只复制上面的片段就跳过配置与登录。

## 角色和语音

默认没有选中的角色。用户通过管理端创建自己的角色卡；角色文件和选择状态只保存在自己的机器上。群友消息不能修改角色或系统设置。

语音合成/识别默认关闭。仓库保留实现和空模板，不含现成音色、个人参考音频或语气方案。火山 ASR/TTS、本地 Whisper / IndexTTS 等后端需要各自的凭据或模型文件；详见配置指南。上级目录的独立 voice-tool GUI/CLI 不属于本仓库，也不是文字聊天或桥接内置语音功能的必需依赖。

## 验证

```bash
node --check src/bridge.js
node scripts/build-agent-preset-patches.mjs --check
node --test scripts/test-role-delivery.mjs scripts/test-active-topic-context.mjs scripts/test-conversation-prompt.mjs
```

其他测试按 package.json 与 scripts/test-*.mjs 选择。部分诊断或端到端脚本需要实际运行的 DSH、QQ 网关或额外语音组件；它们不会因为下载了源码就自动具备环境。对外部组件缺失的跳过结果应单独记录，不能当作通过。

源码和提示装配回归通过不等于云服务器部署成功，也不等于真实聊天质量已经验收。请按教程检查 QQ 收发、原会话连续性、角色更新、等待补接和语音链路。

## 运行数据与网络访问

QQ 消息会交给所选模型服务；开启搜索、云端语音或向量服务后，相应内容还会交给用户配置的提供方。数据接收方由安装者配置。运行态、密钥和个人素材均在 .gitignore 排除范围内；自己的配置、状态、音频与日志不应提交到公开仓库。

控制台、OneBot 和 DSH 的内部端口应保持在本机/可信网络，通过 SSH 转发进行云端管理；详见云部署教程。不要公开启动日志里包含的控制台访问令牌。

## 许可与上游

本项目源码使用 [MIT License](LICENSE)，原作者为 Derpyu520，当前发布由 Albizzia-sun 维护。DSH、SnowLuma、模型权重和语音资源各自遵循其原始条款；本仓库不包含这些第三方服务的凭据、登录态或分发包。SnowLuma 安装和登录由用户按照其官方说明完成。
