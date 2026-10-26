# RAG 与长期记忆：当前能力、配置与验证

公开仓库已经包含长期记忆检索、MemOS embedding、向量与全文检索、可选 rerank，以及相应测试。**当前主回复使用“最近记忆＋关键词相关记忆”；MemOS 只做 Shadow 对照，检索结果不会注入主回复。** 开启 `shadow.enabled` 不会把主回复切换为向量 RAG。

本文对应二代仿真模式 `reserved2` 的记忆链路。初次安装先完成[部署前置条件](PREREQUISITES.md)和[部署教程](CLOUD_DEPLOYMENT.md)，确认 QQ → bridge → DSH → QQ 的文字聊天可用；凭据位置见[配置与 API Key 指南](CONFIGURATION.md)。本文中的地址、模型名、密钥和示例文本均为占位或合成内容。

## 1. 当前回复怎样使用记忆

| 环节 | 当前实现 | 是否影响主回复内容 |
| --- | --- | --- |
| 原始消息与提炼 | 原始消息写入 SQLite；满足既有触发条件后，DSH 辅助会话提炼值得保留的短摘要 | 摘要成为后续检索的数据来源 |
| 主回复检索 | 最近 N 条＋与当前消息关键词相关的 K 条，去重后按时间排列 | 是，格式化后进入唤醒提示词 |
| 人物画像与昨日摘要 | 依照各自开关和既有触发条件生成、读取 | 是，与检索得到的条目分别注入 |
| MemOS Shadow | 摘要进入派生索引，使用 embedding、FTS/向量候选和官方检索排序；可追加远程 rerank | 否，只保存检索对照记录 |

主回复的查询文本取自最近一条对方消息的前 200 个字符。关键词检索对中文取二元词，对英文取单词；相关度按关键词重合、词语稀有度和少量时间权重计算。默认配置是最近 **2** 条＋相关 **6** 条，记忆文本的字符预算为 **3000**。`minKeywordHits` 默认是 `2`，实际判断采用加权命中：一个稀有关键词可达到 2 分，并非必须命中两个不同词。

新摘要在二代模式回合结束后检查是否需要提炼：默认至少有 8 条尚未处理的有效用户消息，两次成功提炼间隔至少 10 分钟。达到消息数只是条件之一；仍需 DSH 可用、当前没有同会话提炼任务、转写批次非空。合法的提炼结果可以是空数组，因此“有聊天”不等于“必定新增摘要”。

Shadow 在既有 `deliverPrompt` 调用返回且未报告失败后另行排队。它同步已提炼的摘要，执行检索，再把同一次 query 的关键词结果与 MemOS 结果写入对照日志。主回复提示词在此之前已经构建并投递；Shadow 结果不会回填到这一轮或后续轮次的主提示词。这里的“投递”也不等于 QQ 已收到最终回复。

源码入口：

- [bridge.js](../src/bridge.js)：`loadConfig` 中的长期记忆默认值、`longMemoryPromptLine`、`buildWakePromptV2`、`sendWakePromptV2`、`queueMemoryShadow`、`maybeSummarizeLongMemory`。
- [long-memory.js](../src/long-memory.js)：`extractKeywords`、`selectMemory`、`formatMemoryForPrompt`，以及画像、摘要提示词。
- [memory-journal.js](../src/memory-journal.js)：原始消息、规范摘要、来源与提取进度。
- [memos-shadow.js](../src/memos-shadow.js)：派生索引、embedding、检索、rerank 与按会话遗忘。

## 2. 安装已有依赖

在仓库根目录执行：

```bash
npm ci
```

最低 Node 版本由 [package.json](../package.json) 的 `engines` 声明，目前为 `22.13.0`。MemOS 已作为 `@memtensor/memos-local-plugin@2.0.16-beta.1` 固定在项目依赖中，`npm ci` 按锁文件安装；不需要额外执行某个 MemOS 全量安装向导，也不需要另建向量数据库服务。

本适配器直接复用 MemOS 的 SQLite 存储和检索组件，没有接入它的完整对话捕获、演化或 DSH hook 流程。这里使用远程兼容 embedding 接口，代码不会在缺少配置时改用默认本地模型或自动下载模型权重。`npm ci` 也不会安装 DSH CLI、QQ/SnowLuma 或替你配置模型服务。

已有部署更新源码时保留自己的 `config.json` 和 `state/`；不要用公开空模板覆盖现有运行配置。跨平台部署应在目标机器重新安装依赖，不能把另一台机器的 `node_modules` 直接当作可运行安装。

