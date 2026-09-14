# CLAUDE.md

@AGENTS.md

<!--
单一真相源在根 AGENTS.md：本仓全部 agent 上下文（仓库形态、命令、架构 orientation、
铁律与约定、文档指针）都住在那里，经上面这行 import 注入 Claude Code 会话。
不要在本文件复述 AGENTS.md 的任何内容——双副本必漂移（本仓已有教训：02abe1cb 曾移除
该 import，两文件随后各自分叉）。本节以下只放 Claude Code 专属事项。
仓库文档以中文为主要语言。
-->

## Claude Code 专属

- 个人/本机覆盖用 `CLAUDE.local.md`（已在 `.gitignore`），不要提交。
- 项目级 skills 在 `.claude/skills/`（与 `.codex/skills/` 同步维护；release 工作流是 `.clinerules/workflows/release.md` 的 symlink）。
- 觉得上下文文件臃肿时可用 `/doctor` 的 trim 检查辅助修剪；上下文文件的改动像代码一样过评审（方法论见 `docs/agent-context-management.md`）。
- Claude Code 的记忆层级（managed policy → user → project → local）、`.claude/rules/` path-scoped 规则、`@import` 限制（≤4 跳、启动即全量展开）等机制差异，见 `docs/agent-context-management.md` 的 provider 表。
