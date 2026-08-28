# Skill 兼容与适配手册

Memory Ferry 0.7 在 Vault 中保存一份公共 Skill 源码，再为每个 Agent 目标渲染最小差异。用户不需要手工维护 Codex、Claude、Gemini、MiniMax 等多份完整副本。

## 公共源目录

每个可识别 Skill 都是包含 `SKILL.md` 的目录：

```text
<Vault>/skills/project-review/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

`SKILL.md` 必须以 YAML frontmatter 开头。`name` 必须与目录名相同，只能使用 1–64 个小写字母、数字和单个连字符；`description` 不能为空且不能超过 1024 个字符。

```markdown
---
name: project-review
description: 检查项目的正确性和可维护性。在用户要求代码或架构审查时使用。
---

# 项目审查

执行公共审查流程。
```

公共可选字段包括 `license`、`compatibility`、`metadata` 和仍处于实验状态的 `allowed-tools`。Memory Ferry 会提示非标准 frontmatter，以及不同 Agent 对 `allowed-tools` 支持不一致的问题。符号链接会被拒绝，因为 Windows、网盘和 NAS 对链接目标的处理并不一致。

## 可选的 Memory Ferry 清单

只有 Skill 存在平台要求或 Agent 差异时，才需要增加 `memory-ferry.yaml`：

```yaml
schemaVersion: 1
platforms:
  - darwin
  - win32
requires:
  commands:
    - git
  network: false
targets:
  codex:
    enabled: true
  claude:
    overlay: adapters/claude
  minimax-code:
    enabled: false
```

支持的目标 ID：`codex`、`claude`、`cursor`、`opencode`、`deepseek-harness`、`gemini`、`copilot`、`minimax-code`。

- `platforms` 可以限制为 `darwin`、`win32` 或 `linux`。
- `requires` 只向用户报告依赖；不会自动安装软件或授予联网权限。
- `enabled: false` 会阻止向独立目标安装。如果启用和禁用的 Agent 共用同一发现目录，界面会提示启用副本仍可能被两者看到。
- `overlay` 必须是 Skill 内部的相对路径；省略时默认查找 `adapters/<agent>`。

## 覆盖层格式

Agent 覆盖层只保存与公共源文件不同的部分：

```text
project-review/
├── SKILL.md
├── memory-ferry.yaml
└── adapters/
    ├── codex/
    │   ├── APPEND.md
    │   └── agents/openai.yaml
    └── claude/
        └── frontmatter.yaml
```

- `frontmatter.yaml` 合并到目标 `SKILL.md` 的 frontmatter。
- `APPEND.md` 追加到公共正文末尾。
- 覆盖层内其他文件按相对路径复制到渲染结果。
- 覆盖层不能提供 `SKILL.md`；公共源文件始终是唯一主体。
- 共用目录的 Agent 如果为同一字段提供不同值，或为同一路径提供内容不同的文件，Memory Ferry 会阻止该 Skill 分发，而不是生成含义不确定的结果。

Codex 元数据示例：

```yaml
# adapters/codex/agents/openai.yaml
policy:
  allow_implicit_invocation: false
```

Claude 专属 frontmatter 示例：

```yaml
# adapters/claude/frontmatter.yaml
allowed-tools: Read Grep
```

覆盖层应该尽量小。公共正文优先使用统一的 Memory Ferry MCP 工具名；只有 Agent 无法加载 MCP 时才增加 CLI 回退。

## 检查与同步

```bash
memory-ferry skills list
memory-ferry skills inspect
memory-ferry skills sync all
memory-ferry skills sync codex claude
```

`inspect` 会报告源 Skill 是否有效，以及每个 Agent 是“原生”“已适配”“不支持”还是“无效”。可视化控制台会显示同样的兼容状态。

同步过程为：

1. 校验公共源文件和可选清单。
2. 合并共用同一目标目录的 Agent。
3. 在临时目录中渲染公共内容和已启用覆盖层。
4. 使用“渲染内容 + Agent 目标组合 + 操作系统 + 渲染器版本”计算哈希。
5. 目标内容相同则不写文件。
6. 内容变化时通过可恢复的目录交换替换 Memory Ferry 管理的副本。
7. 写入 `.memory-ferry-sync.json`，记录所有权和渲染哈希。

同名但不属于 Memory Ferry 的用户 Skill 永远不会被覆盖。Vault 中删除、对目标禁用或不支持当前系统的已管理 Skill，会在下一次同步时移除。新的源内容校验失败时，不会删除上一次已经安装的有效副本。

## 跨电脑行为

iCloud、OneDrive、Syncthing 或 NAS 客户端负责在电脑之间传输公共源文件和覆盖层。每台电脑根据自己的操作系统和 Agent 组合独立渲染。接入 Agent 或切换 Vault 时会立即渲染；控制台保持运行时每五分钟兜底检查一次。

同时编辑同一个源文件产生的冲突仍由网盘客户端处理。应该修改 Vault 源目录，不要修改 Agent 目录中的渲染副本。
