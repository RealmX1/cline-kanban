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
//
// ## 两种记录：立即投递 与 agent 空闲门控的排队投递
//
// 不带 --deliver-when-agent-idle 的记录由 CLI 建、立刻交给终端投递，pending 至多活一个终端投递最坏预算。
// 带它的记录（agent_idle_wait_deadline_at 非空）由 runtime 建，先进 prompt queue 等 agent 空闲，pending 可以
// 合法地活到调用方给的截止时刻——所以「唯一非终态必然有界收敛」对它的上界是**截止时刻 + 终端投递最坏预算**，
// 启动清扫的「超期」判据据此放宽（见 resolvePendingRecordBecomesStaleAtEpochMs）。两种记录同一把锁、同一套
// 写一次即定，只差这一个上界。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type FileLockRequest, lockedFileSystem } from "../fs/locked-file-system";
import type { CodexNativePromptDeliveryEvidence } from "./api-contract";
import {
	CODEX_RVF_CLOSEOUT_CONFIRMATION_SWEEP_MARGIN_MS,
	type CodexRvfCloseoutCompactionAwareConfirmation,
	codexRvfCloseoutCompactionAwareConfirmationSchema,
	resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs,
} from "./codex-rvf-closeout-compaction-aware-confirmation";

export const TASK_MESSAGE_INJECTION_LEDGER_FILENAME = "task-message-injections.json";

// 四种语义不可合并。特别是 accepted_pending_submit_confirmation **不表示成功**——把它当成功
// 正是 2026-08-08 那 49 分钟事故的成因。
export const TASK_MESSAGE_TERMINAL_DELIVERY_STATUSES = [
	// 文本经 PTY 或原生通道提交，且已确认实际用户消息（agent 已收到并开始处理）。
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
	// 原生请求可能已被接受；不得自动重发或退回 PTY。
	"codex_native_prompt_delivery_unconfirmed",
	"human_terminal_contention_timeout",
	// 输入框被占着、而**人不在场**：机器判定框里有未提交内容，却又拿不下来（读屏读不出正文无从暂存 /
	// 写库失败 / 清框时会话已换代）。与 human_terminal_contention_timeout 的关键差别是「人在不在」——
	// 那一条的语义是「人正在这个终端上干活，这一轮本就不该投」，故建议不重投；这一条没有任何人在等，
	// 纯粹是机器这侧的状态拿不下来，故**可以择机换新 idempotency key 重投**。
	// 两者曾被合并成前者上报，结果是回执自相矛盾（reason 说人在场、同一行日志写着 humanPresent=false）
	// 并把调用方劝退——2026-08-20 RVF 决策点横幅静默消失即此。
	"terminal_input_box_contended_but_unstashable",
	"agent_awaiting_user_decision_timeout",
	"superseded_by_later_delivery",
	"session_ended_before_delivery",
	"cancelled_before_delivery",
	"runtime_restarted_before_confirmation",
	// ↓ 以下两个由 **agent 空闲门**（prompt queue 层）判出，终端投递永远不会产生它们。两者都意味着「确定没送达、
	// 没有任何残留」：条目从未交给终端投递。名字以 agent_ 开头，与终端门（开发者输入争用）那一侧的原因区分开。
	// 到调用方给的等待上限为止 agent 一直没空闲（在生成 / park 等后台 / 等模态决定 / 会话不在 / 恢复中 / 单飞槽被占）。
	"agent_never_became_idle_before_queued_delivery_deadline",
	// 入队即被拒：该 task 或整个 workspace 的非终态排队条目已达上限。
	"agent_idle_gated_delivery_queue_capacity_exhausted",
	"native_independent_user_turn_capability_unavailable",
	"native_independent_user_turn_session_replaced",
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
	nativeCompactionAwareConfirmation?: CodexRvfCloseoutCompactionAwareConfirmation;
	task_id: string;
	// 新请求总是记录受理时解析的真实目标会话；旧记录缺省时保持原样，不推断历史主会话。
	attempt_id?: string;
	source: string;
	idempotency_key: string;
	prompt_sha256: string;
	message_id: string;
	turn_id?: string;
	checkpoint_id?: string;
	codex_native_prompt_delivery_evidence?: CodexNativePromptDeliveryEvidence;
	// 遗留镜像，由 terminal_delivery_status 派生，不作判据。
	status?: string;
	terminal_delivery_status: TaskMessageTerminalDeliveryStatus;
	terminal_delivery_failure_reason?: TaskMessageTerminalDeliveryFailureReason;
	terminal_delivery_failure_detail?: string;
	terminal_delivery_status_updated_at: string;
	created_at: string;
	// ↓ 仅 agent 空闲门控的排队投递（--deliver-when-agent-idle）才有。
	// 最多等到这一刻（ISO8601 UTC）。之前一直没交给终端投递就落 agent_never_became_idle_before_queued_delivery_deadline。
	agent_idle_wait_deadline_at?: string;
	// 通过 agent 空闲门、交给终端投递的时刻。pending 且它缺席 ⇒ 卡在 agent 空闲门；pending 且它在 ⇒ 卡在终端门。
	agent_idle_gate_passed_at?: string;
	// prompt queue 里对应条目的 id（诊断用：账本 ↔ 队列文件对照）。
	agent_idle_gated_queue_entry_id?: string;
	required_native_independent_user_turn_session_id?: string;
	required_native_independent_user_turn_session_incarnation_id?: string;
}

