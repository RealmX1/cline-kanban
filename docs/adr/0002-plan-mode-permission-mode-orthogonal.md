# Plan 起步与权限档位是两条正交轴

任务会话有两个刻意独立的选项：「plan 起步」（`startInPlanMode`，开局先只读规划）与「权限档位」（per-task `taskAgentPermissionMode`：`ask_for_every_tool_use` / `auto_approve_file_edits_only` / `bypass_all_permission_prompts`，默认 bypass，域逻辑在 `src/core/task-agent-permission-mode.ts`）。本 ADR 定格的决策是：**二者是正交轴，谁也不得被翻译成另一个**——plan 起步不代表放弃权限，以 plan 起步的会话仍必须能在会话中途进入选定的权限档位。

## 背景

旧模型里全局 `agentAutonomousModeEnabled` 一个开关同时回答两个问题，于是「勾 plan 起步」曾被实现成「降权」。拆轴后：per-task `taskAgentPermissionMode` 接管会话启动的放权决策，旧全局开关只保留「新任务的默认档位」这一语义；`startInPlanMode` 收窄为纯开局行为。各 adapter 不得再用 `startInPlanMode` 去覆盖权限档。

正交性有实证：`applyClaudePermissionAndPlanModeArgs`（`src/terminal/agent-session-adapters.ts:801`）在 plan 起步时剔掉 `--dangerously-skip-permissions`、但补上 `--allow-dangerously-skip-permissions` 预授权后续升档——Claude Code 的两条轴落在同一个 `--permission-mode` 旗标上，所以必须在这一处统一决策，分两处推会产生互相打架的重复旗标。`cursor-agent --plan --force`、kimi 的 `--plan`/`--auto` 均可并存。Kimi 的 Bypass 对应 Never Ask（`--auto`），不是仍会询问敏感操作的 Ask When Needed（`--yolo`）；Never Ask 保留 Plan 起步，但按原生语义自动批准退出 Plan。

## 两个刻意的例外（UI 必须明示，不得静默）

1. **droid 的 `autonomyMode` 是单轴**（spec / normal / auto-high 三选一），plan 起步必然吃掉权限档。由 `doesPlanModeStartOverridePermissionModeForAgent`（`task-agent-permission-mode.ts:118`）判定，UI 据它明示「两者不可兼得」，不假装都生效。
2. **原生 Cline SDK 只能全放行**：其进程内 `requestToolApproval` 目前恒批准，三档里只能表达 bypass。由 `AGENT_IDS_THAT_CAN_ONLY_BYPASS`（`task-agent-permission-mode.ts:34`）标记，选更严的档位会被 `resolveTaskAgentPermissionModeForAgent`（:59）如实报告为 degraded 并交 UI 警示。后续项：把 Cline SDK 的审批接到与 ACP 同一条决策通道上，届时从该集合移除即可。

## 铁律：降级只收紧，不放宽

harness 表达不了用户选定的档位时，只能向**更保守**回落（不能表达中间档 → 回落到「每次询问」），**绝不回落到全放行**——静默地把权限放大是安全事故，缩小只是啰嗦。codex 是具体案例：它的 sandbox × approval 两旗标没有任何组合能表达「改文件放行、执行命令仍询问」，于是选中间档时落到「每次询问」（`task-agent-permission-mode.ts:22-28` 的注释记录了判读依据）。UI 用 `doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest`（:94）区分降级方向：收紧只需说明，放宽（目前仅 Cline SDK 恒批准一例）必须更醒目警示。

## 迁移

仓库无 migration 框架，旧卡片没有 per-task 档位字段：`resolveTaskAgentPermissionModeFromLegacyAutonomousFlag`（`task-agent-permission-mode.ts:105`）在读盘时按「当时的全局 `agentAutonomousModeEnabled`」推出等价档位，保证升级前后行为不变。

未来若有人想把两条轴合并回一个「 autonomy 单选」，请先读本 ADR：合并会直接删除「plan 起步 + 中途升档」这个真实工作流，并重新引入「plan = 降权」的旧误解。
