// 程序化投递（`kanban task message` / RVF followup）的注入账本：CLI 与 runtime 共用的**同一份真相**。
//
// 为什么需要一个共享模块（而不是留在 src/commands/task.ts 里）：
// 2026-08-08 事故的本质是「CLI 写下记录后就再也不更新」——CLI 进程在 PTY 真正收到文本之前很久就退出了，
// 于是那条 `status: "queued"` 是**投递前**读快照推断出来的，与实际结果毫无关系。要让回执诚实，就必须让
// runtime 在投递真正落定（或失败）之后回来**就地改写**同一条记录。CLI 和 runtime 是两个进程，因此这份
// 读写必须走跨进程文件锁（proper-lockfile，与看板状态同一套），且终态**写一次即定**。
//
// 跨仓契约：~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md
// 字段名与取值集合已对外发布、RVF 侧据此接线，**改动前必须先改契约文件**。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";

export const TASK_MESSAGE_INJECTION_LEDGER_FILENAME = "task-message-injections.json";

// 四种语义不可合并。特别是 accepted_pending_submit_confirmation **不表示成功**——把它当成功
// 正是 2026-08-08 那 49 分钟事故的成因。
export const TASK_MESSAGE_TERMINAL_DELIVERY_STATUSES = [
	// 文本已写入 PTY，且提交已确认（agent 已收到并开始处理）。
	"delivered_and_submit_confirmed",
	// 已写入且提交已确认，但写入时 agent 正在自己的回合中，这条消息排在其后。
	"delivered_queued_behind_active_agent_turn",
	// 已受理、尚未确认。唯一的非终态，必然在有界时间内收敛。
	"accepted_pending_submit_confirmation",
	// 未送达，必带 failure reason。
	"delivery_failed",
] as const;
export type TaskMessageTerminalDeliveryStatus = (typeof TASK_MESSAGE_TERMINAL_DELIVERY_STATUSES)[number];

export const TASK_MESSAGE_TERMINAL_DELIVERY_FAILURE_REASONS = [
	"no_active_terminal_session",
	"terminal_prompt_readiness_timeout",
	"submit_confirmation_budget_exhausted",
	"human_terminal_contention_timeout",
	"agent_awaiting_user_decision_timeout",
	"superseded_by_later_delivery",
	"session_ended_before_delivery",
	"cancelled_before_delivery",
	"runtime_restarted_before_confirmation",
] as const;
export type TaskMessageTerminalDeliveryFailureReason = (typeof TASK_MESSAGE_TERMINAL_DELIVERY_FAILURE_REASONS)[number];

// 遗留 `status` 字段的取值。真相已搬到 terminal_delivery_status，这里只保留镜像让旧读者不至于炸；
// 契约里已明确建议 RVF 改读新字段。`failed` 是本次新增的取值（旧实现失败时直接删记录）。
const LEGACY_STATUS_MIRROR: Record<TaskMessageTerminalDeliveryStatus, string> = {
	delivered_and_submit_confirmed: "started",
	delivered_queued_behind_active_agent_turn: "queued",
	accepted_pending_submit_confirmation: "pending",
	delivery_failed: "failed",
};

export interface TaskMessageInjectionRecord {
	task_id: string;
	attempt_id?: string;
	source: string;
	idempotency_key: string;
	prompt_sha256: string;
	message_id: string;
	turn_id?: string;
	checkpoint_id?: string;
	// 遗留镜像，由 terminal_delivery_status 派生，不作判据。
	status?: string;
	terminal_delivery_status: TaskMessageTerminalDeliveryStatus;
	terminal_delivery_failure_reason?: TaskMessageTerminalDeliveryFailureReason;
	terminal_delivery_status_updated_at: string;
	created_at: string;
}

export function getTaskMessageInjectionLedgerPath(workspaceStatePath: string): string {
	return join(workspaceStatePath, TASK_MESSAGE_INJECTION_LEDGER_FILENAME);
}

export function isTaskMessageTerminalDeliveryStatusSettled(status: TaskMessageTerminalDeliveryStatus): boolean {
	return status !== "accepted_pending_submit_confirmation";
}

function isTerminalDeliveryStatus(value: unknown): value is TaskMessageTerminalDeliveryStatus {
	return typeof value === "string" && (TASK_MESSAGE_TERMINAL_DELIVERY_STATUSES as readonly string[]).includes(value);
}

