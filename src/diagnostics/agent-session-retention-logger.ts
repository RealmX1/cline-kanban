// `[agent-session-retention]` 探针的最小日志抽象：会话回收期限的落库失败、回收执行结果、
// 陈旧定时器被拦下等诊断行都经此输出。与 tui-freeze-logger 同构——写 process.stderr，
// 从而绕过 no-console lint 规则，并且不强制用户接入可选的 cline-runtime-logger 管线。
//
// 隐私红线：这里**绝不**打印待答问题的正文、选项、或工具参数正文。只允许 workspaceId /
// taskId / agentId / pid / 状态名 / 时刻 / 错误消息这类结构化标识。

const LOG_PREFIX = "[agent-session-retention]";

function emitLine(level: string, payload: string): void {
	try {
		process.stderr.write(`${level} ${LOG_PREFIX} ${payload}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}

export function logAgentSessionRetentionInfo(payload: string): void {
	emitLine("[info]", payload);
}

export function logAgentSessionRetentionWarning(payload: string): void {
	emitLine("[warn]", payload);
}

export function logAgentSessionRetentionError(payload: string, cause?: unknown): void {
	emitLine("[error]", payload);
	if (cause instanceof Error && cause.stack) {
		try {
			process.stderr.write(`${cause.stack}\n`);
		} catch {
			// Best-effort diagnostic logging only.
		}
	}
}
