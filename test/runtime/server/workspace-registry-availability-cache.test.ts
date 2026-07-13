import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import { loadWorkspaceContext, loadWorkspaceState } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

describe("workspace registry runtime project availability cache", () => {
	it("reuses availability for summary broadcasts and refreshes it only when explicitly requested", async () => {
		const { path: temporaryHomePath, cleanup } = createTempDir("kanban-availability-cache-home-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-availability-cache-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = temporaryHomePath;
		try {
			const gitInit = spawnSync("git", ["init"], { cwd: projectPath, env: createGitTestEnv(), stdio: "ignore" });
			expect(gitInit.status).toBe(0);
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
			cleanupProject();
			cleanup();
		}
	});
});
