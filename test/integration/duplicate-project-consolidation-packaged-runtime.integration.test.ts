import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { mergeSummaryWithFacets } from "../../src/core/session-activity";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { recordAgentRaisedPendingUserDecision } from "../../src/state/agent-raised-pending-user-decision-store";
import {
	duplicateProjectConsolidationDirectory,
	duplicateProjectConsolidationReceiptPath,
} from "../../src/state/duplicate-project-consolidation-status";
import {
	getWorkspaceDirectoryLockRequest,
	loadWorkspaceContext,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { createTaskConversationSessionOperationStore } from "../../src/task-conversation-sessions/task-conversation-session-operation-store";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE as intent } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";
import { createTaskEditorPackagedRuntimeBrowserTestFixture } from "./task-editor-packaged-runtime-browser-test-fixture";

const packagedCliPath =
	process.env.KANBAN_DUPLICATE_PROJECT_CONSOLIDATION_PACKAGED_CLI_PATH ??
	resolve(import.meta.dirname, "../../dist/cli.js");
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!existsSync(packagedCliPath))(
	"真实打包runtime：HTTP受理、捕获后崩溃、后台恢复并保留身份、问题和Stop",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 70000,
		}),
	},
	async (context) => {
		const runtimeFixture = await createTaskEditorPackagedRuntimeBrowserTestFixture(packagedCliPath, children);
		const { fixture, client } = runtimeFixture;
		const ledgerPath = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban", "inter-work-unit-relation-ledger");
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT", ledgerPath);
		runtimeFixture.environment.KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT = ledgerPath;
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "project",
			initialBranchName: "main",
		});
		await writeFile(join(repository.repositoryPath, "original.txt"), "隔离合并验证\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "建立隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const linked = repository.createLinkedWorktree({
			worktreeDirectoryName: "project",
			branchName: "duplicate-project",
		});
		const target = await loadWorkspaceContext(repository.repositoryPath);
		const source = await loadWorkspaceContext(linked.worktreePath);
		const cards = ["abc12", "def34"].map((id, index) => ({
			id,
			title: `保全任务 ${id}`,
			prompt: "保留原正文",
			startInPlanMode: true,
			baseRef: "main",
			createdAt: 1234 + index,
			updatedAt: 1234 + index,
		}));
		const sessions: Record<string, RuntimeTaskSessionSummary> = {};
		for (const card of cards) {
			const nativeSessionId = randomUUID();
			const transcriptPath = join(fixture.isolatedHomeDirectoryPath, `${card.id}-native-history.jsonl`);
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n`,
			);
			sessions[card.id] = mergeSummaryWithFacets(
				{
					taskId: card.id,
					agentId: "codex",
					workspacePath: linked.worktreePath,
					pid: null,
					startedAt: 1000,
					updatedAt: 1234,
					lastOutputAt: 1200,
					state: "idle",
					reviewReason: null,
					exitCode: 0,
					lastHookAt: null,
					latestHookActivity: null,
				},
				{
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: card.id === "abc12" ? "question" : "review",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId,
						transcriptPath,
						observedAt: 1000,
					},
				},
			);
		}
		await saveWorkspaceState(source.repoPath, intent, {
			board: { columns: [{ id: "in_progress", title: "In Progress", cards }] },
			sessions,
		});
		await writeFile(join(linked.worktreePath, "uncommitted-investigation.md"), "保留未提交调查成果\n");
		await recordAgentRaisedPendingUserDecision(source.workspaceId, {
			nativeConversationSessionId: sessions.abc12?.agentNativeConversationSessionIdentity?.nativeSessionId,
			decisionId: "retained-native-question",
			taskId: "abc12",
			workspaceId: source.workspaceId,
			agentId: "codex",
			sessionTransport: "pty_terminal",
			decisionKind: "ordinary_user_question",
			questionMarkdown: "原问题仍待回答",
			options: [],
			allowsFreeformAnswer: true,
			askedAt: 1234,
			graceDeadlineAt: null,
			originRuntimeSessionIncarnationId: null,
			originTurnSequence: 1,
			sourceHarnessSignal: "codex:request_user_input",
		});
		const operations = createTaskConversationSessionOperationStore();
		await operations.recordExplicitStopMarkers({ workspaceId: source.workspaceId, workspacePath: source.repoPath }, [
			"def34",
		]);
		await mkdir(duplicateProjectConsolidationDirectory(), { recursive: true });
		await writeFile(join(duplicateProjectConsolidationDirectory(), "unrelated-damaged-audit.json"), "{damaged-json");
		const waitUntil = async (description: string, condition: () => Promise<boolean>) => {
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				context,
				{
					waitedForDescription: description,
					softDeadlineMsExpectedOnUncontendedHost: 5000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20000,
				},
				condition,
			);
		};
		let releaseTargetLock = () => {};
		let targetLockPromise: Promise<void> | undefined;
		try {
			let runtime = await runtimeFixture.startRuntime(target.repoPath);
			const preview = await client().projects.previewDuplicateConsolidation.query({
				sourceWorkspaceId: source.workspaceId,
				targetWorkspaceId: target.workspaceId,
			});
			let signalTargetLocked = () => {};
			const targetLocked = new Promise<void>((done) => {
				signalTargetLocked = done;
			});
			targetLockPromise = lockedFileSystem.withLock(
				getWorkspaceDirectoryLockRequest(target.workspaceId),
				async () => {
					await new Promise<void>((done) => {
						releaseTargetLock = done;
						signalTargetLocked();
					});
				},
			);
			await targetLocked;
			const acceptedRequest = client()
				.projects.consolidateDuplicate.mutate(preview)
				.then(
					() => true,
					() => false,
				);
			const receiptPath = duplicateProjectConsolidationReceiptPath(source.workspaceId);
			await waitUntil("合并已捕获来源并等待目标锁", async () => {
				try {
					return JSON.parse(await readFile(receiptPath, "utf8")).status === "captured";
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
					throw error;
				}
			});
			runtime.kill("SIGKILL");
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, runtime, {
				waitedForDescription: "隔离runtime崩溃退出",
				softDeadlineMsExpectedOnUncontendedHost: 2000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 10000,
			});
			expect(await acceptedRequest).toBe(false);
			releaseTargetLock();
			await targetLockPromise;
			runtime = await runtimeFixture.startRuntime(target.repoPath);
			await waitUntil(
				"新runtime从捕获回执自动完成合并",
				async () => JSON.parse(await readFile(receiptPath, "utf8")).status === "completed",
			);
			const state = await client(target.workspaceId).workspace.getState.query();
			expect(
				state.board.columns
					.find((column) => column.id === "in_progress")
					?.cards.map((card) => ({ id: card.id, createdAt: card.createdAt })),
			).toEqual(cards.map((card) => ({ id: card.id, createdAt: card.createdAt })));
			for (const card of cards) {
				expect(state.sessions[card.id]?.agentNativeConversationSessionIdentity).toEqual(
					sessions[card.id]?.agentNativeConversationSessionIdentity,
				);
				expect(state.sessions[card.id]?.workspacePath).toBe(linked.worktreePath);
				expect(state.sessions[card.id]?.pid).toBeNull();
			}
			const questions = await client(target.workspaceId).runtime.listAgentRaisedPendingUserDecisions.query({
				taskId: "abc12",
			});
			expect(questions.decisions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						decisionId: "retained-native-question",
						answerDeliveryState: "not_answered",
						questionMarkdown: "原问题仍待回答",
					}),
				]),
			);
			expect(
				(await operations.read({ workspaceId: target.workspaceId, workspacePath: target.repoPath }))
					.explicitlyStoppedSessionIds,
			).toContain("def34");
			const oldScope = await client(source.workspaceId).workspace.getState.query();
			expect(oldScope.repoPath).toBe(target.repoPath);
			expect(await readFile(join(linked.worktreePath, "uncommitted-investigation.md"), "utf8")).toBe(
				"保留未提交调查成果\n",
			);
		} finally {
			releaseTargetLock();
			await targetLockPromise;
			runtimeFixture.writeRuntimeOutput();
		}
	},
);
