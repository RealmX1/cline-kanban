import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as routing from "../../../src/model-provider-access/task-assistance-model-provider-routing";
import {
	assembleTaskAnalysisApiPrompt,
	executeTaskAnalysisApi,
} from "../../../src/task-indexing-support/task-analysis-api-executor";

vi.mock("../../../src/model-provider-access/task-assistance-model-provider-routing", { spy: true });
afterEach(() => vi.restoreAllMocks());
const request = {
	instructionText: "查卡召回",
	context: {
		schemaVersion: 1 as const,
		workspaceId: "workspace",
		levelOneBoardTaskIndexText: "任务目录",
		levelTwoProjectTaskRecapsText: "摘要",
		levelThreeAppendedChangesText: "变化",
		snapshotFingerprint: "snapshot",
		contextCompleteness: [],
		asOf: 1,
		rebuildReason: null,
	},
	queryText: "问题",
	outputSchema: z.object({ accepted: z.boolean() }),
};
describe("无工具单轮 API 执行器", () => {
	it("旧 CLI 设置不驱动执行，项目归属与召回有独立用途入口", async () => {
		vi.mocked(routing.requestTaskAssistanceJsonObject).mockResolvedValue({
			status: "completed",
			parsedJsonObject: { accepted: true },
			attempts: [],
		});
		const result = await executeTaskAnalysisApi({
			...request,
			settings: { agentId: "claude", modelId: "ignored-cli-model" },
			modelUsagePurpose: "task_lookup_candidate_recall",
			operationId: "op",
			stage: "candidate_recall",
		});
		expect(result.value).toEqual({ accepted: true });
		expect(routing.requestTaskAssistanceJsonObject).toHaveBeenCalledWith(
			expect.objectContaining({
				modelUsagePurpose: "task_lookup_candidate_recall",
				operationId: "op",
				stage: "candidate_recall",
				requestTimeoutMs: 60_000,
			}),
			request.outputSchema,
			expect.any(Object),
		);
		expect(JSON.stringify(vi.mocked(routing.requestTaskAssistanceJsonObject).mock.calls)).not.toContain(
			"ignored-cli-model",
		);
	});
	it("失败保留 provider 尝试记录，取消保持取消原因", async () => {
		vi.mocked(routing.requestTaskAssistanceJsonObject).mockResolvedValue({
			status: "unavailable",
			unavailableReason: "execution_cancelled",
			attempts: [],
		});
		await expect(executeTaskAnalysisApi(request)).rejects.toMatchObject({
			reasonCode: "execution_cancelled",
			providerAttempts: [],
		});
	});
	it("查卡和关系共享安全指令；项目归属可以只使用轻量材料", () => {
		const normal = assembleTaskAnalysisApiPrompt(request);
		const light = assembleTaskAnalysisApiPrompt({
			...request,
			context: undefined,
			stableContextText: "完整项目列表",
		});
		expect(normal.stablePrefix).toContain("禁止调用工具");
		expect(light.stablePrefix).toContain("禁止调用工具");
		expect(light.stablePrefix).not.toContain("任务目录");
		expect(light.stablePrefix).not.toContain("摘要");
	});
});
