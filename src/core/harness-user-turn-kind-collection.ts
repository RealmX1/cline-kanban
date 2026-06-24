// harness 级「人轴」采集分类（Stage 4 Phase B 采集增强）——把 best-effort hook 信号映射为更细的
// userTurnKind。纯函数、无副作用，便于单测；signal 脆弱性（Claude 改名即静默退化）由调用点的
// expected-but-absent 结构化日志兜底观测（见 logUserTurnKindCapture）。
import type { RuntimeTaskHookActivity } from "./api-contract.js";

// Claude（终端 agent）hook metadata → 更细人轴；gated source==="claude"。当前可采集三类：
//   - plan_review（Stage 5）：toolName==="ExitPlanMode"（Claude 原生「计划待批」工具）；
//   - question（Stage 5）：toolName==="AskUserQuestion"（Claude 原生「澄清提问」工具）；
//   - permission（B3）：hookEventName==="PermissionRequest" 或 notificationType==="permission_prompt"（无特定工具）。
// 这与 Cline SDK 的 ask_followup_question / plan_mode_respond 同语义、不同工具名——Claude Code 走它自己的
// 工具（见 classifyClineUserAttentionTool 的对称实现）。toolName 由 `kanban hooks` CLI 从 hook stdin 的
// tool_name 抽出（hooks.ts:314-323 → metadata.toolName）。
//
// ⚠️ toolName 判定必须**先于**通用 permission：ExitPlanMode/AskUserQuestion 同时经两种 hook 机制抵达
// to_review——PreToolUse（工具执行前，本仓库新增的 `ExitPlanMode|AskUserQuestion` matcher，
// agent-session-adapters.ts）与 PermissionRequest（ExitPlanMode 的「批准计划」权限对话同样 fire，见 Claude
// hooks 文档 auto-approve ExitPlanMode 示例；本仓库 adapter 的 PermissionRequest matcher "*"→to_review 会
// 携带 toolName=ExitPlanMode）。两者竞争 to_review 闸（先到者落定人轴）；若 permission 先判，ExitPlanMode 的
// 权限请求会被误标 permission 而非 plan_review（评审确认的竞态）。语义上「批准这个计划」本就是 plan_review，
// 故按 toolName 优先是更准确的归类、且对两条 hook 路径与到达顺序均鲁棒，非特例。
// 其余 → null（不强加人轴，回落单源派生的 review/needs_input）；其它 harness 的 permission 暂不区分。
// signal 脆弱（Claude 改工具名即静默退化）由调用点 expected-but-absent 日志兜底（hooks-api.ts）。
export function classifyHookUserTurnKind(
	metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
): "permission" | "question" | "plan_review" | null {
	if (!metadata) {
		return null;
	}
	if (metadata.source?.trim().toLowerCase() !== "claude") {
		return null;
	}
	const toolName = metadata.toolName?.trim().toLowerCase() ?? null;
	if (toolName === "exitplanmode" || toolName === "exit_plan_mode") {
		return "plan_review";
	}
	if (toolName === "askuserquestion" || toolName === "ask_user_question") {
		return "question";
	}
	const hookEventName = metadata.hookEventName?.trim().toLowerCase() ?? null;
	const notificationType = metadata.notificationType?.trim().toLowerCase() ?? null;
	if (hookEventName === "permissionrequest" || notificationType === "permission_prompt") {
		return "permission";
	}
	return null;
}
