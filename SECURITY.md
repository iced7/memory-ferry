# Security Policy / 安全政策

## Supported versions / 支持版本

Security fixes are provided for the latest published release. Beta releases may change storage and configuration behavior, but legacy Vaults are migrated conservatively.

安全修复仅面向最新发布版本。Beta 版本的存储和配置行为可能变化，但旧 Vault 会采用保守方式迁移。

## Reporting a vulnerability / 报告漏洞

Do not open a public issue for a vulnerability that could expose local files, execute commands, bypass the loopback-only dashboard, or alter agent configuration unexpectedly. Use GitHub's private vulnerability reporting after the repository is published. If that channel is unavailable, contact the repository owner privately and include reproduction steps, affected version, and impact.

若问题可能泄露本机文件、执行命令、绕过仅限回环地址的控制台，或意外修改 Agent 配置，请勿提交公开 Issue。项目发布后请使用 GitHub Private Vulnerability Reporting；若该通道不可用，请私下联系仓库所有者，并提供复现步骤、受影响版本和影响范围。

## Current security boundary / 当前安全边界

- Memory encryption is optional; plaintext remains the default. Encrypted Vaults protect memory events/history and caches with AES-256-GCM, using a separate local key file. Skills and filesystem metadata remain visible. See [scope and recovery](docs/ENCRYPTION.md).
- Key files are not password-protected or OS-keychain entries. Keep them private and backed up separately. Losing every copy prevents recovery; device compromise or access to the key defeats encryption. This is not a password manager.
- The dashboard listens only on the local loopback interface, checks Host and Origin, and uses a per-process token. Memory writes require the expected Vault identity and revision.
- Deleting a memory retains history (encrypted only in an encrypted Vault). Migration does not encrypt or erase old source copies, caches, backups or cloud history. Neither tombstones nor local cache removal provide secure erasure.
- Agent configuration updates are backed up before modification.
- Cloud-drive and NAS security remains the responsibility of the selected sync provider and operating system.

- 记忆加密可选、默认明文；Skill 和文件元数据不在加密范围。密钥须放在本机私有目录并单独备份，丢失无法恢复。密钥文件本身没有口令保护，本工具不是密码管理器。
- 迁移不会清除或加密旧库、旧缓存、备份和网盘历史；删除记忆仍保留历史，不能视为安全擦除。
- 控制台仅监听本机回环地址，并使用每次启动随机生成的令牌。
- 修改 Agent 配置前会创建备份。
- 网盘和 NAS 的访问安全仍由同步服务与操作系统负责。
