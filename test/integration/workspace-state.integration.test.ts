import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveAgentConversationSessionResumeAddressing } from "../../src/core/agent-conversation-session-resume-addressing";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { applySessionFacets, SESSION_SUMMARY_SCHEMA_VERSION } from "../../src/core/session-activity";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import { removeTaskSessionSummariesOwnedByOtherWorkspaces } from "../../src/state/task-session-summaries-owned-by-other-workspaces-removal";
import type {
	AgentNativeConversationSessionIdentityPersistenceOutcome,
	WorkspaceStateConflictError,
} from "../../src/state/workspace-state";
import {
	getTaskWorktreesHomePath,
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	loadWorkspaceContextById,
	loadWorkspaceState,
	mutateWorkspaceState,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId,
	removeWorkspaceIndexEntry,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createHooksApi } from "../../src/trpc/hooks-api";
import {
	createIsolatedGitTestWorkspaceFixture,
	type IsolatedGitTestRepository,
} from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title: title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createBoardWithTaskInColumn(
	title: string,
	columnId: RuntimeBoardData["columns"][number]["id"],
): RuntimeBoardData {
	const board = createBoard(title);
	const task = board.columns.find((column) => column.id === "backlog")?.cards[0];
	if (!task) {
		throw new Error("Expected createBoard to create one backlog task.");
	}
	const columns = board.columns.map((column) => ({
		...column,
		cards: column.id === columnId ? [task] : [],
	}));
	if (!columns.some((column) => column.id === columnId)) {
		columns.push({ id: columnId, title: "Validation", cards: [task] });
	}
	return {
		...board,
		columns,
	};
}

function createSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

async function withIsolatedWorkspaceStateHome<T>(
	run: (context: {
		createRepository: (relativePathSegments: readonly string[]) => IsolatedGitTestRepository;
	}) => Promise<T>,
): Promise<T> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const tempHome = gitFixture.isolatedHomeDirectoryPath;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run({
			createRepository(relativePathSegments) {
				const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, ...relativePathSegments);
				mkdirSync(repositoryPath, { recursive: true });
				return gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			},
		});
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		gitFixture.cleanup();
	}
}

