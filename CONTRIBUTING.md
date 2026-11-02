# Contributing / 参与贡献

Thank you for helping improve Memory Ferry. Issues and pull requests may be written in English or Chinese.

感谢你改进 Memory Ferry。Issue 和 Pull Request 均可使用中文或英文。

## Development / 开发

Requirements: Node.js 20, 22, or 24 and npm.

```bash
npm ci
npm run test:all
npm run test:stress
```

Embedding tests await `Vault.flushEmbeddings()` rather than polling the cache with a short deadline. The method drains tasks queued by that Vault instance and throws an `AggregateError` with the latest (up to 20) original causes since the previous drain; normal memory commits remain independent of optional embeddings. Background failures also emit a diagnostic on stderr without memory text or vectors. Stress tests use only temporary Vaults and a synthetic embedder. On Windows, the atomic-write regression holds a real file handle without delete sharing, releases it, and verifies successful replacement.

For UI changes, run `npm run dev -- ui`, test both language modes, and verify that the page does not perform full reloads. For storage or adapter changes, add migration tests and preserve support for legacy `agent-vault.json`, `AGENT_VAULT_*`, and managed Agent Vault configuration blocks.

修改界面时，请运行 `npm run dev -- ui`，检查中英文模式，并确认页面不会整页刷新。修改存储或适配器时，请补充迁移测试，并保留对旧 `agent-vault.json`、`AGENT_VAULT_*` 和 Agent Vault 托管配置块的兼容。

Before submitting / 提交前：

```bash
npm audit --omit=dev
npm pack --dry-run
```

Do not commit real Vault data, personal paths, credentials, generated executables, or cloud-drive contents.

不要提交真实 Vault 数据、个人路径、凭据、生成的 EXE 或网盘内容。