export function isTaskMessageInjectionRecordGatedUntilAgentIdle(record: TaskMessageInjectionRecord): boolean {
	return record.agent_idle_wait_deadline_at !== undefined;
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
		...(isCodexNativePromptDeliveryEvidence(record.codex_native_prompt_delivery_evidence)
			? { codex_native_prompt_delivery_evidence: record.codex_native_prompt_delivery_evidence }
			: {}),
		status: legacyStatus ?? LEGACY_STATUS_MIRROR[terminalStatus],
		terminal_delivery_status: terminalStatus,
		...(failureReason ? { terminal_delivery_failure_reason: failureReason } : {}),
		...(typeof record.terminal_delivery_failure_detail === "string"
			? { terminal_delivery_failure_detail: record.terminal_delivery_failure_detail }
			: {}),
		terminal_delivery_status_updated_at: updatedAt,
		created_at: String(record.created_at),
		...(codexRvfCloseoutCompactionAwareConfirmationSchema.safeParse(record.nativeCompactionAwareConfirmation).success
			? {
					nativeCompactionAwareConfirmation: codexRvfCloseoutCompactionAwareConfirmationSchema.parse(
						record.nativeCompactionAwareConfirmation,
					),
				}
			: {}),
		...(typeof record.required_native_independent_user_turn_session_id === "string"
			? { required_native_independent_user_turn_session_id: record.required_native_independent_user_turn_session_id }
			: {}),
		...(typeof record.required_native_independent_user_turn_session_incarnation_id === "string"
			? {
					required_native_independent_user_turn_session_incarnation_id:
						record.required_native_independent_user_turn_session_incarnation_id,
				}
			: {}),
		...(typeof record.agent_idle_wait_deadline_at === "string"
			? { agent_idle_wait_deadline_at: record.agent_idle_wait_deadline_at }
			: {}),
		...(typeof record.agent_idle_gate_passed_at === "string"
			? { agent_idle_gate_passed_at: record.agent_idle_gate_passed_at }
			: {}),
		...(typeof record.agent_idle_gated_queue_entry_id === "string"
			? { agent_idle_gated_queue_entry_id: record.agent_idle_gated_queue_entry_id }
			: {}),
	};
}

