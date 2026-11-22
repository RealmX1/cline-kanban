import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submittedPromptSha256 } from "../../src/agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import { BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS } from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-assessment";
import {
	collectBacklogTaskStartReadinessEvidence,
	readRestrictedBacklogTaskReadinessEvidence,
} from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-evidence";
import {
	readBacklogTaskStartReadinessOperation,
	writeBacklogTaskStartReadinessOperation,
} from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-operation-store";
import { createBacklogTaskStartReadinessRecovery } from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-recovery";
import {
	BacklogTaskStartReadinessRuntimeClosingError,
	transferBacklogTaskStartReadinessIntentAfterMigration,
} from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-service";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import { backlogTaskStartReadinessDecisionSchema } from "../../src/core/backlog-task-start-readiness-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	mutateWorkspaceState,
} from "../../src/state/workspace-state";
import { recordTaskEditorCreationExplicitStop } from "../../src/task-editor-creation/task-editor-creation-submission-store";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { getTaskWorkspacePathInfo } from "../../src/workspace/task-worktree";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const model = vi.hoisted(() => ({
	respond: vi.fn(),
	preferredRecovery: vi.fn(async () => null as { cooldownUntilEpochMs: number } | null),
}));
vi.mock("../../src/model-provider-access/task-assistance-model-provider-routing", () => ({
	readTaskAssistancePreferredProviderRecovery: model.preferredRecovery,
	requestTaskAssistanceJsonObject: async (input: { userPrompt: string }) => {
		const decision = await model.respond(JSON.parse(input.userPrompt));
		return decision
			? {
					status: "completed",
					parsedJsonObject: backlogTaskStartReadinessDecisionSchema.parse(decision),
					attempts: [],
				}
			: { status: "unavailable", unavailableReason: "request_failed", attempts: [] };
	},
}));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	model.preferredRecovery.mockResolvedValue(null);
});
const launchReceiptTranscriptPagePadding = Array.from({ length: 4 }, () => ({
	type: "noise",
	text: "x".repeat(80_000),
}));
const ready = () => ({
	conclusion: "ready",
	summary: "当前代码与原目标一致，可以开启。",
	evidenceReferences: ["current_repository"],
	remainingWorkRevision: null,
	readOnlyEvidenceRequests: [],
});

async function createHarness() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv(
		"KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT",
		join(fixture.isolatedHomeDirectoryPath, "isolated-model-provider-settings"),
	);
	vi.stubEnv("KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY", "");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY", "");
	vi.stubEnv(
		"KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT",
		join(fixture.isolatedHomeDirectoryPath, "isolated-relation-ledger"),
	);
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "readiness-project",
		initialBranchName: "main",
	});
	writeFileSync(join(repository.repositoryPath, "feature.ts"), "export const feature = 1;\n");
	repository.commitAllRepositoryFilesAtDate({
		message: "创建基线",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const context = await loadWorkspaceContext(repository.repositoryPath);
	const scope = { workspaceId: context.workspaceId, workspacePath: context.repoPath };
	const sessions = new Map<string, RuntimeTaskSessionSummary>();
	const persistCurrentSessionSummary = async (summary: RuntimeTaskSessionSummary) => {
		sessions.set(summary.taskId, summary);
		await mutateWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: state.board,
			sessions: { ...state.sessions, [summary.taskId]: summary },
			value: null,
		}));
	};
	let ensuredTaskWorktreePath = context.repoPath;
	let loseLaunchResponse = false;
	let rejectNextSpawn = false;
	let delayInitialPromptAcceptance = false;
	const launches: string[] = [];
	const api = createTaskCardActionApi({
		runtimeApi: {
			startTaskSession: async (_scope, request, beforeLaunch) => {
				const summary = runtimeTaskSessionSummarySchema.parse({
					taskId: request.taskId,
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
					agentId: "codex",
					workspacePath: ensuredTaskWorktreePath,
					pid: 12345,
					runtimeSessionIncarnationId: globalThis.crypto.randomUUID(),
					startedAt: Date.now(),
					updatedAt: Date.now(),
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
					latestTurnCheckpoint: null,
					previousTurnCheckpoint: null,
				});
				await beforeLaunch?.(summary);
				if (rejectNextSpawn) {
					rejectNextSpawn = false;
					return { ok: false, summary: null, error: "模拟创建进程失败", agentProcessConfirmedNotSpawned: true };
				}
				launches.push(request.prompt ?? "");
				if (!delayInitialPromptAcceptance && summary.runtimeSessionIncarnationId)
					summary.agentConversationPromptSubmissionAcceptance = {
						status: "accepted",
						attemptedAtMs: Date.now(),
						confirmedAtMs: Date.now(),
						runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
						submittedPromptSha256: submittedPromptSha256(request.prompt ?? ""),
					};
				await persistCurrentSessionSummary(summary);
				if (loseLaunchResponse) {
					loseLaunchResponse = false;
					throw new Error("模拟启动回执丢失");
				}
				return { ok: true, summary };
			},
			stopTaskSession: async () => ({ ok: true, summary: null }),
			transitionTaskToReview: async () => ({ ok: true, summary: null }),
		},
		workspaceApi: {
			ensureWorktree: async () => ({
				ok: true,
				path: ensuredTaskWorktreePath,
				baseRef: "main",
				baseCommit: "a".repeat(40),
			}),
			deleteWorktree: async () => ({ ok: true, removed: false }),
		},
		broadcastRuntimeProjectsUpdated: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		findTaskSessionSummaryLiveInRuntimeProcessMemory: (_workspaceId, taskId) => sessions.get(taskId) ?? null,
		taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
	});
	const evidence = { decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" as const } };
	const caller = runtimeAppRouter.createCaller({
		requestedWorkspaceId: scope.workspaceId,
		workspaceScope: scope,
		kanbanRequestOriginActorEvidence: evidence,
		taskCardActionApi: api,
	} as unknown as RuntimeTrpcContext);
	const add = async (
		prompt: string,
		conditions?: string,
		worktreeMode: "inplace" | "branch" = "inplace",
		createdAtEpochMs?: number,
	) => {
		const mutation = await mutateWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => {
			const created = addTaskToColumn(
				state.board,
				"backlog",
				{
					prompt,
					title: "[TEST]复核任务",
					baseRef: "main",
					worktreeMode,
					startInPlanMode: true,
					backlogTaskStartReadinessConditionsText: conditions,
				},
				() => globalThis.crypto.randomUUID(),
				createdAtEpochMs,
			);
			return { board: created.board, value: created.task.id };
		});
		const card = mutation.state.board.columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === mutation.value);
		if (!card) throw new Error("隔离卡片不存在");
		return card;
	};
	return {
		fixture,
		repository,
		context,
		scope,
		api,
		caller,
		evidence,
		sessions,
		persistCurrentSessionSummary,
		launches,
		add,
		setEnsuredTaskWorktreePath: (path: string) => {
			ensuredTaskWorktreePath = path;
		},
		loseNextLaunchResponse: () => {
			loseLaunchResponse = true;
		},
		rejectNextSpawn: () => {
			rejectNextSpawn = true;
		},
		delayInitialPromptAcceptance: () => {
			delayInitialPromptAcceptance = true;
		},
	};
}