function isTerminalDeliveryFailureReason(value: unknown): value is TaskMessageTerminalDeliveryFailureReason {
	return (
		typeof value === "string" && (TASK_MESSAGE_TERMINAL_DELIVERY_FAILURE_REASONS as readonly string[]).includes(value)
	);
}

// 旧记录（本次改动之前落盘的）没有 terminal_* 三个字段，只有遗留 `status`。读进来时补齐，
// 让「读到的每条记录都带 terminal_delivery_status」成为模块内不变量——否则每个消费点都得写兜底分支。
// 反向映射刻意保守：旧的 `queued`/`started` 是投递**前**的快照推断，不能当作已确认送达，
// 一律降级成 pending 交给 runtime 重启清扫去判失败，而不是伪造一个「已送达」的终态。
function normalizeLegacyRecord(record: Record<string, unknown>): TaskMessageInjectionRecord {
	const legacyStatus = typeof record.status === "string" ? record.status : undefined;
	const terminalStatus = isTerminalDeliveryStatus(record.terminal_delivery_status)
		? record.terminal_delivery_status
		: "accepted_pending_submit_confirmation";
	const failureReason = isTerminalDeliveryFailureReason(record.terminal_delivery_failure_reason)
		? record.terminal_delivery_failure_reason
		: undefined;
	const updatedAt =
		typeof record.terminal_delivery_status_updated_at === "string"
			? record.terminal_delivery_status_updated_at
			: String(record.created_at);
	return {
		task_id: String(record.task_id),
		...(typeof record.attempt_id === "string" ? { attempt_id: record.attempt_id } : {}),
		source: String(record.source),
		idempotency_key: String(record.idempotency_key),
		prompt_sha256: String(record.prompt_sha256),
		message_id: String(record.message_id),
		...(typeof record.turn_id === "string" ? { turn_id: record.turn_id } : {}),
		...(typeof record.checkpoint_id === "string" ? { checkpoint_id: record.checkpoint_id } : {}),
		status: legacyStatus ?? LEGACY_STATUS_MIRROR[terminalStatus],
		terminal_delivery_status: terminalStatus,
		...(failureReason ? { terminal_delivery_failure_reason: failureReason } : {}),
		terminal_delivery_status_updated_at: updatedAt,
		created_at: String(record.created_at),
	};
}

function hasRequiredRecordFields(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.task_id === "string" &&
		typeof record.source === "string" &&
		typeof record.idempotency_key === "string" &&
		typeof record.prompt_sha256 === "string" &&
		typeof record.message_id === "string" &&
		typeof record.created_at === "string"
	);
}

export async function readTaskMessageInjectionLedger(ledgerPath: string): Promise<TaskMessageInjectionRecord[]> {
	let raw: string;
	try {
		raw = await readFile(ledgerPath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed) || !parsed.every(hasRequiredRecordFields)) {
		throw new Error(`Invalid ${TASK_MESSAGE_INJECTION_LEDGER_FILENAME}. Fix or remove the file before retrying.`);
	}
	return parsed.map((record) => normalizeLegacyRecord(record));
}

async function writeTaskMessageInjectionLedger(
	ledgerPath: string,
	records: readonly TaskMessageInjectionRecord[],
): Promise<void> {
	// lock: null —— 调用方已持有 withTaskMessageInjectionLedgerLock 取的那把锁，这里再取会自锁。
	await lockedFileSystem.writeJsonFileAtomic(ledgerPath, records, { lock: null });
}

// 全部读改写都必须经这里：跨进程锁（CLI 与 runtime 是两个进程）。
export async function withTaskMessageInjectionLedgerLock<T>(
	ledgerPath: string,
	operation: (records: TaskMessageInjectionRecord[]) => Promise<{ records?: TaskMessageInjectionRecord[]; result: T }>,
): Promise<T> {
	return await lockedFileSystem.withLock({ path: ledgerPath, type: "file" }, async () => {
		const records = await readTaskMessageInjectionLedger(ledgerPath);
		const outcome = await operation(records);
		if (outcome.records) {
			await writeTaskMessageInjectionLedger(ledgerPath, outcome.records);
		}
		return outcome.result;
	});
}

