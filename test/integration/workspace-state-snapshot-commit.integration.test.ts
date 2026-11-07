import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";
import { applySessionFacets } from "../../src/core/session-activity";
import * as fileReadObservation from "../../src/diagnostics/daily-work-progress-collection-cost-recorder";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { createPersistedTaskSessionFactsCacheForUnloadedProjects } from "../../src/server/persisted-task-session-facts-cache-for-unloaded-projects";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import { loadWorkspaceAgentConversationProgressObservedAtByTaskId } from "../../src/state/workspace-agent-conversation-progress-observed-at-reader";
import {
	getWorkspaceDirectoryLockRequest,
	getWorkspaceStateSnapshotReadFingerprintById,
	loadPersistedWorkspaceSessionsById,
	loadPersistedWorkspaceStateById,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
	persistHookReviewLifecycleApplicationInWorkspaceSnapshot,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId,
	recoverWorkspaceStateSnapshotProjectionWithinLock,
	savePersistedWorkspaceSessionsById,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import * as snapshotStorage from "../../src/state/workspace-state-snapshot-storage";
import {
	WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME,
	WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
} from "../../src/state/workspace-state-snapshot-storage";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
let fixture: ReturnType<typeof createIsolatedGitTestWorkspaceFixture>;
let repositoryPath: string;
let workspaceId: string;
let directoryPath: string;

function session(observedAt: number): RuntimeTaskSessionSummary {
	return applySessionFacets({
		taskId: "task-1",
		state: "interrupted",
		agentId: "codex",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: observedAt,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: 0,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native-session-1",
			transcriptPath: null,
			observedAt,
		},
		lastEffectiveAgentConversationActivityObservation: {
			observedAtMs: observedAt,
			evidenceKind: "persisted_agent_transcript",
			activityKind: "agent_output",
		},
	});
}
function withCard(board: RuntimeBoardData, title: string): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards:
				column.id === "in_progress"
					? [
							{
								id: "task-1",
								title,
								prompt: title,
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							},
						]
					: [],
		})),
	};
}
async function saveInitialSnapshot() {
	const initial = await loadWorkspaceState(repositoryPath);
	return await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: withCard(initial.board, "原状态"),
		sessions: { "task-1": session(10) },
		expectedRevision: initial.revision,
	});
}
async function recover() {
	await lockedFileSystem.withLock(getWorkspaceDirectoryLockRequest(workspaceId), () =>
		recoverWorkspaceStateSnapshotProjectionWithinLock(workspaceId),
	);
}

