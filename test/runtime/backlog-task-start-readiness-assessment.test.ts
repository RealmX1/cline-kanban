import { describe, expect, it, vi } from "vitest";
import { assessBacklogTaskStartReadiness } from "../../src/backlog-task-start-readiness/backlog-task-start-readiness-assessment";

const evidence = {
	historyCoverage: "complete",
	taskAgeMs: 1000,
	commitCountSinceCreation: 0,
	changedRepositoryPaths: [],
	relatedTaskSummaries: [],
	uncertaintyReasons: [],
	currentRepository: { commit: "a" },
	repositoryStateAvailable: true,
};
const task = {
	id: "task1",
	title: "修复功能",
	prompt: "修复功能",
	baseRef: "main",
	startInPlanMode: true,
	createdAt: 1,
	updatedAt: 1,
};

describe("Backlog 按证据分层复核", () => {
	it("新建且有完整无漂移证据时不调用模型", async () => {
		const requestDecision = vi.fn();
		const result = await assessBacklogTaskStartReadiness(task, evidence, { requestDecision });
		expect(result.conclusion).toBe("ready");
		expect(requestDecision).not.toHaveBeenCalled();
	});
	it("缺失历史不能当作没有漂移，机器缺证最多补证三轮", async () => {
		const requestDecision = vi.fn().mockResolvedValue({
			conclusion: "waiting_for_evidence",
			summary: "需要查证",
			evidenceReferences: [],
			remainingWorkRevision: null,
			readOnlyEvidenceRequests: [{ kind: "search_repository", reference: "feature" }],
		});
		const readEvidence = vi.fn().mockResolvedValue({ reference: "feature", content: "尚无确证" });
		const result = await assessBacklogTaskStartReadiness(
			task,
			{ ...evidence, historyCoverage: "unknown" },
			{ requestDecision, readEvidence },
		);
		expect(result.conclusion).toBe("waiting_for_evidence");
		expect(requestDecision).toHaveBeenCalledTimes(4);
		expect(readEvidence).toHaveBeenCalledTimes(3);
	});
	it("开启条件必须参加复核，主备不可用时保持机器等待", async () => {
		const result = await assessBacklogTaskStartReadiness(
			{ ...task, backlogTaskStartReadinessConditionsText: "依赖落地" },
			evidence,
			{ requestDecision: vi.fn().mockResolvedValue(null) },
		);
		expect(result.conclusion).toBe("waiting_for_evidence");
	});
	it("无显式开启条件时不接受模型判为条件未满足", async () => {
		const result = await assessBacklogTaskStartReadiness(
			task,
			{ ...evidence, taskAgeMs: 48 * 60 * 60 * 1000 },
			{
				requestDecision: vi.fn().mockResolvedValue({
					conclusion: "conditions_not_met",
					summary: "模型误把上下文缺失当作条件。",
					evidenceReferences: ["current_repository"],
					remainingWorkRevision: null,
					readOnlyEvidenceRequests: [],
				}),
			},
		);
		expect(result.conclusion).toBe("waiting_for_evidence");
	});
	it("没有足够引用和剩余说明时拒绝自动修订", async () => {
		const result = await assessBacklogTaskStartReadiness(
			task,
			{ ...evidence, taskAgeMs: 30 * 86400000 },
			{
				requestDecision: vi.fn().mockResolvedValue({
					conclusion: "revise_remaining_work",
					summary: "部分完成",
					evidenceReferences: [],
					remainingWorkRevision: null,
					readOnlyEvidenceRequests: [],
				}),
			},
		);
		expect(result.conclusion).toBe("waiting_for_evidence");
	});
	it.each(["current_repository", "file:unavailable.ts", "file:unobserved.ts"])(
		"创建历史不完整且引用 %s 无法提供定向证据时继续等待",
		async (reference) => {
			const result = await assessBacklogTaskStartReadiness(
				task,
				{ ...evidence, historyCoverage: "unknown" },
				{
					previousReadOnlyEvidence: [
						{ result: { reference: "file:unavailable.ts", unavailableReason: "不可读" } },
					],
					requestDecision: vi.fn().mockResolvedValue({
						conclusion: "ready",
						summary: "待核验结论",
						evidenceReferences: [reference],
						remainingWorkRevision: null,
						readOnlyEvidenceRequests: [],
					}),
				},
			);
			expect(result.conclusion).toBe("waiting_for_evidence");
		},
	);
});