export function findTaskMessageInjectionRecord(
	records: readonly TaskMessageInjectionRecord[],
	taskId: string,
	idempotencyKey: string,
): TaskMessageInjectionRecord | null {
	return records.find((record) => record.task_id === taskId && record.idempotency_key === idempotencyKey) ?? null;
}

export function buildTaskMessageInjectionMessageId(taskId: string, idempotencyKey: string): string {
	return `terminal:${taskId}:${idempotencyKey}`;
}

export function createPendingTaskMessageInjectionRecord(input: {
	taskId: string;
	attemptId?: string;
	source: string;
	idempotencyKey: string;
	promptSha256: string;
	nowIso: string;
}): TaskMessageInjectionRecord {
	return {
		task_id: input.taskId,
		...(input.attemptId ? { attempt_id: input.attemptId } : {}),
		source: input.source,
		idempotency_key: input.idempotencyKey,
		prompt_sha256: input.promptSha256,
		message_id: buildTaskMessageInjectionMessageId(input.taskId, input.idempotencyKey),
		status: LEGACY_STATUS_MIRROR.accepted_pending_submit_confirmation,
		terminal_delivery_status: "accepted_pending_submit_confirmation",
		terminal_delivery_status_updated_at: input.nowIso,
		created_at: input.nowIso,
	};
}

export function applyTerminalDeliveryOutcomeToRecord(
	record: TaskMessageInjectionRecord,
	outcome: {
		status: TaskMessageTerminalDeliveryStatus;
		failureReason?: TaskMessageTerminalDeliveryFailureReason;
		nowIso: string;
		turnId?: string;
		checkpointId?: string;
	},
): TaskMessageInjectionRecord {
	const { terminal_delivery_failure_reason: _discardedPreviousReason, ...rest } = record;
	return {
		...rest,
		...(outcome.turnId ? { turn_id: outcome.turnId } : {}),
		...(outcome.checkpointId ? { checkpoint_id: outcome.checkpointId } : {}),
		status: LEGACY_STATUS_MIRROR[outcome.status],
		terminal_delivery_status: outcome.status,
		...(outcome.failureReason ? { terminal_delivery_failure_reason: outcome.failureReason } : {}),
		terminal_delivery_status_updated_at: outcome.nowIso,
	};
}

export type RecordTerminalDeliveryOutcomeResult =
	| { outcome: "settled"; record: TaskMessageInjectionRecord }
	| { outcome: "already_settled"; record: TaskMessageInjectionRecord }
	| { outcome: "unknown_idempotency_key" };

// 终态**写一次即定**：首个写终态的一方获胜，晚到者拿到 already_settled 并读回真实终态。
// 这条不变量是「取消 vs 确认的竞争是确定性的」（契约 § 时序保证 3）的全部实现——没有它，
// 一条记录就可能既被取消又被判送达，RVF 两边都不能信。
export async function recordTaskMessageTerminalDeliveryOutcome(input: {
	ledgerPath: string;
	taskId: string;
	idempotencyKey: string;
	status: TaskMessageTerminalDeliveryStatus;
	failureReason?: TaskMessageTerminalDeliveryFailureReason;
	turnId?: string;
	checkpointId?: string;
	nowIso: string;
}): Promise<RecordTerminalDeliveryOutcomeResult> {
	return await withTaskMessageInjectionLedgerLock<RecordTerminalDeliveryOutcomeResult>(
		input.ledgerPath,
		async (records) => {
			const existing = findTaskMessageInjectionRecord(records, input.taskId, input.idempotencyKey);
			if (!existing) {
				return { result: { outcome: "unknown_idempotency_key" } };
			}
			if (isTaskMessageTerminalDeliveryStatusSettled(existing.terminal_delivery_status)) {
				return { result: { outcome: "already_settled", record: existing } };
			}
			const nextRecord = applyTerminalDeliveryOutcomeToRecord(existing, {
				status: input.status,
				...(input.failureReason ? { failureReason: input.failureReason } : {}),
				...(input.turnId ? { turnId: input.turnId } : {}),
				...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
				nowIso: input.nowIso,
			});
			return {
				records: records.map((record) => (record === existing ? nextRecord : record)),
				result: { outcome: "settled", record: nextRecord },
			};
		},
	);
}

