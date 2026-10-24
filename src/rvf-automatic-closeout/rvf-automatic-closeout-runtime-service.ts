import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { resolveRecordedCodexConversationHome } from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskChatSendRequest, RuntimeTaskSessionSummary } from "../core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../core/kanban-cli-invocation-environment-actor-claims";
import {
	type RvfAutomaticCloseoutRecord,
	rvfAutomaticCloseoutExecutionResultReportRequestSchema,
	rvfIndependentUserTurnBoundaryReceiptSchema,
	type rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema,
} from "../core/rvf-automatic-closeout-contract";
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
import { createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder } from "../diagnostics/rvf-review-start-boundary-native-query-diagnostic-recorder";
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
import {
	type AutomaticLateNativePromptAcceptanceRecoveryTrigger,
	createAutomaticLateNativeCloseoutPromptAcceptanceRecovery,
	isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery,
} from "./automatic-late-native-closeout-prompt-acceptance-recovery";
import { captureRvfReviewStartBoundary, computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import {
	withCodexAppServerRequestConnection,
	withRunningCodexAppServerControlSocketConnection,
} from "./codex-app-server-request-connection";
import {
	forkCodexConversationBeforeReviewTurn,
	readCodexConversationTurns,
	verifyRestoredCodexConversationPrefix,
} from "./codex-native-conversation-prefix";
import { inspectRvfCompletionEvidence } from "./inspect-rvf-completion-evidence";
import { observeRvfReviewStartActiveBranch } from "./observe-rvf-review-start-active-branch";
import {
	reconcileRvfAutomaticCloseoutLateNativePromptAcceptance,
	verifyRvfAutomaticCloseoutLateNativePromptAcceptance,
} from "./reconcile-rvf-automatic-closeout-late-native-prompt-acceptance";
import { boundaryCaptureError, ReviewStartBoundaryCaptureError } from "./review-start-boundary-capture-diagnostic";
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
import {
	RvfAutomaticCloseoutExecutionResultDeliveryPendingError,
	validateRvfAutomaticCloseoutExecutionResult,
} from "./validate-rvf-automatic-closeout-execution-result";

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
> &
	Partial<Pick<TerminalSessionManager, "publishRvfAutomaticCloseoutWaiting">>;
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
	const ownedWorkspaceOperation = new AsyncLocalStorage<string>();
	const automaticallyRecoverLateAcceptance = createAutomaticLateNativeCloseoutPromptAcceptanceRecovery();
	let timer: NodeJS.Timeout | null = null;
	let sweepInFlight: Promise<void> | null = null;
	let stopping = false;
	function serialize<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
		const pending = (operations.get(workspaceId) ?? Promise.resolve())
			.catch(() => {})
			.then(() => ownedWorkspaceOperation.run(workspaceId, operation));
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
	async function verifyBoundRunBeforeCloseoutActivation(record: RvfAutomaticCloseoutRecord) {
		const receiptDirectory = await realpath(join(rvfHome, "review-start-independent-user-turn-boundary-receipts"));
		const bindingPath = join(receiptDirectory, `${record.receipt.decision_token}.run-binding.json`);
		if ((await realpath(bindingPath)) !== bindingPath) throw new Error("RVF run 绑定文件不属于凭据目录。");
		const binding = z
			.object({ run_id: z.string().min(1), run_dir: z.string().min(1), receipt_sha256: z.string() })
			.parse(JSON.parse(await readFile(bindingPath, "utf8")));
		const runDirectory = await realpath(binding.run_dir);
		if (!isAbsolute(binding.run_dir) || resolve(binding.run_dir) !== runDirectory)
			throw new Error("RVF run 绑定必须使用真实绝对目录。");
		const scopeContractPath = join(runDirectory, "artifacts", "inputs", "scope.contract.json");
		if ((await realpath(scopeContractPath)) !== scopeContractPath)
			throw new Error("RVF scope contract 不属于该 run。");
		const scopeContract = z
			.object({ run_id: z.string().min(1) })
			.parse(JSON.parse(await readFile(scopeContractPath, "utf8")));
		if (scopeContract.run_id !== binding.run_id) throw new Error("RVF scope contract 与绑定的 run id 不一致。");
		const runReceiptPath = join(runDirectory, "inputs", "automatic-closeout-review-start-receipt.json");
		if ((await realpath(runReceiptPath)) !== runReceiptPath) throw new Error("RVF run 内的开审凭据不属于该 run。");
		const runReceipt = rvfIndependentUserTurnBoundaryReceiptSchema
			.strict()
			.parse(JSON.parse(await readFile(runReceiptPath, "utf8")));
		const canonicalReceiptText = (receipt: typeof record.receipt) =>
			JSON.stringify(
				Object.fromEntries(
					Object.entries(receipt).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
				),
			);
		const capturedReceiptText = canonicalReceiptText(record.receipt);
		if (
			canonicalReceiptText(runReceipt) !== capturedReceiptText ||
			binding.receipt_sha256 !== computeRvfTextSha256(capturedReceiptText)
		)
			throw new Error("RVF run 未精确绑定已捕获的开审凭据。");
		if (
			(record.runId !== null && record.runId !== binding.run_id) ||
			(record.runDirectory !== null && record.runDirectory !== runDirectory)
		)
			throw new Error("RVF 激活绑定的 run 已改变。");
		return { runId: binding.run_id, runDirectory };
	}
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
		if (record?.status === "captured_review_start_boundary")
			throw new RvfAutomaticCloseoutPauseError("本轮只捕获了开审分界，尚未激活自动收尾，不能投递。");
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
		if (isTaskMainSessionHandoverSuspendingAutomaticActions(card))
			throw new RvfAutomaticCloseoutWaitError("main_session_handover_in_progress", "等待主会话交接完成。");
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
		if (!summary)
			throw new RvfAutomaticCloseoutWaitError(
				"main_conversation_session_summary_unavailable",
				"等待当前主会话 summary 恢复，尚未修改原生历史。",
			);
		if (!summary.workspacePath)
			throw new RvfAutomaticCloseoutWaitError("main_conversation_workspace_unavailable", "等待主会话工作目录恢复。");
		if (!summary.agentNativeConversationSessionIdentity)
			throw new RvfAutomaticCloseoutWaitError(
				"native_session_identity_not_yet_observed",
				"等待当前主会话的原生身份观测。",
			);
		if (summary.agentId !== "codex" || summary.agentNativeConversationSessionIdentity.sourceAgentId !== "codex")
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
		const inputSubmission = summary.agentConversationPromptSubmissionAcceptance;
		// CR 已清空输入账本，但原生接受确认前 facet 仍可能是 review，不能据此停止进程。
		const hasUnconfirmedInputSubmissionForCurrentLiveProcess =
			facets.liveness === "live" &&
			inputSubmission != null &&
			inputSubmission.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
			inputSubmission.status !== "accepted";
		if (
			!["live", "exited"].includes(facets.liveness) ||
			facets.turnOwner !== "user" ||
			facets.userTurnKind !== "review" ||
			hasUnconfirmedInputSubmissionForCurrentLiveProcess ||
			manager.getAwaitingDispatchedBackgroundWork(summary.taskId).parked
		)
			throw new RvfAutomaticCloseoutWaitError(
				"agent_turn_not_ready_for_closeout",
				"等待 Agent 完成本轮并让出控制权。",
			);
	}
	async function requireNoPendingUserInput(scope: RuntimeTrpcWorkspaceScope, record: RvfAutomaticCloseoutRecord) {
		const decisions = await readAgentRaisedPendingUserDecisions(scope.workspaceId);
		if (
			decisions.some((decision) => decision.taskId === record.conversationSessionId && decision.status === "pending")
		)
			throw new RvfAutomaticCloseoutWaitError("pending_user_decision", "等待已有用户问题得到回答。");
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
		if (waiting.length)
			throw new RvfAutomaticCloseoutWaitError("queued_programmatic_message", "等待既有程序化消息完成投递。");
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
			await withCodexAppServerRequestConnection(
				{
					workingDirectory: record.receipt.worktree,
					codexConversationStorageNativeSessionId: currentId,
					codexConversationStorageHomeDirectoryPath: resolveRecordedCodexConversationHome({
						...summary,
						transcriptPath: summary.agentNativeConversationSessionIdentity?.transcriptPath,
					}),
				},
				(port) => verifyRestoredCodexConversationPrefix(port, currentId, record.preReviewTurnIds),
			);
			return;
		}
		if (currentId === record.receipt.session_id)
			requireIdle(manager, summary, record.nativeIdentitySwitchStartedAt !== null);
		const occupancy = await manager.resolveTaskTerminalInputBoxOccupancy(summary.taskId);
		// Codex 尚无输入框读屏语法。连续跟踪的空账本可以判空，接管后重建的空账本则仍可能漏着旧草稿。
		if (
			occupancy
				? occupancy.hasUncommittedInput ||
					!occupancy.inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition
				: resolveSessionFacets(summary).liveness === "live"
		)
			throw new RvfAutomaticCloseoutWaitError(
				"terminal_input_box_not_confirmed_empty",
				"终端输入框尚未确认空白，自动恢复等待且保留用户输入。",
			);
		const before = await readRvfCloseoutWorkspaceStateDigest(record.receipt.worktree);
		if (record.restoreWorkspaceStateSha256 && record.restoreWorkspaceStateSha256 !== before)
			throw new RvfAutomaticCloseoutPauseError("恢复期间工作区或暂存内容发生变化。");
		await save({ restoreWorkspaceStateSha256: before });
		await withCodexAppServerRequestConnection(
			{
				workingDirectory: record.receipt.worktree,
				codexConversationStorageNativeSessionId: record.receipt.session_id,
				codexConversationStorageHomeDirectoryPath: resolveRecordedCodexConversationHome({
					...summary,
					transcriptPath: summary.agentNativeConversationSessionIdentity?.transcriptPath,
				}),
			},
			async (port) => {
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
							throw new RvfAutomaticCloseoutPauseError(
								"RVF 开审后出现未登记的用户消息，保留当前会话供人工处理。",
							);
					}
				if (record.restoredNativeSessionId)
					await verifyRestoredCodexConversationPrefix(
						port,
						record.restoredNativeSessionId,
						record.preReviewTurnIds,
					);
				else {
					if (record.nativeForkAttemptStartedAt !== null)
						throw new RvfAutomaticCloseoutPauseError(
							"上次原生 fork 结果未确认，保留现场，不能盲目创建第二个分支。",
						);
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
			},
		);
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
		if (
			finalOccupancy
				? finalOccupancy.hasUncommittedInput ||
					!finalOccupancy.inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition
				: resolveSessionFacets(latest).liveness === "live"
		)
			throw new RvfAutomaticCloseoutWaitError(
				"terminal_input_box_not_confirmed_empty",
				"切换身份前输入框尚未确认空白，保留当前原生会话。",
			);
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
			throw new RvfAutomaticCloseoutWaitError(
				"closeout_delivery_confirmation_pending",
				"等待收尾指令的真实投递确认。",
			);
	}
	function lateNativePromptAcceptanceVerificationDependencies(
		scope: RuntimeTrpcWorkspaceScope,
		record: {
			taskId: string;
			conversationSessionId?: string;
		},
	) {
		return {
			workspaceId: scope.workspaceId,
			rvfHome,
			getMainSummary: async () => (await mainSummary(scope, record.taskId)).summary,
			isExplicitlyStopped: (conversationSessionId = record.conversationSessionId ?? record.taskId) =>
				explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`) ||
				explicitlyStoppedTasks.has(`${scope.workspaceId}:${conversationSessionId}`),
		};
	}
	// 调用方只持 workspace 串行队列；主会话队列与记录锁各进入一次，避免补证入口重入死锁。
	async function recoverEligiblePausedCloseouts(
		scope: RuntimeTrpcWorkspaceScope,
		records: RvfAutomaticCloseoutRecord[],
		trigger: AutomaticLateNativePromptAcceptanceRecoveryTrigger,
	) {
		for (const record of records) {
			if (!isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record)) continue;
			if (
				explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`) ||
				explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.conversationSessionId}`)
			)
				continue;
			try {
				const { summary, manager } = await mainSummary(scope, record.taskId);
				if (manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId)) continue;
				await automaticallyRecoverLateAcceptance({
					record,
					summary,
					trigger,
					recover: () =>
						serializeMainConversationOperation(scope, record.taskId, () =>
							reconcileRvfAutomaticCloseoutLateNativePromptAcceptance(
								lateNativePromptAcceptanceVerificationDependencies(scope, record),
								{
									taskId: record.taskId,
									decisionToken: record.receipt.decision_token,
									runId: record.runId ?? "",
									handoffSha256: record.handoffSha256 ?? "",
									dryRun: false,
								},
							),
						),
				});
			} catch {
				// 缺少当前主绑定时保留暂停；不启动会话、不绕过停止或身份守卫。
			}
		}
	}
	async function sweep() {
		for (const scope of await deps.listWorkspaces())
			await serialize(scope.workspaceId, async () => {
				const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
				await recoverEligiblePausedCloseouts(
					scope,
					await readRvfAutomaticCloseoutRecords(storePath),
					"background_sweep",
				);
				if (
					!(await readRvfAutomaticCloseoutRecords(storePath)).some(
						(record) =>
							!["captured_review_start_boundary", "completed", "paused", "closeout_prompt_submitted"].includes(
								record.status,
							),
					)
				)
					return;
				await createRvfAutomaticCloseoutCoordinator({
					storePath,
					inspectCompletion: async (record) => {
						const completion = await inspectRvfCompletionEvidence(record, rvfHome);
						if (
							completion &&
							(completion.runId !== record.runId || completion.runDirectory !== record.runDirectory)
						)
							throw new Error("RVF 完成证据与激活时绑定的 run 不一致。");
						return completion;
					},
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
					onWaiting: async (record) =>
						(await deps.getManager(scope)).publishRvfAutomaticCloseoutWaiting?.(
							record.conversationSessionId,
							record.waitingReason ?? "等待前置条件就绪。",
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
						(record.taskId === taskId || record.conversationSessionId === taskId) && record.status !== "completed"
							? {
									...record,
									explicitStopRequestedAt: record.explicitStopRequestedAt ?? Date.now(),
									...(pendingRecords.includes(record)
										? {
												status: "paused" as const,
												pauseReason: "用户明确停止会话，自动收尾已暂停。",
											}
										: {}),
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
					if (existing) return { status: "captured" as const, receipt: existing.receipt };
					const stopKey = `${scope.workspaceId}:${input.taskId}`;
					const stopSequenceBeforeCapture = explicitlyStoppedTasks.get(stopKey);
					const { manager, summary } = await mainSummary(scope, input.taskId);
					const conversationStopKey = `${scope.workspaceId}:${summary.taskId}`;
					const conversationStopSequenceBeforeCapture = explicitlyStoppedTasks.get(conversationStopKey);
					const identity = summary.agentNativeConversationSessionIdentity;
					const transcriptPath = identity?.transcriptPath;
					if (!identity || !transcriptPath)
						throw boundaryCaptureError(
							"主会话缺少原生 transcript。",
							"native_independent_user_turn_capability_unverified",
							"pending",
							"repair_host_capability",
						);
					const captured = await withCodexAppServerRequestConnection(
						{
							workingDirectory: summary.workspacePath ?? "",
							codexConversationStorageNativeSessionId: identity.nativeSessionId,
							codexConversationStorageHomeDirectoryPath: resolveRecordedCodexConversationHome({
								...summary,
								transcriptPath: identity.transcriptPath,
							}),
						},
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
						explicitlyStoppedTasks.get(conversationStopKey) !== conversationStopSequenceBeforeCapture ||
						manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId)
					)
						throw new RvfAutomaticCloseoutPauseError("捕获分界期间用户已停止会话。");
					explicitlyStoppedTasks.delete(stopKey);
					explicitlyStoppedTasks.delete(conversationStopKey);
					const record: RvfAutomaticCloseoutRecord = {
						workspaceId: scope.workspaceId,
						taskId: input.taskId,
						conversationSessionId: summary.taskId,
						...captured,
						status: "captured_review_start_boundary",
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
					await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
						if (
							explicitlyStoppedTasks.get(stopKey) !== undefined ||
							explicitlyStoppedTasks.has(conversationStopKey) ||
							manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId)
						)
							throw new RvfAutomaticCloseoutPauseError("保存分界期间用户已停止会话。");
						return { records: [...records, record], value: null };
					});
					return { status: "captured" as const, receipt: captured.receipt };
				}),
			).catch((error: unknown) => {
				if (error instanceof ReviewStartBoundaryCaptureError) return error.diagnostic;
				if (error instanceof RvfAutomaticCloseoutPauseError || error instanceof RvfAutomaticCloseoutWaitError)
					return {
						status: "pending" as const,
						reason: error.message,
						reason_code: "review_start_boundary_host_session_unavailable" as const,
						recovery_action: "inspect_boundary_diagnostic" as const,
					};
				throw error;
			}),
		activateAfterRunBinding: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string; decisionToken: string },
		) =>
			serialize(scope.workspaceId, () =>
				serializeMainConversationOperation(scope, input.taskId, async () => {
					const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
					const record = (await readRvfAutomaticCloseoutRecords(storePath)).find(
						(entry) => entry.taskId === input.taskId && entry.receipt.decision_token === input.decisionToken,
					);
					if (!record) throw new Error("本任务尚未捕获该 RVF token 的开审分界。");
					if (record.status === "paused")
						throw new RvfAutomaticCloseoutPauseError("本轮自动收尾已暂停，不能重新激活。");
					// 第一条原生消息也可证明手动审查；无此前会话时不把可选自动恢复变成开审障碍。
					if (!record.preReviewTurnIds.length || record.automaticCloseoutIneligibleReason)
						return {
							receipt: record.receipt,
							automaticCloseoutActivationStatus: "skipped_no_completed_pre_review_conversation_prefix" as const,
						};
					const binding = await verifyBoundRunBeforeCloseoutActivation(record);
					if (record.status !== "captured_review_start_boundary") return { receipt: record.receipt };
					const { manager, summary } = await mainSummary(scope, input.taskId);
					if (
						record.workspaceId !== scope.workspaceId ||
						record.receipt.kanban_task_id !== input.taskId ||
						summary.taskId !== record.conversationSessionId ||
						summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.receipt.session_id ||
						resolve(summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "") !==
							resolve(record.receipt.transcript_path) ||
						(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
					)
						throw new RvfAutomaticCloseoutPauseError("激活前主会话、原生身份或工作目录已改变。");
					await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
						const current = records.find(
							(entry) => entry.taskId === input.taskId && entry.receipt.decision_token === input.decisionToken,
						);
						if (
							current?.status === "paused" ||
							explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.taskId}`) ||
							explicitlyStoppedTasks.has(`${scope.workspaceId}:${record.conversationSessionId}`) ||
							manager.isTaskSessionAutomaticContinuationSuppressed(summary.taskId)
						)
							throw new RvfAutomaticCloseoutPauseError("激活期间用户已停止会话。");
						if (current?.status !== "captured_review_start_boundary") {
							if (current?.runId === binding.runId && current.runDirectory === binding.runDirectory)
								return { records, value: null };
							throw new Error("RVF 捕获状态已改变，不能覆盖当前阶段。");
						}
						return {
							records: records.map((entry) =>
								entry === current
									? { ...entry, ...binding, status: "awaiting_rvf_completion" as const, updatedAt: Date.now() }
									: entry,
							),
							value: null,
						};
					});
					return { receipt: record.receipt };
				}),
			),
		reconcileLateNativePromptAcceptance: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfLateNativeCloseoutPromptAcceptanceRecoveryRequestSchema>,
		) =>
			serialize(scope.workspaceId, () =>
				serializeMainConversationOperation(scope, input.taskId, () =>
					reconcileRvfAutomaticCloseoutLateNativePromptAcceptance(
						lateNativePromptAcceptanceVerificationDependencies(scope, input),
						input,
					),
				),
			),
		reportExecutionResult: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: z.infer<typeof rvfAutomaticCloseoutExecutionResultReportRequestSchema>,
		) =>
			serialize(scope.workspaceId, async () => {
				if (input.outcome === "completed") {
					const records = await readRvfAutomaticCloseoutRecords(
						getRvfAutomaticCloseoutStorePath(scope.workspaceId),
					);
					await recoverEligiblePausedCloseouts(
						scope,
						records.filter(
							(record) =>
								record.taskId === input.taskId && record.receipt.decision_token === input.decisionToken,
						),
						"execution_report",
					);
				}
				return serializeMainConversationOperation(scope, input.taskId, async () => {
					const report = rvfAutomaticCloseoutExecutionResultReportRequestSchema.parse(input);
					const storePath = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
					const record = (await readRvfAutomaticCloseoutRecords(storePath)).find(
						(entry) => entry.taskId === report.taskId && entry.receipt.decision_token === report.decisionToken,
					);
					if (!record || record.runId !== report.runId || record.handoffSha256 !== report.handoffSha256)
						throw new Error("执行报告与已登记的 task/token/run/handoff 绑定不一致。");
					const canReportInCurrentStatus = (current: RvfAutomaticCloseoutRecord) =>
						["submitting_closeout_prompt", "closeout_prompt_submitted", "completed"].includes(current.status) ||
						(report.outcome !== "completed" && current.status === "paused");
					if (!canReportInCurrentStatus(record))
						throw new Error("本轮尚未确认自动收尾投递，或已暂停，不能报告执行完成。");
					const resultKey = report.stage === "land" ? "landExecutionResult" : "baseBranchSyncExecutionResult";
					const result = {
						outcome: report.outcome,
						...(report.commitSha ? { commitSha: report.commitSha } : {}),
						...(report.baseRef ? { baseRef: report.baseRef } : {}),
						...(report.reason ? { reason: report.reason } : {}),
					};
					const matchesPreviouslyReportedExecutionStageResult = (current: RvfAutomaticCloseoutRecord) => {
						const prior = current[resultKey];
						if (!prior) return false;
						const { reportedAt: _reportedAt, ...priorResult } = prior;
						if (JSON.stringify(priorResult) === JSON.stringify(result)) return true;
						if (
							current.executionResultReportHistory?.some((entry) => {
								const { stage, reportedAt: _historicalReportedAt, ...historicalResult } = entry;
								return stage === report.stage && JSON.stringify(historicalResult) === JSON.stringify(result);
							})
						)
							return true;
						if (prior.outcome === "completed") throw new Error("已确认的执行结果不能被另一份报告覆盖。");
						return false;
					};
					if (report.outcome === "completed" && matchesPreviouslyReportedExecutionStageResult(record))
						return { record };
					const { summary } = await mainSummary(scope, record.taskId);
					if (
						summary.taskId !== record.conversationSessionId ||
						!record.restoredNativeSessionId ||
						summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.restoredNativeSessionId ||
						(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
					)
						throw new Error("执行报告的恢复会话或工作区绑定已改变。");
					if (report.outcome === "completed") {
						const delivery = findTaskMessageInjectionRecord(
							await readTaskMessageInjectionLedger(
								getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(scope.workspaceId)),
							),
							record.conversationSessionId,
							record.promptDeliveryIdempotencyKey,
						);
						if (
							delivery?.terminal_delivery_status !== "delivered_and_submit_confirmed" &&
							record.lateNativePromptAcceptanceRecoveryReceipt
						) {
							await verifyRvfAutomaticCloseoutLateNativePromptAcceptance(
								lateNativePromptAcceptanceVerificationDependencies(scope, record),
								record,
							);
						} else if (delivery?.terminal_delivery_status === "accepted_pending_submit_confirmation")
							throw new RvfAutomaticCloseoutExecutionResultDeliveryPendingError(
								"自动收尾指令尚在等待真实提交确认，请重试同一份执行报告。",
							);
						else if (delivery?.terminal_delivery_status !== "delivered_and_submit_confirmed")
							throw new Error("自动收尾指令没有真实提交确认，不能登记执行结果。");
					}
					await validateRvfAutomaticCloseoutExecutionResult(record, report);
					const saved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
						const current = records.find(
							(entry) => entry.taskId === report.taskId && entry.receipt.decision_token === report.decisionToken,
						);
						if (
							!current ||
							!canReportInCurrentStatus(current) ||
							current.runId !== report.runId ||
							current.handoffSha256 !== report.handoffSha256 ||
							current.conversationSessionId !== record.conversationSessionId ||
							current.restoredNativeSessionId !== record.restoredNativeSessionId ||
							current.handoffPath !== record.handoffPath ||
							JSON.stringify(current.lateNativePromptAcceptanceRecoveryReceipt) !==
								JSON.stringify(record.lateNativePromptAcceptanceRecoveryReceipt) ||
							(report.outcome === "completed" &&
								record.lateNativePromptAcceptanceRecoveryReceipt &&
								(current.explicitStopRequestedAt !== undefined ||
									lateNativePromptAcceptanceVerificationDependencies(scope, current).isExplicitlyStopped()))
						)
							throw new Error("报告期间自动收尾被停止或运行绑定已改变。");
						// 不同 service 可在异步证据验证期间交错，阶段完成事实须在持久写锁内复核。
						if (matchesPreviouslyReportedExecutionStageResult(current)) return { records, value: current };
						const reportedAt = Date.now();
						const history = current.executionResultReportHistory ?? [
							...(current.landExecutionResult
								? [{ stage: "land" as const, ...current.landExecutionResult }]
								: []),
							...(current.baseBranchSyncExecutionResult
								? [{ stage: "base_branch_sync" as const, ...current.baseBranchSyncExecutionResult }]
								: []),
						];
						const updated = {
							...current,
							[resultKey]: { ...result, reportedAt },
							executionResultReportHistory: [...history, { stage: report.stage, ...result, reportedAt }],
							updatedAt: reportedAt,
						};
						if (
							updated.landExecutionResult?.outcome === "completed" &&
							updated.baseBranchSyncExecutionResult?.outcome === "completed"
						)
							updated.status = "completed";
						return { records: records.map((entry) => (entry === current ? updated : entry)), value: updated };
					});
					return { record: saved };
				});
			}),
		observeBoundary: async (
			scope: RuntimeTrpcWorkspaceScope,
			input: { taskId: string; idempotencyKey: string; requestNonce: string },
		) => {
			const diagnosticRecorder = createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder({
				workspaceId: scope.workspaceId,
				taskId: input.taskId,
				requestNonce: input.requestNonce,
			});
			const record = (
				await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId))
			).find((entry) => entry.taskId === input.taskId && entry.receipt.idempotency_key === input.idempotencyKey);
			if (!record) {
				diagnosticRecorder.finishObservation("capability_unavailable");
				return {
					review_start_boundary_pending_reason: "尚未捕获本 task/key 对应的原生分界。",
					reason_code: "native_independent_user_turn_boundary_not_yet_observed" as const,
					recovery_action: "retry_capture" as const,
				};
			}
			try {
				const { summary } = await mainSummary(scope, input.taskId);
				diagnosticRecorder.bindIdentity({
					conversationSessionId: summary.taskId,
					runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
					nativeSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? "unknown",
				});
				if (
					summary.taskId !== record.conversationSessionId ||
					summary.agentNativeConversationSessionIdentity?.nativeSessionId !== record.receipt.session_id ||
					resolve(summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "") !==
						resolve(record.receipt.transcript_path) ||
					(await realpath(summary.workspacePath ?? "")) !== (await realpath(record.receipt.worktree))
				) {
					diagnosticRecorder.finishObservation("binding_invalidated");
					return {
						review_start_boundary_pending_reason: "原生主会话身份已改变，旧分界不可用。",
						reason_code: "review_start_boundary_binding_invalidated" as const,
						recovery_action: "request_new_boundary_after_turn_completion" as const,
					};
				}
				const observedTranscriptPath = summary.agentNativeConversationSessionIdentity?.transcriptPath;
				const endpoint = summary.codexNativeSessionControlEndpoint
					? { ...summary.codexNativeSessionControlEndpoint }
					: null;
				if (
					!endpoint ||
					(endpoint &&
						(endpoint.workspaceId !== scope.workspaceId ||
							endpoint.conversationSessionId !== summary.taskId ||
							endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId))
				) {
					diagnosticRecorder.finishObservation("capability_unavailable");
					return {
						review_start_boundary_pending_reason: "本代会话没有与当前身份绑定的原生活动分支控制面。",
						reason_code: "native_independent_user_turn_capability_unverified" as const,
						recovery_action: "repair_host_capability" as const,
					};
				}
				const observation = await withRunningCodexAppServerControlSocketConnection(
					async (port) => {
						// 不 resume、不从磁盘装载旧 thread；必须已由当前 TUI 宿主持有。
						let cursor: string | null = null;
						const seenCursors = new Set<string>();
						let loaded = false;
						do {
							const page = z
								.object({ data: z.array(z.string()), nextCursor: z.string().nullable().optional() })
								.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
							loaded ||= page.data.includes(record.receipt.session_id);
							cursor = page.nextCursor ?? null;
							if (cursor && seenCursors.has(cursor)) throw new Error("原生已加载会话分页循环。");
							if (cursor) seenCursors.add(cursor);
						} while (cursor);
						if (!loaded) throw new Error("当前 TUI 未连接可查询的原生活动分支控制面。");
						return observeRvfReviewStartActiveBranch({
							port,
							receipt: record.receipt,
							requestNonce: input.requestNonce,
						});
					},
					{ socketPath: endpoint.socketPath, onDiagnostic: diagnosticRecorder.onDiagnostic },
				);
				const { summary: latest } = await mainSummary(scope, input.taskId);
				if (
					latest.taskId !== summary.taskId ||
					latest.startedAt !== summary.startedAt ||
					latest.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
					latest.workspacePath !== summary.workspacePath ||
					latest.codexNativeSessionControlEndpoint?.socketPath !== endpoint?.socketPath ||
					latest.codexNativeSessionControlEndpoint?.workspaceId !== endpoint.workspaceId ||
					latest.codexNativeSessionControlEndpoint?.conversationSessionId !== endpoint.conversationSessionId ||
					latest.codexNativeSessionControlEndpoint?.runtimeSessionIncarnationId !==
						endpoint?.runtimeSessionIncarnationId ||
					latest.agentNativeConversationSessionIdentity?.nativeSessionId !== record.receipt.session_id ||
					latest.agentNativeConversationSessionIdentity?.transcriptPath !== observedTranscriptPath
				) {
					diagnosticRecorder.finishObservation("binding_invalidated");
					return {
						independent_user_turn_boundary_receipt: record.receipt,
						review_start_boundary_pending_reason: "实时原生分支能力尚未确认：观测期间原生主会话被替换。",
						reason_code: "review_start_boundary_binding_invalidated" as const,
						recovery_action: "request_new_boundary_after_turn_completion" as const,
					};
				}
				diagnosticRecorder.finishObservation("observation_verified");
				return {
					independent_user_turn_boundary_receipt: record.receipt,
					review_start_boundary_active_branch_observation: observation,
				};
			} catch (error) {
				diagnosticRecorder.finishObservation("observation_failed");
				return {
					independent_user_turn_boundary_receipt: record.receipt,
					review_start_boundary_pending_reason: `实时原生分支能力尚未确认：${
						error instanceof z.ZodError
							? "原生回合响应结构不合法。"
							: error instanceof Error
								? error.message
								: "观测失败。"
					}`,
				};
			}
		},
		status: async (scope: RuntimeTrpcWorkspaceScope, input: { taskId: string }) => {
			const snapshot = async () => ({
				records: (
					await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId))
				).filter((record) => record.taskId === input.taskId),
			});
			// 内部核验/投递可以读取当前快照，不能等待自己持有的 workspace 队列。
			if (ownedWorkspaceOperation.getStore() === scope.workspaceId) return snapshot();
			return serialize(scope.workspaceId, async () => {
				const path = getRvfAutomaticCloseoutStorePath(scope.workspaceId);
				await recoverEligiblePausedCloseouts(
					scope,
					(await readRvfAutomaticCloseoutRecords(path)).filter((record) => record.taskId === input.taskId),
					"status_query",
				);
				return {
					records: (await readRvfAutomaticCloseoutRecords(path)).filter(
						(record) => record.taskId === input.taskId,
					),
				};
			});
		},
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
