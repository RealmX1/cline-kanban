// 「人轴」采集增强（Stage 4 Phase B）的结构化日志（proper logging 要件，用户拍板）。沿用
// tui-freeze-logger 的 emitLine/stderr 约定（绕过 no-console lint、无需 opt-in 即可在服务端日志可见），
// 前缀 [user-turn-kind]。**仅在捕获到更细人轴（question/plan_review/permission）或 expected-but-absent
// 时记录**——绝不刷普适四种（review/error/interrupted/needs_input），避免噪声淹没线上信号。
// expected-but-absent（resolvedKind="unclassified"）让线上数据暴露 harness 改名 / 新增的未识别信号。

function emitLine(payload: string): void {
	try {
		process.stderr.write(`[user-turn-kind] ${payload}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}

export interface UserTurnKindCaptureLog {
	taskId: string;
	agentId: string | null;
	// 信号来源 harness（cline / claude / …）。
	source: string | null;
	// 触发分类的原始信号（toolName / hookEventName / notificationType），便于线上回溯。
	rawSignal: string | null;
	// 解析出的更细人轴；"unclassified" = expected-but-absent（识别到该 harness 但未匹配已知细类）。
	resolvedKind: RuntimeUserTurnKindCaptureKind;
}

export type RuntimeUserTurnKindCaptureKind = "question" | "plan_review" | "permission" | "unclassified";

export function logUserTurnKindCapture(entry: UserTurnKindCaptureLog): void {
	emitLine(
		`captured taskId=${entry.taskId} agentId=${entry.agentId ?? "(none)"} source=${entry.source ?? "(none)"} rawSignal=${entry.rawSignal ?? "(none)"} resolvedKind=${entry.resolvedKind}`,
	);
}