export interface StalePendingTaskMessageInjectionSweepResult {
	sweptCount: number;
	// 本轮因「还没超期」被放过的 pending 里，最早会超期的那条的绝对时刻（epoch ms）；没放过任何一条时为 null。
	// 调用方必须据此排一次延迟复扫：本轮放过的那些记录，其属主进程也可能早就死了，
	// 没有复扫它们就要一直躺到下一次 runtime 启动——那正是本轮改动要根除的「永远 pending」。
	earliestSkippedPendingBecomesStaleAtEpochMs: number | null;
}

// 账本时间戳读不出来（手改坏 / 更旧的格式）时返回 null，调用方按「已超期」处理：
// 判失败是安全的那一侧，留着才会变成永远没人收敛的 pending。
function resolvePendingRecordBecomesStaleAtEpochMs(
	record: TaskMessageInjectionRecord,
	stalePendingThresholdMs: number,
): number | null {
	const statusUpdatedAtMs = Date.parse(record.terminal_delivery_status_updated_at);
	if (Number.isNaN(statusUpdatedAtMs)) {
		return null;
	}
	return statusUpdatedAtMs + stalePendingThresholdMs;
}

// runtime 启动清扫：把**超期**仍 pending 的记录判失败（契约 § 时序保证 2 的原文就是「超期」）。
//
// 判据为什么必须是「超期」而不是「本进程刚起来」：账本落在全机共享的 workspaces 根下（getWorkspacesRootPath
// 固定在 homedir 下、没有实例级隔离），而「本进程刚起来」说明不了「这条 pending 归本进程管」。按后者全扫，
// 任何第二个 runtime 实例启动（并行 checkout 的 dev:full、dogfood、起真服务器的集成测试）都会把常驻实例
// 此刻**真正在途**的投递写成 delivery_failed。而终态写一次即定，随后真正落定的 delivered_* 会被判
// already_settled 丢弃 ⇒ 调用方拿到一个**不可纠正的假失败**，比「不知道结果」更坏。
//
// 「超期」不需要新发明策略：契约 § 时序保证 1 已承诺 pending 必然在最坏预算内转终态，因此
// 「记录岁数 > 最坏预算」就等价于「不可能还有人在正常投递它」——无论它属于哪个实例，判失败都是对的。
// 预算由调用方注入（真相在 TerminalSessionManager 那几个 deadline 常量里，见
// TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS），本模块不自持策略数字。
export async function sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart(input: {
	ledgerPath: string;
	nowIso: string;
	stalePendingThresholdMs: number;
}): Promise<StalePendingTaskMessageInjectionSweepResult> {
	const nowMs = Date.parse(input.nowIso);
	return await withTaskMessageInjectionLedgerLock(input.ledgerPath, async (records) => {
		let sweptCount = 0;
		let earliestSkippedPendingBecomesStaleAtEpochMs: number | null = null;
		const sweptRecords: TaskMessageInjectionRecord[] = [];
		for (const record of records) {
			if (isTaskMessageTerminalDeliveryStatusSettled(record.terminal_delivery_status)) {
				sweptRecords.push(record);
				continue;
			}
			const becomesStaleAtEpochMs = resolvePendingRecordBecomesStaleAtEpochMs(record, input.stalePendingThresholdMs);
			if (becomesStaleAtEpochMs !== null && becomesStaleAtEpochMs > nowMs) {
				earliestSkippedPendingBecomesStaleAtEpochMs =
					earliestSkippedPendingBecomesStaleAtEpochMs === null
						? becomesStaleAtEpochMs
						: Math.min(earliestSkippedPendingBecomesStaleAtEpochMs, becomesStaleAtEpochMs);
				sweptRecords.push(record);
				continue;
			}
			sweptCount += 1;
			sweptRecords.push(
				applyTerminalDeliveryOutcomeToRecord(record, {
					status: "delivery_failed",
					failureReason: "runtime_restarted_before_confirmation",
					nowIso: input.nowIso,
				}),
			);
		}
		if (sweptCount === 0) {
			return { result: { sweptCount: 0, earliestSkippedPendingBecomesStaleAtEpochMs } };
		}
		return {
			records: sweptRecords,
			result: { sweptCount, earliestSkippedPendingBecomesStaleAtEpochMs },
		};
	});
}
