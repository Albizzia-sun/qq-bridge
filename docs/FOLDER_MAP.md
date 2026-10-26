# 目录说明

| 路径 | 用途 | 是否公开提交 |
| --- | --- | --- |
| src/ | 桥接、MCP、语音、记忆等程序源码 | 是 |
| scripts/ | 安装、诊断、回归测试工具 | 是；测试使用合成数据 |
| plugins/、dsh/agent-presets/ | DSH 插件和工具协议预设 | 是 |
| roles/README.md | 自定义角色教程 | 是 |
| roles/ 下用户创建的角色文件 | 用户人设与风格 | 否 |
| config.example.json、voice-styles.example.json | 空白配置结构 | 是 |
| config.json、voice-config.json、voice-styles.json | 本机实际设置 | 否 |
| state/ | 会话映射、运行日志、记忆、控制台状态等 | 否 |
| data/ | 可选日记等用户数据 | 否 |
| audio/、个人参考音频与模型目录 | 用户语音素材及外部模型 | 否 |
| node_modules/ | npm 安装依赖 | 否 |
| assets/ | 程序使用的上游静态资源 | 是；不含用户素材 |

DSH 的设置与凭据在用户指定的 DSH_HOME；SnowLuma 的登录数据在它自己的用户目录。两者都不属于本仓库。详情见 CONFIGURATION.md 与 CLOUD_DEPLOYMENT.md。
