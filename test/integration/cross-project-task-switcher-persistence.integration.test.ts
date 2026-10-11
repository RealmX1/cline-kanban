// 跨项目「最近活跃任务」切换面板的两份落盘数据：
//   - 「我最后打开」账本（task-last-opened-by-user-record-store）：只前进不后退、跨缓存重读、路径遍历拒绝；
//   - 未加载项目的会话事实缓存：与 hydrateFromRecord 同口径对账、残留的 agent 回合不当真、按文件戳失效。
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createPersistedTaskSessionFactsCacheForUnloadedProjects } from "../../src/server/persisted-task-session-facts-cache-for-unloaded-projects";
import {
	forgetCachedTaskLastOpenedByUserRecords,
	readTaskLastOpenedByUserAtByTaskId,
	recordTaskLastOpenedByUser,
} from "../../src/state/task-last-opened-by-user-record-store";
import { getPersistedWorkspaceSessionsFilePathById, getWorkspaceDirectoryPath } from "../../src/state/workspace-state";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task",
		state: "idle",
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe.sequential("cross-project task switcher persistence integration", () => {
	it("「我最后打开」只前进不后退，落盘后丢掉内存缓存仍能读回", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			expect(await recordTaskLastOpenedByUser(workspaceId, "task-1", 2_000)).toBe(true);
			expect(await recordTaskLastOpenedByUser(workspaceId, "task-1", 1_000)).toBe(false);
			expect(await recordTaskLastOpenedByUser(workspaceId, "task-2", 3_000)).toBe(true);

			forgetCachedTaskLastOpenedByUserRecords(workspaceId);
			const records = await readTaskLastOpenedByUserAtByTaskId(workspaceId);
			expect(Object.fromEntries(records)).toEqual({ "task-1": 2_000, "task-2": 3_000 });
			forgetCachedTaskLastOpenedByUserRecords(workspaceId);
		});
	});

	it("「我最后打开」拒绝 workspaces 根之外的路径", async () => {
		await withIsolatedWorkspaceHome(async () => {
			await expect(recordTaskLastOpenedByUser("../escape", "task-1", 1)).rejects.toThrow(/outside workspaces root/);
		});
	});

	it("未加载项目的会话事实：声称仍在跑的会话按 hydrate 口径归零，用户回合原样保留；文件不变时命中缓存", async () => {
		await withIsolatedWorkspaceHome(async (registerIsolatedWorkspace) => {
			const { workspaceId } = await registerIsolatedWorkspace("project-a");
			const sessionsFilePath = getPersistedWorkspaceSessionsFilePathById(workspaceId);
			expect(sessionsFilePath.startsWith(getWorkspaceDirectoryPath(workspaceId))).toBe(true);
			await mkdir(getWorkspaceDirectoryPath(workspaceId), { recursive: true });
			await writeFile(
				sessionsFilePath,
				JSON.stringify({
					"stale-running": makeSummary({
						taskId: "stale-running",
						state: "running",
						turnOwner: "agent",
						liveness: "live",
						userTurnKind: null,
						pid: 4242,
						lastOutputAt: 9,
					}),
					"stale-agent-without-pid": makeSummary({
						taskId: "stale-agent-without-pid",
						state: "running",
						turnOwner: "agent",
						liveness: "live",
						userTurnKind: null,
						agentId: "cline",
					}),
					"awaiting-review": makeSummary({
						taskId: "awaiting-review",
						state: "awaiting_review",
						turnOwner: "user",
						liveness: "exited",
						userTurnKind: "review",
						reviewReason: "exit",
						agentResponseGenerationStopped: {
							stoppedAt: 7,
							signalConfidence: "harness_turn_complete",
							turnSequence: 1,
						},
					}),
				}),
			);
			const cache = createPersistedTaskSessionFactsCacheForUnloadedProjects();

			const facts = await cache.loadTaskSessionFactsByTaskId(workspaceId);
			expect(facts.get("stale-running")).toMatchObject({ turnOwner: null, lastOutputAt: null });
			expect(facts.get("stale-agent-without-pid")).toMatchObject({ turnOwner: null, liveness: "none" });
			expect(facts.get("awaiting-review")).toMatchObject({
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				agentResponseGenerationStopped: { stoppedAt: 7 },
			});
			expect(await cache.loadTaskSessionFactsByTaskId(workspaceId)).toBe(facts);

			await writeFile(sessionsFilePath, JSON.stringify({}));
			const reloaded = await cache.loadTaskSessionFactsByTaskId(workspaceId);
			expect(reloaded).not.toBe(facts);
			expect(reloaded.size).toBe(0);
		});
	});

	it("未加载项目没有 sessions.json 时返回空", async () => {
		await withIsolatedWorkspaceHome(async () => {
			const cache = createPersistedTaskSessionFactsCacheForUnloadedProjects();
			expect((await cache.loadTaskSessionFactsByTaskId("workspace-without-sessions-file")).size).toBe(0);
		});
	});
});