describe.sequential("workspace-state integration", () => {
	it("returns local branch metadata with last commit dates in recency order", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const repository = createRepository(["project-a"]);
			const workspacePath = repository.repositoryPath;

			writeFileSync(join(workspacePath, "main.txt"), "main\n", "utf8");
			repository.commitAllRepositoryFilesAtDate({
				message: "main commit",
				authorAndCommitterIsoDate: "2026-05-08T10:00:00+08:00",
			});
			const mainBranch = repository.runGit(["symbolic-ref", "--short", "HEAD"]).stdout.trim();

			repository.runGit(["checkout", "--quiet", "-b", "feature/recent"]);
			writeFileSync(join(workspacePath, "feature.txt"), "feature\n", "utf8");
			repository.commitAllRepositoryFilesAtDate({
				message: "feature commit",
				authorAndCommitterIsoDate: "2026-05-10T12:34:56+08:00",
			});

			repository.runGit(["checkout", "--quiet", mainBranch]);

			const state = await loadWorkspaceState(workspacePath);

			expect(state.git.currentBranch).toBe(mainBranch);
			expect(state.git.branches).toEqual([
				{ name: "feature/recent", lastCommitDate: "2026-05-10T12:34:56+08:00" },
				{ name: mainBranch, lastCommitDate: "2026-05-08T10:00:00+08:00" },
			]);
		});
	});

	it("persists revision numbers and rejects stale writes", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-a"]).repositoryPath;

			const initial = await loadWorkspaceState(workspacePath);
			expect(initial.revision).toBe(0);

			const firstSave = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("Task One"),
				sessions: {},
				expectedRevision: initial.revision,
			});
			expect(firstSave.revision).toBe(1);
			expect(firstSave.board.columns[0]?.cards[0]?.prompt).toBe("Task One");

			const secondSave = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("Task Two"),
				sessions: {},
				expectedRevision: firstSave.revision,
			});
			expect(secondSave.revision).toBe(2);
			expect(secondSave.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");

			await expect(
				saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBoard("Stale Task"),
					sessions: {},
					expectedRevision: firstSave.revision,
				}),
			).rejects.toMatchObject({
				name: "WorkspaceStateConflictError",
				currentRevision: secondSave.revision,
			} satisfies Partial<WorkspaceStateConflictError>);

			const loadedAfterConflict = await loadWorkspaceState(workspacePath);
			expect(loadedAfterConflict.revision).toBe(2);
			expect(loadedAfterConflict.board.columns[0]?.cards[0]?.prompt).toBe("Task Two");
		});
	});

	it("prevents whole-board saves from leaving a started task in backlog", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-started-task-stage"]).repositoryPath;
			const initial = await loadWorkspaceState(workspacePath);
			const startedAt = Date.now();
			const startedSession = applySessionFacets({
				...createSessionSummary("task-1"),
				state: "running",
				agentId: "kimi",
				pid: 1234,
				startedAt,
				updatedAt: startedAt,
			});

			const saved = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("Started task"),
				sessions: { "task-1": startedSession },
				expectedRevision: initial.revision,
			});

			expect(saved.board.columns.find((column) => column.id === "backlog")?.cards).toEqual([]);
			expect(saved.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe("task-1");

			const savedFromStaleWholeBoardSnapshot = await saveWorkspaceState(
				workspacePath,
				TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
				{
					board: createBoard("Stale task snapshot"),
					sessions: {},
					expectedRevision: saved.revision,
				},
			);
			expect(
				savedFromStaleWholeBoardSnapshot.board.columns.find((column) => column.id === "backlog")?.cards,
			).toEqual([]);
			expect(
				savedFromStaleWholeBoardSnapshot.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id,
			).toBe("task-1");
			expect(savedFromStaleWholeBoardSnapshot.sessions["task-1"]).toEqual(startedSession);
		});
	});

	it.each(["review", "validation"] as const)(
		"restores a persisted started task to its %s column when a whole-board snapshot is stale",
		async (columnId) => {
			await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
				const workspacePath = createRepository([`project-stale-${columnId}-stage`]).repositoryPath;
				const initial = await loadWorkspaceState(workspacePath);
				const startedSession = applySessionFacets({
					...createSessionSummary("task-1"),
					state: "awaiting_review",
					agentId: "claude",
					startedAt: Date.now(),
				});
				const saved = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBoardWithTaskInColumn("Started task", columnId),
					sessions: { "task-1": startedSession },
					expectedRevision: initial.revision,
				});

				const staleSave = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: createBoard("Stale task snapshot"),
					sessions: {},
					expectedRevision: saved.revision,
				});

				expect(staleSave.board.columns.find((column) => column.id === columnId)?.cards[0]?.id).toBe("task-1");
				expect(staleSave.sessions["task-1"]).toEqual(startedSession);
			});
		},
	);

	it("applies the started-task backlog invariant to direct atomic mutations", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-direct-mutation-stage"]).repositoryPath;
			const initial = await loadWorkspaceState(workspacePath);
			const startedSession = applySessionFacets({
				...createSessionSummary("task-1"),
				state: "running",
				agentId: "kimi",
				startedAt: Date.now(),
			});
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Started task", "in_progress"),
				sessions: { "task-1": startedSession },
				expectedRevision: initial.revision,
			});

			const mutation = await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, () => ({
				board: createBoard("Regressed task"),
				sessions: {},
				value: null,
			}));

			expect(mutation.state.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
				"task-1",
			);
			expect(mutation.state.sessions["task-1"]).toEqual(startedSession);
		});
	});

	it("lists and removes workspace index entries across multiple projects", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspaceAPath = createRepository(["alpha"]).repositoryPath;
			const workspaceBPath = createRepository(["beta"]).repositoryPath;

			const contextA = await loadWorkspaceContext(workspaceAPath);
			const contextB = await loadWorkspaceContext(workspaceBPath);

			const entries = await listWorkspaceIndexEntries();
			expect(entries).toHaveLength(2);
			expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
				[contextA.workspaceId, contextB.workspaceId].sort(),
			);

			expect(await loadWorkspaceContextById(contextA.workspaceId)).not.toBeNull();
			expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(true);
			expect(await loadWorkspaceContextById(contextA.workspaceId)).toBeNull();
			expect(await removeWorkspaceIndexEntry(contextA.workspaceId)).toBe(false);

			const entriesAfterRemoval = await listWorkspaceIndexEntries();
			expect(entriesAfterRemoval).toHaveLength(1);
			expect(entriesAfterRemoval[0]?.workspaceId).toBe(contextB.workspaceId);
		});
	});

	it("keeps all workspace index entries when projects are added concurrently", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspaceAPath = createRepository(["alpha"]).repositoryPath;
			const workspaceBPath = createRepository(["beta"]).repositoryPath;

			const [contextA, contextB] = await Promise.all([
				loadWorkspaceContext(workspaceAPath),
				loadWorkspaceContext(workspaceBPath),
			]);

			const entries = await listWorkspaceIndexEntries();
			expect(entries).toHaveLength(2);
			expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
				[contextA.workspaceId, contextB.workspaceId].sort(),
			);
		});
	});

	it("creates readable workspace ids from folder names with random suffix on collisions", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspaceAPath = createRepository(["one", "vscrui"]).repositoryPath;
			const workspaceBPath = createRepository(["two", "vscrui"]).repositoryPath;
			const workspaceCPath = createRepository(["three", "My Cool Repo"]).repositoryPath;

			const contextA = await loadWorkspaceContext(workspaceAPath);
			const contextB = await loadWorkspaceContext(workspaceBPath);
			const contextC = await loadWorkspaceContext(workspaceCPath);

			expect(contextA.workspaceId).toBe("vscrui");
			expect(contextB.workspaceId).toMatch(/^vscrui-[a-z0-9]{4}$/);
			expect(contextB.workspaceId).not.toBe(contextA.workspaceId);
			expect(contextC.workspaceId).toBe("my-cool-repo");

			const contextAAgain = await loadWorkspaceContext(workspaceAPath);
			expect(contextAAgain.workspaceId).toBe(contextA.workspaceId);
		});
	});

	it("can require an existing project without auto-creating workspace entries", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["gamma"]).repositoryPath;

			await expect(
				loadWorkspaceContext(workspacePath, {
					autoCreateIfMissing: false,
				}),
			).rejects.toThrow("is not added to Kanban yet");

			const created = await loadWorkspaceContext(workspacePath);
			expect(created.repoPath).toBeTruthy();

			const existing = await loadWorkspaceContext(workspacePath, {
				autoCreateIfMissing: false,
			});
			expect(existing.workspaceId).toBe(created.workspaceId);
		});
	});

	it("fails loudly when persisted board data is malformed", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-bad-board"]).repositoryPath;

			const context = await loadWorkspaceContext(workspacePath);
			mkdirSync(context.statePath, { recursive: true });
			writeFileSync(
				join(context.statePath, "board.json"),
				JSON.stringify(
					{
						columns: [
							{
								id: "backlog",
								title: "Backlog",
								cards: [
									{
										prompt: "Missing ID and baseRef",
										startInPlanMode: false,
										createdAt: Date.now(),
										updatedAt: Date.now(),
									},
								],
							},
							{ id: "in_progress", title: "In Progress", cards: [] },
							{ id: "review", title: "Review", cards: [] },
							{ id: "trash", title: "Done", cards: [] },
						],
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("board.json");
			await expect(loadWorkspaceState(workspacePath)).rejects.toThrow(/id|baseRef/);
		});
	});

	// dd2db 1a：任务连线 / 完成后自动启动机制已整体退役。旧盘 board.json 仍可能带 `dependencies` 键，
	// 读入时必须被静默剥离而不是让整块看板读失败。
	it("reads a legacy board.json that still carries the retired dependencies key", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-legacy-board-with-retired-dependencies"]).repositoryPath;

			const context = await loadWorkspaceContext(workspacePath);
			mkdirSync(context.statePath, { recursive: true });
			const legacyBoard = createBoard("Legacy task");
			writeFileSync(
				join(context.statePath, "board.json"),
				JSON.stringify(
					{
						...legacyBoard,
						dependencies: [{ id: "dep01", fromTaskId: "task-1", toTaskId: "task-2", createdAt: Date.now() }],
					},
					null,
					2,
				),
				"utf8",
			);

			const state = await loadWorkspaceState(workspacePath);
			expect(state.board).not.toHaveProperty("dependencies");
			expect(state.board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id)).toEqual([
				"task-1",
			]);
		});
	});

	it("fails loudly when persisted sessions include unknown states", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-bad-sessions"]).repositoryPath;

			const context = await loadWorkspaceContext(workspacePath);
			mkdirSync(context.statePath, { recursive: true });
			writeFileSync(
				join(context.statePath, "board.json"),
				JSON.stringify(createBoard("Valid board"), null, 2),
				"utf8",
			);
			writeFileSync(
				join(context.statePath, "sessions.json"),
				JSON.stringify(
					{
						"task-1": {
							...createSessionSummary("task-1"),
							state: "not-a-valid-state",
						},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("sessions.json");
			await expect(loadWorkspaceState(workspacePath)).rejects.toThrow("state");
		});
	});

	// Stage 2 读时回填回归：旧盘 sessions.json（facet 全缺）在 loadWorkspaceState 时被即时回填出
	// 与 legacy state 自洽的三 facet + schemaVersion；已带 facet 的 session 不被 clobber；且纯读
	// 无副作用——on-disk 文件不被改写（回填只在内存、随下次 save 落盘）。
	it("backfills consistent session facets on read without rewriting the file", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-legacy-sessions"]).repositoryPath;

			const context = await loadWorkspaceContext(workspacePath);
			mkdirSync(context.statePath, { recursive: true });
			writeFileSync(
				join(context.statePath, "board.json"),
				JSON.stringify(createBoard("Valid board"), null, 2),
				"utf8",
			);

			// 旧盘：两个无-facet legacy session（running / awaiting_review 进程已退）+ 一个已带 facet 的。
			const legacyRunning: RuntimeTaskSessionSummary = {
				...createSessionSummary("legacy-running"),
				state: "running",
				pid: 4321,
				lastOutputAt: Date.now(),
			};
			const legacyExited: RuntimeTaskSessionSummary = {
				...createSessionSummary("legacy-exited"),
				state: "awaiting_review",
				pid: null,
				reviewReason: "exit",
			};
			const alreadyFaceted = applySessionFacets({
				...createSessionSummary("already-faceted"),
				state: "awaiting_review",
				pid: 99,
				reviewReason: "hook",
			});
			const sessionsPath = join(context.statePath, "sessions.json");
			const rawSessionsOnDisk = JSON.stringify(
				{
					"legacy-running": legacyRunning,
					"legacy-exited": legacyExited,
					"already-faceted": alreadyFaceted,
				},
				null,
				2,
			);
			writeFileSync(sessionsPath, rawSessionsOnDisk, "utf8");

			const loaded = await loadWorkspaceState(workspacePath);

			// running 旧盘 → agent/live；盖 schemaVersion。
			const running = loaded.sessions["legacy-running"];
			expect(running?.turnOwner).toBe("agent");
			expect(running?.liveness).toBe("live");
			expect(running?.userTurnKind).toBe(null);
			expect(running?.schemaVersion).toBe(SESSION_SUMMARY_SCHEMA_VERSION);

			// awaiting_review + pid:null 旧盘 → exited（legacy state 表达不了、读时回填保真）。
			const exited = loaded.sessions["legacy-exited"];
			expect(exited?.turnOwner).toBe("user");
			expect(exited?.liveness).toBe("exited");
			expect(exited?.userTurnKind).toBe("review");

			// 已带 facet 的 session 原样保留、不被 clobber。
			expect(loaded.sessions["already-faceted"]).toEqual(alreadyFaceted);

			// 纯读无副作用：on-disk sessions.json 未被改写（回填只在内存，随下次 save 落盘）。
			expect(readFileSync(sessionsPath, "utf8")).toBe(rawSessionsOnDisk);
		});
	});

	// ── 「空壳 summary 把真实记录盖掉」的回归护栏 ──────────────────────────────────────────
	// 硬中断后前端一聚焦卡片，服务端 `ensureEntry` 就会就地造出一条全 null 的默认 summary。它带着最新的
	// updatedAt 被并进落盘 payload，把盘上记着 agentId / startedAt 的记录整条盖掉——一次「重启就能自愈」
	// 的中断由此变成永久损坏（TUI 全白 + 「重启终端会话」灰掉）。

	it("saveWorkspaceState keeps a started session when the incoming snapshot only has a blank placeholder", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-a"]).repositoryPath;
			const initial = await loadWorkspaceState(workspacePath);
			const startedSession: RuntimeTaskSessionSummary = {
				...createSessionSummary("task-1"),
				agentId: "claude",
				workspacePath,
				pid: 4242,
				startedAt: 1_000,
				updatedAt: 1_000,
			};
			const afterFirstSave = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Task One", "in_progress"),
				sessions: { "task-1": startedSession },
				expectedRevision: initial.revision,
			});

			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Task One", "in_progress"),
				// 空壳的 updatedAt 更新，但它表达的是「刚被凭空造出来」，不是「掌握了更新的事实」。
				sessions: { "task-1": { ...createSessionSummary("task-1"), updatedAt: 9_000 } },
				expectedRevision: afterFirstSave.revision,
			});

			const reloaded = await loadWorkspaceState(workspacePath);
			expect(reloaded.sessions["task-1"].agentId).toBe("claude");
			expect(reloaded.sessions["task-1"].startedAt).toBe(1_000);
			expect(reloaded.sessions["task-1"].pid).toBe(4242);
		});
	});

	it("mutateWorkspaceState keeps a started session when the mutation carries a blank placeholder", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-a"]).repositoryPath;
			const initial = await loadWorkspaceState(workspacePath);
			const startedSession: RuntimeTaskSessionSummary = {
				...createSessionSummary("task-1"),
				agentId: "codex",
				workspacePath,
				pid: 77,
				startedAt: 1_000,
				updatedAt: 1_000,
			};
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Task One", "in_progress"),
				sessions: { "task-1": startedSession },
				expectedRevision: initial.revision,
			});

			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				sessions: { "task-1": { ...createSessionSummary("task-1"), updatedAt: 9_000 } },
				value: null,
			}));

			const reloaded = await loadWorkspaceState(workspacePath);
			expect(reloaded.sessions["task-1"].agentId).toBe("codex");
			expect(reloaded.sessions["task-1"].startedAt).toBe(1_000);
		});
	});

	it("still accepts a blank placeholder when the persisted record is itself blank", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const workspacePath = createRepository(["project-a"]).repositoryPath;
			const initial = await loadWorkspaceState(workspacePath);
			const afterFirstSave = await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Task One", "in_progress"),
				sessions: { "task-1": { ...createSessionSummary("task-1"), updatedAt: 1_000 } },
				expectedRevision: initial.revision,
			});

			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoardWithTaskInColumn("Task One", "in_progress"),
				sessions: { "task-1": { ...createSessionSummary("task-1"), updatedAt: 9_000 } },
				expectedRevision: afterFirstSave.revision,
			});

			const reloaded = await loadWorkspaceState(workspacePath);
			// 两边都是空壳时留谁都一样，放行 incoming 免得把陈旧 updatedAt 钉住。
			expect(reloaded.sessions["task-1"].updatedAt).toBe(9_000);
		});
	});

	it("fails loudly when persisted workspace index data is malformed", async () => {
		await withIsolatedWorkspaceStateHome(async () => {
			mkdirSync(getWorkspacesRootPath(), { recursive: true });
			writeFileSync(
				join(getWorkspacesRootPath(), "index.json"),
				JSON.stringify(
					{
						version: 1,
						entries: {
							"workspace-a": {
								workspaceId: "workspace-a",
							},
						},
						repoPathToId: {},
					},
					null,
					2,
				),
				"utf8",
			);

			await expect(listWorkspaceIndexEntries()).rejects.toThrow("index.json");
			await expect(listWorkspaceIndexEntries()).rejects.toThrow("repoPath");
		});
	});
});

