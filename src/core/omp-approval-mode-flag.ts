// Kanban 的放权档位 → omp `--approval-mode` 旗标值的唯一映射。
//
// 放在 src/core/ 而不是任一条通道里，是因为 omp 的两条通道（ACP 子进程与 PTY TUI）吃的是同一个
// 根命令旗标，必须共用同一张表——否则切换通道会静默改变放权语义。
// 依赖方向也只有这一种是干净的：src/terminal/ 不得反向 import src/acp-client-session/。
import type { RuntimeTaskAgentPermissionMode } from "./api-contract";

// omp 的 tools.approvalMode 三档正好与 Kanban 的权限轴一一对应。注意必须**显式**传：
// omp 的 schema 默认虽是 yolo，但「默认值」不算 isConfigured，权限门仍会保留。
export function resolveOmpApprovalModeFlagValue(permissionMode: RuntimeTaskAgentPermissionMode): string {
	switch (permissionMode) {
		case "bypass_all_permission_prompts":
			return "yolo";
		case "auto_approve_file_edits_only":
			return "write";
		case "ask_for_every_tool_use":
			return "always-ask";
	}
}
