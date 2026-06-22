// harness 级「人轴」采集分类（Stage 4 Phase B 采集增强）——把 best-effort hook 信号映射为更细的
// userTurnKind。纯函数、无副作用，便于单测；signal 脆弱性（Claude 改名即静默退化）由调用点的
// expected-but-absent 结构化日志兜底观测（见 logUserTurnKindCapture）。
import type { RuntimeTaskHookActivity } from "./api-contract.js";

// Claude permission 采集（B3）：gated source==="claude"；hookEventName==="PermissionRequest" 或
// notificationType==="permission_prompt" → permission；其余 → null（不强加人轴，回落单源派生的 review/
// needs_input）。其它 harness 的 permission 暂不区分（Claude 专属信号，列后续）。返回收窄为 "permission"|null
// ——当前唯一可经 hook metadata 采集的更细人轴；新增细类时再放宽。
export function classifyHookUserTurnKind(
	metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
): "permission" | null {
	if (!metadata) {
		return null;
	}
	if (metadata.source?.trim().toLowerCase() !== "claude") {
		return null;
	}
	const hookEventName = metadata.hookEventName?.trim().toLowerCase() ?? null;
	const notificationType = metadata.notificationType?.trim().toLowerCase() ?? null;
	if (hookEventName === "permissionrequest" || notificationType === "permission_prompt") {
		return "permission";
	}
	return null;
}
