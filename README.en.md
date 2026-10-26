# QQ Bridge

A QQ / OneBot v11 bridge for DeepSeek Harness (DSH), with per-conversation sessions, allowlists, optional memory and speech integrations.

This public source snapshot is maintained at [Albizzia-sun/qq-bridge](https://github.com/Albizzia-sun/qq-bridge), based on [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge). The original MIT copyright notice is retained.

No API keys, login credentials, chat history, memories, diaries, personal role cards, speech presets or personal audio are included. Configuration examples contain empty values. Supply your own accounts, keys, model identifiers and optional resources.

The detailed installation documentation is in Chinese:

- [README and quick start](README.md)
- [External prerequisites](docs/PREREQUISITES.md)
- [Configuration and API keys](docs/CONFIGURATION.md)
- [RAG, long-term memory and MemOS Shadow](docs/RAG_MEMORY.md)
- [Cloud deployment](docs/CLOUD_DEPLOYMENT.md)
- [User-defined roles](roles/README.md)

Install Node.js and Git, separately install and sign in to a supported SnowLuma gateway, configure a DSH model provider, then install bridge dependencies with npm ci. Copy config.example.json to config.json and fill in your own settings. Follow the deployment guide to register the DSH plugins and MCP servers. The model-provider API key belongs to DSH; dsh.authToken is a different authentication setting.

Cloud guides distinguish upstream platform support from this project's offline validation. Actual QQ/DSH/model acceptance must be performed on your deployment. Keep state, credentials and internal service ports private. See [LICENSE](LICENSE) and [RULES.md](RULES.md).
