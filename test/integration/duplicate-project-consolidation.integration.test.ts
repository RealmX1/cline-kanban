import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { duplicateProjectConsolidationControlSchema } from "../../src/core/duplicate-project-consolidation-contract";
import { mergeSummaryWithFacets } from "../../src/core/session-activity";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { listKanbanBoardCardIdentityProjectionsByBareTaskId } from "../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import {
	activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture,
	readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture,
} from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	authorizeExplicitProjectRegistration,
	previewExplicitProjectRegistration,
} from "../../src/projects/explicit-project-registration";
import type { ActiveRuntimeSessionShutdownResult } from "../../src/server/active-runtime-session-shutdown";
import { createDuplicateProjectConsolidationService } from "../../src/server/duplicate-project-consolidation";
import {
	readAgentRaisedPendingUserDecisions,
	recordAgentRaisedPendingUserDecision,
} from "../../src/state/agent-raised-pending-user-decision-store";
import {
	readAgentSessionReclamationDeadlineRecords,
	recordAgentSessionRetentionDeadline,
	supersedeAgentSessionRetentionDeadlinesForTask,
} from "../../src/state/agent-session-reclamation-deadline-store";
import {
	assertTaskSessionIsNotPendingProjectConsolidation,
	assertWorkspaceHasNotBeenConsolidated,
	clearRejectedDuplicateProjectConsolidationControl,
	duplicateProjectConsolidationDirectory,
	duplicateProjectConsolidationReceiptPath,
	readDuplicateProjectConsolidationControlRecord,
} from "../../src/state/duplicate-project-consolidation-status";
import { resolveRegisteredWorkspaceInvocationContext } from "../../src/state/registered-workspace-invocation-context";
import { getRuntimeHomePath } from "../../src/state/runtime-home-path";
import {
	readTaskLastOpenedByUserAtByTaskId,
	recordTaskLastOpenedByUser,
} from "../../src/state/task-last-opened-by-user-record-store";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import * as workspaceState from "../../src/state/workspace-state";
import { createTaskConversationSessionOperationStore } from "../../src/task-conversation-sessions/task-conversation-session-operation-store";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	TASK_MUTATION_INTENT_FOR_TEST_FIXTURE as intent,
	KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE as origin,
} from "../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
});

async function scenario() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv(
		"KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT",
		join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "inter-work-unit-relation-ledger"),
	);
	const repository = fixture.createNonBareRepository({
		repositoryDirectoryName: "project",
		initialBranchName: "main",
	});
	await writeFile(join(repository.repositoryPath, "tracked.txt"), "原始内容\n");
	repository.commitAllRepositoryFilesAtDate({
		message: "建立隔离仓库",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	const linked = repository.createLinkedWorktree({
		worktreeDirectoryName: "project",
		branchName: "isolated-duplicate",
	});
	const target = await workspaceState.loadWorkspaceContext(repository.repositoryPath);
	const source = await workspaceState.loadWorkspaceContext(linked.worktreePath);
	const card = {
		id: "abc12",
		title: "保留原身份与问题",
		prompt: "保留正文",
		startInPlanMode: true,
		baseRef: "main",
		createdAt: 1234,
		updatedAt: 1234,
	};
	const session = mergeSummaryWithFacets(
		{
			taskId: card.id,
			agentId: "codex",
			workspacePath: linked.worktreePath,
			pid: null,
			startedAt: 1000,
			updatedAt: 1234,
			lastOutputAt: 1200,
			reviewReason: null,
			exitCode: 0,
			state: "idle",
			lastHookAt: null,
			latestHookActivity: null,
		},
		{
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "question",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "original-native-session",
				transcriptPath: "/retained/native-history.jsonl",
				observedAt: 1000,
			},
		},
	);
	await workspaceState.saveWorkspaceState(source.repoPath, intent, {
		board: { columns: [{ id: "in_progress", title: "In Progress", cards: [card] }] },
		sessions: { [card.id]: session },
	});
	await workspaceState.loadWorkspaceState(target.repoPath);
	await recordAgentRaisedPendingUserDecision(source.workspaceId, {
		nativeConversationSessionId: "original-native-session",
		decisionId: "original-question",
		taskId: card.id,
		workspaceId: source.workspaceId,
		agentId: "codex",
		sessionTransport: "pty_terminal",
		decisionKind: "ordinary_user_question",
		questionMarkdown: "仍然等待用户回答的问题",
		options: [],
		allowsFreeformAnswer: true,
		askedAt: 1234,
		graceDeadlineAt: null,
		originRuntimeSessionIncarnationId: null,
		originTurnSequence: 1,
		sourceHarnessSignal: "codex:request_user_input",
	});
	await writeFile(join(linked.worktreePath, "uncommitted.txt"), "未提交工作不得改动\n");
	const dependencies = {
		runtimeProcessInstanceId: randomUUID(),
		stopAndCollectProjectRuntimeSessionsForSafePersistence: vi.fn(
			async (): Promise<ActiveRuntimeSessionShutdownResult> => ({
				stoppedRuntimeSessionSummaries: [],
				runtimeSessionSummariesForSafePersistence: [],
			}),
		),
		listProjectRuntimeSessionSummaries: vi.fn((): RuntimeTaskSessionSummary[] => []),
		disposeProjectRuntime: vi.fn(async () => {}),
		hydrateTransferredTaskSessions: vi.fn(async () => {}),
		getActiveWorkspaceId: () => source.workspaceId,
		setActiveWorkspace: vi.fn(async () => {}),
		broadcastRuntimeProjectsUpdated: vi.fn(async () => {}),
		warn: vi.fn(),
	};
	return {
		fixture,
		repository,
		linked,
		source,
		target,
		card,
		session,
		dependencies,
		service: createDuplicateProjectConsolidationService(dependencies),
	};
}