## 3. 只使用主回复的长期记忆

普通摘要提炼和画像使用 DSH 辅助会话，并通过已有 `dsh.provider`、`dsh.model` 选择模型。主模型的服务凭据仍由 DSH 管理；不需要为关键词检索单独购买 embedding 或 rerank 服务。

以下是合并到已有 `config.json` 的片段，保留其他字段：

```json
{
  "socialV2": {
    "longMemory": {
      "enabled": true,
      "shadow": {
        "enabled": false
      }
    }
  }
}
```

公开示例没有要求你启用 Shadow；只有 `shadow.enabled` 明确为 `true` 才会排队做对照。长期记忆参数的其他默认值来自 [bridge.js](../src/bridge.js) 的配置合并，不需要为了使用默认行为重复填写全部字段。

## 4. 启用 MemOS Shadow

先准备一个提供 OpenAI-compatible embeddings 协议的服务。模型必须是该服务实际支持的 embedding 模型，聊天模型名称不能直接代替。若需要重排，再准备兼容下面请求协议的 rerank 服务。

将以下片段合并到已有 `config.json`。示例先开启 embedding，保留 reranker 关闭：

```json
{
  "socialV2": {
    "longMemory": {
      "enabled": true,
      "shadow": {
        "enabled": true,
        "timeoutMs": 3000,
        "topK": 6,
        "embedding": {
          "endpoint": "https://embedding.example.invalid/v1",
          "model": "<EMBEDDING_MODEL_ID>",
          "apiKeyEnv": "QQ_EMBEDDING_API_KEY"
        },
        "reranker": {
          "enabled": false,
          "endpoint": "https://rerank.example.invalid/v1/rerank",
          "model": "<RERANK_MODEL_ID>",
          "apiKeyEnv": "QQ_RERANK_API_KEY"
        }
      }
    }
  }
}
```

`example.invalid` 是不可用的示例域名，必须换成自己的服务地址。`timeoutMs` 和 `topK` 可省略，默认分别为 `3000` 和 `6`；显式填写时必须是正整数。

| 字段 | 填写规则 |
| --- | --- |
| `embedding.endpoint` | 填兼容服务的 base URL，例如 `https://<服务域名>/v1`；固定版本的底层适配器会补 `/embeddings`，已以 `/embeddings` 结尾时保持原地址 |
| `embedding.model` | 实际可调用的 embedding 模型 ID |
| `embedding.apiKeyEnv` | 环境变量的**名称**，不能填写 API Key 本身 |
| `reranker.enabled` | `false` 时不使用重排；需要重排时显式改为 `true` 并补齐它的三个服务字段 |
| `reranker.endpoint` | 完整请求 URL，代码直接向该地址 POST，不会自动拼接 `/rerank` |
| `reranker.model` / `apiKeyEnv` | 重排模型 ID，以及保存其密钥的环境变量名 |

embedding 请求采用 `Authorization: Bearer …`，请求包含 `model` 和 `input`，返回 `data[].embedding`。rerank 请求同样使用 Bearer 鉴权，请求包含 `model`、`query`、`documents`、`top_n`，返回必须包含 `results` 数组，每项提供有效的 `index` 和数值 `relevance_score`。提供商名字相同，不代表其所有接口都满足这些协议。

不需要 rerank 时，也可以整个省略 `reranker` 对象。若保留该对象却省略 `enabled`，当前代码会尝试启用它；不要把缺少 `enabled` 当作默认关闭。

启用远程 Shadow 后，建立索引会将摘要发送给 embedding 服务，查询会将 query 发送给该服务；启用 rerank 时还会发送 query 和候选摘要。原始消息由现有 DSH 提炼流程处理。对照日志也含查询与检索结果，应与其他聊天状态一起留在自己的运行环境。

### 在启动 bridge 的进程中提供密钥

环境变量必须由 **bridge 进程**读到。仅在 DSH 的终端设置变量，或者只将密钥保存到 DSH 凭据库，都不会自动向另一个已经运行的 bridge 进程提供变量。本项目不自动读取 `.env` 文件。

PowerShell，在仓库根目录、启动 bridge 的同一个终端中：

```powershell
$env:QQ_EMBEDDING_API_KEY = '<EMBEDDING_API_KEY>'
# 只有启用 reranker 时才需要这一行。
$env:QQ_RERANK_API_KEY = '<RERANK_API_KEY>'
npm start
```

