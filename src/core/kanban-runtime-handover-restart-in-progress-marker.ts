// 「本端口的 runtime 正在计划内 handover 重启」的落盘标记。
//
// 谁读：CLI 写动词（`kanban task …` 等）撞上 ECONNREFUSED 时据此判断「runtime 是在重启、等一下就回来」，
// 于是等待重试而不是把错误报给 agent。另一条证据（问本会话的 agent session PTY host 有没有 controller）只在 hosted
// 会话里才有；这个标记对任何调用方都成立（例如在普通终端里跑 deploy skill 的 agent）。
// 谁写：handover 开始时由要退出的 runtime 写；下一个 runtime 开始监听后删掉。runtime 迟迟不回来时标记按年龄失效，
// 不会让 CLI 永远等。
//
// 按 runtime 身份（runtime home + 端口）区分：同机 3484 与隔离实例互不影响。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 标记被当作「正在重启」证据的最长年龄。与「controller 离开 host 不超过 90s」同一口径。
export const KANBAN_RUNTIME_HANDOVER_RESTART_IN_PROGRESS_MARKER_MAXIMUM_EVIDENCE_AGE_MS = 90_000;

export interface KanbanRuntimeHandoverRestartInProgressMarker {
	handoverRestartStartedAtEpochMs: number;
	previousRuntimeProcessId: number;
	runtimePort: number;
}

export function resolveKanbanRuntimeHandoverRestartInProgressMarkerPath(input: {
	runtimeHomeDirectoryPath: string;
	runtimePort: number;
}): string {
	return join(
		input.runtimeHomeDirectoryPath,
		"agent-session-pty-host",
		`p${input.runtimePort}-runtime-handover-restart-in-progress-marker.json`,
	);
}

export function writeKanbanRuntimeHandoverRestartInProgressMarker(
	markerPath: string,
	marker: KanbanRuntimeHandoverRestartInProgressMarker,
): void {
	mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
	writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

export function removeKanbanRuntimeHandoverRestartInProgressMarker(markerPath: string): void {
	rmSync(markerPath, { force: true });
}

// 读不到、读坏了、太旧了都返回 null（不是证据）。
export function readFreshKanbanRuntimeHandoverRestartInProgressMarker(
	markerPath: string,
	nowEpochMs: number,
): KanbanRuntimeHandoverRestartInProgressMarker | null {
	let parsedMarker: unknown;
	try {
		parsedMarker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return null;
	}
	if (typeof parsedMarker !== "object" || parsedMarker === null) {
		return null;
	}
	const { handoverRestartStartedAtEpochMs, previousRuntimeProcessId, runtimePort } = parsedMarker as Record<
		string,
		unknown
	>;
	if (
		typeof handoverRestartStartedAtEpochMs !== "number" ||
		typeof previousRuntimeProcessId !== "number" ||
		typeof runtimePort !== "number"
	) {
		return null;
	}
	const markerAgeMs = nowEpochMs - handoverRestartStartedAtEpochMs;
	if (markerAgeMs < 0 || markerAgeMs > KANBAN_RUNTIME_HANDOVER_RESTART_IN_PROGRESS_MARKER_MAXIMUM_EVIDENCE_AGE_MS) {
		return null;
	}
	return { handoverRestartStartedAtEpochMs, previousRuntimeProcessId, runtimePort };
}