async function createRetentionDeadlineFixture(workspaceId: string, taskId: string) {
	await recordAgentSessionRetentionDeadline(workspaceId, {
		taskId,
		agentId: "codex",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "fixture-retention-generation",
		agentResponseGenerationTurnSequence: 1,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: 1234,
		responseGenerationStopSignalConfidence: "structured_user_turn",
		reclamationEligibleAt: 10000,
		recordedAt: 1234,
	});
	const [record] = await readAgentSessionReclamationDeadlineRecords(workspaceId);
	if (!record) throw new Error("隔离回收期限未建立。");
	return record;
}

async function withLedger(action: () => Promise<void>) {
	const capture = await activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
	try {
		await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
		await action();
	} finally {
		await capture.deactivate();
	}
}

function useManualClock() {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return {
		advance(milliseconds: number) {
			now += milliseconds;
		},
	};
}

async function startProbeProcess(): Promise<{ pid: number; stop: () => Promise<void> }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", () => resolve());
		child.once("error", reject);
	});
	if (child.pid === undefined) throw new Error("探针进程没有 pid。");
	const pid = child.pid;
	return {
		pid,
		stop: () =>
			new Promise((resolve, reject) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolve();
					return;
				}
				const timer = setTimeout(() => reject(new Error(`探针进程 ${pid} 没有退出。`)), 2_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				child.kill("SIGKILL");
			}),
	};
}

async function readConsolidationReceipt(workspaceId: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await readFile(duplicateProjectConsolidationReceiptPath(workspaceId), "utf8")) as Record<
			string,
			unknown
		>;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