Linux Bash，在仓库根目录、启动 bridge 的同一个 shell 中：

```bash
export QQ_EMBEDDING_API_KEY='<EMBEDDING_API_KEY>'
# 只有启用 reranker 时才需要这一行。
export QQ_RERANK_API_KEY='<RERANK_API_KEY>'
npm start
```

以上密钥是占位符。不要将真实赋值写进提交到仓库的脚本或分享的终端记录。使用 systemd 等进程管理器时，应由它向 bridge 服务提供同名环境变量，沿用[部署教程](CLOUD_DEPLOYMENT.md)的配置方式；交互终端的 `export` 不会改变已经运行的服务环境。

配置或环境变量修改后重启 bridge，使新进程读取它们，并重新初始化 Shadow。该适配器不提供对运行中实例自动切换 embedding 模型或凭据的操作入口。

### 能否复用主模型的 API Key

有两种不同的复用：

- **普通长期记忆：**直接复用 DSH 已配置的模型与凭据，无需单独的记忆 API Key。
- **MemOS Shadow：**只有服务商允许同一 Key 访问所选 embedding／rerank 模型时，才能使用同一个 Key；仍须填写各自的 endpoint、model、apiKeyEnv，并把相应变量注入 bridge。

例如，同一服务凭据确实具有三类模型权限时，可以将两个 `apiKeyEnv` 都设置为自己选定的同一个变量名，并在 bridge 环境中设置它。代码只读取该名称对应的 `process.env`，不会自动读取 DSH 主模型凭据，也不会根据聊天模型配置推导向量模型。`dsh.authToken` 是连接 DSH 的令牌，不能拿来代替模型服务 API Key。

## 5. 记忆保存在哪里

以下路径均相对**仓库根目录**，不是相对 DSH profile；代码使用 `src/bridge.js` 所在位置确定根目录。

| 路径 | 实际内容与用途 |
| --- | --- |
| `state/memory-journal.sqlite` | 原始消息、提炼批次、规范摘要、摘要来源 ID、处理水位和遗忘 epoch；新摘要的事实来源 |
| `state/long-memory.json` | 历史 JSON 摘要、人物画像、每日摘要使用状态，以及规范摘要的兼容投影；不能将它当成唯一的记忆数据库 |
| `state/memos-shadow/memos.db` | 派生的 MemOS SQLite 索引，含摘要、向量／全文检索数据、会话归属、来源映射与 embedding endpoint/model 绑定 |
| `state/memory-shadow/<会话键的 SHA-256>.jsonl` | 每次对照的 query、`legacy` 关键词结果、`shadow` 检索结果或错误；文件名哈希不代表内容匿名 |
| `state/social-v2.json` | 二代会话的轻量状态、近期消息、话题和成员印象等；与长期记忆共同参与上下文 |
| `data/日记/diary.jsonl` | 可选日记数据；每日摘要可读取昨天的日记，日记 MCP 的独立配置见[配置指南](CONFIGURATION.md) |

MemOS 的输入是 bridge 已提炼的摘要，不是自动把整个 DSH 会话原文导入另一个记忆系统。新规范摘要保留来源 ID；旧 JSON 条目没有原始来源时，代码保留空 `sourceIds`，不会补造来源。

**关闭 Shadow 不等于删除数据。** 将 `shadow.enabled` 改成 `false` 并重启 bridge，会停止新的 Shadow 对照；已存在的数据库和日志仍保留。普通长期记忆也不会因此被删除。

代码另有管理员接口 `POST /api/memory/forget`，它按指定会话处理原始消息、摘要、画像、轻量记忆、MemOS 派生记录及对照日志。该操作范围比关闭 Shadow 大；它不是“换 embedding 模型”的快捷操作，也不等于清空 DSH 历史、全局日记或所有运行数据。接口实现见 [bridge.js](../src/bridge.js) 的 `forgetConversationMemory`，鉴权方式见[配置指南](CONFIGURATION.md)。

## 6. 常见问题与索引限制