describe.sequential("别的项目串写进 sessions.json 的会话（cf427）", () => {
	function createSessionSummaryWorkingIn(taskId: string, workspacePath: string): RuntimeTaskSessionSummary {
		return { ...createSessionSummary(taskId), agentId: "codex", startedAt: 1, workspacePath };
	}

	it("整板保存只收本项目的会话；读取时隐藏盘上的外来条目，下一次写入把它们从盘上清掉", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const ownerRepository = createRepository(["owner-project"]);
			const ownerContext = await loadWorkspaceContext(ownerRepository.repositoryPath);
			const ownSummary = createSessionSummaryWorkingIn(
				"own01",
				join(getTaskWorktreesHomePath(), "own01", "owner-project"),
			);
			const foreignSummary = createSessionSummaryWorkingIn(
				"frgn1",
				join(getTaskWorktreesHomePath(), "frgn1", "other-project"),
			);

			// 1) 客户端（例如没刷新的旧 bundle）整板保存时夹带了别的项目的会话：不落盘。
			const saved = await saveWorkspaceState(ownerRepository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("owner"),
				sessions: { own01: ownSummary, frgn1: foreignSummary },
			});
			expect(Object.keys(saved.sessions)).toEqual(["own01"]);
			expect(Object.keys((await loadPersistedWorkspaceStateById(ownerContext.workspaceId)).sessions)).toEqual([
				"own01",
			]);

			// 2) 部署前就已串写进盘的条目：读取（重启水合、快照）时隐藏。
			const sessionsFilePath = join(getWorkspacesRootPath(), ownerContext.workspaceId, "sessions.json");
			writeFileSync(sessionsFilePath, JSON.stringify({ own01: ownSummary, frgn1: foreignSummary }));
			expect(Object.keys((await loadWorkspaceState(ownerRepository.repositoryPath)).sessions)).toEqual(["own01"]);

			// 3) 下一次 board 写入（不带 sessions 的锁内变更）把它们从盘上清掉。
			await mutateWorkspaceState(ownerRepository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
				board: state.board,
				value: null,
			}));
			expect(Object.keys(JSON.parse(readFileSync(sessionsFilePath, "utf8")) as object)).toEqual(["own01"]);
		});
	});

	it("Windows 上 inplace 任务的仓库与 task worktree 根跨盘符时保留其会话（relative() 返回绝对路径，不得按段误判）", () => {
		const windowsTaskWorktreesHomePath = "C:\\Users\\dev\\.cline\\worktrees";
		const sessions = {
			"inplace-task-on-other-drive": createSessionSummaryWorkingIn(
				"inplace-task-on-other-drive",
				"D:\\repos\\owner-project",
			),
			"inplace-task-on-other-drive-subdirectory": createSessionSummaryWorkingIn(
				"inplace-task-on-other-drive-subdirectory",
				"D:\\repos\\owner-project\\web-ui",
			),
			own01: createSessionSummaryWorkingIn("own01", `${windowsTaskWorktreesHomePath}\\own01\\owner-project`),
			frgn1: createSessionSummaryWorkingIn("frgn1", `${windowsTaskWorktreesHomePath}\\frgn1\\other-project`),
		};
		const removal = removeTaskSessionSummariesOwnedByOtherWorkspaces({
			workspaceId: "owner-project",
			workspaceRepositoryPath: "D:\\repos\\owner-project",
			taskWorktreesHomePath: windowsTaskWorktreesHomePath,
			sessions,
			sessionWorkingDirectoryOwnershipPathOperations: win32,
		});
		// 同盘符的 worktree 判定照旧：只剔除别的仓库目录名下的 worktree 会话。
		expect(removal.removedTaskSessionIdsOwnedByOtherWorkspaces).toEqual(["frgn1"]);
		expect(Object.keys(removal.sessionsWithoutSummariesOwnedByOtherWorkspaces)).toEqual([
			"inplace-task-on-other-drive",
			"inplace-task-on-other-drive-subdirectory",
			"own01",
		]);
	});
});