describe("重复项目的显式注册与保全合并", { timeout: 60000 }, () => {
	it("任务 worktree 使用会话绑定；预览不写盘，缺授权及过期预览不能新增", async () => {
		const value = await scenario();
		await workspaceState.removeWorkspaceIndexEntry(value.source.workspaceId);
		const before = await workspaceState.listWorkspaceIndexEntries();
		expect(
			(
				await resolveRegisteredWorkspaceInvocationContext(undefined, value.linked.worktreePath, {
					KANBAN_PROJECT_PATH: value.target.repoPath,
				})
			).workspaceId,
		).toBe(value.target.workspaceId);
		const preview = await previewExplicitProjectRegistration(value.target.repoPath);
		await expect(
			authorizeExplicitProjectRegistration(
				{ path: value.target.repoPath },
				{
					decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "present_but_malformed" },
					webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
				},
			),
		).rejects.toThrow("授权原话");
		expect(await workspaceState.listWorkspaceIndexEntries()).toEqual(before);
		await expect(authorizeExplicitProjectRegistration({ path: value.target.repoPath }, origin)).rejects.toThrow(
			"授权原话",
		);
		await expect(
			authorizeExplicitProjectRegistration(
				{
					path: value.target.repoPath,
					authorization: { userQuote: "允许新增这个项目", sourceReference: "本测试用户消息" },
					previewFingerprint: "outdated",
				},
				origin,
			),
		).rejects.toThrow("重新预览");
		await authorizeExplicitProjectRegistration(
			{
				path: preview.path,
				previewFingerprint: preview.previewFingerprint,
				authorization: { userQuote: "允许新增这个项目", sourceReference: "本测试用户消息" },
			},
			origin,
		);
		const auditDirectory = join(workspaceState.getRuntimeHomePath(), "explicit-project-registration-audit");
		const auditName = (await readdir(auditDirectory))[0];
		if (!auditName) throw new Error("缺少授权审计原件。");
		const audit = JSON.parse(await readFile(join(auditDirectory, auditName), "utf8"));
		expect(audit.authorization.userQuote).toBe("允许新增这个项目");
		expect(audit.preview.path).toBe(preview.path);
	});
	it("原列、原任务身份、原生历史和待答问题保留，注销来源并支持旧身份查询", async () => {
		const value = await scenario();
		const capture = await activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			expect(value.dependencies.disposeProjectRuntime).not.toHaveBeenCalled();
			const result = await value.service.consolidate(preview, intent);
			expect(result.status).toBe("completed");
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledWith(
				value.target.workspaceId,
				value.target.repoPath,
				expect.objectContaining({
					[value.card.id]: expect.objectContaining({
						agentNativeConversationSessionIdentity: value.session.agentNativeConversationSessionIdentity,
						pid: null,
					}),
				}),
			);
			const target = await workspaceState.loadPersistedWorkspaceStateById(value.target.workspaceId);
			expect(target.board.columns.find((column) => column.id === "in_progress")?.cards).toEqual([value.card]);
			expect(target.sessions[value.card.id]?.agentNativeConversationSessionIdentity).toEqual(
				value.session.agentNativeConversationSessionIdentity,
			);
			const decisions = await readAgentRaisedPendingUserDecisions(value.target.workspaceId);
			expect(decisions).toHaveLength(1);
			expect(decisions[0]).toMatchObject({
				decisionId: "original-question",
				workspaceId: value.target.workspaceId,
				status: "pending",
				answerDeliveryState: "not_answered",
			});
			expect(await readFile(join(value.linked.worktreePath, "uncommitted.txt"), "utf8")).toBe(
				"未提交工作不得改动\n",
			);
			expect(await workspaceState.listWorkspaceIndexEntries()).toEqual([
				{ workspaceId: value.target.workspaceId, repoPath: value.target.repoPath },
			]);
			expect((await workspaceState.loadWorkspaceContextById(value.source.workspaceId))?.workspaceId).toBe(
				value.target.workspaceId,
			);
			expect((await workspaceState.loadWorkspaceContext(value.source.repoPath)).workspaceId).toBe(
				value.target.workspaceId,
			);
			await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((projection) => {
				const identities = listKanbanBoardCardIdentityProjectionsByBareTaskId(
					projection.projectionState.kanbanBoardCardIdentityProjectionState,
					value.card.id,
				);
				expect(identities).toHaveLength(1);
				expect(identities[0]).toMatchObject({
					kanbanBoardCard: { workspaceId: value.source.workspaceId },
					currentWorkspaceId: value.target.workspaceId,
					permanentlyRemovedFromBoardAt: null,
				});
			});
			expect((await value.service.consolidate(preview, intent)).operationId).toBe(result.operationId);
		} finally {
			await capture.deactivate();
		}
	});
	it("目标已写入但来源移除失败时保留回执，下一轮自动恢复且不复制任务", async () => {
		const value = await scenario();
		await recordTaskLastOpenedByUser(value.source.workspaceId, value.card.id, 1000);
		let capture = await activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			const original = workspaceState.writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents;
			let injected = false;
			vi.spyOn(
				workspaceState,
				"writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents",
			).mockImplementation(async (input) => {
				if (!injected && input.context.workspaceId === value.source.workspaceId) {
					injected = true;
					throw new Error("模拟来源写入失败");
				}
				return original(input);
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("模拟来源写入失败");
			await recordTaskLastOpenedByUser(value.target.workspaceId, value.card.id, 2000);
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, value.card.id),
			).rejects.toThrow("正在保全迁移");
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, "unrelated-task"),
			).resolves.toBeUndefined();
			await expect(recordTaskLastOpenedByUser(value.source.workspaceId, value.card.id, Date.now())).rejects.toThrow(
				"禁止后台改写",
			);
			await capture.deactivate();
			capture = await activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			await capture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const restartedService = createDuplicateProjectConsolidationService(value.dependencies);
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
			await restartedService.recoverPending();
			expect(
				(await readTaskLastOpenedByUserAtByTaskId(value.target.workspaceId, { requireCompleteRead: true })).get(
					value.card.id,
				),
			).toBe(2000);
			expect(
				(await workspaceState.loadPersistedWorkspaceStateById(value.target.workspaceId)).board.columns.flatMap(
					(column) => column.cards,
				),
			).toEqual([value.card]);
			expect(
				(await workspaceState.loadPersistedWorkspaceStateById(value.source.workspaceId)).board.columns.flatMap(
					(column) => column.cards,
				),
			).toEqual([]);
			expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
				value.target.workspaceId,
			]);
			await readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((projection) => {
				const identities = listKanbanBoardCardIdentityProjectionsByBareTaskId(
					projection.projectionState.kanbanBoardCardIdentityProjectionState,
					value.card.id,
				);
				expect(identities).toHaveLength(1);
				expect(identities[0]).toMatchObject({
					kanbanBoardCard: { workspaceId: value.source.workspaceId },
					currentWorkspaceId: value.target.workspaceId,
				});
			});
		} finally {
			await capture.deactivate();
		}
	});
	it("未识别状态文件与未结算投递阻止迁移，原项目保持可用", async () => {
		const value = await scenario();
		await lockedFileSystem.writeJsonFileAtomic(join(value.source.statePath, "queued-task-prompt-deliveries.json"), {
			entriesByTaskId: { [value.card.id]: [{ deliveryState: "handed_to_transport" }] },
		});
		await expect(
			value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			}),
		).rejects.toThrow("未结算");
		expect(value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence).not.toHaveBeenCalled();
		await lockedFileSystem.writeJsonFileAtomic(join(value.source.statePath, "queued-task-prompt-deliveries.json"), {
			entriesByTaskId: {},
		});
		await writeFile(join(value.source.statePath, "unsupported-source-state.json"), "{}");
		await expect(
			value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			}),
		).rejects.toThrow("未支持迁移的状态");
		expect(await workspaceState.listWorkspaceIndexEntries()).toHaveLength(2);
	});

	it("已加载的待审或待答会话可以停止后迁入，Agent 仍在生成时不写回执", async () => {
		const value = await scenario();
		const awaitingReview = mergeSummaryWithFacets(value.session, {
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "question",
		});
		value.dependencies.listProjectRuntimeSessionSummaries.mockReturnValue([awaitingReview]);
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			expect((await value.service.consolidate(preview, intent)).status).toBe("completed");
		});
		expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledWith(
			value.target.workspaceId,
			value.target.repoPath,
			expect.objectContaining({
				[value.card.id]: expect.objectContaining({ pid: null, userTurnKind: "question" }),
			}),
		);
	});

	it("Agent 仍在生成时不写合并回执", async () => {
		const blocked = await scenario();
		blocked.dependencies.listProjectRuntimeSessionSummaries.mockReturnValue([
			mergeSummaryWithFacets(blocked.session, {
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
			}),
		]);
		const blockedPreview = await blocked.service.preview({
			sourceWorkspaceId: blocked.source.workspaceId,
			targetWorkspaceId: blocked.target.workspaceId,
		});
		await expect(blocked.service.consolidate(blockedPreview, intent)).rejects.toThrow("仍在工作");
		expect(await readConsolidationReceipt(blocked.source.workspaceId)).toBeNull();
		await expect(assertWorkspaceHasNotBeenConsolidated(blocked.source.workspaceId)).resolves.toBeUndefined();
	});

	it("原进程仍存活时不清除 pid，也不完成迁移", async () => {
		const value = await scenario();
		const probe = await startProbeProcess();
		try {
			const summary = mergeSummaryWithFacets(
				{ ...value.session, pid: probe.pid },
				{ turnOwner: "user", liveness: "live", userTurnKind: "review" },
			);
			value.dependencies.listProjectRuntimeSessionSummaries.mockReturnValue([summary]);
			value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence.mockResolvedValue({
				stoppedRuntimeSessionSummaries: [summary],
				runtimeSessionSummariesForSafePersistence: [summary],
			});
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow(`来源进程 ${probe.pid} 仍存在`);
			expect(value.dependencies.hydrateTransferredTaskSessions).not.toHaveBeenCalled();
			const receipt = await readConsolidationReceipt(value.source.workspaceId);
			expect(receipt?.status).toBe("quiescing");
			expect(receipt?.sourceSessions).toBeUndefined();
		} finally {
			await probe.stop();
		}
	});

	it("进程退出后，先前未受理的合并可以继续完成", async () => {
		const value = await scenario();
		const probe = await startProbeProcess();
		try {
			const summary = mergeSummaryWithFacets(
				{ ...value.session, pid: probe.pid },
				{ turnOwner: "user", liveness: "live", userTurnKind: "review" },
			);
			value.dependencies.listProjectRuntimeSessionSummaries.mockReturnValue([summary]);
			value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence.mockResolvedValue({
				stoppedRuntimeSessionSummaries: [summary],
				runtimeSessionSummariesForSafePersistence: [summary],
			});
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow(`来源进程 ${probe.pid} 仍存在`);
			await probe.stop();
			await withLedger(async () => {
				expect((await value.service.consolidate(preview, intent)).status).toBe("completed");
			});
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledWith(
				value.target.workspaceId,
				value.target.repoPath,
				expect.objectContaining({
					[value.card.id]: expect.objectContaining({ pid: null, liveness: "exited", userTurnKind: "review" }),
				}),
			);
		} finally {
			await probe.stop();
		}
	}, 20_000);

	it("停止回调确认进程退出后，待审会话按退出态迁入", async () => {
		const value = await scenario();
		const probe = await startProbeProcess();
		await probe.stop();
		try {
			const summary = mergeSummaryWithFacets(
				{ ...value.session, pid: probe.pid },
				{ turnOwner: "user", liveness: "live", userTurnKind: "review" },
			);
			value.dependencies.listProjectRuntimeSessionSummaries.mockReturnValue([summary]);
			value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence.mockResolvedValue({
				stoppedRuntimeSessionSummaries: [summary],
				runtimeSessionSummariesForSafePersistence: [summary],
			});
			await withLedger(async () => {
				const preview = await value.service.preview({
					sourceWorkspaceId: value.source.workspaceId,
					targetWorkspaceId: value.target.workspaceId,
				});
				expect((await value.service.consolidate(preview, intent)).status).toBe("completed");
			});
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledWith(
				value.target.workspaceId,
				value.target.repoPath,
				expect.objectContaining({
					[value.card.id]: expect.objectContaining({ pid: null, liveness: "exited", userTurnKind: "review" }),
				}),
			);
		} finally {
			await probe.stop();
		}
	});

	it("当前运行时未托管的存活进程在写回执前拒绝", async () => {
		const value = await scenario();
		const probe = await startProbeProcess();
		try {
			await workspaceState.saveWorkspaceState(value.source.repoPath, intent, {
				board: { columns: [{ id: "in_progress", title: "In Progress", cards: [value.card] }] },
				sessions: { [value.card.id]: { ...value.session, pid: probe.pid } },
			});
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("未受理合并");
			expect(await readConsolidationReceipt(value.source.workspaceId)).toBeNull();
			await expect(assertWorkspaceHasNotBeenConsolidated(value.source.workspaceId)).resolves.toBeUndefined();
			expect(value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence).not.toHaveBeenCalled();
		} finally {
			await probe.stop();
		}
	});

	it("快照派生记账不会在受理后把来源冻结成未识别状态", async () => {
		const value = await scenario();
		const metaPath = join(value.source.statePath, "meta.json");
		const meta = JSON.parse(await readFile(metaPath, "utf8")) as { workspaceStateSnapshotCommitId?: string };
		delete meta.workspaceStateSnapshotCommitId;
		await writeFile(metaPath, JSON.stringify(meta));
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			expect((await value.service.consolidate(preview, intent)).status).toBe("completed");
		});
		expect(await readdir(value.source.statePath)).toContain("workspace-state-legacy-observation.json");
	});

	it("来源的显式 Stop 标记会复制到目标后再装入会话", async () => {
		const value = await scenario();
		const operations = createTaskConversationSessionOperationStore();
		await operations.recordExplicitStopMarkers(
			{ workspaceId: value.source.workspaceId, workspacePath: value.source.repoPath },
			[value.card.id],
		);
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			expect((await value.service.consolidate(preview, intent)).status).toBe("completed");
			expect(
				(
					await operations.read({
						workspaceId: value.target.workspaceId,
						workspacePath: value.target.repoPath,
					})
				).explicitlyStoppedSessionIds,
			).toContain(value.card.id);
		});
	});

	it("未结算的回收期限不会冻进捕获回执，结算后可以继续", async () => {
		const value = await scenario();
		const deadlinePath = join(value.source.statePath, "agent-session-reclamation-deadlines.json");
		const deadline = await createRetentionDeadlineFixture(value.source.workspaceId, value.card.id);
		const preview = await value.service.preview({
			sourceWorkspaceId: value.source.workspaceId,
			targetWorkspaceId: value.target.workspaceId,
		});
		await expect(value.service.consolidate(preview, intent)).rejects.toThrow("尚未结算");
		expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("quiescing");
		expect((await readConsolidationReceipt(value.source.workspaceId))?.sourceFiles).toBeUndefined();
		await writeFile(deadlinePath, JSON.stringify([{ ...deadline, reclamationState: "superseded" }]));
		await withLedger(async () => {
			const clock = useManualClock();
			clock.advance(31_000);
			await value.service.recoverPending();
		});
		expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
			value.target.workspaceId,
		]);
	});

	it("已捕获的未终态回收快照会退回来源原件再继续", async () => {
		const value = await scenario();
		const deadline = await createRetentionDeadlineFixture(value.source.workspaceId, value.card.id);
		const preview = await value.service.preview({
			sourceWorkspaceId: value.source.workspaceId,
			targetWorkspaceId: value.target.workspaceId,
		});
		const source = await workspaceState.loadPersistedWorkspaceStateById(value.source.workspaceId);
		await mkdir(duplicateProjectConsolidationDirectory(), { recursive: true });
		await writeFile(
			duplicateProjectConsolidationReceiptPath(value.source.workspaceId),
			JSON.stringify({
				...preview,
				operationId: randomUUID(),
				status: "captured",
				intent,
				sourceBoard: source.board,
				sourceSessions: {},
				sourceFiles: {
					"agent-session-reclamation-deadlines.json": JSON.stringify([deadline]),
				},
			}),
		);
		await writeFile(
			join(value.source.statePath, "agent-session-reclamation-deadlines.json"),
			JSON.stringify([{ ...deadline, reclamationState: "superseded" }]),
		);
		await withLedger(async () => {
			const clock = useManualClock();
			await value.service.recoverPending();
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("quiescing");
			clock.advance(31_000);
			await value.service.recoverPending();
		});
		expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
			value.target.workspaceId,
		]);
	});

	it("目标会话装入连续失败三次后，相同证据不再重试，重启后的新预算仍会接续", async () => {
		const value = await scenario();
		value.dependencies.hydrateTransferredTaskSessions.mockRejectedValue(new Error("目标会话管理器暂不可用"));
		await withLedger(async () => {
			const clock = useManualClock();
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂不可用");
			for (let attempt = 0; attempt < 3; attempt += 1) {
				clock.advance(31_000);
				await value.service.recoverPending();
			}
			const exhausted = await readConsolidationReceipt(value.source.workspaceId);
			expect(exhausted?.status).toBe("tasks_transferred");
			expect(exhausted?.recoveryAttemptCount).toBe(3);
			const callsAfterBudget = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			for (let attempt = 0; attempt < 4; attempt += 1) {
				clock.advance(31_000);
				await value.service.recoverPending();
			}
			const stillExhausted = await readConsolidationReceipt(value.source.workspaceId);
			expect(stillExhausted?.recoveryAttemptCount).toBe(3);
			expect(stillExhausted?.recoveryEvidenceFingerprint).toBe(exhausted?.recoveryEvidenceFingerprint);
			expect(value.dependencies.hydrateTransferredTaskSessions.mock.calls.length).toBe(callsAfterBudget);
			value.dependencies.hydrateTransferredTaskSessions.mockResolvedValue(undefined);
			const restarted = createDuplicateProjectConsolidationService({
				...value.dependencies,
				runtimeProcessInstanceId: randomUUID(),
			});
			clock.advance(31_000);
			await restarted.recoverPending();
		});
		expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
			value.target.workspaceId,
		]);
	});

	it("同一进程里目标管理器装入后重开有限次装入", async () => {
		const value = await scenario();
		let terminalManagerLoaded = false;
		const service = createDuplicateProjectConsolidationService({
			...value.dependencies,
			observeTransferredTaskSessionHydrationGate: () => ({ terminalManagerLoaded }),
		});
		value.dependencies.hydrateTransferredTaskSessions.mockRejectedValue(new Error("目标会话管理器暂不可用"));
		await withLedger(async () => {
			const clock = useManualClock();
			const preview = await service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(service.consolidate(preview, intent)).rejects.toThrow("暂不可用");
			for (let attempt = 0; attempt < 3; attempt += 1) {
				clock.advance(31_000);
				await service.recoverPending();
			}
			clock.advance(31_000);
			await service.recoverPending();
			expect((await readConsolidationReceipt(value.source.workspaceId))?.recoveryAttemptCount).toBe(3);
			terminalManagerLoaded = true;
			value.dependencies.hydrateTransferredTaskSessions.mockResolvedValue(undefined);
			clock.advance(31_000);
			await service.recoverPending();
		});
		expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
			value.target.workspaceId,
		]);
	});

	it("三次预算耗尽后来源回收期限结算会自动接续", async () => {
		const value = await scenario();
		await recordAgentSessionRetentionDeadline(value.source.workspaceId, {
			taskId: value.card.id,
			agentId: "codex",
			sessionTransport: "pty_terminal",
			runtimeSessionIncarnationId: "incarnation-1",
			agentResponseGenerationTurnSequence: 0,
			retentionAnchorKind: "agent_response_generation_stopped",
			retentionAnchorAt: 1_700_000_000_000,
			responseGenerationStopSignalConfidence: "harness_turn_complete",
			reclamationEligibleAt: 1_700_000_060_000,
			recordedAt: 1_700_000_000_000,
		});
		const preview = await value.service.preview({
			sourceWorkspaceId: value.source.workspaceId,
			targetWorkspaceId: value.target.workspaceId,
		});
		await expect(value.service.consolidate(preview, intent)).rejects.toThrow("尚未结算");
		const clock = useManualClock();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			clock.advance(31_000);
			await value.service.recoverPending();
		}
		const exhausted = await readConsolidationReceipt(value.source.workspaceId);
		expect(exhausted?.status).toBe("quiescing");
		expect(exhausted?.recoveryAttemptCount).toBe(3);
		clock.advance(31_000);
		await value.service.recoverPending();
		expect((await readConsolidationReceipt(value.source.workspaceId))?.recoveryAttemptCount).toBe(3);
		expect(
			(await readAgentSessionReclamationDeadlineRecords(value.source.workspaceId)).map(
				(record) => record.reclamationState,
			),
		).toEqual(["grace_running"]);
		await supersedeAgentSessionRetentionDeadlinesForTask(value.source.workspaceId, value.card.id, 1_700_000_120_000);
		expect(
			(await readAgentSessionReclamationDeadlineRecords(value.source.workspaceId)).map(
				(record) => record.reclamationState,
			),
		).toEqual(["superseded"]);
		await withLedger(async () => {
			const restarted = createDuplicateProjectConsolidationService(value.dependencies);
			clock.advance(31_000);
			await restarted.recoverPending();
		});
		const continued = await readConsolidationReceipt(value.source.workspaceId);
		expect(continued?.status).toBe("completed");
		expect(continued?.recoveryEvidenceFingerprint).not.toBe(exhausted?.recoveryEvidenceFingerprint);
		expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([
			value.target.workspaceId,
		]);
	});
});