describe("Backlog 开启复核的持久运行时链路", () => {
	it("按原受理时间区分不足 24 小时和达到 24 小时，直接启动跳过仓库和辅助 AI 复核", async () => {
		const h = await createHarness();
		const acceptedAtEpochMs = Date.now();
		const threshold = BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS;
		const recent = await h.add("近期无条件启动", undefined, "inplace", acceptedAtEpochMs - threshold + 1);
		const aged = await h.add("达到复核年龄的无条件任务", undefined, "inplace", acceptedAtEpochMs - threshold);
		writeFileSync(join(h.context.repoPath, "untracked-drift.txt"), "尚未提交的无关改动\n");
		model.respond.mockResolvedValue(null);
		const clock = vi.spyOn(Date, "now").mockReturnValue(acceptedAtEpochMs);
		try {
			const recentStart = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
				taskId: recent.id,
			});
			expect(recentStart.agentSessionStartOutcome).toBe("agent_session_started");
			expect(recentStart.taskCardSnapshotAfterAction.taskCard.backlogTaskStartReadinessReview).toBeUndefined();
			expect(model.respond).not.toHaveBeenCalled();
			expect(model.preferredRecovery).not.toHaveBeenCalled();
			const agedStart = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
				taskId: aged.id,
			});
			expect(agedStart.agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
			expect(model.respond).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
		expect(h.launches).toHaveLength(1);
	});

	it("创建时受理的启动在建卡时间较旧且仓库有改动时仍直接开始", async () => {
		const h = await createHarness();
		const acceptedAtEpochMs = Date.now();
		const card = await h.add(
			"创建并启动",
			undefined,
			"inplace",
			acceptedAtEpochMs - 2 * BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS,
		);
		writeFileSync(join(h.context.repoPath, "feature.ts"), "export const feature = 2;\n");
		model.respond.mockResolvedValue(null);
		const start = await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: card.id },
			h.evidence,
			async () => {},
			acceptedAtEpochMs,
		);
		expect(start.agentSessionStartOutcome).toBe("agent_session_started");
		expect(model.respond).not.toHaveBeenCalled();
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			acceptedAtEpochMs,
			reports: [],
			review: { phase: "started" },
		});
	});

	it("恢复器以原受理时间接续旧的启动等待，保留历史报告且只启动一次", async () => {
		const h = await createHarness();
		const card = await h.add(
			"不重复发送旧启动的首条内容",
			"旧复核记录",
			"inplace",
			Date.now() - 2 * BACKLOG_TASK_START_READINESS_RECENT_TASK_MAXIMUM_AGE_MS,
		);
		model.respond.mockResolvedValue({ ...ready(), conclusion: "conditions_not_met" });
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		const original = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		if (!original) throw new Error("缺少隔离环境的旧启动记录");
		await h.caller.taskCardAction.updateTaskCardFieldValues({
			taskId: card.id,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: { backlogTaskStartReadinessConditionsText: null },
			},
		});
		const acceptedAtEpochMs = card.createdAt + 1000;
		await writeBacklogTaskStartReadinessOperation({ ...original, acceptedAtEpochMs, nextAttemptAtEpochMs: 0 });
		model.respond.mockClear().mockResolvedValue(null);
		const recovery = createBacklogTaskStartReadinessRecovery({
			resolveScope: async () => h.scope,
			resume: (scope, record, assertStillOpen) =>
				h.api.startTaskCardAgentSessionMovingItIntoInProgress(
					scope,
					{
						...record.acceptedStartRequest,
						resumeBacklogTaskStartReadinessOperationId: record.review.operationId,
					},
					record.acceptedRequestOriginEvidence,
					assertStillOpen,
				),
			warn: (message) => process.stderr.write(`${message}\n`),
		});
		recovery.start();
		try {
			await expect.poll(() => h.launches.length).toBe(1);
		} finally {
			await recovery.close();
		}
		h.sessions.clear();
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		expect(h.launches).toHaveLength(1);
		expect(model.respond).not.toHaveBeenCalled();
		const recovered = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		expect(recovered).toMatchObject({
			acceptedAtEpochMs,
			startRequested: false,
			review: { operationId: original.review.operationId, phase: "started" },
			reports: original.reports,
		});
	});

	it("直接启动准备期间新增条件，进入复核后才允许启动", async () => {
		const h = await createHarness();
		const card = await h.add("启动前补充条件");
		await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: card.id },
			h.evidence,
			async () => {
				await h.caller.taskCardAction.updateTaskCardFieldValues({
					taskId: card.id,
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
						taskCardFieldValuePatch: { backlogTaskStartReadinessConditionsText: "等待依赖合入" },
					},
				});
			},
		);
		expect(h.launches).toHaveLength(0);
		expect(model.respond).not.toHaveBeenCalled();
		model.respond.mockResolvedValue({ ...ready(), conclusion: "conditions_not_met" });
		const held = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		expect(held.agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(held.taskCardSnapshotAfterAction.taskCard.backlogTaskStartReadinessReview?.phase).toBe(
			"conditions_not_met",
		);
		expect(h.launches).toHaveLength(0);
	});

	it("实际执行工作树的改动使原结果失效，并在重新核验后恢复", async () => {
		const h = await createHarness();
		const card = await h.add("核验执行目录", "确认任务工作树改动", "branch");
		const { worktreePath } = h.repository.createLinkedWorktree({
			worktreeDirectoryName: "isolated-readiness-execution",
			branchName: "readiness-execution",
		});
		const { path } = await getTaskWorkspacePathInfo({
			cwd: h.scope.workspacePath,
			taskId: card.id,
			baseRef: card.baseRef,
			worktreeMode: card.worktreeMode,
		});
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(worktreePath, path, "dir");
		h.setEnsuredTaskWorktreePath(path);
		model.respond.mockResolvedValue(ready());
		const invalidated = await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: card.id },
			h.evidence,
			async () => {
				writeFileSync(join(worktreePath, "feature.ts"), "export const feature = 2;\n");
			},
		);
		expect(invalidated.agentSessionStartOutcome).toBe("agent_session_start_failed");
		expect(h.launches).toHaveLength(0);
		const refreshed = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
			taskId: card.id,
		});
		expect(refreshed.agentSessionStartOutcome).toBe("agent_session_started");
		expect(h.launches).toHaveLength(1);
	});
	it("有活会话却缺原首发接受回执时等待核验，且不重发", async () => {
		const h = await createHarness();
		const card = await h.add("等待原首发接受");
		h.delayInitialPromptAcceptance();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		expect((await launch()).agentSessionStartOutcome).toBe("agent_session_started");
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(h.launches).toHaveLength(1);
		expect(
			(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt))?.review.phase,
		).toBe("waiting_for_evidence");
	});

	it("Codex 摘要缺少启动正文摘要时，仅沿原启动代次核对原生回执", async () => {
		const h = await createHarness();
		const card = await h.add("补证原始启动消息");
		h.delayInitialPromptAcceptance();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		await launch();
		const started = h.sessions.get(card.id);
		if (!started?.runtimeSessionIncarnationId) throw new Error("隔离会话缺少启动代次");
		const acceptedAtMs = Date.now();
		const nativeSessionId = globalThis.crypto.randomUUID();
		const transcriptPath = join(h.fixture.isolatedHomeDirectoryPath, "launch-transcript.jsonl");
		const nativeRecords = [
			{ type: "session_meta", payload: { id: nativeSessionId, cwd: started.workspacePath, source: "cli" } },
			{
				type: "event_msg",
				timestamp: new Date(acceptedAtMs).toISOString(),
				payload: {
					type: "item_completed",
					thread_id: nativeSessionId,
					turn_id: "startup-turn",
					item: {
						type: "UserMessage",
						id: "startup-message",
						content: [{ type: "text", text: h.launches[0] }],
					},
				},
			},
		];
		writeFileSync(transcriptPath, `${nativeRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const originalSession = runtimeTaskSessionSummarySchema.parse({
			...started,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: acceptedAtMs,
			},
			agentConversationPromptSubmissionAcceptance: {
				status: "accepted",
				attemptedAtMs: acceptedAtMs,
				confirmedAtMs: acceptedAtMs,
				runtimeSessionIncarnationId: started.runtimeSessionIncarnationId,
			},
		});
		h.sessions.set(card.id, { ...originalSession, runtimeSessionIncarnationId: globalThis.crypto.randomUUID() });
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		h.sessions.set(card.id, originalSession);
		expect((await launch()).agentSessionStartOutcome).toBe(
			"agent_session_already_in_agent_turn_so_start_was_skipped",
		);
		expect(h.launches).toHaveLength(1);
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			review: { phase: "started" },
			launchingSessionSnapshot: {
				agentConversationPromptSubmissionAcceptance: {
					eventId: `codex:${nativeSessionId}:startup-turn:startup-message`,
					submittedPromptSha256: submittedPromptSha256(h.launches[0] ?? ""),
				},
			},
		});
	});

	it("第三代摘要替换第二代摘要后，仍按已落盘的最早起点排除第二代同文消息", async () => {
		const h = await createHarness();
		const card = await h.add("拒绝后一代同文回执");
		h.delayInitialPromptAcceptance();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		await launch();
		const operation = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		const prepared = operation?.launchingSessionSnapshot;
		const launchTimestamp = operation?.agentProcessLaunchMayHaveBegunAtEpochMs;
		if (operation == null || !prepared?.runtimeSessionIncarnationId || launchTimestamp == null)
			throw new Error("缺少原启动快照");
		const nativeSessionId = globalThis.crypto.randomUUID();
		const laterStartedAt = launchTimestamp + 1_000;
		const transcriptPath = join(h.fixture.isolatedHomeDirectoryPath, "later-generation-transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({
				type: "session_meta",
				payload: { id: nativeSessionId, cwd: prepared.workspacePath, source: "cli" },
			})}\n${JSON.stringify({
				type: "event_msg",
				timestamp: new Date(laterStartedAt + 1_000).toISOString(),
				payload: {
					type: "item_completed",
					thread_id: nativeSessionId,
					turn_id: "later-generation-turn",
					item: {
						type: "UserMessage",
						id: "later-generation-message",
						content: [{ type: "text", text: h.launches[0] }],
					},
				},
			})}\n${launchReceiptTranscriptPagePadding.map((record) => JSON.stringify(record)).join("\n")}\n`,
		);
		await writeBacklogTaskStartReadinessOperation({
			...operation,
			launchingSessionSnapshot: {
				...prepared,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId,
					transcriptPath,
					observedAt: laterStartedAt,
				},
			},
		});
		const original = h.sessions.get(card.id);
		if (!original) throw new Error("缺少原会话");
		const secondGenerationSession = runtimeTaskSessionSummarySchema.parse({
			...original,
			runtimeSessionIncarnationId: globalThis.crypto.randomUUID(),
			startedAt: laterStartedAt,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: laterStartedAt,
			},
		});
		await h.persistCurrentSessionSummary(secondGenerationSession);
		const firstPageObservedAtMs = launchTimestamp + 10_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(firstPageObservedAtMs);
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			launchingSessionSnapshot: {
				agentConversationPromptSubmissionAcceptance: {
					verification: { reason: "scanning_native_transcript", exclusiveAcceptedBeforeMs: laterStartedAt },
				},
			},
		});
		await h.persistCurrentSessionSummary({
			...secondGenerationSession,
			runtimeSessionIncarnationId: globalThis.crypto.randomUUID(),
			startedAt: launchTimestamp + 5_000,
		});
		clock.mockReturnValue(firstPageObservedAtMs + 500);
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		clock.mockReturnValue(firstPageObservedAtMs + 1_000);
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(h.launches).toHaveLength(1);
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			startRequested: true,
			review: { phase: "waiting_for_evidence" },
			launchingSessionSnapshot: {
				runtimeSessionIncarnationId: prepared.runtimeSessionIncarnationId,
				agentConversationPromptSubmissionAcceptance: {
					status: "pending",
					verification: { reason: "no_matching_native_message", exclusiveAcceptedBeforeMs: laterStartedAt },
				},
			},
		});
	});

	it.each([false, true])("同代摘要变更后沿用原事件编号（后续带散列：%s）", async (hasPromptSha256) => {
		const h = await createHarness();
		const card = await h.add("保留原代次精确回执");
		h.delayInitialPromptAcceptance();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		await launch();
		const started = h.sessions.get(card.id);
		const operation = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		const launchTimestamp = operation?.agentProcessLaunchMayHaveBegunAtEpochMs;
		if (!started?.runtimeSessionIncarnationId || launchTimestamp == null) throw new Error("缺少原启动代次");
		const nativeSessionId = globalThis.crypto.randomUUID();
		const acceptedAtMs = launchTimestamp + 1;
		const transcriptPath = join(h.fixture.isolatedHomeDirectoryPath, "original-event-transcript.jsonl");
		const eventId = `codex:${nativeSessionId}:startup-turn:startup-message`;
		writeFileSync(
			transcriptPath,
			`${[
				{ type: "session_meta", payload: { id: nativeSessionId, cwd: started.workspacePath, source: "cli" } },
				...launchReceiptTranscriptPagePadding,
				{
					type: "event_msg",
					timestamp: new Date(acceptedAtMs).toISOString(),
					payload: {
						type: "item_completed",
						thread_id: nativeSessionId,
						turn_id: "startup-turn",
						item: {
							type: "UserMessage",
							id: "startup-message",
							content: [{ type: "text", text: h.launches[0] }],
						},
					},
				},
				{
					type: "event_msg",
					timestamp: new Date(acceptedAtMs + 2).toISOString(),
					payload: {
						type: "item_completed",
						thread_id: nativeSessionId,
						turn_id: "later-turn",
						item: {
							type: "UserMessage",
							id: "later-message",
							content: [{ type: "text", text: h.launches[0] }],
						},
					},
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const originalSession = runtimeTaskSessionSummarySchema.parse({
			...started,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath,
				observedAt: acceptedAtMs,
			},
			agentConversationPromptSubmissionAcceptance: {
				status: "accepted",
				attemptedAtMs: acceptedAtMs,
				confirmedAtMs: acceptedAtMs,
				eventId,
				runtimeSessionIncarnationId: started.runtimeSessionIncarnationId,
			},
		});
		await h.persistCurrentSessionSummary(originalSession);
		const firstPageObservedAtMs = launchTimestamp + 10_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(firstPageObservedAtMs);
		expect((await launch()).agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			launchingSessionSnapshot: {
				agentConversationPromptSubmissionAcceptance: {
					verification: { reason: "scanning_native_transcript", requiredNativeEventId: eventId },
				},
			},
		});
		await h.persistCurrentSessionSummary({
			...originalSession,
			agentConversationPromptSubmissionAcceptance: {
				status: "accepted",
				attemptedAtMs: acceptedAtMs + 2,
				confirmedAtMs: acceptedAtMs + 2,
				eventId: `codex:${nativeSessionId}:later-turn:later-message`,
				runtimeSessionIncarnationId: started.runtimeSessionIncarnationId,
				submittedPromptSha256: hasPromptSha256 ? submittedPromptSha256(h.launches[0] ?? "") : undefined,
			},
		});
		clock.mockReturnValue(firstPageObservedAtMs + 500);
		expect((await launch()).agentSessionStartOutcome).toBe(
			"agent_session_already_in_agent_turn_so_start_was_skipped",
		);
		expect(h.launches).toHaveLength(1);
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			review: { phase: "started" },
			launchingSessionSnapshot: {
				runtimeSessionIncarnationId: started.runtimeSessionIncarnationId,
				agentConversationPromptSubmissionAcceptance: { eventId },
			},
		});
	});

	it("下一代开始前的原代次同文记录仍可补证，下一代记录不参与唯一性", async () => {
		const h = await createHarness();
		const card = await h.add("只采纳原代次窗口内的回执");
		h.delayInitialPromptAcceptance();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		await launch();
		const operation = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		const prepared = operation?.launchingSessionSnapshot;
		const launchTimestamp = operation?.agentProcessLaunchMayHaveBegunAtEpochMs;
		const original = h.sessions.get(card.id);
		if (operation == null || !prepared?.runtimeSessionIncarnationId || launchTimestamp == null || !original)
			throw new Error("缺少原启动快照");
		const nativeSessionId = globalThis.crypto.randomUUID();
		const originalEventAt = launchTimestamp + 1;
		const laterStartedAt = launchTimestamp + 20;
		const transcriptPath = join(h.fixture.isolatedHomeDirectoryPath, "bounded-generation-transcript.jsonl");
		writeFileSync(
			transcriptPath,
			`${[
				{ type: "session_meta", payload: { id: nativeSessionId, cwd: prepared.workspacePath, source: "cli" } },
				{
					type: "event_msg",
					timestamp: new Date(originalEventAt).toISOString(),
					payload: {
						type: "item_completed",
						thread_id: nativeSessionId,
						turn_id: "startup-turn",
						item: {
							type: "UserMessage",
							id: "startup-message",
							content: [{ type: "text", text: h.launches[0] }],
						},
					},
				},
				{
					type: "event_msg",
					timestamp: new Date(laterStartedAt + 5).toISOString(),
					payload: {
						type: "item_completed",
						thread_id: nativeSessionId,
						turn_id: "later-generation-turn",
						item: {
							type: "UserMessage",
							id: "later-generation-message",
							content: [{ type: "text", text: h.launches[0] }],
						},
					},
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		await writeBacklogTaskStartReadinessOperation({
			...operation,
			launchingSessionSnapshot: {
				...prepared,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId,
					transcriptPath,
					observedAt: originalEventAt,
				},
			},
		});
		h.sessions.set(
			card.id,
			runtimeTaskSessionSummarySchema.parse({
				...original,
				runtimeSessionIncarnationId: globalThis.crypto.randomUUID(),
				startedAt: laterStartedAt,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId,
					transcriptPath,
					observedAt: laterStartedAt,
				},
			}),
		);
		expect((await launch()).agentSessionStartOutcome).toBe(
			"agent_session_already_in_agent_turn_so_start_was_skipped",
		);
		expect(h.launches).toHaveLength(1);
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			startRequested: false,
			review: { phase: "started" },
			launchingSessionSnapshot: {
				runtimeSessionIncarnationId: prepared.runtimeSessionIncarnationId,
				agentConversationPromptSubmissionAcceptance: {
					eventId: `codex:${nativeSessionId}:startup-turn:startup-message`,
				},
			},
		});
	});

	it("进程明确未创建时清除可能已启动标记，显式重试可启动", async () => {
		const h = await createHarness();
		const card = await h.add("允许明确失败后重试");
		h.rejectNextSpawn();
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		expect((await launch()).agentSessionStartOutcome).toBe("agent_session_start_failed");
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			agentProcessLaunchMayHaveBegunAtEpochMs: null,
			review: { phase: "start_failed" },
		});
		expect((await launch()).agentSessionStartOutcome).toBe("agent_session_started");
		expect(h.launches).toHaveLength(1);
	});
	it("大量无关变化触发 AI 复核，有限内容采集不会被解释成整个仓库不可用", async () => {
		const h = await createHarness();
		const card = await h.add("当前目标仍适用", "核验无关变化后开启");
		for (let index = 0; index < 201; index++)
			writeFileSync(join(h.context.repoPath, `unrelated-${index}.txt`), "无关材料\n");
		model.respond.mockResolvedValue(ready());
		const result = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		expect(result.agentSessionStartOutcome).toBe("agent_session_started");
		const report = (await h.caller.taskCardAction.readBacklogTaskStartReadinessReport({ taskId: card.id })).report;
		expect(report?.evidence.uncertaintyReasons).toContain("未跟踪文件超过受限采集范围。");
		expect(h.launches).toHaveLength(1);
	});
	it("启动边界保留 Stop 撤销，运行时关闭则可由后继实例安全接续", async () => {
		const h = await createHarness();
		model.respond.mockResolvedValue(ready());
		const stopped = await h.add("spawn 前被 Stop");
		await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: stopped.id },
			h.evidence,
			async () => {
				await recordTaskEditorCreationExplicitStop(h.scope.workspaceId, stopped.id, stopped.createdAt);
			},
		);
		expect(h.launches).toHaveLength(0);
		expect(
			(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, stopped.id, stopped.createdAt))?.review
				.phase,
		).toBe("stopped");
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: stopped.id });
		expect(h.launches).toHaveLength(1);
		const closing = await h.add("spawn 前运行时关闭");
		await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: closing.id },
			h.evidence,
			async () => {
				throw new BacklogTaskStartReadinessRuntimeClosingError();
			},
		);
		const record = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, closing.id, closing.createdAt);
		expect(record?.agentProcessLaunchMayHaveBegunAtEpochMs).toBeNull();
		expect(record?.review.phase).toBe("waiting_for_evidence");
		await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: closing.id, resumeBacklogTaskStartReadinessOperationId: record?.review.operationId },
			h.evidence,
		);
		expect(h.launches).toHaveLength(2);
	});
	it("显式启动担保同一次搁置，重新搁置后原启动不能自动解除搁置", async () => {
		const harness = await createHarness();
		const card = await harness.add("核验显式启动搁置任务", "需要复核开启条件");
		const start = { taskId: card.id, expectedTaskIncarnationCreatedAtEpochMs: card.createdAt };
		const setShelved = (isShelved: boolean) =>
			harness.caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({ ...start, isShelved });
		await setShelved(true);
		model.respond.mockResolvedValueOnce(null).mockResolvedValue(ready());
		const waiting = await harness.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress(start);
		expect(waiting.agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(waiting.taskCardSnapshotAfterAction.taskCard.taskShelvingState?.isShelved).toBe(true);
		const operationId = waiting.taskCardSnapshotAfterAction.taskCard.backlogTaskStartReadinessReview?.operationId;
		expect(operationId).toBeDefined();

		await setShelved(false);
		await setShelved(true);
		await expect(
			harness.api.startTaskCardAgentSessionMovingItIntoInProgress(
				harness.scope,
				{ ...start, resumeBacklogTaskStartReadinessOperationId: operationId },
				harness.evidence,
				async () => {},
			),
		).rejects.toThrow("任务已搁置");
		expect(harness.launches).toHaveLength(0);
		const started = await harness.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress(start);
		expect(started.agentSessionStartOutcome).toBe("agent_session_started");
		expect(started.taskCardSnapshotAfterAction.taskCard.taskShelvingState?.isShelved).toBe(false);
		expect(harness.launches).toHaveLength(1);
	});

	it("迁移时保留原 Stop，即使目标项目已存在独立评估记录", async () => {
		const h = await createHarness();
		const card = await h.add("迁移前需要补证", "等待依赖");
		model.respond.mockResolvedValue(null);
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		const original = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		if (!original) throw new Error("原项目缺少待处理的受理记录");
		const destination = { workspaceId: "isolated-migration-target", workspacePath: h.scope.workspacePath };
		const independentAssessment = {
			...original,
			...destination,
			startRequested: false,
			review: { ...original.review, operationId: globalThis.crypto.randomUUID() },
		};
		await writeBacklogTaskStartReadinessOperation(independentAssessment);
		await recordTaskEditorCreationExplicitStop(h.scope.workspaceId, card.id, card.createdAt);
		expect(await transferBacklogTaskStartReadinessIntentAfterMigration(destination, original)).toBeNull();
		expect(
			await readBacklogTaskStartReadinessOperation(destination.workspaceId, card.id, card.createdAt),
		).toMatchObject({ startRequested: false, review: { operationId: independentAssessment.review.operationId } });
		expect(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt)).toMatchObject({
			startRequested: false,
			review: { phase: "stopped" },
		});
	});

	it("路由冷却期间保留尝试预算，冷却到期后继续原启动", async () => {
		const h = await createHarness();
		const card = await h.add("等待模型恢复", "复核依赖");
		const launch = () => h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		model.respond.mockResolvedValue(null);
		await launch();
		model.preferredRecovery.mockResolvedValue({ cooldownUntilEpochMs: Date.now() + 60_000 });
		await launch();
		await launch();
		expect(model.respond).toHaveBeenCalledTimes(1);
		model.preferredRecovery.mockResolvedValue({ cooldownUntilEpochMs: Date.now() - 1 });
		model.respond.mockResolvedValue(ready());
		expect((await launch()).agentSessionStartOutcome).toBe("agent_session_started");
	});

	it("同批卡片正常移列不使并发复核失效", async () => {
		const h = await createHarness();
		const first = await h.add("同批第一张", "条件已满足");
		const second = await h.add("同批第二张", "条件已满足");
		model.respond.mockResolvedValue(ready());
		const results = await Promise.all(
			[first, second].map((card) =>
				h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id }),
			),
		);
		expect(results.map((result) => result.agentSessionStartOutcome)).toEqual([
			"agent_session_started",
			"agent_session_started",
		]);
		expect(h.launches).toHaveLength(2);
	});
	it("历史缺失、分叉、baseRef 和仓库归属变化均保留覆盖未知，补证不会执行任意命令", async () => {
		const h = await createHarness();
		const card = await h.add("核验历史漂移");
		writeFileSync(join(h.context.repoPath, "unrelated.txt"), "与原需求无关的新增工作\n");
		h.repository.commitAllRepositoryFilesAtDate({
			message: "新增工作",
			authorAndCommitterIsoDate: "2026-02-01T00:00:00Z",
		});
		const board = (await loadPersistedWorkspaceStateById(h.scope.workspaceId)).board;
		const collect = (candidate: typeof card) =>
			collectBacklogTaskStartReadinessEvidence({
				workspaceId: h.scope.workspaceId,
				repositoryPath: h.scope.workspacePath,
				card: candidate,
				board,
			});
		const changed = await collect(card);
		expect(changed.historyCoverage).toBe("complete");
		expect(changed.commitCountSinceCreation).toBe(1);
		expect(changed.changedRepositoryPaths).toContain("unrelated.txt");
		expect((await collect({ ...card, backlogTaskCreationRepositoryBaseline: undefined })).historyCoverage).toBe(
			"unknown",
		);
		if (!card.backlogTaskCreationRepositoryBaseline) throw new Error("创建基线缺失");
		expect(
			(
				await collect({
					...card,
					backlogTaskCreationRepositoryBaseline: {
						...card.backlogTaskCreationRepositoryBaseline,
						commit: "f".repeat(40),
					},
				})
			).historyCoverage,
		).toBe("unknown");
		h.repository.runGit(["branch", "alternative"]);
		expect((await collect({ ...card, baseRef: "alternative" })).historyCoverage).toBe("base_ref_changed");
		expect(
			(
				await collect({
					...card,
					backlogTaskCreationRepositoryBaseline: {
						...card.backlogTaskCreationRepositoryBaseline,
						workspaceId: "prior-project",
					},
				})
			).historyCoverage,
		).toBe("repository_changed");
		const lookup = await readRestrictedBacklogTaskReadinessEvidence({
			repositoryPath: h.context.repoPath,
			board,
			kind: "read_repository_file",
			reference: "../../auth.json",
		});
		expect(lookup).toHaveProperty("unavailableReason");
		const commandLikeSearch = await readRestrictedBacklogTaskReadinessEvidence({
			repositoryPath: h.context.repoPath,
			board,
			kind: "search_repository",
			reference: "$(touch outside-repository)",
		});
		expect(commandLikeSearch).toHaveProperty("available", true);
	});
	it("补证预算跨请求持久保留，耗尽后等待依赖变化，恢复后沿原意图开启", async () => {
		const h = await createHarness();
		const card = await h.add("等待机器补证", "核验 feature.ts");
		model.respond.mockResolvedValue({
			...ready(),
			conclusion: "waiting_for_evidence",
			summary: "等待更多代码证据。",
			readOnlyEvidenceRequests: [{ kind: "read_repository_file", reference: "feature.ts" }],
		});
		for (let attempt = 0; attempt < 4; attempt++)
			await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		const persisted = await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, card.id, card.createdAt);
		expect(persisted?.completedReadOnlyRoundCount).toBe(3);
		expect(persisted?.readOnlyEvidence).toHaveLength(3);
		expect(persisted?.sameDependencyAttemptCount).toBe(3);
		expect(model.respond).toHaveBeenCalledTimes(6);
		expect(h.launches).toHaveLength(0);
		writeFileSync(join(h.context.repoPath, "feature.ts"), "export const feature = 2;\n");
		model.respond.mockResolvedValue(ready());
		await h.api.startTaskCardAgentSessionMovingItIntoInProgress(
			h.scope,
			{ taskId: card.id, resumeBacklogTaskStartReadinessOperationId: persisted?.review.operationId },
			h.evidence,
		);
		expect(h.launches).toHaveLength(1);
	});
	it("新建无漂移直接通过；独立评估不启动；未满足条件留在 Backlog，显式覆盖有依据", async () => {
		const h = await createHarness();
		model.respond.mockResolvedValue(ready());
		const first = await h.add("新建无漂移");
		expect(first.backlogTaskCreationRepositoryBaseline?.commit).toMatch(/^[0-9a-f]{40}$/u);
		const started = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
			taskId: first.id,
		});
		expect(started.agentSessionStartOutcome).toBe("agent_session_started");
		expect(model.respond).not.toHaveBeenCalled();
		const conditional = await h.add("依赖后开启", "依赖尚未合入时等待");
		model.respond.mockResolvedValue({ ...ready(), conclusion: "conditions_not_met", summary: "依赖未合入。" });
		const assessed = await h.caller.taskCardAction.assessBacklogTaskStartReadiness({ taskId: conditional.id });
		expect(h.launches).toHaveLength(1);
		expect(
			(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, conditional.id, conditional.createdAt))
				?.startRequested,
		).toBe(false);
		const held = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
			taskId: conditional.id,
		});
		expect(held.agentSessionStartOutcome).toBe("backlog_task_start_readiness_review_pending");
		expect(held.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("backlog");
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
			taskId: conditional.id,
			overrideUnmetBacklogTaskStartConditions: {
				operationId: assessed.review.operationId,
				reason: "已确认可先推进独立部分",
			},
		});
		expect(h.launches).toHaveLength(2);
		expect(
			(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, conditional.id, conditional.createdAt))
				?.conditionOverrides,
		).toHaveLength(1);
	});
	it("部分完成修订同目标剩余工作，保留原 Prompt；回执丢失后不会重复首发", async () => {
		const h = await createHarness();
		const card = await h.add("原始需求与来源保持不变", "复核现有实现");
		model.respond.mockResolvedValue({
			...ready(),
			conclusion: "revise_remaining_work",
			remainingWorkRevision: {
				title: "[FIX]完成剩余边界",
				taskDescription: "已有核心功能，仅补齐边界",
				currentExecutionInstructions: "只实现尚未覆盖的边界，并遵守原授权。",
			},
		});
		h.loseNextLaunchResponse();
		await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: card.id });
		const state = await loadPersistedWorkspaceStateById(h.scope.workspaceId);
		const revised = state.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === card.id);
		expect(revised?.prompt).toBe(card.prompt);
		expect(revised?.title).toBe("[FIX]完成剩余边界");
		expect(h.launches[0]).toContain(card.prompt);
		expect(h.launches[0]).toContain("只实现尚未覆盖的边界");
		h.sessions.clear();
		const reconciled = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
			taskId: card.id,
		});
		expect(reconciled.agentSessionStartOutcome).toBe("agent_session_already_in_agent_turn_so_start_was_skipped");
		expect(h.launches).toHaveLength(1);
	});
	it("全部完成不启动不结案；并发编辑与 Stop 使旧结果失效", async () => {
		const h = await createHarness();
		const done = await h.add("已有完整实现", "核验当前代码");
		model.respond.mockResolvedValue({
			...ready(),
			conclusion: "no_remaining_work",
			summary: "当前代码已覆盖全部需求。",
		});
		const result = await h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: done.id });
		expect(result.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("backlog");
		expect(h.launches).toHaveLength(0);
		model.respond.mockResolvedValue(ready());
		await h.caller.taskCardAction.updateTaskCardFieldValues({
			taskId: done.id,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: { taskDescription: "补充新的待评估说明" },
			},
		});
		await h.caller.taskCardAction.assessBacklogTaskStartReadiness({ taskId: done.id });
		expect(
			(await readBacklogTaskStartReadinessOperation(h.scope.workspaceId, done.id, done.createdAt))?.startRequested,
		).toBe(false);
		const edited = await h.add("复核中被编辑", "核验当前代码");
		model.respond.mockImplementationOnce(async () => {
			await h.caller.taskCardAction.updateTaskCardFieldValues({
				taskId: edited.id,
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: { prompt: "用户新的有效说明" },
				},
			});
			return ready();
		});
		await expect(
			h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: edited.id }),
		).rejects.toThrow("旧结果失效");
		const stopped = await h.add("复核中 Stop", "核验当前代码");
		model.respond.mockImplementationOnce(async () => {
			await recordTaskEditorCreationExplicitStop(h.scope.workspaceId, stopped.id, stopped.createdAt);
			return ready();
		});
		await expect(
			h.caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: stopped.id }),
		).rejects.toThrow("Stop");
		expect(h.launches).toHaveLength(0);
	});
});