function isCodexNativePromptDeliveryEvidence(value: unknown): value is CodexNativePromptDeliveryEvidence {
	if (typeof value !== "object" || value === null) return false;
	return ["clientUserMessageId", "nativeSessionId", "nativeTurnId", "nativeUserMessageId"].every(
		(field) => field in value && typeof Reflect.get(value, field) === "string",
	);
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
	lockAcquisitionRetries?: FileLockRequest["retries"],
): Promise<T> {
	return await lockedFileSystem.withLock(
		{ path: ledgerPath, type: "file", retries: lockAcquisitionRetries },
		async () => {
			const records = await readTaskMessageInjectionLedger(ledgerPath);
			const outcome = await operation(records);
			if (outcome.records) {
				await writeTaskMessageInjectionLedger(ledgerPath, outcome.records);
			}
			return outcome.result;
		},
	);
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

// 省略目标的重试沿用首次绑定，不按当前主会话重算。旧记录仅兼容其原有 task/attempt ID，绝不借重试补投。
export function doesTaskMessageInjectionRecordMatchRequestedConversationSession(
	record: TaskMessageInjectionRecord,
	requestedTaskConversationSessionId: string | undefined,
): boolean {
	return (
		requestedTaskConversationSessionId === undefined ||
		requestedTaskConversationSessionId === (record.attempt_id ?? record.task_id)
	);
}

export function createPendingTaskMessageInjectionRecord(input: {
	taskId: string;
	attemptId?: string;
	source: string;
	idempotencyKey: string;
	promptSha256: string;
	nowIso: string;
	// 仅 agent 空闲门控的排队投递传。
	agentIdleGate?: {
		waitDeadlineAtIso: string;
		queueEntryId: string;
		requiredNativeIndependentUserTurnSessionId?: string;
		requiredNativeIndependentUserTurnSessionIncarnationId?: string;
	};
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
		...(input.agentIdleGate
			? {
					agent_idle_wait_deadline_at: input.agentIdleGate.waitDeadlineAtIso,
					agent_idle_gated_queue_entry_id: input.agentIdleGate.queueEntryId,
					...(input.agentIdleGate.requiredNativeIndependentUserTurnSessionId
						? {
								required_native_independent_user_turn_session_id:
									input.agentIdleGate.requiredNativeIndependentUserTurnSessionId,
								required_native_independent_user_turn_session_incarnation_id:
									input.agentIdleGate.requiredNativeIndependentUserTurnSessionIncarnationId,
							}
						: {}),
				}
			: {}),
	};
}

export function applyTerminalDeliveryOutcomeToRecord(
	record: TaskMessageInjectionRecord,
	outcome: {
		status: TaskMessageTerminalDeliveryStatus;
		failureReason?: TaskMessageTerminalDeliveryFailureReason;
		failureDetail?: string;
		nowIso: string;
		turnId?: string;
		checkpointId?: string;
		codexNativePromptDeliveryEvidence?: CodexNativePromptDeliveryEvidence;
	},
): TaskMessageInjectionRecord {
	const {
		terminal_delivery_failure_reason: _discardedPreviousReason,
		terminal_delivery_failure_detail: _discardedPreviousDetail,
		...rest
	} = record;
	return {
		...rest,
		...(outcome.turnId ? { turn_id: outcome.turnId } : {}),
		...(outcome.checkpointId ? { checkpoint_id: outcome.checkpointId } : {}),
		...(outcome.codexNativePromptDeliveryEvidence
			? { codex_native_prompt_delivery_evidence: outcome.codexNativePromptDeliveryEvidence }
			: {}),
		status: LEGACY_STATUS_MIRROR[outcome.status],
		terminal_delivery_status: outcome.status,
		...(outcome.failureReason ? { terminal_delivery_failure_reason: outcome.failureReason } : {}),
		...(outcome.failureDetail ? { terminal_delivery_failure_detail: outcome.failureDetail } : {}),
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
	failureDetail?: string;
	turnId?: string;
	checkpointId?: string;
	codexNativePromptDeliveryEvidence?: CodexNativePromptDeliveryEvidence;
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
				...(input.failureDetail ? { failureDetail: input.failureDetail } : {}),
				...(input.turnId ? { turnId: input.turnId } : {}),
				...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
				...(input.codexNativePromptDeliveryEvidence
					? { codexNativePromptDeliveryEvidence: input.codexNativePromptDeliveryEvidence }
					: {}),
				nowIso: input.nowIso,
			});
			return {
				records: records.map((record) => (record === existing ? nextRecord : record)),
				result: { outcome: "settled", record: nextRecord },
			};
		},
	);
}

// 排队投递通过 agent 空闲门、交给终端投递的那一刻，在账本上记一笔。只改仍 pending 的门控记录、只写一次
// （重复调用保留第一次的时刻）；不动 terminal_delivery_status_updated_at——那个字段的含义是「状态何时变的」，
// 而状态没变，仍是 pending。
export async function recordTaskMessageInjectionAgentIdleGatePassed(input: {
	ledgerPath: string;
	taskId: string;
	idempotencyKey: string;
	nowIso: string;
}): Promise<void> {
	await withTaskMessageInjectionLedgerLock<null>(input.ledgerPath, async (records) => {
		const existing = findTaskMessageInjectionRecord(records, input.taskId, input.idempotencyKey);
		if (
			!existing ||
			!isTaskMessageInjectionRecordGatedUntilAgentIdle(existing) ||
			existing.agent_idle_gate_passed_at !== undefined ||
			isTaskMessageTerminalDeliveryStatusSettled(existing.terminal_delivery_status)
		) {
			return { result: null };
		}
		const annotated: TaskMessageInjectionRecord = { ...existing, agent_idle_gate_passed_at: input.nowIso };
		return { records: records.map((record) => (record === existing ? annotated : record)), result: null };
	});
}

export interface StalePendingTaskMessageInjectionSweepResult {
	sweptCount: number;
	// 本轮因「还没超期」被放过的 pending 里，最早会超期的那条的绝对时刻（epoch ms）；没放过任何一条时为 null。
	// 调用方必须据此排一次延迟复扫：本轮放过的那些记录，其属主进程也可能早就死了，
	// 没有复扫它们就要一直躺到下一次 runtime 启动——那正是本轮改动要根除的「永远 pending」。
	earliestSkippedPendingBecomesStaleAtEpochMs: number | null;
}

