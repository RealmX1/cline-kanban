// `kanban task message --deliver-when-agent-idle` 在 runtime 侧的两个入口：程序化入队、以及排队期间的取消。
//
// 跨仓契约：~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md
// § agent 空闲门控的排队投递。语义总览：.plan/docs/queued-task-prompt-delivery-semantics.md 的程序化一节。
//
// ## 为什么账本记录由 runtime 建，而不是像立即投递那样由 CLI 建
//
// 立即投递里 CLI 建记录、紧接着调 runtime 投递；CLI 在两步之间死掉，那条 pending 至多挂一个终端投递预算，
// 之后由启动清扫收敛。排队投递的 pending 可以合法地挂到调用方给的截止时刻（几十分钟乃至几小时），CLI 若在
// 「建记录」与「入队」之间死掉，留下的 pending 没有队列条目、也就没有任何人会在截止时刻收敛它。所以两步放在
// runtime 的同一次调用里：入队失败当场把记录落成失败，不留悬空的 pending。runtime 自己在两步之间崩溃留下的
// 那条，由账本的持续清扫在「截止 + 终端投递最坏预算」之后判失败（src/server/pending-task-message-injection-startup-sweep.ts），
// **不**靠同 key 重发补排（理由见下面 already_existed 分支）。

import type {
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
	RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse,
	RuntimeTaskSessionSummary,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../core/api-contract";
import { buildQueuedProgrammaticInjectionQueueEntryId } from "../core/queued-programmatic-injection-ledger-receipt-mirroring";
import { QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS } from "../core/queued-task-prompt-delivery-dispatch-eligibility";
import { resolveTaskChatMessageTargetConversationSessionSummary } from "../core/task-main-conversation-session-binding";
import {
	createPendingTaskMessageInjectionRecord,
	doesTaskMessageInjectionRecordMatchRequestedConversationSession,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { enqueueAgentIdleGatedProgrammaticInjectionIntoQueue } from "../state/enqueue-agent-idle-gated-programmatic-injection-into-prompt-delivery-queue";
import {
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath, loadPersistedWorkspaceStateById } from "../state/workspace-state";

// 调用方最多能要求等多久。与人排条目的保质期同一个数：队列里任何条目都不该活过它（终态保留、裁剪、
// 投影都按这个量级设计）。契约里写的是 86 400 000。
export const MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS = QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS;

export interface AgentIdleGatedProgrammaticTaskChatMessageQueueDependencies {
	// 队列改动后通知出队引擎（刷新缓存与投影、对准截止定时器、立刻尝试一次——agent 已经闲着就当场交出）。
	notifyQueueMutated?: (
		workspaceId: string,
		taskId: string,
		snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
	) => Promise<void>;
	now?: () => number;
	getTaskSessionSummary?: (taskId: string) => RuntimeTaskSessionSummary | null;
}

function buildInjectionLedgerPathForWorkspace(workspaceId: string): string {
	return getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceId));
}

type InjectionLedgerPreflightOutcome =
	| "idempotency_conflict"
	| "already_existed"
	| "created"
	| "target_session_mismatch"
	| "native_requirement_mismatch";

