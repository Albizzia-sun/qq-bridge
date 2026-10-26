# DSH 配置入口

当前安装与启动步骤已整理到 [云部署教程](../CLOUD_DEPLOYMENT.md)，主模型凭据、DSH_HOME、profile 和桥接连接设置见 [配置指南](../CONFIGURATION.md)。

本仓库使用 scripts/setup-dsh.mjs 注册 qq-mode-console / qq-agent-presets 和三个 MCP：snowluma、snowluma-host、web-search-safe。日记 MCP 是可选组件，需另行配置。安装时使用正式项目目录，不要注册临时解压或测试目录。

升级保留 config.json、state 和原 DSH profile。生成的 qq-chat-v2.patch.yml 与源 agent.cordis.yml 必须一致，预设变更后完整重启对应 DSH 实例。