// 先把有界截止写入与清扫器共用的账本，再允许内存延长等待；终态与旧 revision 均不可覆盖。
export async function persistTaskMessageNativeCompactionAwareConfirmation(input: {
	ledgerPath: string;
	ledgerTaskId: string;
	snapshot: CodexRvfCloseoutCompactionAwareConfirmation;
	expectedRevision: number | null;
}): Promise<boolean> {
	const snapshot = codexRvfCloseoutCompactionAwareConfirmationSchema.parse(input.snapshot);
	return withTaskMessageInjectionLedgerLock(
		input.ledgerPath,
		async (records) => {
			const record = findTaskMessageInjectionRecord(records, input.ledgerTaskId, snapshot.binding.idempotencyKey);
			if (
				!record ||
				record.terminal_delivery_status !== "accepted_pending_submit_confirmation" ||
				record.source !== "rvf_automatic_closeout" ||
				record.prompt_sha256 !== snapshot.binding.promptSha256 ||
				(record.attempt_id !== undefined && record.attempt_id !== snapshot.binding.conversationSessionId)
			)
				return { result: false };
			const previous = record.nativeCompactionAwareConfirmation;
			if (previous && JSON.stringify(previous) === JSON.stringify(snapshot)) return { result: true };
			if (
				(previous?.revision ?? null) !== input.expectedRevision ||
				snapshot.revision !== (previous ? previous.revision + 1 : 0) ||
				(previous &&
					(JSON.stringify(previous.binding) !== JSON.stringify(snapshot.binding) ||
						previous.firstSubmissionAtEpochMs !== snapshot.firstSubmissionAtEpochMs ||
						previous.absoluteConfirmationDeadlineAtEpochMs !== snapshot.absoluteConfirmationDeadlineAtEpochMs ||
						previous.clientUserMessageId !== snapshot.clientUserMessageId ||
						previous.submissionTransport !== snapshot.submissionTransport ||
						previous.predecessorNativeTurnId !== snapshot.predecessorNativeTurnId ||
						(previous.nativeTurnIdReturnedBySubmissionRequest !== undefined &&
							previous.nativeTurnIdReturnedBySubmissionRequest !==
								snapshot.nativeTurnIdReturnedBySubmissionRequest) ||
						previous.accumulatedCompactionWaitMs > snapshot.accumulatedCompactionWaitMs ||
						previous.ordinaryConfirmationBudgetRemainingMs < snapshot.ordinaryConfirmationBudgetRemainingMs ||
						previous.phaseStartedAtEpochMs > snapshot.phaseStartedAtEpochMs))
			)
				return { result: false };
			const updated = { ...record, nativeCompactionAwareConfirmation: snapshot };
			return { records: records.map((entry) => (entry === record ? updated : entry)), result: true };
		},
		{ retries: 3, factor: 1, minTimeout: 25, maxTimeout: 25 },
	);
}

// 账本时间戳读不出来（手改坏 / 更旧的格式）时返回 null，调用方按「已超期」处理：
// 判失败是安全的那一侧，留着才会变成永远没人收敛的 pending。
//
// agent 空闲门控的记录从 max(状态时间戳, 等待截止时刻) 起算：它在截止之前合法地挂着 pending，不是被撂下的。
// 不放宽的话，并存的第二个 runtime 实例一启动，就会把常驻实例上还在合法排队的记录写成
// runtime_restarted_before_confirmation——终态写一次即定，那是不可纠正的假失败。
// 截止时刻读不出来时退回只看状态时间戳（偏向判失败，理由同上）。
export function resolvePendingRecordBecomesStaleAtEpochMs(
	record: TaskMessageInjectionRecord,
	stalePendingThresholdMs: number,
): number | null {
	if (record.nativeCompactionAwareConfirmation) {
		return (
			resolveCodexRvfCloseoutConfirmationDeadlineAtEpochMs(record.nativeCompactionAwareConfirmation) +
			CODEX_RVF_CLOSEOUT_CONFIRMATION_SWEEP_MARGIN_MS
		);
	}
	const statusUpdatedAtMs = Date.parse(record.terminal_delivery_status_updated_at);
	if (Number.isNaN(statusUpdatedAtMs)) {
		return null;
	}
	const agentIdleWaitDeadlineAtMs =
		record.agent_idle_wait_deadline_at === undefined ? Number.NaN : Date.parse(record.agent_idle_wait_deadline_at);
	const pendingLegitimatelyUntilEpochMs = Number.isNaN(agentIdleWaitDeadlineAtMs)
		? statusUpdatedAtMs
		: Math.max(statusUpdatedAtMs, agentIdleWaitDeadlineAtMs);
	return pendingLegitimatelyUntilEpochMs + stalePendingThresholdMs;
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