export async function enqueueAgentIdleGatedProgrammaticTaskChatMessage(
	deps: AgentIdleGatedProgrammaticTaskChatMessageQueueDependencies,
	workspaceId: string,
	request: RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueRequest,
): Promise<RuntimeAgentIdleGatedProgrammaticTaskChatMessageEnqueueResponse> {
	const taskId = request.taskId.trim();
	const source = request.source.trim();
	const idempotencyKey = request.idempotencyKey.trim();
	if (!taskId || !source || !idempotencyKey) {
		return { ok: false, error: "taskId, source and idempotencyKey are required." };
	}
	if (request.text.trim().length === 0) {
		return { ok: false, error: "task message prompt cannot be empty." };
	}
	if (request.maxWaitForAgentIdleMs > MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS) {
		return {
			ok: false,
			error: `maxWaitForAgentIdleMs must not exceed ${MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS} (24 hours).`,
		};
	}
	const { board, sessions } = await loadPersistedWorkspaceStateById(workspaceId);
	const cards = board.columns.flatMap((column) => column.cards);
	const addressedConversationSession = deps.getTaskSessionSummary?.(taskId) ?? sessions[taskId];
	// 内部自动收尾沿用会话 ID 寻址；先核实真实宿主卡片，再保留调用方原有的账本键。
	const card =
		cards.find((candidate) => candidate.id === taskId) ??
		cards.find(
			(candidate) =>
				addressedConversationSession?.taskId === taskId &&
				candidate.id === addressedConversationSession.taskConversationSessionMetadata?.workspaceTaskId,
		);
	const requestedConversationSessionId = request.attemptId?.trim() || undefined;
	const destinationSummary = card
		? resolveTaskChatMessageTargetConversationSessionSummary(
				card,
				sessions,
				requestedConversationSessionId ?? (card.id !== taskId ? taskId : undefined),
				deps.getTaskSessionSummary,
			)
		: null;
	const destinationSessionId = destinationSummary?.taskId;
	const requiredSessionId = request.requiredNativeIndependentUserTurnSessionId;
	const requiredSummary =
		requiredSessionId && destinationSessionId ? deps.getTaskSessionSummary?.(destinationSessionId) : null;
	const requiredSessionIncarnationId = requiredSummary?.runtimeSessionIncarnationId;
	const nativeRequirement = requiredSessionId
		? {
				requiredNativeIndependentUserTurnSessionId: requiredSessionId,
				requiredNativeIndependentUserTurnSessionIncarnationId: requiredSessionIncarnationId ?? undefined,
			}
		: {};
	const nowEpochMs = (deps.now ?? (() => Date.now()))();
	const ledgerPath = buildInjectionLedgerPathForWorkspace(workspaceId);
	const queueEntryId = buildQueuedProgrammaticInjectionQueueEntryId(idempotencyKey);
	const agentIdleWaitDeadlineAtEpochMs = nowEpochMs + request.maxWaitForAgentIdleMs;

	// 第一段（账本锁内）：幂等判定，与 `kanban task message` 同一套规则——同 key 同正文返回当前记录、不重排；
	// 同 key 不同正文是冲突。截止时刻在**首次**建记录时定下，重发不续命。
	const preflight = await withTaskMessageInjectionLedgerLock<InjectionLedgerPreflightOutcome>(
		ledgerPath,
		async (records) => {
			const existing = findTaskMessageInjectionRecord(records, taskId, idempotencyKey);
			if (existing) {
				return {
					result:
						existing.prompt_sha256 === request.promptSha256 &&
						doesTaskMessageInjectionRecordMatchRequestedConversationSession(
							existing,
							requestedConversationSessionId,
						) &&
						existing.required_native_independent_user_turn_session_id === requiredSessionId
							? "already_existed"
							: "idempotency_conflict",
				};
			}
			if (!destinationSessionId) return { result: "target_session_mismatch" };
			if (
				requiredSessionId &&
				(!requiredSessionIncarnationId ||
					requiredSummary?.taskId !== destinationSessionId ||
					requiredSummary?.agentId !== "codex" ||
					requiredSummary.agentNativeConversationSessionIdentity?.nativeSessionId !== requiredSessionId)
			)
				return { result: "native_requirement_mismatch" };
			const nowIso = new Date(nowEpochMs).toISOString();
			const created = createPendingTaskMessageInjectionRecord({
				taskId,
				attemptId: destinationSessionId,
				source,
				idempotencyKey,
				promptSha256: request.promptSha256,
				nowIso,
				agentIdleGate: {
					waitDeadlineAtIso: new Date(agentIdleWaitDeadlineAtEpochMs).toISOString(),
					queueEntryId,
					...nativeRequirement,
				},
			});
			return { records: [...records, created], result: "created" };
		},
	);
	if (preflight === "target_session_mismatch") return { ok: false, error: "目标会话不存在或不属于该任务。" };
	if (preflight === "native_requirement_mismatch")
		return { ok: false, error: "独立原生回合要求与当前 Codex 会话身份不符。" };
	if (preflight === "idempotency_conflict") {
		return {
			ok: false,
			idempotencyConflict: true,
			error: `Idempotency conflict for task "${taskId}" and key "${idempotencyKey}": prompt hash, target conversation session or required native session differs.`,
		};
	}
	// 同 key 重发（记录早已存在）：幂等的定义就是「什么都不做，返回当前记录」——无论它已落定、是一条立即投递，
	// 还是仍 pending 的门控记录。
	//
	// 仍 pending 的门控记录也**绝不**重新入队，哪怕队列里已经找不到它的条目。条目不见了有两种成因，这里分不清：
	//   ① 上一次调用在「建记录」与「入队」之间 runtime 崩溃，一个字节都没送出；
	//   ② 条目早已落定（甚至已送达），只是落定镜像写账本失败，而终态条目随后被 Dismiss / per-task 上限 /
	//      保留期裁掉，兜底对账没了证据。
	// 按「不在就补排」处理，② 会把已经送达的同一段话再送一遍。两种都交给账本的持续清扫在「截止 + 终端投递最坏
	// 预算」之后落 runtime_restarted_before_confirmation（src/server/pending-task-message-injection-startup-sweep.ts）——
	// 那是「没确认送达」、不承诺「确定没送达」的一格，重不重排由调用方换新 key 决定。宁可晚一点给出这个结论，
	// 也不替调用方冒重复投递的险。
	if (preflight === "already_existed") {
		return { ok: true, injectionLedgerRecordDisposition: preflight };
	}
	if (!destinationSessionId) return { ok: false, error: "目标会话不存在或不属于该任务。" };

	// 第二段（账本锁外）：入队。只有本次调用新建了记录才走到这里，截止时刻就是刚写进记录的那个。
	let queueSnapshotAfterDurableEnqueue: WorkspaceQueuedTaskPromptDeliverySnapshot;
	try {
		const { snapshot, outcome } = await enqueueAgentIdleGatedProgrammaticInjectionIntoQueue({
			workspaceId,
			enqueue: {
				taskId: destinationSessionId,
				workspaceTaskId: card?.id ?? taskId,
				injectionLedgerTaskId: taskId,
				queueEntryId,
				text: request.text,
				injectionLedgerIdempotencyKey: idempotencyKey,
				injectionSource: source,
				agentIdleWaitDeadlineAtEpochMs,
				...nativeRequirement,
			},
			nowEpochMs,
		});
		if (outcome === "refused_queue_capacity_exhausted") {
			await recordTaskMessageTerminalDeliveryOutcome({
				ledgerPath,
				taskId,
				idempotencyKey,
				status: "delivery_failed",
				failureReason: "agent_idle_gated_delivery_queue_capacity_exhausted",
				nowIso: new Date(nowEpochMs).toISOString(),
			});
		}
		queueSnapshotAfterDurableEnqueue = snapshot;
	} catch (error) {
		// 队列写不进去（磁盘 / 权限）：账本那条 pending 再也不会有人收敛，当场落失败。原因沿用 CLI 在
		// 「runtime 本身够不到」时的同一个选择（no_active_terminal_session）：都是基础设施这一侧失败、一个字节都
		// 没进 agent，处置也相同——等会话（这里是 runtime 的存储）恢复再说。
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId,
			idempotencyKey,
			status: "delivery_failed",
			failureReason: "no_active_terminal_session",
			nowIso: new Date(nowEpochMs).toISOString(),
		}).catch(() => undefined);
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	// 通知出队引擎放在上面的 try 之外：走到这里队列条目已经 durable，通知失败（刷新缓存 / 广播投影抛错）
	// 不代表没排上——停止边沿与 60s 兜底 sweep 都会从队列文件把它捡起来照常投递。若在这里把账本落成失败、
	// 回 ok:false，调用方会换 key 重投（同一段话送两遍），而真实投递结果回写账本只会拿到 already_settled，
	// 账本那条「确定没送达」再也纠正不了。所以通知失败只吞掉，账本保持 pending、返回值保持 ok:true。
	try {
		await deps.notifyQueueMutated?.(workspaceId, destinationSessionId, queueSnapshotAfterDurableEnqueue);
	} catch {
		// 有意吞掉，理由见上。
	}
	return { ok: true, injectionLedgerRecordDisposition: preflight };
}

