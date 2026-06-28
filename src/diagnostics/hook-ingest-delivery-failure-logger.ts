// Hook 投递「最终失败」（重试耗尽 / 业务拒绝）的「永不静默」记录（F3）。
//
// 背景：`kanban hooks ingest` / `codex-hook` 把 to_review、to_in_progress 等**生命周期事件**投递给
// 常驻 runtime daemon。这类投递若失败而只写一行随即被终端滚走的 stderr，看板列状态会与现实悄悄脱节、
// 需人工纠正——handoff 反复强调的危险正是这种「静默丢投」。
//
// 本模块在生命周期事件**最终投递失败**时，除既有 stderr 外，向 Kanban 运行目录追加一条结构化、可 grep、
// 跨进程存活、且**不依赖 daemon** 的持久记录，使「丢投」可被事后发现而非彻底静默——即便 daemon 此刻
// 不可达（恰是最危险的丢投场景），记录也能落盘。
//
// ponytail: 仅落地「持久记录文件 + 结构化 stderr」；daemon 周期排空 / 自动重放 / 看板 toast 是后续 F4
// 的升级路径（本批刻意不做）。本文件即 F4 将来扫描/重放的天然入口。
//
// activity（纯元数据、不改看板列）刻意**不记录**：调用方按 `event !== "activity"` 闸过，避免高频活动事件
// 在 daemon 不可达时刷爆记录文件。

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RuntimeHookEvent } from "../core/api-contract";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const HOOK_DELIVERY_FAILURE_DIR = "agent-hook-delivery-failures";
const HOOK_DELIVERY_FAILURE_FILENAME = "agent-hook-delivery-failures.log";

// transport：daemon 不可达 / 超时，重试耗尽后仍失败（传输层）。rejected：daemon 可达但逻辑拒绝
// （{ok:false}，如 workspace/task not found），重试不会变 → 不重试、直接记。
export type HookDeliveryFailureKind = "transport" | "rejected";

export interface HookDeliveryFailureRecord {
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	source: string | null;
	attempts: number;
	failureKind: HookDeliveryFailureKind;
	error: string;
}

export function getHookDeliveryFailureLogPath(): string {
	return join(
		homedir(),
		RUNTIME_HOME_PARENT_DIR,
		RUNTIME_HOME_DIR,
		HOOK_DELIVERY_FAILURE_DIR,
		HOOK_DELIVERY_FAILURE_FILENAME,
	);
}

export function formatHookDeliveryFailureLine(record: HookDeliveryFailureRecord, isoTimestamp: string): string {
	return [
		isoTimestamp,
		`event=${record.event}`,
		`taskId=${record.taskId}`,
		`workspaceId=${record.workspaceId}`,
		`source=${record.source ?? "(none)"}`,
		`attempts=${record.attempts}`,
		`failureKind=${record.failureKind}`,
		`error=${JSON.stringify(record.error)}`,
	].join(" ");
}

// 双通道记录，两通道各自 best-effort、互不阻断，且都绝不向调用方抛错（记录失败不得加剧丢投）：
//   1) 结构化 stderr（[hook-ingest-drop] 前缀）——立即可见，落在 agent 的 Kanban 终端镜像，daemon-independent。
//   2) 追加到 Kanban 运行目录下的记录文件——跨进程存活、可 grep、daemon-independent。
export async function recordHookDeliveryFailure(record: HookDeliveryFailureRecord): Promise<void> {
	const isoTimestamp = new Date().toISOString();
	const line = formatHookDeliveryFailureLine(record, isoTimestamp);
	try {
		process.stderr.write(`[hook-ingest-drop] ${line}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
	try {
		const filePath = getHookDeliveryFailureLogPath();
		await mkdir(dirname(filePath), { recursive: true });
		await appendFile(filePath, `${line}\n`, "utf8");
	} catch {
		// Best-effort persistence only — never throw from the failure recorder.
	}
}
