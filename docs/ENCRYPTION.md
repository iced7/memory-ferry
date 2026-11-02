# Optional memory encryption / 可选记忆加密

Memory Ferry 1.1 defaults to the existing plaintext format. Encryption is an explicit choice for a **new, empty Vault**. Existing Vaults are never converted automatically.

1.1 默认保持现有明文用法。创建新 Vault 时可以选择加密记忆；现有库不会自动加密。控制台“添加 Vault”中的加密选项默认不勾选。

## Scope and keys / 加密范围与密钥

Memory events (including titles, content, tags, sources and historical/deleted versions), local event caches, and local embedding indexes use AES-256-GCM. A random 256-bit key lives in a separate local key file; it is **not** written to the Vault, agent configuration, or release package. This is a key-file design, not a password or recovery-service design. The app remembers only its path in local state so CLI/MCP agents can work in the background.

记忆正文、标题、标签、来源、历史版本、删除事件、本机事件缓存及向量索引使用 AES-256-GCM 加密。每个库随机生成独立密钥，本机状态只记录密钥文件路径，方便 Agent 后台使用。密钥文件本身不是口令保护的保险箱：任何能读取它的人或程序都可解密对应的记忆。请放在本机私有目录，并单独安全备份。macOS/Linux 要求密钥权限为 `600`；Windows 使用所在私有目录的访问权限，请勿放入公共目录或共享盘。

The following remain visible: Skills and their attachments, Vault name/ID, device directories, event filenames/timing/counts/sizes. A running authorized agent receives decrypted memories and may retain them in its own logs or send them to its configured model. An optional embedding service also receives plaintext input, just as in plaintext mode. Encryption does not protect an already-compromised device, enforce secure erasure, or detect a complete rollback/deletion of synchronized history. This is not a password manager.

Skill 文件及附件、Vault 名称和 ID、设备目录、事件文件名、时间、数量和大小仍可见。已授权 Agent 会读到解密后的记忆，可能把它们写入自己的日志或发送到其模型；启用的向量服务同样会接收明文输入。加密不能保护已被控制的电脑，也不等于安全擦除或完整的防回滚机制。

## Create and use / 创建与使用

```sh
memory-ferry init "/path/to/new-encrypted-vault" --encrypt --json
memory-ferry vault privacy "/path/to/new-encrypted-vault" --json
```

The default key is generated under the machine-local state directory (`~/.memory-ferry/keys/` unless configured otherwise). The returned `privacy.keyFile` and dashboard show the path, never the key contents. Back it up outside the synchronized Vault using a secure channel. Losing every copy of this file makes the encrypted memories unrecoverable. There is no server-side reset or recovery key. Do not paste the key into chat, issues, or shell arguments.

默认密钥保存在本机状态目录下的 `keys/` 文件夹中。命令输出和控制台会显示文件路径；请单独备份。所有密钥副本丢失后无法恢复加密记忆，没有服务器重置入口。不要把密钥内容粘贴到聊天、Issue 或命令参数中。

To choose a **new** local key-file location:

```sh
memory-ferry init "/path/to/new-encrypted-vault" --encrypt --key-file "/private/local/new-vault.key"
```

Existing key files are never overwritten. Both keys and local state must be outside the Vault, including symlink aliases. They should also remain outside any other synced/shared directory; the app cannot identify every cloud-provider root.

## A second device / 另一台设备

1. Install Memory Ferry **1.1.0 or later** and let the sync provider transfer the encrypted Vault.
2. Transfer the matching key separately to a private local directory. On macOS/Linux use `chmod 600 /private/local/vault.key` after copying if needed.
3. Import its path and select the Vault:

```sh
memory-ferry vault unlock "/path/to/synced-vault" --key-file "/private/local/vault.key"
memory-ferry use "/path/to/synced-vault"
memory-ferry doctor --json
```

In the dashboard, select the synced Vault and enter the local key-file path. A missing/wrong key leaves the memories locked. Forgetting the local association removes automatic access for future operations; it does not delete the key file, revoke another device, erase an agent's existing context, or interrupt operations already in flight:

```sh
memory-ferry vault lock "/path/to/synced-vault"
```

在另一台电脑上先安装 1.1.0 或更高版本，同步 Vault，再把密钥通过安全渠道单独复制过去。在控制台输入本机密钥文件路径，或运行上述 `vault unlock`。控制台的“移除本机密钥关联”保留密钥文件，只让后续操作重新要求导入；不会撤销其他电脑或清除 Agent 已拿到的内容。

## Existing data / 现有数据迁移

Create an empty encrypted target first, then copy the history into it:

```sh
memory-ferry init "/path/to/new-encrypted-vault" --encrypt
memory-ferry vault migrate "/path/to/old-plaintext-vault" "/path/to/new-encrypted-vault"
memory-ferry doctor --vault "/path/to/new-encrypted-vault" --json
```

Migration preserves event IDs, all historical revisions, tombstones, and conflicts. It decrypts/re-encrypts events for the target Vault; repeating a successful migration does not duplicate events. Skills are copied as plaintext. Damaged events stop encrypted migration before event copying begins. Interrupted copies can be rerun; migration is not an atomic transaction across cloud devices.

**The old Vault, its local caches, backups, and cloud-provider version history remain plaintext.** Verify the new Vault and all devices before deciding how to retire those copies. The app never deletes them automatically. New devices and connected agents must select the new target; the source can continue to receive changes until you switch them.

迁移会保留完整历史及删除记录，并按目标库密钥重新加密；重复迁移不会复制同一事件。原库、原库本机缓存、备份和网盘历史仍为明文，不会自动删除。请核对新库和所有设备后自行决定旧副本的保留方式。所有设备和 Agent 需要切换到新库；尚未切换的客户端仍可能继续往旧库写入。

An encrypted-to-plaintext export requires an explicit option (or the corresponding dashboard checkbox):

```sh
memory-ferry vault migrate "/encrypted-source" "/plaintext-target" --allow-plaintext
```

Key rotation is performed by creating a new encrypted Vault/key and migrating into it. This does not revoke access to copies already encrypted with the old key. In-place mode changes are intentionally unsupported because offline/older clients could keep writing the prior format. Version 1.0 clients reject the new schema instead of silently opening an empty Vault; they continue to support default plaintext Vaults.

## Format and validation / 格式与验证

Encrypted manifests use schema 2 and `memory-ferry-encrypted-events`. Events retain the logical v1 schema inside an authenticated envelope. Each write uses a fresh 12-byte random IV and a 16-byte authentication tag. Authenticated additional data binds the Vault ID, key ID, purpose and (for events) relative event path. A key-check envelope detects wrong keys even for empty Vaults. Devices pin encrypted Vault identity in local state and reject a changed identity/protection mode at a known path.

Encrypted cache fingerprints include ciphertext content hashes, so equal-size/mtime event modifications cannot bypass event validation through a cache hit. Invalid event ciphertext fails closed. Disposable cache corruption may be rebuilt after key validation. Whole-history rollback/deletion is not prevented. No independent cryptographic security audit is claimed.

Implementation uses the standard [Node.js crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html). The design separates data and keys and uses authenticated encryption as described in [OWASP Cryptographic Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html). Tests cover tampering, wrong keys, key placement, downgrade refusal, cache leakage, history migration, CLI/MCP/UI integration, and cross-device key import; they do not replace an independent security review.