// `message-cancel` 打到一条**还在等 agent 空闲**的程序化条目上：它还没交给终端投递，PTY 单飞槽里根本没有它，
// session-manager 的取消只会回 no_pending_delivery——CLI 随后等不到账本收敛，就会报一个「已取消」而条目其实
// 还排着、稍后照发。所以先在队列里把它撤下；撤下即由 store 把 cancelled_before_delivery 镜像进账本。
//
// 返回 null = 它不是一条还在等空闲的程序化条目（不存在 / 已交给终端投递 / 已落定），调用方照旧走 PTY 取消。
export async function cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(
	deps: AgentIdleGatedProgrammaticTaskChatMessageQueueDependencies,
	workspaceId: string,
	taskId: string,
	idempotencyKey: string,
): Promise<"cancelled_before_delivery" | null> {
	const findEntry = (snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) =>
		Object.values(snapshot.entriesByTaskId)
			.flat()
			.find(
				(entry) =>
					(entry.programmaticInjectionLedgerReceiptLink?.injectionLedgerTaskId ?? entry.taskId) === taskId &&
					entry.programmaticInjectionLedgerReceiptLink?.injectionLedgerIdempotencyKey === idempotencyKey,
			) ?? null;
	const before = findEntry(await readWorkspaceQueuedTaskPromptDeliverySnapshot(workspaceId));
	if (before === null || (before.deliveryState !== "queued" && before.deliveryState !== "claimed_for_dispatch")) {
		return null;
	}
	const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(
		workspaceId,
		{ kind: "cancel_queued_prompt_delivery", taskId: before.taskId, queueEntryId: before.queueEntryId },
		(deps.now ?? (() => Date.now()))(),
	);
	await deps.notifyQueueMutated?.(workspaceId, before.taskId, snapshot);
	// 读与撤之间它可能刚被交给终端投递（store 的取消只动 queued / claimed）——那就不是我们撤下的，交给 PTY 取消。
	return findEntry(snapshot)?.deliveryState === "cancelled" ? "cancelled_before_delivery" : null;
}