describe.sequential("原生会话身份的独立持久化", () => {
	const nativeSessionIds = [
		"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
		"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
		"cccccccc-3333-4333-8333-cccccccccccc",
	];
	const sessionKeys = ["task-1", "task-conversation-session-fork", "task-conversation-session-scratch"];
	function createNativeSummary(taskId: string, nativeSessionId: string): RuntimeTaskSessionSummary {
		return {
			...createSessionSummary(taskId),
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: null,
				observedAt: 1,
			},
		};
	}

	it("无浏览器保存或正常关闭，hook 确认后重建 manager 仍按各自原生 ID 恢复", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const repo = createRepository(["native-identity-restart"]);
			const context = await loadWorkspaceContext(repo.repositoryPath);
			await saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("identity"),
				sessions: {},
			});
			const before = await loadPersistedWorkspaceStateById(context.workspaceId);
			const manager = new TerminalSessionManager();
			const restored = new TerminalSessionManager();
			manager.hydrateFromRecord(
				Object.fromEntries(
					sessionKeys.map((key) => [
						key,
						{ ...createSessionSummary(key), agentId: "codex", workspacePath: repo.repositoryPath },
					]),
				),
			);
			const api = createHooksApi({
				getWorkspacePathById: () => repo.repositoryPath,
				ensureTerminalManagerForWorkspace: async () => manager,
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastTaskReadyForReview: vi.fn(),
			});
			try {
				for (const [index, key] of sessionKeys.entries()) {
					const previous = await loadPersistedWorkspaceStateById(context.workspaceId);
					const identity = createNativeSummary(
						key,
						nativeSessionIds[index],
					).agentNativeConversationSessionIdentity;
					expect(
						await api.ingest({
							workspaceId: context.workspaceId,
							taskId: key,
							event: "activity",
							agentNativeConversationSessionIdentity: identity ?? undefined,
						}),
					).toEqual({ ok: true });
					const after = await loadPersistedWorkspaceStateById(context.workspaceId);
					for (const [otherKey, value] of Object.entries(previous.sessions))
						expect(after.sessions[otherKey]).toEqual(value);
				}
				const persisted = await loadPersistedWorkspaceStateById(context.workspaceId);
				expect(persisted.board).toEqual(before.board);
				expect(persisted.revision).toBe(before.revision + 3);
				// 旧 manager 尚未关闭；这个新 manager 唯一的输入是磁盘记录。
				restored.hydrateFromRecord(persisted.sessions);
				for (const [index, key] of sessionKeys.entries()) {
					const addressing = resolveAgentConversationSessionResumeAddressing({
						resumesPriorAgentConversation: true,
						launchAgentId: "codex",
						observedAgentNativeConversationSessionIdentity:
							restored.getSummary(key)?.agentNativeConversationSessionIdentity,
						taskConversationSessionsSharingExecutionWorkingDirectory: sessionKeys
							.filter((otherKey) => otherKey !== key)
							.map((otherKey) => ({
								taskConversationSessionId: otherKey,
								agentId: "codex",
								taskConversationSessionRole: "by_the_way" as const,
							})),
					});
					expect(addressing).toMatchObject({
						kind: "addressed_by_observed_agent_native_session_id",
						taskAgentSessionInitialization: {
							sourceSessionId: nativeSessionIds[index],
							sourceSessionReuseMode: "resume_existing_session",
						},
					});
				}
				const summary = manager.getSummary(sessionKeys[1]);
				if (!summary?.agentNativeConversationSessionIdentity) throw new Error("Expected captured identity");
				await api.ingest({
					workspaceId: context.workspaceId,
					taskId: sessionKeys[1],
					event: "activity",
					agentNativeConversationSessionIdentity: {
						...summary.agentNativeConversationSessionIdentity,
						observedAt: 999,
					},
				});
				const confirmed = await loadPersistedWorkspaceStateById(context.workspaceId);
				// 同身份的新确认必须推进磁盘上的 observedAt 水位，但不推进 revision（cf427：否则每个 hook 都让客户端整板重水合）。
				expect(confirmed.revision).toBe(persisted.revision);
				expect(confirmed.sessions[sessionKeys[1]].agentNativeConversationSessionIdentity?.observedAt).toBe(999);
				await api.ingest({
					workspaceId: context.workspaceId,
					taskId: sessionKeys[1],
					event: "agent_conversation_session_identity_observed",
					agentNativeConversationSessionIdentity: {
						...summary.agentNativeConversationSessionIdentity,
						observedAt: 999,
					},
				});
				expect((await loadPersistedWorkspaceStateById(context.workspaceId)).revision).toBe(confirmed.revision);
			} finally {
				manager.dispose();
				restored.dispose();
			}
		});
	});

	it.each(["lock", "meta.json", "sessions.json"])("%s 失败不确认，重复相同内存身份可补存", async (failurePoint) => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const repo = createRepository(["native-identity-failure"]);
			const context = await loadWorkspaceContext(repo.repositoryPath);
			await saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("identity"),
				sessions: {},
			});
			const before = await loadPersistedWorkspaceStateById(context.workspaceId);
			const summary = createNativeSummary(sessionKeys[1], nativeSessionIds[1]);
			const originalWrite = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
			const failure =
				failurePoint === "lock"
					? vi.spyOn(lockedFileSystem, "withLock").mockRejectedValueOnce(new Error("injected failure"))
					: vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, value, options) => {
							if (path.endsWith(failurePoint)) throw new Error("injected failure");
							return originalWrite(path, value, options);
						});
			try {
				await expect(
					persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
						context.workspaceId,
						summary.taskId,
						() => summary,
					),
				).rejects.toThrow("injected failure");
			} finally {
				failure.mockRestore();
			}
			const afterFailure = await loadPersistedWorkspaceStateById(context.workspaceId);
			expect(afterFailure.sessions).toEqual(before.sessions);
			expect(afterFailure.revision).toBe(before.revision + (failurePoint === "sessions.json" ? 1 : 0));
			expect(
				await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					summary.taskId,
					() => summary,
				),
			).toBe("persisted_new_identity_and_invalidated_stale_snapshot_revision");
			expect(
				(await loadPersistedWorkspaceStateById(context.workspaceId)).sessions[summary.taskId]
					.agentNativeConversationSessionIdentity,
			).toEqual(summary.agentNativeConversationSessionIdentity);
			await expect(
				saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: before.board,
					sessions: before.sessions,
					expectedRevision: before.revision,
				}),
			).rejects.toThrow("revision mismatch");
		});
	});

	it("同一身份的再次确认只推进 observedAt 水位，不推进 revision；之后的陈旧整板保存不会冲突也不回退水位", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const repo = createRepository(["native-identity-reconfirmation"]);
			const context = await loadWorkspaceContext(repo.repositoryPath);
			await saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("identity"),
				sessions: {},
			});
			const summary = createNativeSummary(sessionKeys[0], nativeSessionIds[0]);
			expect(
				await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					summary.taskId,
					() => summary,
				),
			).toBe("persisted_new_identity_and_invalidated_stale_snapshot_revision");
			// 浏览器在这一刻拿到的快照：之后它会带着这份 sessions 与 revision 发起整板保存。
			const snapshotHeldByBrowser = await loadPersistedWorkspaceStateById(context.workspaceId);
			const reconfirmedSummary: RuntimeTaskSessionSummary = {
				...summary,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: nativeSessionIds[0],
					transcriptPath: null,
					observedAt: 50,
				},
			};
			expect(
				await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					summary.taskId,
					() => reconfirmedSummary,
				),
			).toBe("persisted_reconfirmed_identity_observation_time_without_revision_change");
			const afterReconfirmation = await loadPersistedWorkspaceStateById(context.workspaceId);
			expect(afterReconfirmation.revision).toBe(snapshotHeldByBrowser.revision);
			expect(afterReconfirmation.sessions[summary.taskId].agentNativeConversationSessionIdentity?.observedAt).toBe(
				50,
			);
			expect(
				await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					summary.taskId,
					() => reconfirmedSummary,
				),
			).toBe("already_persisted_without_write");

			// 陈旧快照照常保存成功（revision 没被再确认推走），但盘上较新的 observedAt 水位保留。
			const saved = await saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: snapshotHeldByBrowser.board,
				sessions: snapshotHeldByBrowser.sessions,
				expectedRevision: snapshotHeldByBrowser.revision,
			});
			expect(saved.revision).toBe(snapshotHeldByBrowser.revision + 1);
			expect(
				(await loadPersistedWorkspaceStateById(context.workspaceId)).sessions[summary.taskId]
					.agentNativeConversationSessionIdentity?.observedAt,
			).toBe(50);
		});
	});

	it("锁内读取最新身份，并发保存不同会话及看板不丢修改", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const repo = createRepository(["native-identity-concurrent"]);
			const context = await loadWorkspaceContext(repo.repositoryPath);
			await saveWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard("before"),
				sessions: {},
			});
			let summary = createNativeSummary(sessionKeys[1], nativeSessionIds[0]);
			let queuedPersistence: Promise<AgentNativeConversationSessionIdentityPersistenceOutcome> = Promise.resolve(
				"already_persisted_without_write",
			);
			await lockedFileSystem.withLock(
				{
					type: "directory",
					path: context.statePath,
					lockfilePath: join(getWorkspacesRootPath(), `${context.workspaceId}.lock`),
				},
				async () => {
					queuedPersistence = persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
						context.workspaceId,
						sessionKeys[1],
						() => summary,
					);
					// 排队前的身份不能捕获在写操作中。
					summary = createNativeSummary(sessionKeys[1], nativeSessionIds[1]);
				},
			);
			await Promise.all([
				queuedPersistence,
				persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(context.workspaceId, sessionKeys[2], () =>
					createNativeSummary(sessionKeys[2], nativeSessionIds[2]),
				),
				mutateWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
					board: {
						...state.board,
						columns: state.board.columns.map((column) => ({
							...column,
							cards: column.cards.map((card) => ({ ...card, title: "after" })),
						})),
					},
					value: null,
				})),
			]);
			const persisted = await loadPersistedWorkspaceStateById(context.workspaceId);
			expect(persisted.sessions[sessionKeys[1]].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				nativeSessionIds[1],
			);
			expect(persisted.sessions[sessionKeys[2]].agentNativeConversationSessionIdentity?.nativeSessionId).toBe(
				nativeSessionIds[2],
			);
			expect(persisted.board.columns[0].cards[0].title).toBe("after");
		});
	});

	it("不存在或 agent 不匹配的会话不能建立绑定", async () => {
		await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
			const context = await loadWorkspaceContext(createRepository(["native-identity-invalid"]).repositoryPath);
			await expect(
				persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					"missing",
					() => null,
				),
			).rejects.toThrow("no longer available");
			const wrongAgent = { ...createNativeSummary("task-1", nativeSessionIds[0]), agentId: "claude" as const };
			await expect(
				persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(
					context.workspaceId,
					"task-1",
					() => wrongAgent,
				),
			).rejects.toThrow("does not match");
			expect((await loadPersistedWorkspaceStateById(context.workspaceId)).sessions).toEqual({});
		});
	});
});