| 现象 | 需要核对的实际条件 |
| --- | --- |
| 没有 Shadow 日志 | 当前是否在 `reserved2` 链路中、`shadow.enabled` 是否严格为 `true`、是否发生了成功接受的提示词投递，以及 query 是否为空；仅启动进程不会立即生成对照 |
| 没有新摘要或检索结果为空 | 是否已有规范摘要／历史条目；检查未处理有效用户消息数、冷却时间、提炼会话和合法提炼结果；空摘要与检索错误应分别判断 |
| `MEMOS_CONFIG_REQUIRED` | 检查 endpoint、model、apiKeyEnv 及 bridge 中该变量的值；endpoint 需为不带嵌入账号密码的 HTTP(S) URL，timeoutMs/topK 需为正整数 |
| 401、403、404 或模型不存在 | 检查服务地址、路径、密钥权限和模型 ID；聊天接口可用不能证明 embeddings／rerank 接口可用 |
| `MEMOS_RERANK_FAILED` | 检查完整重排 URL、HTTP 状态及响应字段；错误会明确记录，不能将这一轮当成重排成功 |
| `status: "degraded"` | 读取 `shadow.embedding` 元数据；官方检索可能在向量查询失败时降级到 FTS，仍有结果不代表向量检索成功 |
| Shadow 有命中，但回复未采用它 | 这是当前设计：主回复继续使用关键词结果，Shadow 命中只用于对照 |
| 安装后无法加载 SQLite 原生依赖 | 先核对 Node 版本与目标平台安装结果，按目标机器环境重新执行 `npm ci`；不复用其他平台的 `node_modules` |

索引首次建立时，会记录 embedding 的 endpoint 和 model。之后配置与记录不一致时抛出 `MEMOS_EMBEDDING_MISMATCH`；已有索引含数据但缺少该绑定记录时也会拒绝继续。即使两个模型向量维度相同，也不能据此认为其向量可混用。

当前适配器没有自动模型迁移、自动重建索引或跨模型兼容机制。遇到绑定冲突，应先恢复与现有索引一致的配置；需要迁移时必须另行设计和验证保留原始数据的迁移方案，不应直接删掉 `state/`。对某个会话执行遗忘也不等于重置整个索引的模型绑定。

Shadow 出错会写入对照错误和运行日志，主回复已经使用原有记忆路径投递。对照日志的 `status: "ok"` 只说明那次 Shadow 调用的状态，不代表模型回复正确、QQ 消息已送达或完整部署已验收。

## 7. 验证命令与能证明的范围

安装依赖后，在仓库根目录运行已有测试：

```bash
node --test scripts/test-memory-journal.mjs
node --test scripts/test-memory-bridge.mjs
npm run test:memos-shadow
node --test scripts/test-memory-e2e.mjs
```

| 测试 | 覆盖内容 |
| --- | --- |
| [test-memory-journal.mjs](../scripts/test-memory-journal.mjs) | SQLite 原始记录、提炼提交、进度和会话范围等 |
| [test-memory-bridge.mjs](../scripts/test-memory-bridge.mjs) | 真实 bridge 函数配合合成 DSH 输出；来源、提炼失败处理、遗忘，以及 Shadow 不改变提示词 |
| [test-memos-shadow.mjs](../scripts/test-memos-shadow.mjs) | 真实 MemOS 存储／检索配合本机合成 embedding、rerank HTTP 服务；持久化、会话隔离、失败状态与模型绑定 |
| [test-memory-e2e.mjs](../scripts/test-memory-e2e.mjs) | bridge 原始消息→合成摘要→真实 MemOS→对照日志→HTTP 遗忘→重新打开存储；验证只存在于 Shadow 索引的标记不会进入模型提示词 |

这些测试使用合成消息、合成 DSH 回复和 localhost embedding／rerank 服务。通过它们可以说明本地代码路径和协议处理符合断言，**不能证明真实 embedding／rerank 供应商、实际 QQ 收发或 DSH 主模型已验收**。文档列出命令也不表示当前机器已经执行通过。

实际部署检查应区分三项结果：

1. **文字聊天链路：**从允许的 QQ 会话发送测试内容，确认 DSH 处理并有有效回复返回 QQ。
2. **主记忆链路：**使用无个人信息的测试对话，按现有提炼条件产生摘要，再检查后续唤醒提示中的长期记忆是否来自当前会话；不要仅凭一条看似“记得”的回复判定检索成功。
3. **真实 Shadow 服务：**核对该轮对照记录中的 `engine`、`mode`、`status`、`embedding`、`reranker` 与来源。启用 rerank 且有候选时应核对其状态；无候选返回 `empty`，未启用返回 `disabled`。有命中也仍只代表 Shadow 检索，不代表主回复已经使用它。

保存实际验收结果时分别标明通过、失败、未运行或未验证；分享证据前移除查询文本、记忆内容、会话标识和凭据。公开仓库提供实现、配置结构和测试入口，不附带任何人的真实记忆数据库或服务密钥。
