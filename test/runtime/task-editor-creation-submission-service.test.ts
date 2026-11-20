import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClientConnectionRuntime } from "../../src/acp-client-session/acp-client-connection-runtime";
import { AcpTaskSessionService } from "../../src/acp-client-session/acp-task-session-service";
import type { RuntimeBoardCard, RuntimeTaskCardActionStartAgentSessionResponse } from "../../src/core/api-contract";
import { resolveCreationStartupSettings } from "../../src/core/creation-startup-settings";
import { assignCrossProjectTaskSwitcherSections } from "../../src/core/cross-project-recently-active-task-switcher-section-assignment";
import {
	type TaskEditorCreationSubmissionRequest,
	taskEditorCreationSubmissionRequestSchema,
} from "../../src/core/task-editor-creation-submission-contract";
import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { buildInterWorkUnitRelationWorkUnitKey } from "../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import * as liveRelationProjection from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { createEmptyRecordedInterWorkUnitRelationProjectionState } from "../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "../../src/server/cross-project-task-switcher-entry-projection";
import { extractTaskSessionFactsForCrossProjectTaskViews } from "../../src/server/in-progress-task-detail-projection";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
} from "../../src/state/workspace-state";
import { createTaskEditorCreationSubmissionService } from "../../src/task-editor-creation/task-editor-creation-submission-service";
import {
	readTaskEditorCreationAgentStartupProgressByTaskId,
	readTaskEditorCreationSubmission,
	recordTaskEditorCreationExplicitStop,
} from "../../src/task-editor-creation/task-editor-creation-submission-store";
import { persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart } from "../../src/trpc/web-ui-new-backlog-task-card-persistence-before-agent-session-start-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const evidence: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};
const characteristics = {
	triggeringDomEventIsTrusted: true,
	navigatorWebdriver: true,
	navigatorUserAgent: "隔离自动化",
};
const services: ReturnType<typeof createTaskEditorCreationSubmissionService>[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	vi.unstubAllEnvs();
});

