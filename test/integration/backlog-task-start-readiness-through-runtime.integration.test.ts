import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submittedPromptSha256 } from "../../src/agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import {
	collectBacklogTaskStartReadinessEvidence,
	readRestrictedBacklogTaskReadinessEvidence,
} from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-evidence";
import {
	readBacklogTaskStartReadinessOperation,
	writeBacklogTaskStartReadinessOperation,
} from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-operation-store";
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
	model.preferredRecovery.mockResolvedValue(null);
});
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
				sessions.set(request.taskId, summary);
				await mutateWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: state.board,
					sessions: { ...state.sessions, [request.taskId]: summary },
					value: null,
				}));
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
	const add = async (prompt: string, conditions?: string, worktreeMode: "inplace" | "branch" = "inplace") => {
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
		const stopped = await h.add("spawn 前被 Stop", "条件已经满足");
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
		const closing = await h.add("spawn 前运行时关闭", "条件已经满足");
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
