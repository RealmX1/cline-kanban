import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskChatSendRequest, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { RvfAutomaticCloseoutRecord } from "../../../src/core/rvf-automatic-closeout-contract";
import {
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../../../src/core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "../../../src/rvf-automatic-closeout/capture-rvf-review-start-boundary";
import { createRvfAutomaticCloseoutRuntimeService } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-runtime-service";
import {
	getRvfAutomaticCloseoutStorePath,
	updateRvfAutomaticCloseoutRecords,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { createQueuedTaskPromptDeliveryDispatcher } from "../../../src/server/queued-task-prompt-delivery-dispatcher";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../../../src/state/queued-task-prompt-delivery-store";
import type { TaskChatInputDeliveryOutcomeObserver } from "../../../src/terminal/session-manager";
import { createRuntimeApi } from "../../../src/trpc/runtime-api";
import { sendTaskChatMessageAcrossSessionTransports } from "../../../src/trpc/task-chat-message-send-across-session-transports";

const workspace = vi.hoisted(() => ({ root: "", directory: "" }));
const createdDispatchers: Array<ReturnType<typeof createQueuedTaskPromptDeliveryDispatcher>> = [];
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => workspace.root,
	getWorkspaceDirectoryPath: () => workspace.directory,
	getWorkspacesRootPath: () => workspace.root,
	loadWorkspaceBoardById: async () => ({
		columns: [{ id: "review", cards: [{ id: "task", mainTaskConversationSessionId: "main-session" }] }],
	}),
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: vi.fn(),
}));
beforeEach(async () => {
	workspace.root = await mkdtemp(join(tmpdir(), "rvf-closeout-stop-"));
	workspace.directory = join(workspace.root, "workspace");
	await mkdir(workspace.directory);
});
afterEach(async () => {
	for (const dispatcher of createdDispatchers.splice(0)) dispatcher.stop();
	await rm(workspace.root, { recursive: true, force: true });
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function setup() {
	const scope = { workspaceId: "workspace", workspacePath: workspace.root };
	const handoffPath = join(workspace.directory, "handoff.md");
	await writeFile(handoffPath, "已完成修复");
	const record: RvfAutomaticCloseoutRecord = {
		workspaceId: scope.workspaceId,
		taskId: "task",
		conversationSessionId: "main-session",
		receipt: {
			schema: "rvf-independent-user-turn-boundary/v1",
			decision_token: "0123456789abcdef",
			session_id: "original",
			worktree: scope.workspacePath,
			native_user_message_id: "boundary-message",
			native_turn_id: "boundary-turn",
			transcript_path: "/original.jsonl",
			boundary_message_sha256: "boundary-hash",
			candidate_fingerprint: "candidate",
			worktree_head_commit_sha: "head",
			checkpoint_commit: "checkpoint",
			checkpoint_tree: "tree",
			comparison_base_tip: null,
			comparison_base_ref: null,
			comparison_base_ref_tip: null,
			source: "rvf_automatic_decision_message",
			kanban_task_id: "task",
			idempotency_key: "boundary",
		},
		preReviewTurnIds: ["implementation"],
		status: "submitting_closeout_prompt",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		runId: "run",
		runDirectory: workspace.directory,
		handoffPath,
		handoffSha256: computeRvfTextSha256("已完成修复"),
		restoredNativeSessionId: "restored",
		restoredTranscriptPath: "/restored.jsonl",
		restoreWorkspaceStateSha256: null,
		nativeIdentitySwitchStartedAt: Date.now(),
		nativeForkAttemptStartedAt: Date.now(),
		pauseReason: null,
		promptDeliveryIdempotencyKey: "rvf-automatic-closeout-0123456789abcdef",
	};
	await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(scope.workspaceId), () => ({
		records: [record],
		value: null,
	}));
	const summary: RuntimeTaskSessionSummary = {
		taskId: "main-session",
		taskConversationSessionMetadata: {
			workspaceTaskId: "task",
			taskConversationSessionRole: "main",
			taskConversationSessionContextSource: "main",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		},
		state: "awaiting_review",
		agentId: "codex",
		workspacePath: scope.workspacePath,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "incarnation",
		agentResponseGenerationTurnSequence: 1,
		agentResponseGenerationStopped: { stoppedAt: 1, signalConfidence: "harness_turn_complete", turnSequence: 1 },
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "restored",
			transcriptPath: "/restored.jsonl",
			observedAt: 1,
		},
	};
	let observer: TaskChatInputDeliveryOutcomeObserver | undefined;
	const terminalOptions: Array<{ validateBeforeTerminalWrite?: () => Promise<void> }> = [];
	const terminalManager = {
		getSummary: () => summary,
		listSummaries: () => [summary],
		stopTaskSession: vi.fn(() => summary),
		isTaskSessionAutomaticContinuationSuppressed: () => false,
		getAwaitingDispatchedBackgroundWork: () => ({ parked: false, label: null, sinceMs: null }),
		resolveTaskTerminalInputBoxOccupancy: vi.fn(),
		forceStopTaskSession: vi.fn(),
		applyAgentNativeConversationSessionIdentity: vi.fn(),
		publishRvfAutomaticCloseoutPaused: vi.fn(),
		submitTaskChatInputWhenReady: vi.fn(
			(_taskId: string, _text: string, options: { validateBeforeTerminalWrite?: () => Promise<void> }) => {
				terminalOptions.push(options);
				return summary;
			},
		),
		cancelTaskChatInputDelivery: vi.fn(() => {
			observer?.({ status: "delivery_failed", reason: "cancelled_before_delivery" });
			return "cancelled_before_delivery" as const;
		}),
	};
	const acpService = { getSummary: () => null, listSummaries: () => [], stopTaskSession: vi.fn(async () => null) };
	const clineService = {
		sendTaskSessionInput: async () => null,
		rebindPersistedTaskSession: async () => null,
		listSummaries: () => [],
		stopTaskSession: vi.fn(async () => null),
	};
	const transportEntered = deferred();
	let beforeTransportValidation: (() => Promise<void>) | undefined;
	let service: ReturnType<typeof createRvfAutomaticCloseoutRuntimeService>;
	const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: () => summary,
		hasPendingProgrammaticTaskChatInputDelivery: () => false,
		resolveWorkspaceScope: () => scope,
		sendThroughTaskChatTransports: async (_scope, input, onSettled) => {
			transportEntered.resolve();
			await beforeTransportValidation?.();
			observer = onSettled;
			return sendTaskChatMessageAcrossSessionTransports(
				{
					getScopedTerminalManager: async () => terminalManager as never,
					getScopedAcpTaskSessionService: async () => acpService as never,
					getScopedClineTaskSessionService: async () => clineService as never,
					loadScopedRuntimeConfig: vi.fn(async () => ({}) as never),
					resolveClineTaskSessionLaunchConfig: vi.fn(),
					onProgrammaticTerminalDeliverySettled: onSettled,
					validateBeforeTerminalWrite: () => service.validateCloseoutPromptDelivery(scope, input),
				},
				scope,
				input,
			);
		},
		cancelProgrammaticTerminalDelivery: async () => terminalManager.cancelTaskChatInputDelivery(),
		readPromptLibraryEntryTextSha256ByEntryId: async () => new Map(),
		onProjectedQueueChanged: () => {},
	});
	const runtimeApi = createRuntimeApi({
		getActiveWorkspaceId: () => scope.workspaceId,
		loadScopedRuntimeConfig: vi.fn(),
		setActiveRuntimeConfig: vi.fn(),
		getScopedTerminalManager: async () => terminalManager as never,
		getScopedAcpTaskSessionService: async () => acpService as never,
		getScopedClineTaskSessionService: async () => clineService as never,
		resolveInteractiveShellCommand: vi.fn(),
		runCommand: vi.fn(),
		getUpdateStatus: vi.fn(),
		runUpdateNow: vi.fn(),
		queuedTaskPromptDeliveryDispatcher: dispatcher,
		onTaskSessionStopRequested: (workspaceId, taskId) => service.pauseForExplicitStop(workspaceId, taskId),
	});
	createdDispatchers.push(dispatcher);
	const dependencies = {
		getManager: async () => terminalManager,
		runtimeApi: {
			startTaskSession: vi.fn(),
			enqueueAgentIdleGatedProgrammaticTaskChatMessage: vi.fn(
				runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage,
			),
			cancelTaskChatDelivery: vi.fn(runtimeApi.cancelTaskChatDelivery),
		},
		listWorkspaces: async () => [scope],
		warn: vi.fn(),
	};
	service = createRvfAutomaticCloseoutRuntimeService(dependencies);
	const deliveryIdentity: RuntimeTaskChatSendRequest = {
		taskId: record.conversationSessionId,
		text: "收尾",
		source: "rvf_automatic_closeout",
		idempotencyKey: record.promptDeliveryIdempotencyKey,
	};
	return {
		scope,
		record,
		service,
		dependencies,
		dispatcher,
		runtimeApi,
		terminalManager,
		terminalOptions,
		deliveryIdentity,
		transportEntered,
		setBeforeTransportValidation: (operation: () => Promise<void>) => {
			beforeTransportValidation = operation;
		},
		queue: async () =>
			(await readWorkspaceQueuedTaskPromptDeliverySnapshot(scope.workspaceId)).entriesByTaskId["main-session"] ?? [],
		ledger: async () => readTaskMessageInjectionLedger(getTaskMessageInjectionLedgerPath(workspace.directory)),
	};
}

