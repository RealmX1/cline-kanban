import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadWorkspaceContext } from "../../src/state/workspace-state";
import * as heavyMaterialCollector from "../../src/task-indexing-support/collect-task-indexing-materials";
import { executeTaskAnalysisApi } from "../../src/task-indexing-support/task-analysis-api-executor";
import {
	TASK_ANALYSIS_SHARED_CONTEXT_VERSION,
	TASK_ANALYSIS_SHARED_INSTRUCTIONS,
} from "../../src/task-indexing-support/task-analysis-shared-prompt-prefix";
import {
	loadAndAdvanceSharedTaskIndexingContext,
	saveTaskIndexingSupportExecutorSettings,
} from "../../src/task-indexing-support/task-indexing-support-storage";
import { analyzeTaskProjectAssignment } from "../../src/task-indexing-support/task-project-assignment-analysis";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createTaskAssistanceOpenAiCompatibleHttpFixture,
	readTaskAssistanceHttpFixtureUserPrompt,
} from "../utilities/task-assistance-openai-compatible-http-fixture";

vi.mock("node:child_process", { spy: true });
vi.mock("../../src/task-indexing-support/collect-task-indexing-materials", { spy: true });
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("项目归属与共享分析的 API 单轮链路", { timeout: 60000 }, () => {
	it("DeepSeek 单独可用，忽略旧 CLI 配置，归属保留完整新正文且不收集重材料", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "single-turn-project",
			initialBranchName: "main",
		});
		const scope = await loadWorkspaceContext(repository.repositoryPath);
		const model = await createTaskAssistanceOpenAiCompatibleHttpFixture({
			isolatedHomeDirectoryPath: fixture.isolatedHomeDirectoryPath,
			respond: (request) =>
				String(request.messages[0]?.content).includes('"suggestedWorkspaceId"')
					? { suggestedWorkspaceId: null, rationale: "当前项目合适", confidence: "high" }
					: { accepted: true },
		});
		await saveTaskIndexingSupportExecutorSettings(null, { agentId: "claude", modelId: "obsolete-cli-model" });
		vi.mocked(childProcess.spawn).mockClear();
		const completePrompt = `完整需求${"实现并验证".repeat(8000)}结束标记`;
		const analysis = await analyzeTaskProjectAssignment({
			workspaceId: scope.workspaceId,
			operationId: randomUUID(),
			title: "任务",
			prompt: completePrompt,
			settings: { agentId: "claude", modelId: "obsolete-cli-model" },
		});
		const first = model.requests[0];
		if (!first) throw new Error("模型未收到请求");
		expect(
			JSON.parse(readTaskAssistanceHttpFixtureUserPrompt(first).split("L4 本次查询：\n").at(-1) ?? "").task
				.prompt === completePrompt,
		).toBe(true);
		expect(String(first.messages[0]?.content)).toContain(repository.repositoryPath);
		expect(String(first.messages[0]?.content)).not.toContain("L2 本项目任务 recap");
		expect(heavyMaterialCollector.collectTaskIndexingMaterials).not.toHaveBeenCalled();
		expect(analysis.suggestedWorkspaceId).toBeNull();
		const context = await loadAndAdvanceSharedTaskIndexingContext({
			workspaceId: scope.workspaceId,
			materials: [],
			settings: { agentId: "codex", modelId: null },
			instructionVersion: TASK_ANALYSIS_SHARED_CONTEXT_VERSION,
			now: Date.now(),
			forModelRequest: true,
		});
		for (const purpose of ["task_lookup_candidate_recall", "task_indexing_support_relation_analysis"] as const)
			await executeTaskAnalysisApi({
				context,
				settings: { agentId: "codex", modelId: "ignored" },
				modelUsagePurpose: purpose,
				instructionText: "分析任务",
				queryText: "完整问题",
				outputSchema: z.object({ accepted: z.boolean() }),
			});
		expect(model.requests).toHaveLength(3);
		expect(
			model.requests.every((request) =>
				String(request.messages[0]?.content).startsWith(TASK_ANALYSIS_SHARED_INSTRUCTIONS),
			),
		).toBe(true);
		expect(model.requests.every((request) => request.model === "fixture-requested-model")).toBe(true);
		expect(childProcess.spawn).not.toHaveBeenCalled();
	});
});