describe("合并控制边界的架构回归", { timeout: 60000 }, () => {
	it("冻结之后，已经进入的普通卡片写入仍由低层门禁拒绝", async () => {
		const value = await scenario();
		value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence.mockImplementationOnce(async () => {
			await lockedFileSystem.withLock(
				workspaceState.getWorkspaceDirectoryLockRequest(value.source.workspaceId),
				async () => {
					const state = await workspaceState.loadPersistedWorkspaceStateById(value.source.workspaceId);
					await expect(
						workspaceState.writeWorkspaceStateFilesWithinBoardLockCapturingTaskMutationEvents({
							context: value.source,
							previousBoard: state.board,
							previousSessions: state.sessions,
							nextBoard: {
								...state.board,
								columns: state.board.columns.map((column) =>
									column.id === "backlog"
										? { ...column, cards: [{ ...value.card, id: "def34", createdAt: 5678, updatedAt: 5678 }] }
										: column,
								),
							},
							nextSessions: state.sessions,
							nextMeta: { revision: state.revision + 1, updatedAt: Date.now() },
							taskMutationIntentWithResolvedActor: intent,
						}),
					).rejects.toThrow("冻结");
				},
			);
			return { stoppedRuntimeSessionSummaries: [], runtimeSessionSummariesForSafePersistence: [] };
		});
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).resolves.toMatchObject({ status: "completed" });
		});
		expect(
			(await workspaceState.loadPersistedWorkspaceStateById(value.target.workspaceId)).board.columns.flatMap(
				(column) => column.cards,
			),
		).toEqual([value.card]);
	});

	it("受理回执存在但控制状态尚未发布时，范围漂移会拒绝并恢复来源访问", async () => {
		const value = await scenario();
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			value.dependencies.stopAndCollectProjectRuntimeSessionsForSafePersistence.mockRejectedValueOnce(
				new Error("暂时停止不可用"),
			);
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时停止");
			await clearRejectedDuplicateProjectConsolidationControl(
				duplicateProjectConsolidationControlSchema.parse(await readConsolidationReceipt(value.source.workspaceId)),
			);
			const state = await workspaceState.loadPersistedWorkspaceStateById(value.source.workspaceId);
			await workspaceState.saveWorkspaceState(value.source.repoPath, intent, {
				board: {
					...state.board,
					columns: state.board.columns.map((column) =>
						column.id === "backlog"
							? { ...column, cards: [{ ...value.card, id: "def34", createdAt: 5678, updatedAt: 5678 }] }
							: column,
					),
				},
				sessions: state.sessions,
			});
			const clock = useManualClock();
			clock.advance(31000);
			await value.service.recoverPending();
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("rejected_before_capture");
			await expect(
				workspaceState.loadWorkspaceContext(value.source.repoPath, { autoCreateIfMissing: false }),
			).resolves.toMatchObject({ workspaceId: value.source.workspaceId });
			expect(
				(await workspaceState.loadPersistedWorkspaceStateById(value.target.workspaceId)).board.columns.flatMap(
					(column) => column.cards,
				),
			).toEqual([]);
			const revisedPreview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await value.service.consolidate(revisedPreview, intent);
			expect(await readdir(join(duplicateProjectConsolidationDirectory(), "rejected-before-capture"))).toHaveLength(
				1,
			);
		});
	});

	it("无关损坏的审计回执不阻断普通读取、启动门禁或其他操作恢复", async () => {
		const value = await scenario();
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			value.dependencies.hydrateTransferredTaskSessions.mockRejectedValueOnce(new Error("暂时不能装入"));
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时不能装入");
			await writeFile(
				join(duplicateProjectConsolidationDirectory(), "unrelated-retired-project.json"),
				"{damaged-json",
			);
			await expect(
				workspaceState.loadWorkspaceContext(value.target.repoPath, { autoCreateIfMissing: false }),
			).resolves.toMatchObject({ workspaceId: value.target.workspaceId });
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, "other-task"),
			).resolves.toBeUndefined();
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, value.card.id),
			).rejects.toThrow("正在保全迁移");
			const clock = useManualClock();
			clock.advance(31000);
			await value.service.recoverPending();
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
			expect(value.dependencies.warn).toHaveBeenCalledWith(
				expect.stringContaining("unrelated-retired-project.json"),
			);
		});
	});

	it("完成控制状态已公开但审计回执仍滞后时，不重新添加用户已解除的Stop", async () => {
		const value = await scenario();
		const operations = createTaskConversationSessionOperationStore();
		await operations.recordExplicitStopMarkers(
			{ workspaceId: value.source.workspaceId, workspacePath: value.source.repoPath },
			[value.card.id],
		);
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await value.service.consolidate(preview, intent);
			await operations.clearExplicitStopMarker(
				{ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath },
				value.card.id,
			);
			const receipt = await readConsolidationReceipt(value.source.workspaceId);
			await writeFile(
				duplicateProjectConsolidationReceiptPath(value.source.workspaceId),
				JSON.stringify({ ...receipt, status: "tasks_transferred" }),
			);
			const calls = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			await createDuplicateProjectConsolidationService({
				...value.dependencies,
				runtimeProcessInstanceId: randomUUID(),
			}).recoverPending();
			expect(
				(await operations.read({ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath }))
					.explicitlyStoppedSessionIds,
			).not.toContain(value.card.id);
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledTimes(calls);
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
		});
	});

	it("控制状态仍是 tasks_transferred 时，恢复不会把用户已解除的 Stop 加回", async () => {
		const value = await scenario();
		const operations = createTaskConversationSessionOperationStore();
		await operations.recordExplicitStopMarkers(
			{ workspaceId: value.source.workspaceId, workspacePath: value.source.repoPath },
			[value.card.id],
		);
		value.dependencies.hydrateTransferredTaskSessions.mockRejectedValueOnce(new Error("暂时不能装入"));
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时不能装入");
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("tasks_transferred");
			expect((await readConsolidationReceipt(value.source.workspaceId))?.explicitStopMarkersMigrated).toBe(true);
			await operations.clearExplicitStopMarker(
				{ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath },
				value.card.id,
			);
			const hydrateCalls = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			const clock = useManualClock();
			clock.advance(31_000);
			await value.service.recoverPending();
			expect(
				(await operations.read({ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath }))
					.explicitlyStoppedSessionIds,
			).not.toContain(value.card.id);
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledTimes(hydrateCalls + 1);
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
		});
	});

	it("目标完成控制写入失败后，回执保持可恢复，且补发布时不再装入会话", async () => {
		const value = await scenario();
		let failTargetCompletedWrite = true;
		const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, payload, options) => {
			const controls =
				payload !== null && typeof payload === "object" && "consolidationsBySourceWorkspaceId" in payload
					? (
							payload as {
								consolidationsBySourceWorkspaceId: Record<string, { status?: string }>;
							}
						).consolidationsBySourceWorkspaceId
					: null;
			if (
				failTargetCompletedWrite &&
				path.includes(join("by-workspace-id", `${value.target.workspaceId}.json`)) &&
				Object.values(controls ?? {}).some((control) => control.status === "completed")
			) {
				failTargetCompletedWrite = false;
				throw Object.assign(new Error("目标完成控制暂时不可写"), { code: "EIO" });
			}
			return originalWrite(path, payload, options);
		});
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时不可写");
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("tasks_transferred");
			await expect(readDuplicateProjectConsolidationControlRecord(value.source.workspaceId)).resolves.toMatchObject({
				status: "completed",
			});
			await expect(
				readDuplicateProjectConsolidationControlRecord(value.target.workspaceId, value.source.workspaceId),
			).resolves.toMatchObject({ status: "tasks_transferred" });
			expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toContain(
				value.source.workspaceId,
			);
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, value.card.id),
			).rejects.toThrow("正在保全迁移");
			const hydrateCalls = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			const clock = useManualClock();
			clock.advance(31_000);
			await value.service.recoverPending();
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledTimes(hydrateCalls);
			await expect(
				readDuplicateProjectConsolidationControlRecord(value.target.workspaceId, value.source.workspaceId),
			).resolves.toMatchObject({ status: "completed" });
			await expect(readDuplicateProjectConsolidationControlRecord(value.source.workspaceId)).resolves.toMatchObject({
				status: "completed",
			});
			expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).not.toContain(
				value.source.workspaceId,
			);
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, value.card.id),
			).resolves.toBeUndefined();
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
		});
	});

	it("完成审计已写入但目标控制仍未发布时，恢复只补齐发布且不重新添加 Stop", async () => {
		const value = await scenario();
		const operations = createTaskConversationSessionOperationStore();
		await operations.recordExplicitStopMarkers(
			{ workspaceId: value.source.workspaceId, workspacePath: value.source.repoPath },
			[value.card.id],
		);
		value.dependencies.hydrateTransferredTaskSessions.mockRejectedValueOnce(new Error("暂时不能装入"));
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时不能装入");
			await operations.clearExplicitStopMarker(
				{ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath },
				value.card.id,
			);
			const sourceControlPath = join(
				getRuntimeHomePath(),
				"duplicate-project-consolidation-controls",
				"by-workspace-id",
				`${value.source.workspaceId}.json`,
			);
			const sourceControl = JSON.parse(await readFile(sourceControlPath, "utf8")) as {
				consolidationsBySourceWorkspaceId: Record<string, { status: string }>;
			};
			const published = sourceControl.consolidationsBySourceWorkspaceId[value.source.workspaceId];
			if (!published) throw new Error("来源控制记录不存在");
			published.status = "completed";
			await writeFile(sourceControlPath, JSON.stringify(sourceControl));
			const receipt = await readConsolidationReceipt(value.source.workspaceId);
			await writeFile(
				duplicateProjectConsolidationReceiptPath(value.source.workspaceId),
				JSON.stringify({ ...receipt, status: "completed" }),
			);
			const hydrateCalls = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			const clock = useManualClock();
			clock.advance(31_000);
			await value.service.recoverPending();
			expect(
				(await operations.read({ workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath }))
					.explicitlyStoppedSessionIds,
			).not.toContain(value.card.id);
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledTimes(hydrateCalls);
			await expect(
				readDuplicateProjectConsolidationControlRecord(value.target.workspaceId, value.source.workspaceId),
			).resolves.toMatchObject({ status: "completed" });
			expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).not.toContain(
				value.source.workspaceId,
			);
			await expect(
				assertTaskSessionIsNotPendingProjectConsolidation(value.target.workspaceId, value.card.id),
			).resolves.toBeUndefined();
		});
	});

	it("活动项目切换失败后，已完成发布会在恢复时重试且不重复装入", async () => {
		const value = await scenario();
		value.dependencies.setActiveWorkspace.mockRejectedValueOnce(new Error("活动项目暂时不能切换"));
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("暂时不能切换");
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
			expect((await readConsolidationReceipt(value.source.workspaceId))?.activeWorkspaceRetargeted).not.toBe(true);
			await expect(readDuplicateProjectConsolidationControlRecord(value.source.workspaceId)).resolves.toMatchObject({
				status: "completed",
			});
			await expect(
				readDuplicateProjectConsolidationControlRecord(value.target.workspaceId, value.source.workspaceId),
			).resolves.toMatchObject({ status: "completed" });
			expect((await workspaceState.listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).not.toContain(
				value.source.workspaceId,
			);
			const hydrateCalls = value.dependencies.hydrateTransferredTaskSessions.mock.calls.length;
			const switchCalls = value.dependencies.setActiveWorkspace.mock.calls.length;
			const clock = useManualClock();
			clock.advance(31_000);
			await value.service.recoverPending();
			expect(value.dependencies.setActiveWorkspace).toHaveBeenCalledTimes(switchCalls + 1);
			expect(value.dependencies.hydrateTransferredTaskSessions).toHaveBeenCalledTimes(hydrateCalls);
			expect((await readConsolidationReceipt(value.source.workspaceId))?.activeWorkspaceRetargeted).toBe(true);
		});
	});

	it("Stop 已落盘但迁移收据未落盘时，重启恢复不得重加用户已解除的 Stop", async () => {
		const value = await scenario();
		const operations = createTaskConversationSessionOperationStore();
		const sourceScope = { workspaceId: value.source.workspaceId, workspacePath: value.source.repoPath };
		const targetScope = { workspaceId: value.target.workspaceId, workspacePath: value.target.repoPath };
		await operations.recordExplicitStopMarkers(sourceScope, [value.card.id]);
		let receiptWritesUnavailable = true;
		const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, payload, options) => {
			const stopMigrationAlreadyClaimed =
				payload !== null &&
				typeof payload === "object" &&
				"explicitStopMarkersMigrated" in payload &&
				(payload as { explicitStopMarkersMigrated?: unknown }).explicitStopMarkersMigrated === true;
			if (
				receiptWritesUnavailable &&
				path === duplicateProjectConsolidationReceiptPath(value.source.workspaceId) &&
				stopMigrationAlreadyClaimed
			) {
				throw Object.assign(new Error("模拟 Stop 已落盘但收据未持久化的崩溃窗口"), { code: "EIO" });
			}
			return await originalWrite(path, payload, options);
		});
		await withLedger(async () => {
			const preview = await value.service.preview({
				sourceWorkspaceId: value.source.workspaceId,
				targetWorkspaceId: value.target.workspaceId,
			});
			await expect(value.service.consolidate(preview, intent)).rejects.toThrow("收据未持久化");
			const receiptAfterCrashWindow = await readConsolidationReceipt(value.source.workspaceId);
			expect(receiptAfterCrashWindow?.status).toBe("tasks_transferred");
			expect(receiptAfterCrashWindow?.explicitStopMarkersMigrated).not.toBe(true);
			const targetMarkerPath = join(
				getRuntimeHomePath(),
				"task-conversation-session-operations",
				"explicit-session-stop-markers",
				`${createHash("sha256").update(value.target.workspaceId).digest("hex")}.json`,
			);
			expect(JSON.parse(await readFile(targetMarkerPath, "utf8"))).toMatchObject({
				schemaVersion: 1,
				sessionIds: [value.card.id],
				appliedDuplicateProjectStopMigrations: [
					{
						operationId: receiptAfterCrashWindow?.operationId,
						sourceWorkspaceId: value.source.workspaceId,
					},
				],
			});
			expect((await operations.read(targetScope)).explicitlyStoppedSessionIds).toContain(value.card.id);
			receiptWritesUnavailable = false;
			await operations.clearExplicitStopMarker(targetScope, value.card.id);
			expect(JSON.parse(await readFile(targetMarkerPath, "utf8"))).toMatchObject({
				schemaVersion: 1,
				sessionIds: [],
				appliedDuplicateProjectStopMigrations: [
					{
						operationId: receiptAfterCrashWindow?.operationId,
						sourceWorkspaceId: value.source.workspaceId,
					},
				],
			});
			expect((await operations.read(targetScope)).explicitlyStoppedSessionIds).not.toContain(value.card.id);
			const rebooted = createDuplicateProjectConsolidationService({
				...value.dependencies,
				runtimeProcessInstanceId: randomUUID(),
			});
			await rebooted.recoverPending();
			expect((await operations.read(targetScope)).explicitlyStoppedSessionIds).not.toContain(value.card.id);
			expect((await readConsolidationReceipt(value.source.workspaceId))?.status).toBe("completed");
		});
	});
});
