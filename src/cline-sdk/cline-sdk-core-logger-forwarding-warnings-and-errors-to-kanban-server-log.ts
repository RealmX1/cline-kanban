// `[cline-sdk-core]` 诊断：注入给 `ClineCore.create({ logger })` 的 SDK logger，只把 warn 及以上的行写进
// Kanban 服务器日志。与 tui-freeze-logger / lock-diagnostics-logger 同款范式：直接写 process.stderr，
// 绕过 no-console lint 规则，且默认可见。
//
// 为什么不复用 cline-runtime-logger：那条管线要设置 CLINE_LOG_ENABLED 才落盘，默认等于看不见；
// 而且它要 import sdk-runtime-boundary 里的值，boundary 反过来 import 它会形成运行时循环依赖。
//
// 存在意义：SDK 的运行时后端选择与回退（例如 "Falling back to local runtime host"）、hub 连接失败
// 只经这个 logger 报告；不注入时全部静默丢失。debug 与普通 log（info）一律丢弃，避免刷屏。

import type { ClineSdkBasicLogger } from "./sdk-runtime-boundary";

const LOG_PREFIX = "[cline-sdk-core]";

type KanbanServerLogLevelPrefix = "[warn]" | "[error]";

function serializeMetadataForKanbanServerLogLine(metadata: Record<string, unknown> | undefined): string {
	if (!metadata) {
		return "";
	}
	const { severity: _severity, ...metadataWithoutSeverity } = metadata;
	if (Object.keys(metadataWithoutSeverity).length === 0) {
		return "";
	}
	try {
		return ` ${JSON.stringify(metadataWithoutSeverity, (_key, value: unknown) =>
			value instanceof Error ? { name: value.name, message: value.message } : value,
		)}`;
	} catch {
		return " [unserializable metadata]";
	}
}

function emitLine(levelPrefix: KanbanServerLogLevelPrefix, message: string, metadata?: Record<string, unknown>): void {
	try {
		process.stderr.write(
			`${levelPrefix} ${LOG_PREFIX} ${message}${serializeMetadataForKanbanServerLogLine(metadata)}\n`,
		);
		const cause = metadata?.error;
		if (levelPrefix === "[error]" && cause instanceof Error && cause.stack) {
			process.stderr.write(`${cause.stack}\n`);
		}
	} catch {
		// Best-effort diagnostic logging only.
	}
}

export function createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog(): ClineSdkBasicLogger {
	return {
		debug: () => {},
		log: (message, metadata) => {
			if (metadata?.severity === "warn") {
				emitLine("[warn]", message, metadata);
			} else if (metadata?.severity === "error") {
				emitLine("[error]", message, metadata);
			}
		},
		error: (message, metadata) => emitLine("[error]", message, metadata),
	};
}