it("原生身份在无浏览器保存时落盘，重复观察幂等且不推进对话时间", async () => {
	await withIsolatedWorkspaceStateHome(async ({ createRepository }) => {
		const repository = createRepository(["identity-persistence"]);
		const cwd = repository.repositoryPath;
		const identity = { sourceAgentId: "codex", nativeSessionId: "native-A", transcriptPath: null, observedAt: 1 };
		const summary: RuntimeTaskSessionSummary = {
			taskId: "task-1",
			agentId: "codex",
			state: "awaiting_review",
			workspacePath: cwd,
			pid: null,
			startedAt: 1,
			updatedAt: 2,
			lastOutputAt: 2,
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			agentNativeConversationSessionIdentity: identity,
		};
		await loadWorkspaceState(cwd);
		const { workspaceId } = await loadWorkspaceContext(cwd);
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
		const first = await loadWorkspaceState(cwd);
		expect(first.sessions["task-1"].agentNativeConversationSessionIdentity).toEqual(identity);
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
		expect((await loadWorkspaceState(cwd)).revision).toBe(first.revision);
		summary.agentNativeConversationSessionIdentity = { ...identity, nativeSessionId: "native-B", observedAt: 3 };
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
		const restored = (await loadWorkspaceState(cwd)).sessions["task-1"];
		expect(restored.agentNativeConversationSessionIdentity?.nativeSessionId).toBe("native-B");
		expect(restored.lastOutputAt).toBe(2);
		const confirmedIdentity = { ...identity, nativeSessionId: "native-B", observedAt: 5 };
		summary.agentNativeConversationSessionIdentity = confirmedIdentity;
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
		const confirmedState = await loadWorkspaceState(cwd);
		expect(confirmedState.sessions["task-1"]).toEqual({
			...restored,
			agentNativeConversationSessionIdentity: confirmedIdentity,
		});
		await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
		expect((await loadWorkspaceState(cwd)).revision).toBe(confirmedState.revision);
		// 过期的同身份确认和迟到的旧身份都不得回退已落盘水位。
		for (const staleIdentity of [
			{ ...confirmedIdentity, observedAt: 3 },
			{ ...identity, observedAt: 4 },
		]) {
			summary.agentNativeConversationSessionIdentity = staleIdentity;
			await persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId(workspaceId, "task-1", () => summary);
			expect((await loadWorkspaceState(cwd)).sessions["task-1"].agentNativeConversationSessionIdentity).toEqual(
				confirmedIdentity,
			);
			expect((await loadWorkspaceState(cwd)).revision).toBe(confirmedState.revision);
		}
		// 重启后以内存重建的水位拒绝迟到 hook，证明保护不依赖旧进程内存。
		const restoredManager = new TerminalSessionManager();
		restoredManager.hydrateFromRecord(confirmedState.sessions);
		const afterDelayedObservation = restoredManager.applyAgentNativeConversationSessionIdentity("task-1", {
			...identity,
			observedAt: 4,
		});
		expect(afterDelayedObservation?.agentNativeConversationSessionIdentity).toEqual(confirmedIdentity);

		const currentState = await loadWorkspaceState(cwd);
		await saveWorkspaceState(cwd, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: currentState.board,
			sessions: { "task-1": { ...summary, agentNativeConversationSessionIdentity: identity } },
			expectedRevision: currentState.revision,
		});
		expect(
			(await loadWorkspaceState(cwd)).sessions["task-1"].agentNativeConversationSessionIdentity?.nativeSessionId,
		).toBe("native-B");
		await mutateWorkspaceState(cwd, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: state.board,
			sessions: { "task-1": { ...summary, agentNativeConversationSessionIdentity: undefined } },
			value: null,
		}));
		expect(
			(await loadWorkspaceState(cwd)).sessions["task-1"].agentNativeConversationSessionIdentity?.nativeSessionId,
		).toBe("native-B");
	});
});