describe("RVF 自动收尾的用户停止与持久投递竞争", () => {
	it("入队前停止时不调用入队 API，重启仍拒绝旧投递", async () => {
		const context = await setup();
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		await context.service.sweepPendingCloseoutsOnce();
		expect(context.dependencies.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage).not.toHaveBeenCalled();
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await expect(restarted.validateCloseoutPromptDelivery(context.scope, context.deliveryIdentity)).rejects.toThrow(
			"暂停",
		);
		await expect(
			restarted.validateCloseoutPromptDelivery(context.scope, { ...context.deliveryIdentity, source: "other" }),
		).resolves.toBeUndefined();
	});

	it("入队内部挂起期间先停止，晚到的持久条目被补撤并回写取消账本", async () => {
		const context = await setup();
		const entered = deferred();
		const release = deferred();
		const enqueue =
			context.dependencies.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.getMockImplementation();
		context.dependencies.runtimeApi.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mockImplementation(
			async (...args) => {
				entered.resolve();
				await release.promise;
				if (!enqueue) throw new Error("缺少真实入队入口");
				return enqueue(...args);
			},
		);
		const sweep = context.service.sweepPendingCloseoutsOnce();
		await entered.promise;
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "main-session");
		release.resolve();
		await sweep;
		await context.dispatcher.whenIdle();
		expect((await context.queue())[0]?.deliveryState).toBe("cancelled");
		expect((await context.ledger())[0]?.terminal_delivery_failure_reason).toBe("cancelled_before_delivery");
		expect(context.terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
		context.dispatcher.stop();
	});

	it("已持久入队后停止会撤销队列，重新创建服务后也不再交出", async () => {
		const context = await setup();
		// 让真实入队写盘，但不通知 dispatcher，准确停在 queued 阶段。
		const notify = vi.spyOn(context.dispatcher, "notifyQueueMutated").mockResolvedValue();
		await context.service.sweepPendingCloseoutsOnce();
		expect((await context.queue())[0]?.deliveryState).toBe("queued");
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		expect((await context.queue())[0]?.deliveryState).toBe("cancelled");
		notify.mockRestore();
		await createRvfAutomaticCloseoutRuntimeService(context.dependencies).sweepPendingCloseoutsOnce();
		await context.dispatcher.runFallbackSweep();
		await context.dispatcher.whenIdle();
		expect(context.terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
		context.dispatcher.stop();
	});

	it("已交给 transport 但尚未受理时停止，临写门拒绝并把持久队列结算为取消", async () => {
		const context = await setup();
		const release = deferred();
		context.setBeforeTransportValidation(() => release.promise);
		await context.service.sweepPendingCloseoutsOnce();
		await context.transportEntered.promise;
		expect((await context.queue())[0]?.deliveryState).toBe("handed_to_transport");
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		release.resolve();
		await context.dispatcher.whenIdle();
		expect((await context.queue())[0]?.deliveryState).toBe("cancelled");
		expect((await context.ledger())[0]?.terminal_delivery_failure_reason).toBe("cancelled_before_delivery");
		expect(context.terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
		context.dispatcher.stop();
	});

	it("终端已经受理后停止复用在途取消，逐次写入核验也会读取持久暂停", async () => {
		const context = await setup();
		await context.service.sweepPendingCloseoutsOnce();
		await vi.waitFor(() => expect(context.terminalOptions).toHaveLength(1));
		await context.terminalOptions[0]?.validateBeforeTerminalWrite?.();
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		await context.dispatcher.whenIdle();
		expect(context.terminalManager.cancelTaskChatInputDelivery).toHaveBeenCalled();
		expect((await context.queue())[0]?.deliveryState).toBe("cancelled");
		await expect(context.terminalOptions[0]?.validateBeforeTerminalWrite?.()).rejects.toThrow("暂停");
		const restarted = createRvfAutomaticCloseoutRuntimeService(context.dependencies);
		await expect(restarted.validateCloseoutPromptDelivery(context.scope, context.deliveryIdentity)).rejects.toThrow(
			"暂停",
		);
		context.dispatcher.stop();
	});

	it("另一实例已持久暂停而本实例没有内存标记时，dispatcher 仍不受理终端投递", async () => {
		const context = await setup();
		const release = deferred();
		context.setBeforeTransportValidation(() => release.promise);
		await context.service.sweepPendingCloseoutsOnce();
		await context.transportEntered.promise;
		const otherInstance = createRvfAutomaticCloseoutRuntimeService({
			...context.dependencies,
			runtimeApi: {
				...context.dependencies.runtimeApi,
				cancelTaskChatDelivery: vi.fn(async () => ({ ok: false, cancelResult: "no_pending_delivery" as const })),
			},
		});
		await otherInstance.pauseForExplicitStop(context.scope.workspaceId, "task");
		release.resolve();
		await context.dispatcher.whenIdle();
		expect(context.terminalManager.submitTaskChatInputWhenReady).not.toHaveBeenCalled();
		expect((await context.queue())[0]?.deliveryState).toBe("cancelled");
		context.dispatcher.stop();
	});

	it("取消入口失败不阻断停止，已确认提交的历史事实保持不变", async () => {
		const context = await setup();
		context.dependencies.runtimeApi.cancelTaskChatDelivery.mockRejectedValue(new Error("取消失败"));
		await expect(context.service.pauseForExplicitStop(context.scope.workspaceId, "task")).resolves.toBeUndefined();
		expect(context.dependencies.warn).toHaveBeenCalledWith(expect.stringContaining("取消失败"));
		await updateRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(context.scope.workspaceId), () => ({
			records: [{ ...context.record, status: "closeout_prompt_submitted" }],
			value: null,
		}));
		context.dependencies.runtimeApi.cancelTaskChatDelivery.mockClear();
		await context.service.pauseForExplicitStop(context.scope.workspaceId, "task");
		expect((await context.service.status(context.scope, { taskId: "task" })).records[0]?.status).toBe(
			"closeout_prompt_submitted",
		);
		expect(context.dependencies.runtimeApi.cancelTaskChatDelivery).not.toHaveBeenCalled();
	});

	it("暂停回调异常也不阻止用户真正停止终端", async () => {
		const context = await setup();
		vi.spyOn(context.service, "pauseForExplicitStop").mockRejectedValue(new Error("停止状态存储失败"));
		expect(await context.runtimeApi.stopTaskSession(context.scope, { taskId: "main-session" })).toMatchObject({
			ok: true,
		});
		expect(context.terminalManager.stopTaskSession).toHaveBeenCalledWith("main-session");
	});
});
