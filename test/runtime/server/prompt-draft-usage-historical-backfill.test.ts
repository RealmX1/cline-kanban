import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isolatedState = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../../src/state/runtime-home-path", () => ({ getRuntimeHomePath: () => isolatedState.directory }));
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => isolatedState.directory,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedState.directory, workspaceId),
	listWorkspaceIndexEntries: async () => [
		{ workspaceId: "alpha", repoPath: "/isolated/alpha" },
		{ workspaceId: "beta", repoPath: "/isolated/beta" },
	],
	loadPersistedWorkspaceSessionsById: async () => ({ sameId: { taskId: "sameId" } }),
}));

import { createPromptDraftUsageService } from "../../../src/server/prompt-draft-usage-service";
import {
	mutateWorkspacePromptLibrary,
	readWorkspacePromptLibrarySnapshotForUsageDetection,
} from "../../../src/state/prompt-library-store";

beforeEach(async () => {
	isolatedState.directory = await mkdtemp(join(tmpdir(), "prompt-usage-backfill-"));
});
afterEach(async () => {
	await rm(isolatedState.directory, { recursive: true, force: true });
});

describe("一次性全局历史回填", () => {
	it("跨项目同号 Task 独立处理，中断后从进度继续，完成后不重复执行", async () => {
		for (const workspaceId of ["alpha", "beta"])
			await mutateWorkspacePromptLibrary(
				workspaceId,
				{
					kind: "upsert_prompt",
					promptId: workspaceId,
					text: `${workspaceId} 的旧提示`,
					scope: "task",
					taskId: "sameId",
				},
				10,
			);
		const visited: string[] = [];
		let failBeta = true;
		const readHistory = vi.fn(async (input: { workspaceId: string }) => {
			visited.push(input.workspaceId);
			if (input.workspaceId === "beta" && failBeta) throw new Error("模拟中断");
			return {
				warnings: [],
				prompts: (async function* () {
					yield {
						text: `${input.workspaceId} 的旧提示`,
						sourceAgentId: "codex",
						nativeSessionId: "old",
						messageId: "message",
						submittedAtEpochMs: 1,
					};
				})(),
			};
		});
		const first = createPromptDraftUsageService({ readHistory, warn: () => {} });
		first.startInitialHistoricalBackfill();
		await first.waitForInitialHistoricalBackfill();
		await first.close();
		const progressPath = join(isolatedState.directory, "prompt-draft-usage-historical-backfill-v1.json");
		expect(JSON.parse(await readFile(progressPath, "utf8"))).toMatchObject({
			checkedTaskKeys: [JSON.stringify(["alpha", "sameId"])],
			completedAtEpochMs: null,
		});
		failBeta = false;
		const resumed = createPromptDraftUsageService({ readHistory, warn: () => {} });
		resumed.startInitialHistoricalBackfill();
		await resumed.waitForInitialHistoricalBackfill();
		await resumed.close();
		expect(visited).toEqual(["alpha", "beta", "beta"]);
		for (const workspaceId of ["alpha", "beta"])
			expect(
				(await readWorkspacePromptLibrarySnapshotForUsageDetection(workspaceId)).taskScopedPromptsByTaskId.sameId[0]
					.draftUsage?.matchEvidence?.workspaceId,
			).toBe(workspaceId);
		const repeated = createPromptDraftUsageService({ readHistory, warn: () => {} });
		repeated.startInitialHistoricalBackfill();
		await repeated.waitForInitialHistoricalBackfill();
		await repeated.close();
		expect(visited).toEqual(["alpha", "beta", "beta"]);
	});
});
