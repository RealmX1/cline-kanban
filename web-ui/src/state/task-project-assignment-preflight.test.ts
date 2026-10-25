import { afterEach, expect, it, vi } from "vitest";
import * as queries from "@/runtime/task-analysis-query";
import {
	getPendingTaskProjectAssignmentDecisions,
	runTaskProjectAssignmentPreflight,
} from "@/state/task-project-assignment-preflight";

vi.mock("@/runtime/task-analysis-query", () => ({ requestTaskProjectAssignmentAnalysis: vi.fn() }));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn() }));
afterEach(() => {
	for (const request of getPendingTaskProjectAssignmentDecisions()) request.resolve("cancel");
	vi.restoreAllMocks();
});
const input = { workspaceId: "project", title: "任务", prompt: "完整需求", baseRef: "main" };
it("同一输入的并发提交只分析一次，迟到结果不提交", async () => {
	let complete!: (value: Awaited<ReturnType<typeof queries.requestTaskProjectAssignmentAnalysis>>) => void;
	vi.mocked(queries.requestTaskProjectAssignmentAnalysis).mockReturnValue(
		new Promise((resolve) => {
			complete = resolve;
		}),
	);
	let current = true;
	const first = runTaskProjectAssignmentPreflight({ ...input, isStillCurrent: () => current });
	const second = runTaskProjectAssignmentPreflight(input);
	expect(first).toBe(second);
	expect(queries.requestTaskProjectAssignmentAnalysis).toHaveBeenCalledTimes(1);
	current = false;
	complete({
		operationId: "id",
		inputFingerprint: "fingerprint",
		currentWorkspaceId: "project",
		suggestedWorkspaceId: null,
		suggestedProjectName: null,
		rationale: "合适",
		confidence: "high",
		stablePromptPrefixSha256: "hash",
	});
	expect(await first).toBeNull();
});
it("失败保留明确状态，只有用户选择原项目后才继续", async () => {
	vi.mocked(queries.requestTaskProjectAssignmentAnalysis).mockRejectedValue(new Error("认证失败"));
	const run = runTaskProjectAssignmentPreflight({ ...input, prompt: "失败路径" });
	await vi.waitFor(() => expect(getPendingTaskProjectAssignmentDecisions()).toHaveLength(1));
	expect(getPendingTaskProjectAssignmentDecisions()[0]?.failureMessage).toContain("认证失败");
	getPendingTaskProjectAssignmentDecisions()[0]?.resolve("keep");
	expect(await run).toEqual({ workspaceId: "project", baseRef: "main" });
});
