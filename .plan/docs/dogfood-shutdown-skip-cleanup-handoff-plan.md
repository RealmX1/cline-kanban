# Dogfood shutdown cleanup handoff plan（已被安全默认行为取代）

## 状态

本计划已退役。安全 shutdown 已成为唯一行为，不再存在 cleanup owner 或反向开启破坏性清理的选项。

## 当前不变量

- 正常 shutdown 不移动任何卡片，不删除任何 task worktree。
- 只停止 managed workspace 中实际存活的 PTY。
- Agent-owned 活跃回合安全投影为 interrupted，PID 清空。
- User-owned review/question/permission 等回合保留 `userTurnKind`，投影为 exited，PID 清空。
- Idle/exited session 不修改。
- 未加载的 indexed workspace 不读取或写入 board/session state。
- 可重建的 task worktree setup lock 仍可在 shutdown 时清理。

## 兼容边界

仓库内的 dogfood、开发和文档示例均不再传 `--skip-shutdown-cleanup`。CLI 仅把该参数保留为隐藏 no-op，使已经安装但尚未迁移的外部 supervisor 能继续启动；参数不会进入 runtime 或 shutdown coordinator，也不会输出提示。

## 回归覆盖

- `test/integration/shutdown-coordinator.integration.test.ts`
- `test/integration/runtime-state-stream.integration.test.ts`

两处测试共同验证默认 shutdown 保留 card column、session 等待语义和 task worktree；runtime 启动测试额外验证隐藏兼容参数仍可被旧 supervisor 接受。
