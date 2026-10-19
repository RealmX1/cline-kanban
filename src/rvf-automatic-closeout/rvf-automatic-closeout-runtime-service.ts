import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeTaskChatSendRequest, RuntimeTaskSessionSummary } from "../core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../core/kanban-cli-invocation-environment-actor-claims";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	projectConversationSessionMetadataForMainSessionBinding,
	resolveMainTaskConversationSessionSummary,
} from "../core/task-main-conversation-session-binding";
import { isTaskMainSessionHandoverSuspendingAutomaticActions } from "../core/task-main-session-handover-contract";
import {
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { readAgentRaisedPendingUserDecisions } from "../state/agent-raised-pending-user-decision-store";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../state/queued-task-prompt-delivery-store";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceBoardById,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import type { TaskCardActionPerTaskCommandSerializer } from "../trpc/task-card-action-per-task-command-serializer";
import { captureRvfReviewStartBoundary, computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withCodexAppServerRequestConnection } from "./codex-app-server-request-connection";
import {
	forkCodexConversationBeforeReviewTurn,
	readCodexConversationTurns,
	verifyRestoredCodexConversationPrefix,
} from "./codex-native-conversation-prefix";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import {
	createRvfAutomaticCloseoutCoordinator,
	RvfAutomaticCloseoutPauseError,
	RvfAutomaticCloseoutWaitError,
} from "./rvf-automatic-closeout-coordinator";
import { buildRvfAutomaticCloseoutPrompt } from "./rvf-automatic-closeout-prompt";
import {
	getRvfAutomaticCloseoutStorePath,
	readRvfAutomaticCloseoutRecords,
	updateRvfAutomaticCloseoutRecords,
} from "./rvf-automatic-closeout-store";
import { readRvfCloseoutWorkspaceStateDigest } from "./rvf-closeout-workspace-state-digest";

type RvfAutomaticCloseoutTerminalManager = Pick<
	TerminalSessionManager,
	| "listSummaries"
	| "getSummary"
	| "isTaskSessionAutomaticContinuationSuppressed"
	| "getAwaitingDispatchedBackgroundWork"
	| "resolveTaskTerminalInputBoxOccupancy"
	| "forceStopTaskSession"
	| "applyAgentNativeConversationSessionIdentity"
	| "publishRvfAutomaticCloseoutPaused"
>;
export function createRvfAutomaticCloseoutRuntimeService(deps: {
	taskCardActionPerTaskCommandSerializer?: TaskCardActionPerTaskCommandSerializer;
	getManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<RvfAutomaticCloseoutTerminalManager>;
	runtimeApi: Pick<
		RuntimeTrpcContext["runtimeApi"],
		"startTaskSession" | "enqueueAgentIdleGatedProgrammaticTaskChatMessage" | "cancelTaskChatDelivery"
	>;
	listWorkspaces: () => Promise<RuntimeTrpcWorkspaceScope[]>;
	warn: (message: string) => void;
}) {
	const rvfHome = resolve(process.env.RVF_HOME?.trim() || join(homedir(), ".rvf"));
	const explicitlyStoppedTasks = new Map<string, number>();
	let explicitStopSequence = 0;
	const operations = new Map<string, Promise<unknown>>();
	let timer: NodeJS.Timeout | null = null;
	let sweepInFlight: Promise<void> | null = null;
	let stopping = false;
	function serialize<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
		const pending = (operations.get(workspaceId) ?? Promise.resolve()).catch(() => {}).then(operation);
		operations.set(workspaceId, pending);
		void pending
			.finally(() => {
				if (operations.get(workspaceId) === pending) operations.delete(workspaceId);
			})
			.catch(() => {});
		return pending;
	}
	const serializeMainConversationOperation = <T>(
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		operation: () => Promise<T>,
	): Promise<T> =>
		deps.taskCardActionPerTaskCommandSerializer
			? deps.taskCardActionPerTaskCommandSerializer.runTaskCardActionCommandSeriallyForTaskCards(
					scope.workspaceId,
					[taskId],
					operation,
				)
			: operation();
	async function validateCloseoutPromptDelivery(
		scope: RuntimeTrpcWorkspaceScope,
		input: Pick<RuntimeTaskChatSendRequest, "taskId" | "source" | "idempotencyKey">,
	) {
		if (input.source !== "rvf_automatic_closeout") return;
		const record = (await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId))).find(
			(entry) =>
				(entry.conversationSessionId === input.taskId || entry.taskId === input.taskId) &&
				entry.promptDeliveryIdempotencyKey === input.idempotencyKey,
		);
		// 发送出口与重启后的 dispatcher 都重读持久暂停；内存门覆盖停止状态尚未落盘的窗口。
		if (
			!record ||
			record.status === "paused" ||
			explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`) ||
			explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.conversationSessionId}`)
		)
			throw new RvfAutomaticCloseoutPauseError("用户已停止会话或本轮收尾已暂停，不能继续投递。");
	}
	async function cancelCloseoutPromptDelivery(scope: RuntimeTrpcWorkspaceScope, record: RvfAutomaticCloseoutRecord) {
		try {
			const result = await deps.runtimeApi.cancelTaskChatDelivery(scope, {
				taskId: record.conversationSessionId,
				idempotencyKey: record.promptDeliveryIdempotencyKey,
			});
			if (!result.ok) throw new Error(result.error ?? "取消请求未完成。");
		} catch (error) {
			deps.warn(`自动收尾的排队投递未能取消：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async function mainSummary(scope: RuntimeTrpcWorkspaceScope, taskId: string) {
		const board = await loadWorkspaceBoardById(scope.workspaceId);
		const column = board.columns.find((column) => column.cards.some((card) => card.id === taskId));
		const card = column?.cards.find((card) => card.id === taskId);
		if (!card || column?.id === "trash")
			throw new RvfAutomaticCloseoutPauseError("任务已删除或结案，自动收尾已暂停。");
		const manager = await deps.getManager(scope);
		if (isTaskMainSessionHandoverSuspendingAutomaticActions(card)) throw new RvfAutomaticCloseoutWaitError();
		const boundSummary = resolveMainTaskConversationSessionSummary(
			card,
			Object.fromEntries(manager.listSummaries().map((summary) => [summary.taskId, summary])),
		);
		const summary = boundSummary
			? {
					...boundSummary,
					taskConversationSessionMetadata: projectConversationSessionMetadataForMainSessionBinding(
						card,
						boundSummary,
					),
				}
			: null;
		if (
			!summary ||
			summary.agentId !== "codex" ||
			summary.agentNativeConversationSessionIdentity?.sourceAgentId !== "codex" ||
			!summary.workspacePath
		)
			throw new RvfAutomaticCloseoutPauseError("首版自动收尾需要已确认原生身份的 Codex 主会话。");
		return { manager, summary, card };
	}
	function requireIdle(
		manager: RvfAutomaticCloseoutTerminalManager,
		summary: RuntimeTaskSessionSummary,
		identitySwitchAlreadyStarted = false,
	) {
		if (!identitySwitchAlreadyStarted && manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId))
			throw new RvfAutomaticCloseoutPauseError("会话已停止或被暂停，自动收尾不再续跑。");
		const facets = resolveSessionFacets(summary);
		if (
			!["live", "exited"].includes(facets.liveness) ||
			facets.turnOwner !== "user" ||
			facets.userTurnKind !== "review" ||
			manager.getAwaitingDispatchedBackgroundWork(summary.taskId).parked
		)
			throw new RvfAutomaticCloseoutWaitError();
	}
	async function requireNoPendingUserInput(scope: RuntimeTrpcWorkspaceScope, record: RvfAutomaticCloseoutRecord) {
		const decisions = await readAgentRaisedPendingUserDecisions(scope.workspaceId);
		if (
			decisions.some((decision) => decision.taskId === record.conversationSessionId && decision.status === "pending")
		)
			throw new RvfAutomaticCloseoutWaitError();
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(scope.workspaceId);
		const waiting = (snapshot.entriesByTaskId[record.conversationSessionId] ?? []).filter(
			(entry) =>
				((entry.deliveryState === "queued" && entry.expiresAt > Date.now()) ||
					entry.deliveryState === "handed_to_transport") &&
				entry.programmaticInjectionLedgerReceiptLink?.injectionLedgerIdempotencyKey !==
					record.promptDeliveryIdempotencyKey,
		);
		if (waiting.some((entry) => !entry.programmaticInjectionLedgerReceiptLink))
			throw new RvfAutomaticCloseoutPauseError("存在用户已排队的后续指令，自动收尾已让位。");
		if (waiting.length) throw new RvfAutomaticCloseoutWaitError();
	}

	async function restore(
		scope: RuntimeTrpcWorkspaceScope,
		record: RvfAutomaticCloseoutRecord,
		save: (patch: Partial<RvfAutomaticCloseoutRecord>) => Promise<void>,
	) {
		const { manager, summary, card } = await mainSummary(scope, record.taskId);
		const launchSettings = summary.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings;
		if (
			summary.taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation === "task_collaborator" &&
			!launchSettings
		)
			throw new RvfAutomaticCloseoutPauseError("交接后的主会话缺少原启动权限与模型配置。");
		if (
			summary.taskId !== record.conversationSessionId ||
			resolve(summary.workspacePath ?? "") !== record.receipt.worktree
		)
			throw new RvfAutomaticCloseoutPauseError("主会话绑定或工作目录已经改变。");
		await requireNoPendingUserInput(scope, record);
		const currentId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
		if (currentId !== record.receipt.session_id && currentId !== record.restoredNativeSessionId)
			throw new RvfAutomaticCloseoutPauseError("原生主会话身份已改变。");
		// 已切换身份但尚未投递时可等待恢复启动；不能把 app-server 只创建了 fork 误当成已切换。
		if (currentId === record.restoredNativeSessionId && resolveSessionFacets(summary).liveness === "live") {
			await withCodexAppServerRequestConnection({ workingDirectory: record.receipt.worktree }, (port) =>
				verifyRestoredCodexConversationPrefix(port, currentId, record.preReviewTurnIds),
			);
			return;
		}
		if (currentId === record.receipt.session_id)
			requireIdle(manager, summary, record.nativeIdentitySwitchStartedAt !== null);
		const occupancy = await manager.resolveTaskTerminalInputBoxOccupancy(summary.taskId);
		if (occupancy && (occupancy.hasUncommittedInput || occupancy.screenReadingSaysNonEmpty === null))
			throw new RvfAutomaticCloseoutWaitError();
		const before = await readRvfCloseoutWorkspaceStateDigest(record.receipt.worktree);
		if (record.restoreWorkspaceStateSha256 && record.restoreWorkspaceStateSha256 !== before)
			throw new RvfAutomaticCloseoutPauseError("恢复期间工作区或暂存内容发生变化。");
		await save({ restoreWorkspaceStateSha256: before });
		await withCodexAppServerRequestConnection({ workingDirectory: record.receipt.worktree }, async (port) => {
			const original = await readCodexConversationTurns(port, record.receipt.session_id);
			const boundaryIndex = original.findIndex((turn) => turn.id === record.receipt.native_turn_id);
			if (
				boundaryIndex !== record.preReviewTurnIds.length ||
				original.slice(0, boundaryIndex).some((turn, index) => turn.id !== record.preReviewTurnIds[index])
			)
				throw new RvfAutomaticCloseoutPauseError("原始开审前缀已经改变。");
			const ledger = await readTaskMessageInjectionLedger(
				getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(scope.workspaceId)),
			);
			// 账本保留调用方的寻址 ID：交接后宿主 Task 与当前主会话都可接收 RVF 投递。
			const machineHashes = new Set(
				ledger
					.filter(
						(entry) =>
							(entry.task_id === record.taskId || entry.task_id === record.conversationSessionId) &&
							(entry.source === "review-validate-fix" || entry.source.startsWith("rvf")) &&
							(entry.terminal_delivery_status === "delivered_and_submit_confirmed" ||
								entry.terminal_delivery_status === "delivered_queued_behind_active_agent_turn"),
					)
					.map((entry) => entry.prompt_sha256),
			);
			for (const turn of original.slice(boundaryIndex + 1))
				for (const item of turn.items.filter((item) => item.type === "userMessage")) {
					const text = item.content?.map((part) => part.text ?? "").join("") ?? "";
					if (!machineHashes.has(computeRvfTextSha256(text)) && !text.startsWith("<task-notification>"))
						throw new RvfAutomaticCloseoutPauseError("RVF 开审后出现未登记的用户消息，保留当前会话供人工处理。");
				}
			if (record.restoredNativeSessionId)
				await verifyRestoredCodexConversationPrefix(port, record.restoredNativeSessionId, record.preReviewTurnIds);
			else {
				if (record.nativeForkAttemptStartedAt !== null)
					throw new RvfAutomaticCloseoutPauseError("上次原生 fork 结果未确认，保留现场，不能盲目创建第二个分支。");
				await save({ nativeForkAttemptStartedAt: Date.now() });
				try {
					await forkCodexConversationBeforeReviewTurn(
						port,
						{
							sourceThreadId: record.receipt.session_id,
							boundaryTurnId: record.receipt.native_turn_id,
							lastPreReviewTurnId: record.preReviewTurnIds.at(-1) ?? "",
							workingDirectory: record.receipt.worktree,
						},
						async (identity) => {
							record.restoredNativeSessionId = identity.nativeSessionId;
							record.restoredTranscriptPath = identity.transcriptPath;
							await save({
								restoredNativeSessionId: identity.nativeSessionId,
								restoredTranscriptPath: identity.transcriptPath,
							});
						},
					);
				} catch (error) {
					throw new RvfAutomaticCloseoutPauseError(
						`原生 fork 未确认：${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		});
		if ((await readRvfCloseoutWorkspaceStateDigest(record.receipt.worktree)) !== before)
			throw new RvfAutomaticCloseoutPauseError("原生恢复意外改变工作区或暂存内容，未投递收尾。");
		const latest = manager.getSummary(summary.taskId);
		if (
			!latest ||
			latest.startedAt !== summary.startedAt ||
			latest.agentResponseGenerationTurnSequence !== summary.agentResponseGenerationTurnSequence ||
			latest.agentNativeConversationSessionIdentity?.nativeSessionId !== currentId
		)
			throw new RvfAutomaticCloseoutPauseError("恢复过程中会话被替换。");
		if (currentId === record.receipt.session_id)
			requireIdle(manager, latest, record.nativeIdentitySwitchStartedAt !== null);
		const finalOccupancy = await manager.resolveTaskTerminalInputBoxOccupancy(summary.taskId);
		if (finalOccupancy && (finalOccupancy.hasUncommittedInput || finalOccupancy.screenReadingSaysNonEmpty === null))
			throw new RvfAutomaticCloseoutWaitError();
		await requireNoPendingUserInput(scope, record);
		if (explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`))
			throw new RvfAutomaticCloseoutPauseError("用户已停止会话。");
		await save({ nativeIdentitySwitchStartedAt: record.nativeIdentitySwitchStartedAt ?? Date.now() });
		await manager.forceStopTaskSession(summary.taskId);
		await save({});
		if (explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`))
			throw new RvfAutomaticCloseoutPauseError("用户已停止会话。");
		if (!record.restoredNativeSessionId || !record.restoredTranscriptPath)
			throw new RvfAutomaticCloseoutPauseError("恢复分支没有持久身份。");
		manager.applyAgentNativeConversationSessionIdentity(summary.taskId, {
			sourceAgentId: "codex",
			nativeSessionId: record.restoredNativeSessionId,
			transcriptPath: record.restoredTranscriptPath,
			observedAt: Date.now(),
		});
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(scope.workspaceId, summary.taskId, () =>
			manager.getSummary(summary.taskId),
		);
		await save({});
		const started = await deps.runtimeApi.startTaskSession(scope, {
			taskId: summary.taskId,
			workspaceTaskId: record.taskId,
			taskConversationSessionMetadata: summary.taskConversationSessionMetadata,
			agentId: "codex",
			prompt: "",
			baseRef: card.baseRef,
			worktreeMode: card.worktreeMode,
			taskAgentPermissionMode: launchSettings?.taskAgentPermissionMode ?? card.taskAgentPermissionMode,
			requestedAgentSessionTransport: launchSettings?.sessionTransport,
			terminalAgentModelOverrideSettings: launchSettings
				? launchSettings.terminalAgentModelOverrideSettings
				: card.terminalAgentModelOverrideSettings,
			taskConversationMode: summary.taskConversationMode,
			resumePriorAgentConversationWithoutResendingPrompt: true,
		});
		if (!started.ok) throw new RvfAutomaticCloseoutPauseError(started.error ?? "恢复主会话启动失败。");
	}
	async function enqueue(
		scope: RuntimeTrpcWorkspaceScope,
		record: RvfAutomaticCloseoutRecord,
		assertOperationStillOwned: () => Promise<void>,
	) {
		const deliveryIdentity = {
			taskId: record.conversationSessionId,
			source: "rvf_automatic_closeout",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
		};
		await validateCloseoutPromptDelivery(scope, deliveryIdentity);
		const { summary } = await mainSummary(scope, record.taskId);
		if (
			summary.taskId !== record.conversationSessionId ||
			summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.restoredNativeSessionId
		)
			throw new RvfAutomaticCloseoutPauseError("收尾投递前主会话身份已经改变。");
		if (!record.handoffPath || computeRvfTextSha256(await readFile(record.handoffPath)) !== record.handoffSha256)
			throw new RvfAutomaticCloseoutPauseError("投递前 handoff 内容已改变。");
		await requireNoPendingUserInput(scope, record);
		const text = buildRvfAutomaticCloseoutPrompt(record);
		await validateCloseoutPromptDelivery(scope, deliveryIdentity);
		await assertOperationStillOwned();
		const response = await deps.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage(
			scope,
			{
				taskId: record.conversationSessionId,
				text,
				source: "rvf_automatic_closeout",
				idempotencyKey: record.promptDeliveryIdempotencyKey,
				promptSha256: computeRvfTextSha256(text),
				maxWaitForAgentIdleMs: 60_000,
			},
			{
				decodedCliActorClaimsRequestHeader:
					decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
			},
		);
		try {
			await validateCloseoutPromptDelivery(scope, deliveryIdentity);
		} catch (error) {
			// 停止可能发生在 runtime 入队内部；补撤晚到的持久条目，终端临写门同时阻止它先被投递。
			await cancelCloseoutPromptDelivery(scope, record);
			throw error;
		}
		if (!response.ok) throw new RvfAutomaticCloseoutPauseError(response.error ?? "收尾投递失败。");
		const ledger = await readTaskMessageInjectionLedger(
			getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(scope.workspaceId)),
		);
		const delivery = findTaskMessageInjectionRecord(
			ledger,
			record.conversationSessionId,
			record.promptDeliveryIdempotencyKey,
		);
		if (delivery?.terminal_delivery_status === "delivery_failed")
			throw new RvfAutomaticCloseoutPauseError(`收尾投递失败：${delivery.terminal_delivery_failure_reason}`);
		if (delivery?.terminal_delivery_status !== "delivered_and_submit_confirmed")
			throw new RvfAutomaticCloseoutWaitError();
	}
	async function sweep() {
		for (const scope of await deps.listWorkspaces())
			await serialize(scope.workspaceId, async () => {
				const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
				if (
					!(await readRvfAutomaticCloseoutRecords(storePath)).some(
						(record) => !["completed", "paused", "closeout_prompt_submitted"].includes(record.status),
					)
				)
					return;
				await createRvfAutomaticCloseoutCoordinator({
					storePath,
					inspectCompletion: (record) => inspectRvfCompletionEvidence(record, rvfHome),
					restore: (record, save) =>
						serializeMainConversationOperation(scope, record.taskId, () => restore(scope, record, save)),
					enqueue: (record, assertOperationStillOwned) =>
						serializeMainConversationOperation(scope, record.taskId, () =>
							enqueue(scope, record, assertOperationStillOwned),
						),
					onPaused: async (record) =>
						(await deps.getManager(scope)).publishRvfAutomaticCloseoutPaused(
							record.conversationSessionId,
							record.pauseReason ?? "原因未知",
						),
				}).sweep();
			}).catch((error) =>
				deps.warn(`RVF 自动收尾暂未推进：${error instanceof Error ? error.message : String(error)}`),
			);
	}
	const trigger = () => {
		if (stopping || sweepInFlight) return;
		sweepInFlight = sweep().finally(() => {
			sweepInFlight = null;
		});
		void sweepInFlight.catch((error) => deps.warn(`RVF 自动收尾扫描失败：${String(error)}`));
	};
	return {
		validateCloseoutPromptDelivery,
		pauseForExplicitStop: async (workspaceId: string, taskId: string) => {
			explicitlyStoppedTasks.set(`${workspaceId}:${taskId}`, ++explicitStopSequence);
			let pendingRecords: RvfAutomaticCloseoutRecord[] = [];
			await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(workspaceId), (records) => {
				pendingRecords = records.filter(
					(record) =>
						(record.taskId === taskId || record.conversationSessionId === taskId) &&
						!["completed", "closeout_prompt_submitted"].includes(record.status),
				);
				return {
					records: records.map((record) =>
						pendingRecords.includes(record)
							? {
									...record,
									status: "paused" as const,
									pauseReason: "用户明确停止会话，自动收尾已暂停。",
									updatedAt: Date.now(),
								}
							: record,
					),
					value: null,
				};
			}).catch((error) =>
				deps.warn(`自动收尾的停止状态未能落盘：${error instanceof Error ? error.message : String(error)}`),
			);
			try {
				const scope = (await deps.listWorkspaces()).find((entry) => entry.workspaceId === workspaceId);
				if (scope) for (const record of pendingRecords) await cancelCloseoutPromptDelivery(scope, record);
			} catch (error) {
				deps.warn(`自动收尾的取消未完成：${error instanceof Error ? error.message : String(error)}`);
			}
		},
		capture: async (scope: RuntimeTrpcWorkspaceScope, input: { taskId: string; decisionToken: string }) =>
			serialize(scope.workspaceId, () =>
				serializeMainConversationOperation(scope, input.taskId, async () => {
					const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
					const existing = (await readRvfAutomaticCloseoutRecords(storePath)).find(
						(record) => record.taskId === input.taskId && record.receipt.decision_token === input.decisionToken,
					);
					if (existing) return { receipt: existing.receipt };
					const stopKey = `${scope.workspaceId}:${input.taskId}`;
					const stopSequenceBeforeCapture = explicitlyStoppedTasks.get(stopKey);
					const { manager, summary } = await mainSummary(scope, input.taskId);
					const identity = summary.agentNativeConversationSessionIdentity;
					const transcriptPath = identity?.transcriptPath;
					if (!identity || !transcriptPath) throw new Error("主会话缺少原生 transcript。");
					const captured = await withCodexAppServerRequestConnection(
						{ workingDirectory: summary.workspacePath ?? "" },
						(port) =>
							captureRvfReviewStartBoundary({
								taskId: input.taskId,
								decisionToken: input.decisionToken,
								nativeSessionId: identity.nativeSessionId,
								transcriptPath,
								workingDirectory: summary.workspacePath ?? "",
								rvfHome,
								port,
							}),
					);
					if (
						explicitlyStoppedTasks.get(stopKey) !== stopSequenceBeforeCapture ||
						manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId)
					)
						throw new RvfAutomaticCloseoutPauseError("捕获分界期间用户已停止会话。");
					explicitlyStoppedTasks.delete(stopKey);
					const record: RvfAutomaticCloseoutRecord = {
						workspaceId: scope.workspaceId,
						taskId: input.taskId,
						conversationSessionId: summary.taskId,
						...captured,
						status: "awaiting_rvf_completion",
						createdAt: Date.now(),
						updatedAt: Date.now(),
						runId: null,
						runDirectory: null,
						handoffPath: null,
						handoffSha256: null,
						restoredNativeSessionId: null,
						restoredTranscriptPath: null,
						restoreWorkspaceStateSha256: null,
						nativeIdentitySwitchStartedAt: null,
						nativeForkAttemptStartedAt: null,
						pauseReason: null,
						promptDeliveryIdempotencyKey: `rvf-automatic-closeout-${input.decisionToken}`,
					};
					await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
						records: [...records, record],
						value: null,
					}));
					return { receipt: captured.receipt };
				}),
			),
		status: async (scope: RuntimeTrpcWorkspaceScope, input: { taskId: string }) => ({
			records: (await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId))).filter(
				(record) => record.taskId === input.taskId,
			),
		}),
		sweepPendingCloseoutsOnce: sweep,
		start: () => {
			stopping = false;
			timer = setInterval(trigger, 2_000);
			timer.unref();
			trigger();
		},
		stop: async () => {
			stopping = true;
			if (timer) clearInterval(timer);
			timer = null;
			await sweepInFlight;
		},
	};
}