beforeEach(async () => {
	fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "codex"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "codex-sqlite"));
	repositoryPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "snapshot-project");
	await mkdir(repositoryPath, { recursive: true });
	fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
	const context = await loadWorkspaceContext(repositoryPath);
	workspaceId = context.workspaceId;
	directoryPath = context.statePath;
});
afterEach(async () => {
	vi.restoreAllMocks();
	// 先恢复计时器 spy，再退出假时钟，避免 spy 把假 setInterval 写回真实时钟环境。
	vi.useRealTimers();
	await recover();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("workspace 持久快照提交", { timeout: 120_000 }, () => {
	it("完成事件的领域投影与去重回执同一快照提交，投影恢复不重复应用", async () => {
		const initial = await saveInitialSnapshot();
		const receipt = {
			deliveryIdempotencyKey: "persistent-review-event",
			capturedAtEpochMs: 20,
			runtimeSessionIncarnationId: "runtime-incarnation-1",
		};
		const current = applySessionFacets({
			...session(30),
			state: "awaiting_review",
			pid: null,
			runtimeSessionIncarnationId: receipt.runtimeSessionIncarnationId,
			lastAppliedHookReviewLifecycleEventDelivery: receipt,
		});
		const originalWrite = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		const projectionFailure = vi
			.spyOn(lockedFileSystem, "writeTextFileAtomic")
			.mockImplementation(async (path, text, options) => {
				if (path === join(directoryPath, "sessions.json"))
					throw Object.assign(new Error("模拟提交之后投影失败"), { code: "EIO" });
				await originalWrite(path, text, options);
			});
		await persistHookReviewLifecycleApplicationInWorkspaceSnapshot({
			workspaceId,
			taskId: "task-1",
			taskIncarnationCreatedAtEpochMs: 1,
			deliveryIdempotencyKey: receipt.deliveryIdempotencyKey,
			runtimeSessionIncarnationId: receipt.runtimeSessionIncarnationId,
			readCurrentSummary: () => current,
		});
		const committed = await snapshotStorage.readWorkspaceStateSnapshotCommit(directoryPath, workspaceId);
		if (!committed) throw new Error("缺少已提交快照。");
		expect(JSON.parse(committed.sessionsJsonText)["task-1"]).toMatchObject({
			turnOwner: "user",
			lastAppliedHookReviewLifecycleEventDelivery: receipt,
		});
		expect(committed?.meta.revision).toBe(initial.revision);
		projectionFailure.mockRestore();
		await recover();
		const persisted = await loadPersistedWorkspaceSessionsById(workspaceId, { requireCompleteRead: true });
		expect(persisted["task-1"]?.lastAppliedHookReviewLifecycleEventDelivery).toEqual(receipt);
		await persistHookReviewLifecycleApplicationInWorkspaceSnapshot({
			workspaceId,
			taskId: "task-1",
			taskIncarnationCreatedAtEpochMs: 1,
			deliveryIdempotencyKey: receipt.deliveryIdempotencyKey,
			runtimeSessionIncarnationId: receipt.runtimeSessionIncarnationId,
			readCurrentSummary: () => null,
		});
		expect(
			(await loadPersistedWorkspaceSessionsById(workspaceId))["task-1"]?.lastAppliedHookReviewLifecycleEventDelivery,
		).toEqual(receipt);
	});
	it.each([false, true])("延迟 UI 保存不能撤销完成回执与 facet，伪造同毫秒标识=%s", async (forgedReceipt) => {
		const initial = await saveInitialSnapshot();
		const receipt = {
			deliveryIdempotencyKey: "authoritative-completion",
			capturedAtEpochMs: 20,
			runtimeSessionIncarnationId: "runtime-incarnation-1",
		};
		const completed = applySessionFacets({
			...session(30),
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			liveness: "exited",
			reviewReason: "hook",
			runtimeSessionIncarnationId: receipt.runtimeSessionIncarnationId,
			agentResponseGenerationTurnSequence: 1,
			lastAppliedHookReviewLifecycleEventDelivery: receipt,
		});
		await savePersistedWorkspaceSessionsById(workspaceId, { "task-1": completed }, initial.revision);
		const current = await loadWorkspaceState(repositoryPath);
		const stale = applySessionFacets({
			...completed,
			state: "running",
			turnOwner: "agent",
			userTurnKind: null,
			liveness: "live",
			reviewReason: null,
			lastAppliedHookReviewLifecycleEventDelivery: forgedReceipt
				? { ...receipt, deliveryIdempotencyKey: "forged-completion" }
				: undefined,
		});
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: current.board,
			sessions: { "task-1": stale },
			expectedRevision: current.revision,
		});
		expect((await loadWorkspaceState(repositoryPath)).sessions["task-1"]).toMatchObject({
			turnOwner: "user",
			userTurnKind: "review",
			liveness: "exited",
			lastAppliedHookReviewLifecycleEventDelivery: receipt,
		});
	});
	it("带同一完成回执的合法人工审阅更新仍然保留", async () => {
		const initial = await saveInitialSnapshot();
		const completed = applySessionFacets({
			...session(30),
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			liveness: "exited",
			reviewReason: "hook",
			runtimeSessionIncarnationId: "runtime-incarnation-1",
			lastAppliedHookReviewLifecycleEventDelivery: {
				deliveryIdempotencyKey: "authoritative-completion",
				capturedAtEpochMs: 20,
				runtimeSessionIncarnationId: "runtime-incarnation-1",
			},
		});
		await savePersistedWorkspaceSessionsById(workspaceId, { "task-1": completed }, initial.revision);
		const current = await loadWorkspaceState(repositoryPath);
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: current.board,
			sessions: { "task-1": { ...completed, reviewReason: "manual_review" } },
			expectedRevision: current.revision,
		});
		expect((await loadWorkspaceState(repositoryPath)).sessions["task-1"]?.reviewReason).toBe("manual_review");
	});
	it.each(["sessions-only", "identity-reconfirmation", "new-identity"] as const)(
		"%s 只更新会话时，完整提交和恢复均保留未修改看板的原始字节",
		async (saveKind) => {
			const initial = await saveInitialSnapshot();
			const boardPath = join(directoryPath, "board.json");
			const originalBoard = JSON.parse(await readFile(boardPath, "utf8"));
			const originalBoardText = `${JSON.stringify({ dependencies: ["legacy-observation"], ...originalBoard }, null, "\t")}\n`;
			await writeFile(boardPath, originalBoardText);
			const originalMeta = JSON.parse(await readFile(join(directoryPath, "meta.json"), "utf8"));
			const nextSession = session(30);
			if (saveKind === "new-identity") {
				nextSession.agentNativeConversationSessionIdentity = {
					sourceAgentId: "codex",
					nativeSessionId: "replacement-native-session",
					transcriptPath: null,
					observedAt: 30,
				};
			}
			const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
			const projectionFailure = vi
				.spyOn(lockedFileSystem, "writeTextFileAtomic")
				.mockImplementation(async (path, content, options) => {
					if (path === boardPath) throw new Error("保留已提交日志以检查未修改看板的字节");
					await writeText(path, content, options);
				});
			try {
				if (saveKind === "sessions-only") {
					await savePersistedWorkspaceSessionsById(workspaceId, { "task-1": nextSession }, initial.revision);
				} else {
					await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
						workspaceId,
						"task-1",
						() => nextSession,
					);
				}
				const committed = JSON.parse(
					await readFile(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME), "utf8"),
				);
				expect(committed.boardJsonText).toBe(originalBoardText);
				expect(committed.workspaceStateSnapshotCommitId).not.toBe(originalMeta.workspaceStateSnapshotCommitId);
				expect(committed.meta.revision).toBe(initial.revision + (saveKind === "identity-reconfirmation" ? 0 : 1));
				expect((await loadPersistedWorkspaceSessionsById(workspaceId))["task-1"]?.updatedAt).toBe(30);
			} finally {
				projectionFailure.mockRestore();
				await recover();
			}
			expect(await readFile(boardPath, "utf8")).toBe(originalBoardText);
		},
	);

	it.each(["board", "sessions"] as const)("日志保留旧 %s null 正文时，严格读取仍拒绝空正文", async (projection) => {
		await saveInitialSnapshot();
		const snapshot = snapshotStorage.createWorkspaceStateSnapshotCommit({
			workspaceId,
			boardJsonText: projection === "board" ? "null" : await readFile(join(directoryPath, "board.json"), "utf8"),
			sessionsJsonText:
				projection === "sessions" ? "null" : await readFile(join(directoryPath, "sessions.json"), "utf8"),
			meta: JSON.parse(await readFile(join(directoryPath, "meta.json"), "utf8")),
		});
		await snapshotStorage.writeWorkspaceStateSnapshotCommitDurably(directoryPath, snapshot);
		const readStrictProjection =
			projection === "board"
				? () => loadWorkspaceBoardById(workspaceId, { requireCompleteRead: true })
				: () => loadPersistedWorkspaceSessionsById(workspaceId, { requireCompleteRead: true });
		await expect(readStrictProjection()).rejects.toThrow("正文不能为 null");
	});

	it("锁争用耗尽后，持有者无写入释放也会自动恢复投影", async () => {
		await saveInitialSnapshot();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		let firstProjection = true;
		vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockImplementation(async (path, text, options) => {
			if (path === join(directoryPath, "board.json") && firstProjection) {
				firstProjection = false;
				throw new Error("为锁争用恢复回归保留待投影日志");
			}
			await writeText(path, text, options);
		});
		const mutation = vi.fn((state: RuntimeWorkspaceStateResponse) => ({
			board: withCard(state.board, "锁释放后自动恢复"),
			value: null,
		}));
		await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, mutation);
		const releaseHolder = await lockedFileSystem.acquireLock(getWorkspaceDirectoryLockRequest(workspaceId));
		const lockFailure = () => Object.assign(new Error("模拟有界取锁等待耗尽"), { code: "ELOCKED" });
		const recoveryLock = vi
			.spyOn(lockedFileSystem, "withLock")
			.mockRejectedValueOnce(lockFailure())
			.mockRejectedValueOnce(lockFailure())
			.mockRejectedValueOnce(lockFailure());
		const conditionObservation = vi.spyOn(globalThis, "setInterval");
		try {
			await vi.advanceTimersByTimeAsync(21_000);
			await vi.waitFor(() => expect(conditionObservation).toHaveBeenCalledWith(expect.any(Function), 15_000));
			expect(recoveryLock).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(recoveryLock).toHaveBeenCalledTimes(3);
		} finally {
			await releaseHolder();
		}
		// 释放只改变内核锁资格，不改任何 JSON、目录权限或文件时间戳，也不触发新业务写入。
		await vi.waitFor(
			async () => {
				await vi.advanceTimersByTimeAsync(1_000);
				await expect(stat(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME))).rejects.toMatchObject({
					code: "ENOENT",
				});
			},
			{ timeout: 10_000 },
		);
		expect(mutation).toHaveBeenCalledTimes(1);
	});

	it.each(["board.json", "sessions.json", "meta.json"])(
		"%s 投影失败后服务完整提交，后续写入先恢复再校验 revision",
		async (filename) => {
			const initial = await saveInitialSnapshot();
			const cache = createPersistedTaskSessionFactsCacheForUnloadedProjects();
			const cachedFacts = await cache.loadTaskSessionFactsByTaskId(workspaceId);
			expect(await loadWorkspaceAgentConversationProgressObservedAtByTaskId(workspaceId)).toEqual(
				new Map([["task-1", 10]]),
			);
			const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
			const failure = vi
				.spyOn(lockedFileSystem, "writeTextFileAtomic")
				.mockImplementation(async (path, content, options) => {
					if (path === join(directoryPath, filename)) throw new Error("模拟投影故障");
					await writeText(path, content, options);
				});
			const mutation = vi.fn((state: RuntimeWorkspaceStateResponse) => ({
				board: withCard(state.board, "已提交状态"),
				sessions: { "task-1": session(20) },
				value: "业务执行一次",
			}));
			const accepted = await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, mutation);
			expect(accepted.state.revision).toBe(initial.revision + 1);
			const loaded = await loadPersistedWorkspaceStateById(workspaceId);
			expect(loaded.revision).toBe(accepted.state.revision);
			expect(loaded.board.columns.flatMap((column) => column.cards)[0]?.title).toBe("已提交状态");
			expect(loaded.sessions["task-1"]?.updatedAt).toBe(20);
			expect(await loadWorkspaceBoardById(workspaceId)).toEqual(loaded.board);
			expect((await loadPersistedWorkspaceSessionsById(workspaceId))["task-1"]?.updatedAt).toBe(20);
			expect(await cache.loadTaskSessionFactsByTaskId(workspaceId)).not.toBe(cachedFacts);
			expect(await loadWorkspaceAgentConversationProgressObservedAtByTaskId(workspaceId)).toEqual(
				new Map([["task-1", 20]]),
			);
			await expect(
				saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: initial.board,
					sessions: initial.sessions,
					expectedRevision: initial.revision,
				}),
			).rejects.toThrow("模拟投影故障");
			failure.mockRestore();
			await expect(
				saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: initial.board,
					sessions: initial.sessions,
					expectedRevision: initial.revision,
				}),
			).rejects.toMatchObject({ currentRevision: accepted.state.revision });
			expect(mutation).toHaveBeenCalledTimes(1);
			expect(JSON.parse(await readFile(join(directoryPath, "board.json"), "utf8"))).toEqual(loaded.board);
			await expect(stat(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME))).rejects.toMatchObject({
				code: "ENOENT",
			});
		},
	);

	it.each(["board.json", "sessions.json", "meta.json"])("%s rename 后出错也能幂等恢复", async (filename) => {
		await saveInitialSnapshot();
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		const failure = vi
			.spyOn(lockedFileSystem, "writeTextFileAtomic")
			.mockImplementation(async (path, content, options) => {
				await writeText(path, content, options);
				if (path === join(directoryPath, filename)) throw new Error("模拟 rename 后故障");
			});
		const committed = await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: withCard(state.board, "rename 后已提交"),
			value: null,
		}));
		expect((await loadPersistedWorkspaceStateById(workspaceId)).revision).toBe(committed.state.revision);
		failure.mockRestore();
		await recover();
		expect((await loadWorkspaceState(repositoryPath)).revision).toBe(committed.state.revision);
	});

	it("sessions-only 保存投影失败后仍返回已提交版本，公共读取不获取写锁", async () => {
		const initial = await saveInitialSnapshot();
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		const failure = vi
			.spyOn(lockedFileSystem, "writeTextFileAtomic")
			.mockImplementation(async (path, content, options) => {
				if (path === join(directoryPath, "sessions.json")) throw new Error("sessions 投影暂时失败");
				await writeText(path, content, options);
			});
		expect(await savePersistedWorkspaceSessionsById(workspaceId, { "task-1": session(40) }, initial.revision)).toBe(
			initial.revision + 1,
		);
		const noReadLock = vi.spyOn(lockedFileSystem, "withLock").mockRejectedValue(new Error("公共读取不应获取写锁"));
		try {
			expect((await loadWorkspaceState(repositoryPath)).sessions["task-1"]?.updatedAt).toBe(40);
			expect((await loadWorkspaceBoardById(workspaceId)).columns).toHaveLength(5);
			expect((await loadPersistedWorkspaceSessionsById(workspaceId))["task-1"]?.updatedAt).toBe(40);
			expect(noReadLock).not.toHaveBeenCalled();
		} finally {
			noReadLock.mockRestore();
			failure.mockRestore();
		}
	});

	it("读取旧 board 后发生完整提交时，丢弃跨版本 board/sessions 组合", async () => {
		await saveInitialSnapshot();
		const readText = fileReadObservation.readUtf8FileWithDailyWorkProgressCostObservation;
		let markReadStarted: () => void = () => {};
		let allowReadToReturn: () => void = () => {};
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const readMayReturn = new Promise<void>((resolve) => {
			allowReadToReturn = resolve;
		});
		let pauseNextBoardRead = true;
		vi.spyOn(fileReadObservation, "readUtf8FileWithDailyWorkProgressCostObservation").mockImplementation(
			async (...parameters) => {
				const result = await readText(...parameters);
				if (parameters[0] === join(directoryPath, "board.json") && pauseNextBoardRead) {
					pauseNextBoardRead = false;
					markReadStarted();
					await readMayReturn;
				}
				return result;
			},
		);
		const racingRead = loadPersistedWorkspaceStateById(workspaceId);
		try {
			await readStarted;
			await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: withCard(state.board, "新 board"),
				sessions: { "task-1": session(50) },
				value: null,
			}));
		} finally {
			allowReadToReturn();
		}
		const loaded = await racingRead;
		expect(loaded.board.columns.flatMap((column) => column.cards)[0]?.title).toBe("新 board");
		expect(loaded.sessions["task-1"]?.updatedAt).toBe(50);
	});

	it("最终日志查询窗口完成投影时，最后的 meta 围栏拒绝新正文配旧 revision", async () => {
		const initial = await saveInitialSnapshot();
		const readerScope = new AsyncLocalStorage<boolean>();
		let markReaderPaused: () => void = () => {};
		let markWriterReachedMeta: () => void = () => {};
		let allowWriterToFinish: () => void = () => {};
		const readerPaused = new Promise<void>((resolve) => {
			markReaderPaused = resolve;
		});
		const writerReachedMeta = new Promise<void>((resolve) => {
			markWriterReachedMeta = resolve;
		});
		const writerMayFinish = new Promise<void>((resolve) => {
			allowWriterToFinish = resolve;
		});
		let readerBoardPaused = false;
		let readerJournalQueryCount = 0;
		let writerCompletion: Promise<unknown> = Promise.resolve();
		const readText = fileReadObservation.readUtf8FileWithDailyWorkProgressCostObservation;
		vi.spyOn(fileReadObservation, "readUtf8FileWithDailyWorkProgressCostObservation").mockImplementation(
			async (...parameters) => {
				if (readerScope.getStore() && parameters[0] === join(directoryPath, "board.json") && !readerBoardPaused) {
					readerBoardPaused = true;
					markReaderPaused();
					await writerReachedMeta;
				}
				return await readText(...parameters);
			},
		);
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockImplementation(async (path, text, options) => {
			if (path === join(directoryPath, "meta.json")) {
				markWriterReachedMeta();
				await writerMayFinish;
			}
			await writeText(path, text, options);
		});
		const readJournal = snapshotStorage.readWorkspaceStateSnapshotCommit;
		vi.spyOn(snapshotStorage, "readWorkspaceStateSnapshotCommit").mockImplementation(async (...parameters) => {
			if (readerScope.getStore() && ++readerJournalQueryCount === 2) {
				allowWriterToFinish();
				await writerCompletion;
			}
			return await readJournal(...parameters);
		});
		const racingRead = readerScope.run(true, () => loadPersistedWorkspaceStateById(workspaceId));
		try {
			await readerPaused;
			writerCompletion = mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: withCard(state.board, "最终围栏后的新正文"),
				sessions: { "task-1": session(60) },
				value: null,
			}));
			const loaded = await racingRead;
			expect(loaded.revision).toBe(initial.revision + 1);
			expect(loaded.board.columns.flatMap((column) => column.cards)[0]?.title).toBe("最终围栏后的新正文");
			expect(loaded.sessions["task-1"]?.updatedAt).toBe(60);
		} finally {
			allowWriterToFinish();
			await writerCompletion;
		}
	});

	it("projects summary 的宽松及严格 board 缓存在日志待投影时都刷新", async () => {
		await saveInitialSnapshot();
		const registry = await createWorkspaceRegistry({
			cwd: fixture.isolatedHomeDirectoryPath,
			loadGlobalRuntimeConfig: async () => ({}) as never,
			loadRuntimeConfig: async () => ({}) as never,
			hasGitRepository: () => false,
			now: () => 1_000,
		});
		const initialCounts = await registry.summarizeProjectTaskCounts(workspaceId, repositoryPath);
		expect(initialCounts.in_progress).toBe(1);
		await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 });
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		const failure = vi
			.spyOn(lockedFileSystem, "writeTextFileAtomic")
			.mockImplementation(async (path, text, options) => {
				if (path === join(directoryPath, "board.json")) throw new Error("board 投影暂时失败");
				await writeText(path, text, options);
			});
		try {
			await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: {
					...state.board,
					columns: state.board.columns.map((column) => ({
						...column,
						cards: column.cards
							.map((card) => ({ ...card, title: "日志中的新标题" }))
							.concat(
								column.id === "in_progress"
									? [
											{
												id: "task-2",
												title: "第二张卡",
												prompt: "第二张卡",
												baseRef: "main",
												startInPlanMode: false,
												createdAt: 2,
												updatedAt: 2,
											},
										]
									: [],
							),
					})),
				},
				value: null,
			}));
			expect((await registry.summarizeProjectTaskCounts(workspaceId, repositoryPath)).in_progress).toBe(2);
			const snapshot = await registry.getAllProjectsTaskGroupQuerySnapshot({ recentDays: 7 });
			expect(JSON.stringify(snapshot)).toContain("日志中的新标题");
		} finally {
			failure.mockRestore();
			registry.disposeWorkspace(workspaceId);
		}
	});

	it("日志持久提交前失败不改变可见版本", async () => {
		const initial = await saveInitialSnapshot();
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockImplementation(async (path, content, options) => {
			if (path === join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME))
				throw new Error("模拟日志提交失败");
			await writeText(path, content, options);
		});
		await expect(
			savePersistedWorkspaceSessionsById(workspaceId, { "task-1": session(20) }, initial.revision),
		).rejects.toThrow("模拟日志提交失败");
		expect((await loadPersistedWorkspaceStateById(workspaceId)).revision).toBe(initial.revision);
	});

	it("后台恢复只重放快照，不重跑业务回调", async () => {
		await saveInitialSnapshot();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		const failure = vi
			.spyOn(lockedFileSystem, "writeTextFileAtomic")
			.mockImplementation(async (path, content, options) => {
				if (path === join(directoryPath, "board.json")) throw new Error("暂时不可写");
				await writeText(path, content, options);
			});
		const mutation = vi.fn((state: RuntimeWorkspaceStateResponse) => ({
			board: withCard(state.board, "自动恢复"),
			value: null,
		}));
		await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, mutation);
		failure.mockRestore();
		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();
		await vi.waitFor(async () => {
			await expect(stat(join(directoryPath, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME))).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
		expect(mutation).toHaveBeenCalledTimes(1);
	});

	it("同一项目恢复尚未结束时，无锁读取不会再派发并行恢复", async () => {
		await saveInitialSnapshot();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let firstProjection = true;
		let markRecoveryStarted: () => void = () => {};
		let allowRecoveryToFinish: () => void = () => {};
		const recoveryStarted = new Promise<void>((resolve) => {
			markRecoveryStarted = resolve;
		});
		const recoveryMayFinish = new Promise<void>((resolve) => {
			allowRecoveryToFinish = resolve;
		});
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockImplementation(async (path, text, options) => {
			if (path === join(directoryPath, "board.json")) {
				if (firstProjection) {
					firstProjection = false;
					throw new Error("暂时不可投影");
				}
				markRecoveryStarted();
				await recoveryMayFinish;
			}
			await writeText(path, text, options);
		});
		await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: state.board,
			value: null,
		}));
		const recoveryLockCalls = vi.spyOn(lockedFileSystem, "withLock");
		try {
			await vi.advanceTimersByTimeAsync(1_000);
			await recoveryStarted;
			await Promise.all([loadPersistedWorkspaceStateById(workspaceId), loadWorkspaceBoardById(workspaceId)]);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(recoveryLockCalls).toHaveBeenCalledTimes(1);
		} finally {
			allowRecoveryToFinish();
			vi.useRealTimers();
		}
		await vi.waitFor(async () => {
			await expect(stat(join(directoryPath, "workspace-state-snapshot-commit.json"))).rejects.toMatchObject({
				code: "ENOENT",
			});
		});
	});

	it("重试预算耗尽后不重复写入，文件系统条件恢复后自动接续", async (context) => {
		await saveInitialSnapshot();
		let projectionMaySucceed = false;
		let projectionWriteAttempts = 0;
		const writeText = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeTextFileAtomic").mockImplementation(async (path, text, options) => {
			if (path === join(directoryPath, "board.json")) {
				projectionWriteAttempts += 1;
				if (!projectionMaySucceed) throw Object.assign(new Error("暂时没有投影写权限"), { code: "EACCES" });
			}
			await writeText(path, text, options);
		});
		const mutation = vi.fn((state: RuntimeWorkspaceStateResponse) => ({
			board: withCard(state.board, "条件恢复后接续"),
			value: null,
		}));
		await mutateWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, mutation);
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "三次有界投影重试耗尽",
				softDeadlineMsExpectedOnUncontendedHost: 25_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
			},
			() => projectionWriteAttempts === 4,
		);
		// 跨过一次条件观察窗口：没有新证据时只能观察，不能再次写入。
		await new Promise((resolve) => setTimeout(resolve, 16_000));
		expect(projectionWriteAttempts).toBe(4);
		projectionMaySucceed = true;
		await chmod(directoryPath, 0o700);
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "权限条件变化后自动完成日志投影",
				softDeadlineMsExpectedOnUncontendedHost: 20_000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 40_000,
			},
			async () => {
				try {
					await stat(join(directoryPath, "workspace-state-snapshot-commit.json"));
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
					throw error;
				}
			},
		);
		expect(projectionWriteAttempts).toBe(5);
		expect(mutation).toHaveBeenCalledTimes(1);
	});

	it("首次迁移保留原始字节、递增一次 revision 并拒绝旧版本", async () => {
		await mkdir(directoryPath, { recursive: true });
		const boardJsonText = JSON.stringify(withCard((await loadWorkspaceState(repositoryPath)).board, "旧协议观测"));
		const sessionsJsonText = "{}\n";
		const metaJsonText = '{"revision":7,"updatedAt":123}\n';
		await writeFile(join(directoryPath, "board.json"), boardJsonText);
		await writeFile(join(directoryPath, "sessions.json"), sessionsJsonText);
		await writeFile(join(directoryPath, "meta.json"), metaJsonText);
		await expect(savePersistedWorkspaceSessionsById(workspaceId, {}, 7)).rejects.toMatchObject({
			currentRevision: 8,
		});
		const observation = JSON.parse(
			await readFile(join(directoryPath, WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME), "utf8"),
		);
		expect(observation).toMatchObject({
			historicalSnapshotConsistency: "unverified",
			boardJsonText,
			sessionsJsonText,
			metaJsonText,
		});
		const migrated = JSON.parse(await readFile(join(directoryPath, "meta.json"), "utf8"));
		expect(migrated.workspaceStateSnapshotCommitId).toEqual(expect.any(String));
		expect(await savePersistedWorkspaceSessionsById(workspaceId, {}, 8)).toBe(9);
		expect(
			JSON.parse(await readFile(join(directoryPath, WORKSPACE_STATE_LEGACY_OBSERVATION_FILENAME), "utf8")),
		).toEqual(observation);
	});

	it("同 revision 的身份观察更换 commitId，并排除读取窗口中的旧 sessions", async () => {
		const initial = await saveInitialSnapshot();
		const beforeFingerprint = await getWorkspaceStateSnapshotReadFingerprintById(workspaceId);
		const beforeMeta = JSON.parse(await readFile(join(directoryPath, "meta.json"), "utf8"));
		const readText = fileReadObservation.readUtf8FileWithDailyWorkProgressCostObservation;
		let markReadStarted: () => void = () => {};
		let allowReadToReturn: () => void = () => {};
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const readMayReturn = new Promise<void>((resolve) => {
			allowReadToReturn = resolve;
		});
		let pauseNextSessionsRead = true;
		vi.spyOn(fileReadObservation, "readUtf8FileWithDailyWorkProgressCostObservation").mockImplementation(
			async (...parameters) => {
				const result = await readText(...parameters);
				if (parameters[0] === join(directoryPath, "sessions.json") && pauseNextSessionsRead) {
					pauseNextSessionsRead = false;
					markReadStarted();
					await readMayReturn;
				}
				return result;
			},
		);
		const racingRead = loadPersistedWorkspaceStateById(workspaceId);
		try {
			await readStarted;
			expect(
				await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () =>
					session(30),
				),
			).toBe("persisted_reconfirmed_identity_observation_time_without_revision_change");
		} finally {
			allowReadToReturn();
		}
		const loaded = await racingRead;
		expect(loaded.revision).toBe(initial.revision);
		expect(loaded.sessions["task-1"]?.agentNativeConversationSessionIdentity?.observedAt).toBe(30);
		const afterMeta = JSON.parse(await readFile(join(directoryPath, "meta.json"), "utf8"));
		expect(afterMeta.workspaceStateSnapshotCommitId).not.toBe(beforeMeta.workspaceStateSnapshotCommitId);
		expect(await getWorkspaceStateSnapshotReadFingerprintById(workspaceId)).not.toBe(beforeFingerprint);
	});

	it("持久提交后进程被杀，下一进程读完整日志并恢复，旧 expectedRevision 失效", async (context) => {
		const initial = await saveInitialSnapshot();
		const moduleUrl = new URL("../../src/state/workspace-state.ts", import.meta.url).href;
		const filesystemUrl = new URL("../../src/fs/locked-file-system.ts", import.meta.url).href;
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
import { appendFile } from "node:fs/promises";
import { mutateWorkspaceState } from ${JSON.stringify(moduleUrl)};
import { lockedFileSystem } from ${JSON.stringify(filesystemUrl)};
const original = lockedFileSystem.writeTextFileAtomic.bind(lockedFileSystem);
lockedFileSystem.writeTextFileAtomic = async (path, content, options) => {
 if (path === ${JSON.stringify(join(directoryPath, "board.json"))}) process.kill(process.pid, "SIGKILL");
 await original(path, content, options);
};
await mutateWorkspaceState(${JSON.stringify(repositoryPath)}, ${JSON.stringify(TASK_MUTATION_INTENT_FOR_TEST_FIXTURE)}, async (state) => {
 await appendFile(${JSON.stringify(join(directoryPath, "business-action-count.txt"))}, "一次\\n");
 return { board: ${JSON.stringify(withCard(initial.board, "进程退出前已提交"))}, value: null };
});
`,
			],
			{
				cwd: fileURLToPath(new URL("../../", import.meta.url)),
				env: fixture.createIsolatedChildProcessEnvironment({
					CODEX_HOME: process.env.CODEX_HOME,
					CODEX_SQLITE_HOME: process.env.CODEX_SQLITE_HOME,
				}),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		childProcesses.register(child);
		await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(context, child, {
			waitedForDescription: "隔离子进程退出",
			softDeadlineMsExpectedOnUncontendedHost: 10_000,
			hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
		});
		expect(child.signalCode).toBe("SIGKILL");
		const committed = await loadPersistedWorkspaceStateById(workspaceId);
		expect(committed.revision).toBe(initial.revision + 1);
		expect(committed.board.columns.flatMap((column) => column.cards)[0]?.title).toBe("进程退出前已提交");
		await expect(savePersistedWorkspaceSessionsById(workspaceId, {}, initial.revision)).rejects.toMatchObject({
			currentRevision: initial.revision + 1,
		});
		expect(await readFile(join(directoryPath, "business-action-count.txt"), "utf8")).toBe("一次\n");
	});
});