async function scenario() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
	const scopes: Array<{ workspaceId: string; workspacePath: string }> = [];
	for (const name of ["creation-source", "creation-target"]) {
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: name, initialBranchName: "main" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离创建回归\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		await loadWorkspaceState(repository.repositoryPath);
		const context = await loadWorkspaceContext(repository.repositoryPath);
		scopes.push({ workspaceId: context.workspaceId, workspacePath: repository.repositoryPath });
	}
	const [source, target] = scopes;
	if (!source || !target) throw new Error("隔离项目初始化失败");
	let dependenciesVersion = 1;
	let removed = false;
	const broadcasts = { broadcastRuntimeWorkspaceStateUpdated: vi.fn(), broadcastRuntimeProjectsUpdated: vi.fn() };
	const persist = vi.fn(
		async (scope: typeof source, card: RuntimeBoardCard, origin: KanbanRequestOriginActorEvidence) =>
			persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(
				broadcasts,
				scope,
				{
					newBacklogTaskCardsCreatedFromWebUi: [card],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				},
				origin,
			),
	);
	const applyRelations = vi.fn(async (): Promise<void> => undefined);
	const start = vi.fn(
		async (
			_scope: typeof source,
			card: RuntimeBoardCard,
			_record: unknown,
			beforeLaunch: () => Promise<void>,
		): Promise<RuntimeTaskCardActionStartAgentSessionResponse> => {
			await beforeLaunch();
			return {
				agentSessionStartOutcome: "agent_session_started",
				agentSessionStartFailureMessage: null,
				ensuredTaskWorktreeWarningMessage: null,
				startedAgentSessionSummary: null,
				boardColumnIdOfTaskCardBeforeAction: "backlog",
				taskCardWasMovedIntoInProgressColumnByThisAction: true,
				taskCardSnapshotAfterAction: {
					taskCard: card,
					boardColumnIdContainingTaskCard: "in_progress",
					taskSessionSummaryLiveInRuntimeProcessMemory: null,
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				},
			};
		},
	);
	const warnings = vi.fn();
	const onStatusChanged = vi.fn();
	const resolveIdentity = vi.fn(async (_workspaceId: string, snapshot: Pick<RuntimeBoardCard, "id" | "createdAt">) => {
		for (const scope of scopes) {
			const card = (await loadPersistedWorkspaceStateById(scope.workspaceId)).board.columns
				.flatMap((column) => column.cards)
				.find((entry) => entry.id === snapshot.id);
			if (card)
				return {
					workspaceId: scope.workspaceId,
					taskIncarnationCreatedAtEpochMs: card.createdAt,
					permanentlyRemoved: removed,
					workspaceIdsUsedByTaskIncarnation: scopes.map((entry) => entry.workspaceId),
				};
		}
		return null;
	});
	const makeService = (
		resolveCreationSettings?: Parameters<
			typeof createTaskEditorCreationSubmissionService
		>[0]["resolveCreationSettings"],
	) => {
		const service = createTaskEditorCreationSubmissionService({
			resolveCreationSettings,
			resolveIdentity,
			persistCard: persist,
			applyAcceptedRelations: applyRelations,
			startAgent: start,
			readDependencyFingerprint: async () => dependenciesVersion,
			warn: warnings,
			onStatusChanged,
		});
		services.push(service);
		return service;
	};
	const service = makeService();
	const request = (id = "new01", withRelations = true): TaskEditorCreationSubmissionRequest => ({
		submissionId: randomUUID(),
		newTaskCard: {
			id,
			title: `任务 ${id}`,
			prompt: `原始正文 ${id}`,
			taskDescription: `独立简介 ${id}`,
			baseRef: "main",
			startInPlanMode: true,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		},
		referenceRelationDrafts: withRelations
			? [
					{
						draftId: "relation-1",
						replacesRelationId: null,
						expectedAssertedRelationStateVersion: null,
						counterpartWorkUnit: {
							workUnitType: "kanban_board_card",
							workspaceId: target.workspaceId,
							taskId: "other",
							taskIncarnationCreatedAtEpochMs: 123,
						},
						relationKind: "reference_is_generally_related_with",
						currentTaskIsStatementSubject: true,
						relationAssertionRationaleOneSentence: "保留原来的关联",
						relationAssertionEvidencePointers: [],
						assertedRelationKindSpecificAttributes: {},
					},
				]
			: [],
		relationRevocations: [],
		startAgentAfterCreation: true,
		webUiUserDecisionClientCharacteristics: characteristics,
	});
	const mutateCard = async (scope: typeof source, id: string, patch: Partial<RuntimeBoardCard>) =>
		mutateWorkspaceState(scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: {
				...state.board,
				columns: state.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => (card.id === id ? { ...card, ...patch } : card)),
				})),
			},
			value: null,
		}));
	return {
		readStartupProgress: (workspaceId: string) =>
			readTaskEditorCreationAgentStartupProgressByTaskId(workspaceId, (status) =>
				resolveIdentity(status.workspaceId, {
					id: status.taskId,
					createdAt: status.taskIncarnationCreatedAtEpochMs,
				}),
			),
		recordPath: (submissionId: string) =>
			join(
				fixture.isolatedHomeDirectoryPath,
				".cline",
				"kanban",
				"task-editor-creation-submissions",
				`${submissionId}.json`,
			),
		warnings,
		onStatusChanged,
		resolveIdentity,
		source,
		target,
		service,
		makeService,
		request,
		persist,
		applyRelations,
		start,
		mutateCard,
		changeDependencies: () => dependenciesVersion++,
		removeIdentity: () => {
			removed = true;
		},
	};
}

