import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import * as workspaceState from "../../../src/state/workspace-state";
import { loadWorkspaceContext, loadWorkspaceState } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("workspace registry runtime project availability cache", () => {
	it("项目摘要重复构建复用看板，文件变化后只重新加载对应看板", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const projectPath = fixture.createNonBareRepository({
			repositoryDirectoryName: "project-summary-board-cache",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		try {
			const initial = await loadWorkspaceState(projectPath);
			const workspaceContext = await loadWorkspaceContext(projectPath);
			await mkdir(workspaceState.getWorkspaceDirectoryPath(workspaceContext.workspaceId), { recursive: true });
			await writeFile(
				workspaceState.getPersistedWorkspaceBoardFilePathById(workspaceContext.workspaceId),
				JSON.stringify(initial.board),
			);
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				inspectRuntimeProjectAvailability: async () => ({ status: "available" }),
			});
			const readBoard = vi.spyOn(workspaceState, "loadWorkspaceBoardById");
			try {
				await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				expect(readBoard).toHaveBeenCalledTimes(1);
				const backlog = initial.board.columns.find((column) => column.id === "backlog");
				if (!backlog) throw new Error("隔离看板缺少 Backlog");
				backlog.cards.push({
					id: "new-task",
					title: "新任务",
					prompt: "新任务",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				});
				await writeFile(
					workspaceState.getPersistedWorkspaceBoardFilePathById(workspaceContext.workspaceId),
					JSON.stringify(initial.board),
				);
				const updated = await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				expect(updated.projects[0]?.taskCounts.backlog).toBe(1);
				expect(readBoard).toHaveBeenCalledTimes(2);
			} finally {
				readBoard.mockRestore();
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("reuses availability for summary broadcasts and refreshes it only when explicitly requested", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const temporaryHomePath = gitFixture.isolatedHomeDirectoryPath;
		const projectPath = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "workspace-registry-availability-project",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = temporaryHomePath;
		try {
			await loadWorkspaceState(projectPath);
			const workspaceContext = await loadWorkspaceContext(projectPath);
			const inspectRuntimeProjectAvailability = vi.fn(async () => ({ status: "available" as const }));
			const registry = await createWorkspaceRegistry({
				cwd: temporaryHomePath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				inspectRuntimeProjectAvailability,
			});

			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(1);

			await registry.buildProjectsPayload(null);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(2);

			await registry.resolveWorkspaceForStream(workspaceContext.workspaceId);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(3);
			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(workspaceContext.workspaceId);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(3);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
});