describe("编辑器持久创建提交", { timeout: 30000 }, () => {
	it("保存确认与阻塞启动即时通知，持久进度按项目恢复，Stop 立即排除旧记录", async () => {
		const test = await scenario();
		let releaseStart = () => {};
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		test.start.mockImplementation(async () => {
			await startGate;
			throw new Error("隔离启动暂不可用");
		});
		const request = test.request("start", false);
		await test.service.submit(test.target, request, evidence);
		try {
			await expect
				.poll(async () => (await test.readStartupProgress(test.target.workspaceId)).get("start")?.phase)
				.toBe("starting_agent");
			expect(test.onStatusChanged).toHaveBeenCalled();
			expect(await test.readStartupProgress(test.source.workspaceId)).toEqual(new Map());
			expect((await test.readStartupProgress(test.target.workspaceId)).get("start")).toMatchObject({
				cardPersisted: true,
				startRequested: true,
				startCompleted: false,
			});
			await recordTaskEditorCreationExplicitStop(test.target.workspaceId, "start", request.newTaskCard.createdAt);
			expect(await test.readStartupProgress(test.target.workspaceId)).toEqual(new Map());
		} finally {
			releaseStart();
			await test.service.settle();
		}
	});

	it("创建提交契约与持久卡片保留独立 Codex effort ", async () => {
		const test = await scenario();
		const request = test.request("eff01", false);
		Object.assign(request.newTaskCard, {
			agentId: "codex",
			codexReasoningEffortOverride: "ultra",
		});
		const parsed = taskEditorCreationSubmissionRequestSchema.parse(request);
		expect(parsed.newTaskCard).toMatchObject({
			codexReasoningEffortOverride: "ultra",
		});
		await test.service.submit(test.source, parsed, evidence);
		await test.service.settle();
		const card = (await loadPersistedWorkspaceStateById(test.source.workspaceId)).board.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === "eff01");
		expect(card).toMatchObject({
			codexReasoningEffortOverride: "ultra",
			taskDescription: request.newTaskCard.taskDescription,
			prompt: request.newTaskCard.prompt,
		});
	});
	it("默认模型与启动设置先持久冻结，建卡失败及新实例恢复不重新套用默认值", async () => {
		const test = await scenario();
		const defaults = vi.fn(async () =>
			resolveCreationStartupSettings({
				agentId: "codex",
				startInPlanMode: false,
				defaultModelId: "creation-default-model",
			}),
		);
		const service = test.makeService(defaults);
		const input = test.request("new01", false);
		test.persist.mockRejectedValueOnce(new Error("写盘暂不可用"));
		await service.submit(test.source, input, evidence);
		await service.settle();
		expect(defaults).toHaveBeenCalledTimes(1);
		expect(test.persist.mock.calls.at(-1)?.[1]).toMatchObject({
			startInPlanMode: false,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "creation-default-model" },
		});
		const record = await readTaskEditorCreationSubmission(test.source.workspaceId, input.submissionId);
		expect(record?.request.newTaskCard.terminalAgentModelOverrideSettings).toBeUndefined();
		expect(record?.status.resolvedSettings?.modelId.value).toBe("creation-default-model");
		await service.close();
		const restored = test.makeService(defaults);
		await restored.submit(test.source, input, evidence);
		await restored.settle();
		expect(defaults).toHaveBeenCalledTimes(1);
	});
	it("A 的关系失败后，B 在另一项目独立建卡；重试不覆盖 A 的新字段", async () => {
		const test = await scenario();
		test.applyRelations.mockRejectedValue(new Error("账本暂不可用"));
		const a = test.request();
		await test.service.submit(test.source, a, evidence);
		await test.service.settle();
		expect(test.applyRelations).toHaveBeenCalledTimes(3);
		expect(test.start).not.toHaveBeenCalled();
		expect((await test.service.getStatus(test.source, a))?.cardPersisted).toBe(true);
		await test.mutateCard(test.source, a.newTaskCard.id, { title: "A 后来的名称", prompt: "A 后来的正文" });
		const b = test.request("new02", false);
		await test.service.submit(test.target, b, evidence);
		await test.service.settle();
		await test.service.submit(test.source, a, evidence);
		await test.service.settle();
		const stateA = await loadPersistedWorkspaceStateById(test.source.workspaceId);
		expect(stateA.board.columns.flatMap((column) => column.cards)).toEqual([
			expect.objectContaining({ id: "new01", title: "A 后来的名称", prompt: "A 后来的正文" }),
		]);
		expect(stateA.sessions).toEqual({});
		expect(
			(await loadPersistedWorkspaceStateById(test.target.workspaceId)).board.columns.flatMap(
				(column) => column.cards,
			),
		).toHaveLength(1);
		expect(test.start).toHaveBeenCalledTimes(1);
		await expect(
			test.service.submit(
				test.source,
				{ ...a, newTaskCard: { ...a.newTaskCard, prompt: "不能复用提交 ID" } },
				evidence,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("保存响应丢失和重复受理仍只保存一张卡、启动一次", async () => {
		const test = await scenario();
		const request = test.request("lost1", false);
		const originalPersist = test.persist.getMockImplementation();
		if (!originalPersist) throw new Error("缺少隔离持久化实现");
		test.persist.mockImplementationOnce(async (...args) => {
			await originalPersist(...args);
			throw new Error("保存响应丢失");
		});
		await Promise.all([
			test.service.submit(test.source, request, evidence),
			test.service.submit(test.source, request, evidence),
		]);
		await test.service.settle();
		expect(test.persist).toHaveBeenCalledTimes(1);
		expect(test.start).toHaveBeenCalledTimes(1);
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("completed");
	});
	it("保存即发布确认，关系仍在等待；没有关系成功证据时不启动", async () => {
		const test = await scenario();
		const request = test.request();
		let finishRelations!: () => void;
		test.applyRelations.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishRelations = resolve;
				}),
		);
		await test.service.submit(test.source, request, evidence);
		await vi.waitFor(async () =>
			expect((await test.service.getStatus(test.source, request))?.cardPersisted).toBe(true),
		);
		expect(test.start).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(finishRelations).toBeTypeOf("function"));
		finishRelations();
		await test.service.settle();
		expect(test.start).toHaveBeenCalledTimes(1);
	});
	it("三次失败后等待条件变化，依赖恢复及新运行时自动接续", async () => {
		const test = await scenario();
		const request = test.request();
		test.applyRelations.mockRejectedValue(new Error("依赖不可用"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		await test.service.sweep();
		await test.service.settle();
		expect(test.applyRelations).toHaveBeenCalledTimes(3);
		test.changeDependencies();
		await test.service.sweep();
		await test.service.settle();
		expect(test.applyRelations).toHaveBeenCalledTimes(6);
		await test.service.close();
		test.applyRelations.mockResolvedValue(undefined);
		const restarted = test.makeService();
		await restarted.sweep();
		await restarted.settle();
		expect((await restarted.getStatus(test.source, request))?.phase).toBe("completed");
		expect(test.start).toHaveBeenCalledTimes(1);
	});
	it.each(["Stop", "搁置", "同 ID 新身份"])("%s 阻止后续执行", async (kind) => {
		const test = await scenario();
		const request = test.request();
		test.applyRelations.mockRejectedValue(new Error("稍后恢复"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		if (kind === "Stop")
			await recordTaskEditorCreationExplicitStop(
				test.source.workspaceId,
				request.newTaskCard.id,
				request.newTaskCard.createdAt,
			);
		else if (kind === "搁置")
			await test.mutateCard(test.source, request.newTaskCard.id, {
				taskShelvingState: { isShelved: true, lastChangedAt: Date.now() },
			});
		else
			await test.mutateCard(test.source, request.newTaskCard.id, {
				createdAt: request.newTaskCard.createdAt + 1,
				title: "新一世卡片",
			});
		test.applyRelations.mockResolvedValue(undefined);
		test.changeDependencies();
		await test.service.sweep();
		await test.service.settle();
		expect(test.start).not.toHaveBeenCalled();
		if (kind === "搁置") {
			await test.mutateCard(test.source, request.newTaskCard.id, {
				taskShelvingState: { isShelved: false, lastChangedAt: Date.now() },
			});
			await test.service.sweep();
			await test.service.settle();
			expect(test.start).toHaveBeenCalledTimes(1);
		}
	});
	it("可能启动后崩溃保持未知，重启只补证、不重复投递 Initial Prompt", async () => {
		const test = await scenario();
		const request = test.request("maybe", false);
		test.start.mockImplementationOnce(async (_scope, _card, _record, beforeLaunch) => {
			await beforeLaunch();
			throw new Error("启动响应丢失");
		});
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("waiting_for_evidence");
		await test.service.close();
		const restarted = test.makeService();
		await restarted.sweep();
		await restarted.settle();
		expect(test.start).toHaveBeenCalledTimes(1);
		await test.mutateCard(test.source, request.newTaskCard.id, { mostRecentlyLaunchedAgentSessionAgentId: "codex" });
		await restarted.sweep();
		await restarted.settle();
		expect((await restarted.getStatus(test.source, request))?.phase).toBe("completed");
		expect(test.start).toHaveBeenCalledTimes(1);
	});
	it("未到真正启动边界的失败可以有界重试", async () => {
		const test = await scenario();
		const request = test.request("retry", false);
		test.start.mockRejectedValueOnce(new Error("启动配置暂不可用"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect(test.start).toHaveBeenCalledTimes(2);
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("completed");
	});
	it("旧草稿只迁移恢复记录，不改原任务，也不猜测启动意图", async () => {
		const test = await scenario();
		const request = test.request("old01", false);
		request.startAgentAfterCreation = false;
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		const legacy = await test.service.migrateLegacyDraft(test.source.workspaceId, {
			createdTaskId: "old01",
			createdTaskWorkspaceId: test.source.workspaceId,
			createdTaskCardSnapshot: request.newTaskCard,
			creationPrompt: "后来填写的新正文",
			creationTitle: "新任务名称",
			modelingSubmissionId: "legacy-original-request",
			referenceRelationDrafts: test.request().referenceRelationDrafts,
			relationRevocations: [],
		});
		expect(legacy.createdTaskId).toBeNull();
		const records = await test.service.listForTask(test.source, {
			taskId: "old01",
			taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt,
		});
		const recovery = records.find((entry) => entry.phase === "waiting_for_authorization");
		if (!recovery) throw new Error("旧草稿恢复记录缺失");
		expect(legacy.creationPrompt).toBe("后来填写的新正文");
		expect(recovery.startRequested).toBe(false);
		expect(test.start).not.toHaveBeenCalled();
		const stored = await readTaskEditorCreationSubmission(test.source.workspaceId, recovery.submissionId);
		expect(stored?.request.referenceRelationDrafts).toHaveLength(1);
		expect(stored?.relationModelingSubmissionId).toBe("legacy-original-request");
		expect(
			(await loadPersistedWorkspaceStateById(test.source.workspaceId)).board.columns.flatMap(
				(column) => column.cards,
			)[0]?.prompt,
		).toBe(request.newTaskCard.prompt);
	});
	it("损坏身份绑定不会执行，也不阻塞其他创建提交", async () => {
		const test = await scenario();
		const original = test.request("bind1", false);
		original.startAgentAfterCreation = false;
		await test.service.submit(test.source, original, evidence);
		await test.service.settle();
		const path = test.recordPath(original.submissionId);
		const record = JSON.parse(await readFile(path, "utf8"));
		record.status.taskId = "other";
		await writeFile(path, JSON.stringify(record));
		const restarted = test.makeService();
		await restarted.sweep();
		await restarted.settle();
		await expect(restarted.getStatus(test.source, original)).rejects.toThrow("冻结输入");
		const next = test.request("bind2", false);
		next.startAgentAfterCreation = false;
		await restarted.submit(test.target, next, evidence);
		await restarted.settle();
		expect((await restarted.getStatus(test.target, next))?.phase).toBe("completed");
		await restarted.sweep();
		await restarted.settle();
		expect(test.warnings).toHaveBeenCalledTimes(1);
	});

	it("同一提交不能跨项目改用冻结身份", async () => {
		const test = await scenario();
		const request = test.request("scope", false);
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		await expect(test.service.submit(test.target, request, evidence)).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			(await loadPersistedWorkspaceStateById(test.target.workspaceId)).board.columns.flatMap(
				(column) => column.cards,
			),
		).toHaveLength(0);
	});

	it("启动准备期间发生 Stop，在真正启动边界再次检查", async () => {
		const test = await scenario();
		const request = test.request("stop2", false);
		const launched = vi.fn();
		test.start.mockImplementationOnce(async (scope, card, _record, beforeLaunch) => {
			await recordTaskEditorCreationExplicitStop(scope.workspaceId, card.id, card.createdAt);
			await beforeLaunch();
			launched();
			throw new Error("不应运行到这里");
		});
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect(launched).not.toHaveBeenCalled();
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("stopped");
	});

	it("没有页面授权或使用合成手势时不受理，也不创建卡片", async () => {
		const test = await scenario();
		const request = test.request();
		await expect(
			test.service.submit(test.source, request, {
				decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			test.service.submit(
				test.source,
				{
					...request,
					webUiUserDecisionClientCharacteristics: { ...characteristics, triggeringDomEventIsTrusted: false },
				},
				evidence,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(test.persist).not.toHaveBeenCalled();
	});
	it.each(["Stop", "搁置", "关闭"])("落盘后立即 %s 仍确认保存，且不执行后续步骤", async (kind) => {
		const test = await scenario();
		const request = test.request("saved");
		const persist = test.persist.getMockImplementation();
		if (!persist) throw new Error("缺少隔离持久化实现");
		test.persist.mockImplementationOnce(async (...args) => {
			const result = await persist(...args);
			if (kind === "Stop")
				await recordTaskEditorCreationExplicitStop(
					test.source.workspaceId,
					request.newTaskCard.id,
					request.newTaskCard.createdAt,
				);
			else if (kind === "搁置")
				await test.mutateCard(test.source, request.newTaskCard.id, {
					taskShelvingState: { isShelved: true, lastChangedAt: Date.now() },
				});
			else
				await mutateWorkspaceState(test.source.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards:
								column.id === "trash"
									? [...column.cards, request.newTaskCard]
									: column.cards.filter((card) => card.id !== request.newTaskCard.id),
						})),
					},
					value: null,
				}));
			return result;
		});
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect((await test.service.getStatus(test.source, request))?.cardPersisted).toBe(true);
		expect(test.applyRelations).not.toHaveBeenCalled();
		expect(test.start).not.toHaveBeenCalled();
		expect(test.persist).toHaveBeenCalledTimes(1);
	});

	it.each(["同 ID 换世", "删除"])("保存成功响应前发生%s仍保留原保存事实和冲突历史", async (kind) => {
		const test = await scenario();
		const request = test.request("saved");
		const persist = test.persist.getMockImplementation();
		if (!persist) throw new Error("缺少隔离持久化实现");
		test.persist.mockImplementationOnce(async (...args) => {
			const result = await persist(...args);
			if (kind === "同 ID 换世")
				await test.mutateCard(test.source, request.newTaskCard.id, {
					createdAt: request.newTaskCard.createdAt + 1,
					title: "新一世卡片",
				});
			else
				await mutateWorkspaceState(test.source.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.filter((card) => card.id !== request.newTaskCard.id),
						})),
					},
					value: null,
				}));
			return result;
		});
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		const record = await readTaskEditorCreationSubmission(test.source.workspaceId, request.submissionId);
		expect(record?.status).toMatchObject({
			cardPersisted: true,
			phase: "identity_conflict",
			taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt,
			startCompleted: false,
		});
		expect(record?.failureHistory).toEqual([
			expect.objectContaining({ message: expect.stringMatching(/身份已变化|不会复活/) }),
		]);
		const boardAfterConflict = (await loadPersistedWorkspaceStateById(test.source.workspaceId)).board;
		await test.service.close();
		const restarted = test.makeService();
		await restarted.sweep();
		await restarted.settle();
		expect((await restarted.getStatus(test.source, request))?.cardPersisted).toBe(true);
		expect((await loadPersistedWorkspaceStateById(test.source.workspaceId)).board).toEqual(boardAfterConflict);
		expect(test.applyRelations).not.toHaveBeenCalled();
		expect(test.start).not.toHaveBeenCalled();
		expect(test.persist).toHaveBeenCalledTimes(1);
	});

	it("保存抛错且无可信落盘证据时保持未确认", async () => {
		const test = await scenario();
		const request = test.request("unsav");
		test.persist.mockRejectedValue(new Error("尚未落盘"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect(await test.service.getStatus(test.source, request)).toMatchObject({
			cardPersisted: false,
			phase: "waiting_for_dependency",
		});
		expect(test.applyRelations).not.toHaveBeenCalled();
		expect(test.start).not.toHaveBeenCalled();
	});

	it("迁到中间项目 Stop 后再迁回，原提交不能恢复启动", async () => {
		const test = await scenario();
		const request = test.request("moved");
		test.applyRelations.mockRejectedValue(new Error("等待关系依赖"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		const move = async (from: typeof test.source, to: typeof test.source) => {
			await mutateWorkspaceState(from.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards.filter((card) => card.id !== request.newTaskCard.id),
					})),
				},
				value: null,
			}));
			await mutateWorkspaceState(to.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.id === "backlog" ? [...column.cards, request.newTaskCard] : column.cards,
					})),
				},
				value: null,
			}));
		};
		await move(test.source, test.target);
		expect(await test.readStartupProgress(test.source.workspaceId)).toEqual(new Map());
		expect((await test.readStartupProgress(test.target.workspaceId)).get(request.newTaskCard.id)).toMatchObject({
			workspaceId: test.target.workspaceId,
			phase: "waiting_for_dependency",
		});
		expect(
			(await readTaskEditorCreationSubmission(test.source.workspaceId, request.submissionId))?.status.workspaceId,
		).toBe(test.source.workspaceId);
		await recordTaskEditorCreationExplicitStop(
			test.target.workspaceId,
			request.newTaskCard.id,
			request.newTaskCard.createdAt,
		);
		await move(test.target, test.source);
		expect(await test.readStartupProgress(test.source.workspaceId)).toEqual(new Map());
		test.applyRelations.mockResolvedValue(undefined);
		test.changeDependencies();
		await test.service.sweep();
		await test.service.settle();
		expect(test.start).not.toHaveBeenCalled();
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("stopped");
	});

	it("启动投影按账本的精确一世键读取当前位置、历史项目和删除墓碑", async () => {
		const test = await scenario();
		const request = test.request("lgmov");
		test.applyRelations.mockRejectedValue(new Error("等待关系依赖"));
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		const projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
		const identity = {
			kanbanBoardCard: {
				workUnitType: "kanban_board_card" as const,
				workspaceId: test.source.workspaceId,
				taskId: request.newTaskCard.id,
				taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt,
			},
			currentWorkspaceId: test.target.workspaceId,
			workspaceIdsUsedByCard: [test.source.workspaceId, test.target.workspaceId],
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture" as const,
			firstObservedAt: Date.now(),
			creationActor: null,
			creationOnBehalfOfInitiatingWorkUnit: null,
			currentFieldValueSha256ByFieldName: {},
			lastKnownBoardColumnId: "backlog",
			movedToTrashColumnAt: null,
			permanentlyRemovedFromBoardAt: null as number | null,
		};
		projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.set(
			buildInterWorkUnitRelationWorkUnitKey(identity.kanbanBoardCard),
			identity,
		);
		const readProjection = vi
			.spyOn(liveRelationProjection, "readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture")
			.mockImplementation(async (read) =>
				read({
					projectionState,
					readRetainedTaskCardFieldValuesBySha256: async () => new Map(),
					findRetainedTaskCardFieldKeywordMatchesBySha256: async () => new Map(),
				}),
			);
		try {
			expect(await readTaskEditorCreationAgentStartupProgressByTaskId(test.source.workspaceId)).toEqual(new Map());
			expect(
				(await readTaskEditorCreationAgentStartupProgressByTaskId(test.target.workspaceId)).get(
					request.newTaskCard.id,
				)?.workspaceId,
			).toBe(test.target.workspaceId);
			identity.permanentlyRemovedFromBoardAt = Date.now();
			expect(await readTaskEditorCreationAgentStartupProgressByTaskId(test.target.workspaceId)).toEqual(new Map());
			identity.permanentlyRemovedFromBoardAt = null;
			await recordTaskEditorCreationExplicitStop(
				test.target.workspaceId,
				request.newTaskCard.id,
				request.newTaskCard.createdAt,
			);
			identity.currentWorkspaceId = test.source.workspaceId;
			expect(await readTaskEditorCreationAgentStartupProgressByTaskId(test.source.workspaceId)).toEqual(new Map());
		} finally {
			readProjection.mockRestore();
		}
	});

	it("旧草稿缺少快照时沿原已受理提交补证，不采用卡片现值", async () => {
		const test = await scenario();
		const request = test.request("proof", false);
		request.startAgentAfterCreation = false;
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		await test.mutateCard(test.source, request.newTaskCard.id, { prompt: "卡片后来编辑的正文" });
		const recovered = await test.service.migrateLegacyDraft(test.source.workspaceId, {
			createdTaskId: request.newTaskCard.id,
			createdTaskCardSnapshot: null,
			modelingSubmissionId: request.submissionId,
			creationPrompt: "用户后来填写的新草稿",
			creationTitle: "用户后来填写的名称",
			referenceRelationDrafts: [],
			relationRevocations: [],
		});
		expect(recovered.createdTaskId).toBeNull();
		expect(recovered.creationPrompt).toBe("用户后来填写的新草稿");
		expect(test.start).not.toHaveBeenCalled();
	});

	it("旧草稿缺少快照时不能借同裸 ID 当前卡确定原 incarnation", async () => {
		const test = await scenario();
		const request = test.request("reuse", false);
		request.startAgentAfterCreation = false;
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		await test.mutateCard(test.source, request.newTaskCard.id, { createdAt: request.newTaskCard.createdAt + 1 });
		const draft = {
			createdTaskId: request.newTaskCard.id,
			createdTaskCardSnapshot: null,
			modelingSubmissionId: "unproven-original-modeling-submission",
			creationPrompt: "后来正文",
			creationTitle: "后来名称",
			referenceRelationDrafts: test.request().referenceRelationDrafts,
			relationRevocations: [],
		};
		await expect(test.service.migrateLegacyDraft(test.source.workspaceId, draft)).rejects.toThrow("身份尚未确认");
		expect(draft.createdTaskId).toBe(request.newTaskCard.id);
		expect(
			await test.service.listForTask(test.source, {
				taskId: request.newTaskCard.id,
				taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt + 1,
			}),
		).toEqual([]);
	});

	it("ACP 建立连接失败留下的 startedAt 在重启后仍不能证明启动成功", async () => {
		const test = await scenario();
		const request = test.request("acper", false);
		const connectionStart = vi
			.spyOn(AcpClientConnectionRuntime.prototype, "startTaskConnection")
			.mockImplementation(async () => {
				await assertStartupVisible();
				throw new Error("连接尚未启动");
			});
		const acp = new AcpTaskSessionService(null);
		const assertStartupVisible = async () => {
			const summary = acp.getSummary(request.newTaskCard.id);
			if (!summary) throw new Error("缺少 ACP 准备摘要");
			expect(
				extractTaskSessionFactsForCrossProjectTaskViews({ ...summary, pid: process.pid })
					.agentSessionHasNoEstablishedAcpConnection,
			).toBe(false);
			expect(
				extractTaskSessionFactsForCrossProjectTaskViews({
					...summary,
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "omp",
						nativeSessionId: "established-native-session",
						transcriptPath: null,
						observedAt: Date.now(),
					},
				}).agentSessionHasNoEstablishedAcpConnection,
			).toBe(false);
			expect(
				extractTaskSessionFactsForCrossProjectTaskViews({
					...summary,
					lastAgentConversationUserHandoffObservation: {
						observedAtMs: Date.now(),
						signalConfidence: "structured_user_turn",
						turnSequence: 1,
					},
				}).agentSessionHasNoEstablishedAcpConnection,
			).toBe(false);
			const entries = collectCrossProjectTaskSwitcherEntriesFromBoard({
				board: (await loadPersistedWorkspaceStateById(test.source.workspaceId)).board,
				sessionFactsByTaskId: new Map([[summary.taskId, extractTaskSessionFactsForCrossProjectTaskViews(summary)]]),
				lastOpenedByUserAtByTaskId: new Map(),
				nowMs: Date.now(),
				activityHorizonMs: 7 * 24 * 60 * 60_000,
				taskEditorCreationAgentStartupProgressByTaskId: await test.readStartupProgress(test.source.workspaceId),
			});
			expect(entries[0]?.taskEditorCreationAgentStartupProgress).toBeDefined();
			expect(
				assignCrossProjectTaskSwitcherSections({
					entriesInProjects: entries.map((entry) => ({
						workspaceId: test.source.workspaceId,
						projectName: "隔离项目",
						entry,
					})),
					nowMs: Date.now(),
					remainingSectionOrderingMode:
						"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
					remainingSectionActivityHorizonMs: 7 * 24 * 60 * 60_000,
				}).runningEntries,
			).toHaveLength(1);
		};
		test.start.mockImplementationOnce(async (_scope, card, _record, beforeLaunch) => {
			await beforeLaunch();
			const summary = await acp.startTaskSession({
				taskId: card.id,
				agentId: "omp",
				cwd: test.source.workspacePath,
				prompt: card.prompt,
				permissionMode: "ask_for_every_tool_use",
			});
			expect(summary.pid).toBeNull();
			expect(summary.startedAt).toBeGreaterThanOrEqual(card.createdAt);
			await mutateWorkspaceState(test.source.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: { ...state.sessions, [card.id]: summary },
				value: null,
			}));
			throw new Error(summary.warningMessage ?? "启动失败");
		});
		try {
			await test.service.submit(test.source, request, evidence);
			await test.service.settle();
			await test.service.close();
			const restarted = test.makeService();
			await restarted.sweep();
			await restarted.settle();
			const status = await restarted.getStatus(test.source, request);
			expect(status?.startCompleted).toBe(false);
			expect(status?.phase).toBe("waiting_for_evidence");
			expect(status?.lastError).toContain("连接尚未启动");
			await assertStartupVisible();
			expect(test.start).toHaveBeenCalledTimes(1);
		} finally {
			connectionStart.mockRestore();
		}
	});
	it("启动标记落盘后的最终资格核验明确失败时，保留未 spawn 的事实并自动重试", async () => {
		const test = await scenario();
		const request = test.request("gate1", false);
		const resolveIdentity = test.resolveIdentity.getMockImplementation();
		if (!resolveIdentity) throw new Error("缺少隔离身份核验");
		let failFinalEligibilityCheckOnce = true;
		test.resolveIdentity.mockImplementation(async (...args) => {
			const record = await readTaskEditorCreationSubmission(test.source.workspaceId, request.submissionId);
			if (record?.agentProcessLaunchMayHaveBegun && failFinalEligibilityCheckOnce) {
				failFinalEligibilityCheckOnce = false;
				throw new Error("最终核验依赖暂不可用，尚未 spawn");
			}
			return resolveIdentity(...args);
		});
		await test.service.submit(test.source, request, evidence);
		await test.service.settle();
		expect(test.start).toHaveBeenCalledTimes(2);
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("completed");
	});
	it("runtime 关闭时等待中的创建不再启动进程，后继实例按原提交恢复一次", async () => {
		const test = await scenario();
		const request = test.request("clse1", false);
		const originalStart = test.start.getMockImplementation();
		if (!originalStart) throw new Error("缺少隔离启动实现");
		let releasePreparation!: () => void;
		let observePreparationEntered!: () => void;
		const preparation = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const preparationEntered = new Promise<void>((resolve) => {
			observePreparationEntered = resolve;
		});
		const actualProcessLaunch = vi.fn();
		test.start.mockImplementation(async (...argumentsForStart) => {
			observePreparationEntered();
			await preparation;
			const result = await originalStart(...argumentsForStart);
			actualProcessLaunch();
			return result;
		});
		await test.service.submit(test.source, request, evidence);
		await preparationEntered;
		const closing = test.service.close();
		releasePreparation();
		await closing;
		expect(actualProcessLaunch).not.toHaveBeenCalled();
		expect(
			(await readTaskEditorCreationSubmission(test.source.workspaceId, request.submissionId))
				?.agentProcessLaunchMayHaveBegun,
		).toBe(false);
		expect((await test.service.getStatus(test.source, request))?.phase).toBe("waiting_for_dependency");
		const successor = test.makeService();
		await successor.sweep();
		await successor.settle();
		expect(actualProcessLaunch).toHaveBeenCalledOnce();
		expect(test.start).toHaveBeenCalledTimes(2);
		expect((await successor.getStatus(test.source, request))?.phase).toBe("completed");
	});
});
