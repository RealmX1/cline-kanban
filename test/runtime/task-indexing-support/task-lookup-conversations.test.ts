import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskIndexingMaterial } from "../../../src/core/task-indexing-support-contract";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
import { StatelessTaskIndexingAgentExecutionError } from "../../../src/task-indexing-support/stateless-task-indexing-agent-execution-diagnostics";
import { createTaskLookupConversationService } from "../../../src/task-indexing-support/task-lookup-conversation-service";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const createSynchronizationBarrier = () => {
	let release = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
};
const sessionIntent = (taskId: string, text: string) => ({
	taskConversationSessionId: taskId,
	nativeSessionId: "native-session",
	messages: [
		{ kind: "user_prompt" as const, sourceMessageId: `${taskId}-user`, turnUserMessageId: `${taskId}-user`, text },
	],
});
const material = (taskId: string, workspaceId = "project-a"): TaskIndexingMaterial => ({
	taskReference: { workUnitType: "kanban_board_card", workspaceId, taskId, taskIncarnationCreatedAtEpochMs: 1 },
	projectName: workspaceId,
	title: `任务 ${taskId}`,
	prompt: "实现任务查卡和持久历史",
	sessionIntent: sessionIntent(taskId, "用户希望实现任务查卡和持久历史"),
	columnId: "backlog",
	latestNotificationSummaryText: null,
	latestHookFinalMessage: null,
	claudeAwaySummary: null,
	missingContextParts: [],
});
async function setup() {
	const storageDirectoryPath = await mkdtemp(join(tmpdir(), "kanban-task-lookup-test-"));
	roots.push(storageDirectoryPath);
	const materials = [material("abc12"), material("def34", "project-b")];
	const requests: string[] = [];
	const dependencies = {
		storageDirectoryPath,
		collectMaterials: async () => ({ materials, missingContextParts: [] }),
		getExecutorSettings: async () => ({ agentId: "codex" as const, modelId: null }),
		getContext: async () => ({
			schemaVersion: 1 as const,
			workspaceId: "project-a",
			levelOneBoardTaskIndexText: "abc12 def34",
			levelTwoProjectTaskRecapsText: "查卡",
			levelThreeAppendedChangesText: "",
			snapshotFingerprint: "test",
			contextCompleteness: [],
			asOf: 1,
			rebuildReason: null,
		}),
		executeAgent: async (request: { queryText: string; outputSchema: { parse: (value: unknown) => unknown } }) => {
			requests.push(request.queryText);
			const query = JSON.parse(request.queryText);
			return {
				value: request.outputSchema.parse(
					query.phase === "recall"
						? { candidateTaskReferenceKeys: materials.map((_entry, index) => `task-${index + 1}`) }
						: {
								answerText: "找到两个可能相关任务",
								candidates: materials.map((entry) => ({
									taskReference: entry.taskReference,
									matchingReason: "包含查卡要求",
									evidence: ["当前任务要求"],
									limitations: [],
								})),
							},
				),
				usage: { resolvedModelId: null },
				stablePromptPrefixSha256: "prefix",
				elapsedMs: 1,
				diagnosticWarnings: [],
			};
		},
	};
	return { service: createTaskLookupConversationService(dependencies), dependencies, materials, requests };
}
async function waitForTurn(service: ReturnType<typeof createTaskLookupConversationService>, conversationId: string) {
	await service.waitForIdle();
	return await service.getConversation(conversationId);
}
describe("持久多轮查卡服务", () => {
	it("首轮允许零候选，不补足数量，也不读取任何 Session Intent", async () => {
		const { dependencies } = await setup();
		const reads: unknown[] = [];
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async (_workspaceId, options) => {
				reads.push(options);
				return await dependencies.collectMaterials();
			},
			executeAgent: async (request) => {
				expect(JSON.parse(request.queryText).phase).toBe("recall");
				return {
					value: request.outputSchema.parse({ candidateTaskReferenceKeys: [] }),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "zero",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "zero-intent",
				questionText: "查找无关意图",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(saved.turns[0]?.result?.candidates).toEqual([]);
			expect(reads.every((options) => !JSON.stringify(options).includes("sessionIntentTaskReferences"))).toBe(true);
		} finally {
			await service.close();
		}
	});
	it("候选只读取 Session Intent，不发送完整要求、recap 或过程工具正文", async () => {
		const { dependencies } = await setup();
		const candidate = {
			...material("abc12"),
			taskDescription: "会话意图检索",
			prompt: "禁止发送的完整任务原文",
			latestNotificationSummaryText: "禁止发送的 recap",
			latestHookFinalMessage: "禁止发送的 hook 全文",
			sessionIntent: {
				taskConversationSessionId: "abc12",
				nativeSessionId: "native-session",
				messages: [
					{
						kind: "user_prompt" as const,
						sourceMessageId: "user-1",
						turnUserMessageId: "user-1",
						text: "允许读取的用户意图",
					},
				],
			},
		};
		const reads: unknown[] = [];
		const requests: string[] = [];
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async (_workspaceId, options) => {
				reads.push(options);
				return { materials: [candidate], missingContextParts: [] };
			},
			executeAgent: async (request) => {
				requests.push(request.queryText + request.stableContextText);
				return {
					value: request.outputSchema.parse(
						JSON.parse(request.queryText).phase === "recall"
							? { candidateTaskReferenceKeys: ["task-1"] }
							: { answerText: "意图匹配", candidates: [] },
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "intent-only",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "intent-only",
				questionText: "查找意图",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(reads).toContainEqual(
				expect.objectContaining({
					includeRecapSources: false,
					sessionIntentTaskReferences: [candidate.taskReference],
				}),
			);
			expect(requests.join("\n")).toContain("允许读取的用户意图");
			for (const forbidden of [
				candidate.prompt,
				candidate.latestNotificationSummaryText,
				candidate.latestHookFinalMessage,
				"completeCandidateRequirements",
			])
				expect(requests.join("\n")).not.toContain(forbidden);
		} finally {
			await service.close();
		}
	});
	it("长卡后文撤回的匹配不会残留在其他候选的说明中", async () => {
		const { dependencies } = await setup();
		const shortCandidate = { ...material("abc12"), sessionIntent: sessionIntent("abc12", "短卡支持自动部署。") };
		const longCandidate = {
			...material("def34"),
			sessionIntent: sessionIntent(
				"def34",
				`长卡原先设想支持自动部署。${"补充说明。".repeat(22000)}最终明确禁止自动部署。`,
			),
		};
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async () => ({ materials: [shortCandidate, longCandidate], missingContextParts: [] }),
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				const references: TaskIndexingMaterial["taskReference"][] = query.eligibleTaskReferences ?? [];
				const excluded = JSON.stringify([
					query.candidateSessionIntentSegments,
					query.previousCandidateSessionIntentAssessments,
				]).includes("明确禁止自动部署");
				const candidates = references
					.filter((reference) => reference.taskId !== longCandidate.taskReference.taskId || !excluded)
					.map((taskReference) => ({
						taskReference,
						matchingReason: "支持自动部署",
						evidence: ["当前可读要求"],
						limitations: [],
					}));
				const answerText = references
					.map((reference) =>
						reference.taskId === shortCandidate.taskReference.taskId
							? "短卡支持自动部署。"
							: excluded
								? "长卡明确禁止自动部署。"
								: "长卡仍支持自动部署。",
					)
					.join("\n");
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: ["task-1", "task-2"] }
							: { answerText, candidates },
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "isolated-candidate-assessments",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "candidate-narrative-isolation",
				questionText: "查找支持自动部署的任务",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(saved.turns[0]?.result?.candidates.map((candidate) => candidate.taskReference.taskId)).toEqual([
				"abc12",
			]);
			expect(saved.turns[0]?.result?.answerText).toContain("长卡明确禁止自动部署");
			expect(saved.turns[0]?.result?.answerText).not.toContain("长卡仍支持自动部署");
		} finally {
			await service.close();
		}
	});

	it("单项会话意图被上下文拒绝后保留完整子分片路径，缩批不静默裁掉材料", async () => {
		const { dependencies } = await setup();
		const candidate = { ...material("abc12"), sessionIntent: sessionIntent("abc12", "详细意图".repeat(4000)) };
		const acceptedSegments: Array<{ serializedSessionIntentText: string; sessionIntentSubsegmentPath: unknown[] }> =
			[];
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async () => ({ materials: [candidate], missingContextParts: [] }),
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				if (query.phase === "answer") {
					const segment = query.candidateSessionIntentSegments[0];
					if (Buffer.byteLength(segment.serializedSessionIntentText) > 20000)
						throw new StatelessTaskIndexingAgentExecutionError(
							"input_budget_exceeded",
							"context length limit exceeded",
						);
					acceptedSegments.push(segment);
				}
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: ["task-1"] }
							: {
									answerText: "只解释当前分片证据",
									candidates: [
										{
											taskReference: candidate.taskReference,
											matchingReason: "原文匹配",
											evidence: ["本分片"],
											limitations: [],
										},
									],
								},
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "split",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "single-large-requirement",
				questionText: "查找原文",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(acceptedSegments.map((segment) => segment.serializedSessionIntentText).join("")).toBe(
				JSON.stringify(candidate.sessionIntent),
			);
			expect(acceptedSegments.length).toBeGreaterThan(1);
			expect(acceptedSegments.every((segment) => segment.sessionIntentSubsegmentPath.length > 0)).toBe(true);
			expect(saved.turns[0]?.contextBatchCoverage?.failedCandidateSessionIntentSegmentCount).toBe(0);
		} finally {
			await service.close();
		}
	});
	it.each([false, true])("全局候选按预算归并排序，排序失败=%s 时保留部分覆盖说明", async (rankingUnavailable) => {
		const { dependencies } = await setup();
		const materials = Array.from({ length: 800 }, (_, index) => ({
			...material(`task${index}`),
			taskDescription: "任务要求".repeat(100),
		}));
		let rankingCalls = 0;
		const selectedIntentReads: number[] = [];
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async (_workspaceId, options) => {
				if (options?.sessionIntentTaskReferences)
					selectedIntentReads.push(options.sessionIntentTaskReferences.length);
				return { materials, missingContextParts: [] };
			},
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				const rows = JSON.parse(request.stableContextText ?? "[]") as Array<{ taskReferenceKey: string }>;
				expect(Buffer.byteLength((request.stableContextText ?? "") + request.queryText)).toBeLessThan(300000);
				if (query.purpose === "rank_candidates") {
					rankingCalls++;
					if (rankingUnavailable) throw new Error("排序暂不可用");
				}
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: rows.slice(0, 10).map((row) => row.taskReferenceKey) }
							: {
									answerText: "已核对候选原文",
									candidates: query.eligibleTaskReferences.map((taskReference: unknown) => ({
										taskReference,
										matchingReason: "要求匹配",
										evidence: ["原文"],
										limitations: [],
									})),
								},
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "ranked",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "ranked",
				questionText: "查找相关任务",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(saved.turns[0]?.result?.candidates).toHaveLength(10);
			expect(selectedIntentReads).toEqual([10]);
			expect(rankingCalls).toBeGreaterThan(0);
			expect(saved.turns[0]?.contextBatchCoverage?.recalledTaskCount).toBe(800);
			expect(saved.turns[0]?.result?.answerText.includes("部分结果")).toBe(rankingUnavailable);
		} finally {
			await service.close();
		}
	});
	it("长历史按绑定轮次压缩并持久保存摘要，原始问题不被改写", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "seed",
			questionText: "排除自动部署",
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		await service.close();
		const seed = saved.turns[0];
		if (!seed) throw new Error("缺少历史模板。");
		saved.turns = Array.from({ length: 24 }, (_, index) => ({
			...seed,
			turnId: `history-${index}`,
			requestId: `history-${index}`,
			questionText: `第 ${index + 1} 轮：${index === 0 ? "排除自动部署，原始精确限制仅在这一轮。" : "继续讨论检索范围。"}${"需要保留用户修正和具体范围。".repeat(300)}`,
		}));
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		const queries: Array<Record<string, unknown>> = [];
		const resumed = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText) as Record<string, unknown>;
				queries.push(query);
				return {
					value: request.outputSchema.parse(
						query.phase === "history_summary"
							? { historySummaryText: "用户讨论了检索范围；具体条件需回读历史原文。" }
							: query.phase === "recall"
								? {
										candidateTaskReferenceKeys: ["task-1"],
										requestedHistoricalTurnIds: saved.turns.slice(0, 6).map((turn) => turn.turnId),
									}
								: { answerText: "当前材料未找到", candidates: [] },
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "summary",
					elapsedMs: 1,
				};
			},
		});
		try {
			await resumed.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "next",
				questionText: "继续查找",
			});
			const result = await waitForTurn(resumed, conversation.conversationId);
			expect(result.turns.at(-1)?.status).toBe("completed");
			expect(result.turns.at(-1)?.queryHistorySummary?.historySummaryText).toContain("具体条件需回读");
			expect(result.turns[0].questionText).toBe(saved.turns[0].questionText);
			expect(queries.filter((query) => query.phase === "history_summary").length).toBeGreaterThan(0);
			expect(queries.find((query) => query.phase === "recall")?.earlierHistorySummaryText).toContain(
				"具体条件需回读",
			);
			const answerQueries = queries.filter((query) => query.phase === "answer");
			const historicalSegments = answerQueries.map(
				(query) =>
					query.requestedHistoricalTurnMaterialSegment as {
						serializedHistoricalTurnMaterialText: string;
						segmentIndex: number;
						segmentCount: number;
					},
			);
			expect(historicalSegments.length).toBeGreaterThan(1);
			expect(historicalSegments.every((segment) => segment.segmentCount === historicalSegments.length)).toBe(true);
			expect(
				JSON.parse(historicalSegments.map((segment) => segment.serializedHistoricalTurnMaterialText).join("")),
			).toMatchObject(
				saved.turns.slice(0, 6).map((turn) => ({ turnId: turn.turnId, questionText: turn.questionText })),
			);
			expect(JSON.stringify(answerQueries)).toContain("原始精确限制仅在这一轮");
			for (const query of answerQueries) expect(Buffer.byteLength(JSON.stringify(query))).toBeLessThan(300000);
			expect(answerQueries.at(-1)?.previousCandidateSessionIntentAssessments).toMatchObject([
				{ answer: { answerText: "当前材料未找到", candidates: [] } },
			]);
		} finally {
			await resumed.close();
		}
	});
	it.each([false, true])("候选跨批核验保留否定证据并覆盖前文设想，否定证据在前=%s", async (exclusionFirst) => {
		const { dependencies } = await setup();
		const candidate = {
			...material("abc12"),
			sessionIntent: sessionIntent(
				"abc12",
				[
					exclusionFirst ? "明确限制：禁止自动部署。" : "前文设想：自动部署。",
					"中间任务说明。".repeat(22000),
					exclusionFirst ? "尚未批准的设想：自动部署。" : "最终修正：禁止自动部署。",
				].join("\n"),
			),
		};
		let answerBatchCount = 0;
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async () => ({ materials: [candidate], missingContextParts: [] }),
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				let answer = {
					answerText: "前文设想支持自动部署",
					candidates: [
						{
							taskReference: candidate.taskReference,
							matchingReason: "前文设想支持自动部署",
							evidence: ["前文设想"],
							limitations: [],
						},
					],
				};
				if (query.phase === "answer") {
					answerBatchCount++;
					if (answerBatchCount > 1) expect(query.previousCandidateSessionIntentAssessments).toHaveLength(1);
					const hasExclusion = JSON.stringify([
						query.candidateSessionIntentSegments,
						query.previousCandidateSessionIntentAssessments,
					]).includes("禁止自动部署");
					if (hasExclusion) answer = { answerText: "禁止自动部署，已排除该候选", candidates: [] };
				}
				return {
					value: request.outputSchema.parse(
						query.phase === "recall" ? { candidateTaskReferenceKeys: ["task-1"] } : answer,
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "cumulative-evidence",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "cumulative-evidence",
				questionText: "查找允许自动部署的任务",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(answerBatchCount).toBeGreaterThan(1);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(saved.turns[0]?.result?.candidates).toEqual([]);
			expect(saved.turns[0]?.result?.answerText).toBe("禁止自动部署，已排除该候选");
			expect(saved.turns[0]?.contextBatchCoverage?.failedCandidateSessionIntentSegmentCount).toBe(0);
		} finally {
			await service.close();
		}
	});
	it.each([false, true])("候选补读缺口传入模型并保存，返回候选=%s", async (returnCandidate) => {
		const { dependencies } = await setup();
		const candidate = material("abc12");
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async (_workspaceId, options) => ({
				materials: [
					{
						...candidate,
						missingContextParts: options?.sessionIntentTaskReferences
							? ["session_intent_source_unavailable"]
							: [],
					},
				],
				missingContextParts: options?.sessionIntentTaskReferences
					? ["project-a:session_intent_sources_unreadable", "project-b:outside_scope_unreadable"]
					: [],
			}),
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				if (query.phase === "answer") {
					expect(query.candidateSessionIntentSegments[0].missingContextParts).toContain(
						"session_intent_source_unavailable",
					);
					expect(query.contextCompleteness).toContain("project-a/abc12:session_intent_source_unavailable");
					expect(query.contextCompleteness).not.toContain("project-b:outside_scope_unreadable");
				}
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: ["task-1"] }
							: {
									answerText: "按当前可读材料核验",
									candidates: returnCandidate
										? [
												{
													taskReference: candidate.taskReference,
													matchingReason: "当前要求匹配",
													evidence: ["原始要求"],
													limitations: [],
												},
											]
										: [],
								},
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "material-gap",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: ["project-a"], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "material-gap",
				questionText: "查找已有汇报",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(saved.turns[0]?.result?.contextCompleteness).toEqual([
				"project-a:session_intent_sources_unreadable",
				"project-a/abc12:session_intent_source_unavailable",
			]);
			expect(saved.turns[0]?.result?.answerText).toContain("未覆盖材料");
			if (returnCandidate)
				expect(saved.turns[0]?.result?.candidates[0]?.limitations.join(" ")).toContain("未覆盖材料");
		} finally {
			await service.close();
		}
	});
	it("已知上下文拒绝自动拆批，失败批次保留未知覆盖，候选只核对会话意图", async () => {
		const { dependencies, materials } = await setup();
		let contextRejections = 0;
		const service = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				const query = JSON.parse(request.queryText);
				const rows = JSON.parse(request.stableContextText ?? "[]") as Array<{ taskReferenceKey: string }>;
				if (query.phase === "recall" && rows.length > 1) {
					contextRejections++;
					throw new StatelessTaskIndexingAgentExecutionError(
						"input_budget_exceeded",
						"context length limit exceeded",
					);
				}
				if (query.phase === "recall" && rows[0]?.taskReferenceKey === "task-2")
					throw new Error("该批模型暂时不可用");
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: rows.map((row) => row.taskReferenceKey) }
							: {
									answerText: "找到当前材料可确认的候选",
									candidates: [
										{
											taskReference: materials[0].taskReference,
											matchingReason: "原文匹配",
											evidence: ["原始要求"],
											limitations: [],
										},
									],
								},
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "prefix",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "context-rejection",
				questionText: "查找任务",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(contextRejections).toBe(1);
			expect(saved.turns[0]?.contextBatchCoverage).toMatchObject({
				recalledTaskCount: 1,
				failedRecallBatchCount: 1,
			});
			expect(saved.turns[0]?.result?.answerText).toContain("未覆盖");
			expect(saved.turns[0]?.result?.candidates[0].limitations.join(" ")).toContain("未覆盖");
		} finally {
			await service.close();
		}
	});
	it("超限规模的全局材料分批召回，候选回答不重复全局 Context，覆盖范围持久保存", async () => {
		const { dependencies } = await setup();
		const materials = Array.from({ length: 1500 }, (_, index) => ({
			...material(`task${index}`),
			prompt: "原始要求".repeat(8000),
			taskDescription: `任务简介 ${index} ${"说明".repeat(100)}`,
		}));
		const seenKeys = new Set<string>();
		const requests: Array<{ stableContextText?: string; queryText: string; context?: unknown }> = [];
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async () => ({ materials, missingContextParts: [] }),
			getContext: async () => ({
				...(await dependencies.getContext()),
				levelTwoProjectTaskRecapsText: "全局旧 recap".repeat(100000),
			}),
			executeAgent: async (request) => {
				requests.push(request);
				const query = JSON.parse(request.queryText);
				const rows = JSON.parse(request.stableContextText ?? "[]") as Array<{ taskReferenceKey: string }>;
				for (const row of rows) seenKeys.add(row.taskReferenceKey);
				return {
					value: request.outputSchema.parse(
						query.phase === "recall"
							? { candidateTaskReferenceKeys: rows.slice(0, 1).map((row) => row.taskReferenceKey) }
							: {
									answerText: "核对候选当前要求",
									candidates: query.eligibleTaskReferences.map((taskReference: unknown) => ({
										taskReference,
										matchingReason: "要求匹配",
										evidence: ["当前原文"],
										limitations: [],
									})),
								},
					),
					usage: { resolvedModelId: null },
					stablePromptPrefixSha256: "small-prefix",
					elapsedMs: 1,
				};
			},
		});
		try {
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "large-overview",
				questionText: "查找相关任务",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			expect(saved.turns[0]?.status).toBe("completed");
			expect(seenKeys.size).toBe(1500);
			expect(requests.filter((request) => JSON.parse(request.queryText).phase === "recall").length).toBeGreaterThan(
				1,
			);
			for (const request of requests) {
				expect(request.context).toBeUndefined();
				expect(Buffer.byteLength((request.stableContextText ?? "") + request.queryText)).toBeLessThan(300000);
				if (JSON.parse(request.queryText).phase === "answer") expect(request.stableContextText).toBe("[]");
			}
			expect(saved.turns[0]?.contextBatchCoverage?.recalledTaskCount).toBe(1500);
			const verifiedSegments = requests.flatMap(
				(request) => JSON.parse(request.queryText).candidateSessionIntentSegments ?? [],
			);
			expect(verifiedSegments.length).toBeGreaterThan(0);
			expect(JSON.stringify(requests)).not.toContain("原始要求原始要求");
		} finally {
			await service.close();
		}
	});
	it.each(["completed", "running"] as const)("空闲恢复扫描不重复解析 %s 大图片历史", async (status) => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		const imageId = "large-completed-history-image";
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "large-image-history",
			questionText: "带大图片的已完成查询",
			questionImages: [{ id: imageId, data: "YQ==".repeat(524288), mimeType: "image/png", name: "历史参考图" }],
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		await service.close();
		if (saved.turns[0]) saved.turns[0].status = status;
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		const parseJson = JSON.parse;
		let parsedHistoryCharacters = 0;
		vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
			if (text.includes(imageId)) parsedHistoryCharacters += text.length;
			return parseJson(text, reviver);
		});
		const recoveryTimer = vi.spyOn(globalThis, "setInterval");
		const observer = createTaskLookupConversationService({
			...dependencies,
			readRuntimeOwnerLiveness: async () => "live",
		});
		try {
			observer.start();
			const recoveryTick = recoveryTimer.mock.calls.at(-1)?.[0];
			if (typeof recoveryTick !== "function") throw new Error("缺少恢复定时器。");
			await recoveryTick();
			const initiallyParsedHistoryCharacters = parsedHistoryCharacters;
			expect(initiallyParsedHistoryCharacters).toBeGreaterThan(2_000_000);
			await recoveryTick();
			await recoveryTick();
			expect(parsedHistoryCharacters).toBe(initiallyParsedHistoryCharacters);
		} finally {
			await observer.close();
		}
	});
	it.each(["new_conversation", "changed_conversation"] as const)(
		"后台发现其他实例的 %s，缓存归属仍遵守 live/unknown/dead 三态",
		async (discoveryMode) => {
			const { service, dependencies } = await setup();
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "cached-owner",
				questionText: "归属待检查的查询",
			});
			const saved = await waitForTurn(service, conversation.conversationId);
			await service.close();
			const historyPath = join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`);
			if (discoveryMode === "new_conversation") await rm(historyPath);
			let ownerLiveness: "live" | "dead" | "unknown" = "live";
			const readRuntimeOwnerLiveness = vi.fn(async () => ownerLiveness);
			const recoveryTimer = vi.spyOn(globalThis, "setInterval");
			const observer = createTaskLookupConversationService({ ...dependencies, readRuntimeOwnerLiveness });
			try {
				observer.start();
				const recoveryTick = recoveryTimer.mock.calls.at(-1)?.[0];
				if (typeof recoveryTick !== "function") throw new Error("缺少恢复定时器。");
				await recoveryTick();
				const runningTurn = saved.turns[0];
				if (!runningTurn) throw new Error("缺少查询轮次。");
				runningTurn.status = "running";
				runningTurn.result = null;
				runningTurn.finishedAt = null;
				await writeFile(historyPath, JSON.stringify(saved));
				await recoveryTick();
				expect(readRuntimeOwnerLiveness).toHaveBeenCalledWith(runningTurn.owningRuntimeProcessInstanceId);
				expect(JSON.parse(await readFile(historyPath, "utf8")).turns[0].status).toBe("running");
				readRuntimeOwnerLiveness.mockClear();
				ownerLiveness = "unknown";
				await recoveryTick();
				expect(readRuntimeOwnerLiveness).toHaveBeenCalledOnce();
				expect(JSON.parse(await readFile(historyPath, "utf8")).turns[0].status).toBe("running");
				ownerLiveness = "dead";
				await recoveryTick();
				expect(JSON.parse(await readFile(historyPath, "utf8")).turns[0].status).toBe("interrupted");
			} finally {
				await observer.close();
			}
		},
	);
	it("关闭会等待已开始的缓存归属检查，返回后不再执行恢复", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "closing-recovery",
			questionText: "等待归属检查的查询",
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		await service.close();
		if (!saved.turns[0]) throw new Error("缺少查询轮次。");
		saved.turns[0].status = "running";
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		const ownerCheckEntered = createSynchronizationBarrier();
		const ownerCheckReleased = createSynchronizationBarrier();
		let pauseOwnerCheck = false;
		const readRuntimeOwnerLiveness = vi.fn(async () => {
			if (!pauseOwnerCheck) return "live" as const;
			ownerCheckEntered.release();
			await ownerCheckReleased.promise;
			return "dead" as const;
		});
		const observer = createTaskLookupConversationService({ ...dependencies, readRuntimeOwnerLiveness });
		const recoveryTimer = vi.spyOn(globalThis, "setInterval");
		try {
			observer.start();
			const recoveryTick = recoveryTimer.mock.calls.at(-1)?.[0];
			if (typeof recoveryTick !== "function") throw new Error("缺少恢复定时器。");
			await recoveryTick();
			pauseOwnerCheck = true;
			const recovery = recoveryTick();
			await ownerCheckEntered.promise;
			let closeReturned = false;
			const closing = observer.close().then(() => {
				closeReturned = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closeReturned).toBe(false);
			ownerCheckReleased.release();
			await Promise.all([recovery, closing]);
			readRuntimeOwnerLiveness.mockClear();
			await recoveryTick();
			expect(readRuntimeOwnerLiveness).not.toHaveBeenCalled();
			expect((await observer.getConversation(conversation.conversationId)).turns[0]?.status).toBe("interrupted");
		} finally {
			ownerCheckReleased.release();
			await observer.close();
		}
	});
	it.each(["waiting_for_conversation_lock", "persisting_running_turn"] as const)(
		"关闭会等待提交退出 %s 边界，且不会启动模型",
		async (submissionBoundary) => {
			const { service, dependencies, requests } = await setup();
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			const boundaryEntered = createSynchronizationBarrier();
			const boundaryReleased = createSynchronizationBarrier();
			if (submissionBoundary === "waiting_for_conversation_lock") {
				const withLock = lockedFileSystem.withLock.bind(lockedFileSystem);
				vi.spyOn(lockedFileSystem, "withLock").mockImplementationOnce(
					async <T>(request: LockRequest, operation: () => Promise<T>) => {
						boundaryEntered.release();
						await boundaryReleased.promise;
						return await withLock(request, operation);
					},
				);
			} else {
				const writeJsonFileAtomic = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
				vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementationOnce(async (...parameters) => {
					await writeJsonFileAtomic(...parameters);
					boundaryEntered.release();
					await boundaryReleased.promise;
				});
			}
			const submission = service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "shutdown-boundary",
				questionText: "关闭前提交的查卡",
			});
			await boundaryEntered.promise;
			let closeReturned = false;
			const closing = service.close().then(() => {
				closeReturned = true;
			});
			try {
				// 让关闭流程的 Promise continuation 跑完；边界仍由显式屏障阻塞，不依赖墙钟等待。
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closeReturned).toBe(false);
			} finally {
				boundaryReleased.release();
				await Promise.allSettled([submission, closing]);
				await service.waitForIdle();
			}
			if (submissionBoundary === "waiting_for_conversation_lock") {
				await expect(submission).rejects.toThrow("查卡服务已关闭");
				expect((await service.getConversation(conversation.conversationId)).turns).toHaveLength(0);
			} else {
				await expect(submission).resolves.toHaveProperty("conversationId", conversation.conversationId);
				expect((await service.getConversation(conversation.conversationId)).turns[0]?.status).toBe("interrupted");
			}
			expect(requests).toHaveLength(0);
			const restarted = createTaskLookupConversationService(dependencies);
			await restarted.getConversation(conversation.conversationId);
			expect(requests).toHaveLength(0);
			await restarted.close();
		},
	);
	it("创建会话等待设置时关闭，不会在关闭后新增历史文件", async () => {
		const { service: originalService, dependencies } = await setup();
		await originalService.close();
		const settingsRequested = createSynchronizationBarrier();
		const settingsReleased = createSynchronizationBarrier();
		const service = createTaskLookupConversationService({
			...dependencies,
			getExecutorSettings: async () => {
				settingsRequested.release();
				await settingsReleased.promise;
				return await dependencies.getExecutorSettings();
			},
		});
		const creation = service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await settingsRequested.promise;
		const closing = service.close();
		settingsReleased.release();
		await Promise.allSettled([creation, closing]);
		await expect(creation).rejects.toThrow("查卡服务已关闭");
		expect(await service.listConversations()).toEqual([]);
	});
	it("创建会话已开始落盘时，关闭会等待历史写入结束", async () => {
		const { service } = await setup();
		await service.listConversations();
		const writeEntered = createSynchronizationBarrier();
		const writeReleased = createSynchronizationBarrier();
		const writeJsonFileAtomic = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementationOnce(async (...parameters) => {
			writeEntered.release();
			await writeReleased.promise;
			await writeJsonFileAtomic(...parameters);
		});
		const creation = service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await writeEntered.promise;
		let closeReturned = false;
		const closing = service.close().then(() => {
			closeReturned = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closeReturned).toBe(false);
		} finally {
			writeReleased.release();
			await Promise.allSettled([creation, closing]);
		}
		await expect(creation).resolves.toHaveProperty("conversationId");
		expect(await service.listConversations()).toHaveLength(1);
	});
	it("多轮补充保留历史与多个候选，重复请求不重复调用模型，重建服务后仍可读取", async () => {
		const { service, dependencies, requests, materials } = await setup();
		const originalMaterials = structuredClone(materials);
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "request-1",
			questionText: "有没有查卡任务？",
		});
		let result = await waitForTurn(service, conversation.conversationId);
		expect(result.turns[0]?.result?.candidates).toHaveLength(2);
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "request-1",
			questionText: "有没有查卡任务？",
		});
		expect(requests).toHaveLength(2);
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "request-2",
			questionText: "需要持久保存历史",
		});
		result = await waitForTurn(service, conversation.conversationId);
		expect(requests[2]).toContain("有没有查卡任务？");
		expect(requests[2]).toContain("需要持久保存历史");
		expect(materials).toEqual(originalMaterials);
		await service.close();
		const restarted = createTaskLookupConversationService(dependencies);
		expect(await restarted.getConversation(conversation.conversationId)).toEqual(result);
		await restarted.close();
	});
	it("模型失败不能冒充零候选，失败轮次也保存到历史", async () => {
		const { dependencies } = await setup();
		const service = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async () => {
				throw new Error("认证已过期");
			},
		});
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "request-1",
			questionText: "查卡",
		});
		const result = await waitForTurn(service, conversation.conversationId);
		expect(result.turns[0]).toMatchObject({ status: "failed", errorMessage: "认证已过期", result: null });
		await service.close();
	});
	it("范围外候选和不存在的 incarnation 被拒绝，不能成为可打开结果", async () => {
		const { service } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: ["project-a"], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "scope",
			questionText: "查卡",
		});
		const result = await waitForTurn(service, conversation.conversationId);
		expect(result.turns[0]).toMatchObject({ status: "failed", result: null });
		expect(result.turns[0]?.errorMessage).toContain("范围外");
		await service.close();
	});
	it("零候选是成功结果，运行中的轮次不可并发提交且可以取消", async () => {
		const { dependencies } = await setup();
		const emptyService = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => ({
				value:
					JSON.parse(request.queryText).phase === "recall"
						? { candidateTaskReferenceKeys: [] }
						: { answerText: "当前材料下未找到", candidates: [] },
				usage: { resolvedModelId: null },
				stablePromptPrefixSha256: "prefix",
				elapsedMs: 1,
				diagnosticWarnings: [],
			}),
		});
		const conversation = await emptyService.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await emptyService.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "empty",
			questionText: "不存在的任务",
		});
		expect((await waitForTurn(emptyService, conversation.conversationId)).turns[0]).toMatchObject({
			status: "completed",
			result: { candidates: [] },
			errorMessage: null,
		});
		await emptyService.close();
		const service = createTaskLookupConversationService({
			...dependencies,
			executeAgent: (request) =>
				new Promise((_resolve, reject) => {
					request.abortSignal?.addEventListener("abort", () => reject(new Error("用户取消")), { once: true });
					request.abortSignal?.throwIfAborted();
				}),
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "running",
			questionText: "慢查询",
		});
		await expect(
			service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "concurrent",
				questionText: "另一条",
			}),
		).rejects.toThrow("已有正在执行");
		expect((await service.cancelTurn(conversation.conversationId)).turns.at(-1)?.status).toBe("cancelled");
		await service.close();
	});
	it("重启恢复中断记录，历史文件损坏不会冒充空历史", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "first",
			questionText: "查卡",
		});
		const persisted = await waitForTurn(service, conversation.conversationId);
		await service.close();
		const turn = persisted.turns[0];
		if (!turn) throw new Error("缺少轮次。");
		turn.status = "running";
		turn.result = null;
		turn.finishedAt = null;
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(persisted),
		);
		const restarted = createTaskLookupConversationService({
			...dependencies,
			readRuntimeOwnerLiveness: async () => "dead",
		});
		expect((await restarted.getConversation(conversation.conversationId)).turns[0]?.status).toBe("interrupted");
		await restarted.close();
		await writeFile(join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`), "broken-json");
		const corrupted = createTaskLookupConversationService(dependencies);
		await expect(corrupted.listConversations()).rejects.toThrow();
		await expect(
			corrupted.createConversation({ contextWorkspaceId: "project-a", scope: { projectIds: [], columnIds: [] } }),
		).resolves.toHaveProperty("conversationId");
		await corrupted.close();
	});
	it("并存实例不能中断活跃查询、取消它或覆盖正常完成的结果", async () => {
		const { dependencies } = await setup();
		const executing = createSynchronizationBarrier();
		const released = createSynchronizationBarrier();
		const first = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				executing.release();
				await released.promise;
				return dependencies.executeAgent(request);
			},
		});
		const conversation = await first.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await first.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "first-instance",
			questionText: "正常慢查询",
		});
		await executing.promise;
		const second = createTaskLookupConversationService({
			...dependencies,
			readRuntimeOwnerLiveness: async () => "live",
		});
		try {
			expect((await second.getConversation(conversation.conversationId)).turns[0]?.status).toBe("running");
			await expect(second.cancelTurn(conversation.conversationId)).rejects.toThrow("不持有");
			released.release();
			await first.waitForIdle();
			expect((await second.getConversation(conversation.conversationId)).turns[0]?.status).toBe("completed");
		} finally {
			released.release();
			await first.close();
			await second.close();
		}
	});
	it("心跳读取异常保留执行状态，后续确认归属退出才恢复为中断", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "owner",
			questionText: "查卡",
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		await service.close();
		if (!saved.turns[0]) throw new Error("缺少轮次");
		saved.turns[0].status = "running";
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		let ownerHasExited = false;
		const observer = createTaskLookupConversationService({
			...dependencies,
			readRuntimeOwnerLiveness: async () => {
				if (!ownerHasExited) throw new Error("心跳暂不可读");
				return "dead";
			},
		});
		try {
			const unknown = await observer.getConversation(conversation.conversationId);
			expect(unknown.turns[0]).toMatchObject({
				status: "running",
				executionRecoveryMessage: expect.stringContaining("无法确认"),
			});
			expect(unknown.revision).toBe(saved.revision);
			ownerHasExited = true;
			expect((await observer.getConversation(conversation.conversationId)).turns[0]?.status).toBe("interrupted");
		} finally {
			await observer.close();
		}
	});
	it("无归属的旧记录只有显式恢复才结束，重新提问保存新轮而不抹去旧轮", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "legacy",
			questionText: "旧查询",
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		if (!saved.turns[0]) throw new Error("缺少轮次");
		saved.turns[0].status = "running";
		delete saved.turns[0].owningRuntimeProcessInstanceId;
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		expect((await service.getConversation(conversation.conversationId)).turns[0]?.status).toBe("running");
		await expect(
			service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "blocked",
				questionText: "旧查询",
			}),
		).rejects.toThrow("已有正在执行");
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "explicit",
			questionText: "旧查询",
			explicitlyRecoveredUnownedTurnId: saved.turns[0].turnId,
		});
		const recovered = await waitForTurn(service, conversation.conversationId);
		expect(recovered.turns.map((turn) => turn.status)).toEqual(["interrupted", "completed"]);
		await service.close();
	});
	it("重复提问按图片内容去重，两阶段保留当前与历史问题的图片归属", async () => {
		const { dependencies } = await setup();
		const executeAgent = vi.fn(dependencies.executeAgent);
		const service = createTaskLookupConversationService({ ...dependencies, executeAgent });
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		const originalImage = { id: "reference-image", data: "aW1hZ2U=", mimeType: "image/png", name: "原图" };
		const repeatedImage = { ...originalImage, id: "retry-reference-image", name: "重问时重新选的同图" };
		const differentImage = { ...originalImage, data: "b3RoZXI=", name: "沿用旧 ID 的另一张图" };
		try {
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "original-image",
				questionText: "查找原图中的任务",
				questionImages: [originalImage],
			});
			await service.waitForIdle();
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "repeat-with-comparison-image",
				questionText: "再找一次，并与另一张图比较",
				questionImages: [repeatedImage, differentImage],
			});
			const repeated = await waitForTurn(service, conversation.conversationId);
			expect(executeAgent).toHaveBeenCalledTimes(4);
			for (const [request] of executeAgent.mock.calls.slice(2)) {
				expect(request).toHaveProperty("questionImages", [originalImage, differentImage]);
				expect(JSON.parse(request.queryText)).toMatchObject({
					turnId: repeated.turns[1]?.turnId,
					questionImageReferences: [
						{ imageInputNumber: 1, imageAttachmentId: repeatedImage.id, imageDisplayName: repeatedImage.name },
						{ imageInputNumber: 2, imageAttachmentId: differentImage.id, imageDisplayName: differentImage.name },
					],
					history: [
						{
							turnId: repeated.turns[0]?.turnId,
							questionText: "查找原图中的任务",
							questionImageReferences: [{ imageInputNumber: 1, imageAttachmentId: originalImage.id }],
						},
					],
				});
			}
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "text-only-followup",
				questionText: "另查修复输入框的任务",
			});
			const followedUp = await waitForTurn(service, conversation.conversationId);
			expect(executeAgent).toHaveBeenCalledTimes(6);
			for (const [request] of executeAgent.mock.calls.slice(4)) {
				expect(request).toHaveProperty("questionImages", [originalImage, differentImage]);
				const query = JSON.parse(request.queryText);
				expect(query).toMatchObject({
					turnId: followedUp.turns[2]?.turnId,
					questionText: "另查修复输入框的任务",
					questionImageReferences: [],
					history: [
						{ turnId: followedUp.turns[0]?.turnId, questionImageReferences: [{ imageInputNumber: 1 }] },
						{
							turnId: followedUp.turns[1]?.turnId,
							questionImageReferences: [{ imageInputNumber: 1 }, { imageInputNumber: 2 }],
						},
					],
				});
			}
			expect(followedUp.turns.map((turn) => turn.questionImages)).toEqual([
				[originalImage],
				[repeatedImage, differentImage],
				[],
			]);
			const archivedInput = JSON.parse(
				await readFile(
					join(
						dependencies.storageDirectoryPath,
						conversation.conversationId,
						`${followedUp.turns[2]?.turnId}-answer-input.json`,
					),
					"utf8",
				),
			);
			expect(archivedInput.questionImages).toEqual([originalImage, differentImage]);
			expect(archivedInput.queryText).toBe(executeAgent.mock.calls[5]?.[0].queryText);
		} finally {
			await service.close();
		}
	});
	it("两阶段均接收图片，图片变化不能复用同一 requestId", async () => {
		const { dependencies } = await setup();
		const executeAgent = vi.fn(dependencies.executeAgent);
		const service = createTaskLookupConversationService({ ...dependencies, executeAgent });
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		const questionImages = [{ id: "reference-image", data: "aW1hZ2U=", mimeType: "image/png", name: "参考图" }];
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "image",
			questionText: "查找图片中的任务",
			questionImages,
		});
		await service.waitForIdle();
		expect(executeAgent).toHaveBeenCalledTimes(2);
		for (const [request] of executeAgent.mock.calls) expect(request).toHaveProperty("questionImages", questionImages);
		await expect(
			service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "image",
				questionText: "查找图片中的任务",
			}),
		).rejects.toThrow("不可用于不同查询");
		await service.close();
	});
	it("轮次已被外部终止时，迟到模型结果既不覆盖终态，也不再启动下一次调用", async () => {
		const { service: initial, dependencies, requests } = await setup();
		await initial.close();
		const entered = createSynchronizationBarrier(),
			released = createSynchronizationBarrier();
		const service = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				entered.release();
				await released.promise;
				return dependencies.executeAgent(request);
			},
		});
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "late-result",
			questionText: "迟到结果",
		});
		await entered.promise;
		try {
			const persisted = await service.getConversation(conversation.conversationId);
			const turn = persisted.turns[0];
			if (!turn) throw new Error("缺少轮次");
			turn.status = "interrupted";
			turn.phase = "finished";
			turn.finishedAt = Date.now();
			turn.errorMessage = "外部已结束";
			await writeFile(
				join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
				JSON.stringify(persisted),
			);
		} finally {
			released.release();
			await service.waitForIdle();
			await service.close();
		}
		expect((await service.getConversation(conversation.conversationId)).turns[0]).toMatchObject({
			status: "interrupted",
			errorMessage: "外部已结束",
			result: null,
		});
		expect(requests).toHaveLength(1);
	});
	it.each(["live", "unknown", "unreadable", "legacy"] as const)(
		"恢复时保留 %s 归属的轮次，不把未知状态写成重启",
		async (ownership) => {
			const { service, dependencies } = await setup();
			const conversation = await service.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await service.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "original",
				questionText: "保留历史",
			});
			const persisted = await waitForTurn(service, conversation.conversationId);
			await service.close();
			const turn = persisted.turns[0];
			if (!turn) throw new Error("缺少轮次");
			turn.status = "running";
			turn.result = null;
			turn.finishedAt = null;
			if (ownership === "legacy") delete turn.owningRuntimeProcessInstanceId;
			await writeFile(
				join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
				JSON.stringify(persisted),
			);
			const observer = createTaskLookupConversationService({
				...dependencies,
				runtimeProcessInstanceId: "another-runtime",
				readRuntimeOwnerLiveness: async () => {
					if (ownership === "unreadable") throw new Error("EACCES");
					return ownership === "live" ? "live" : "unknown";
				},
			});
			try {
				const observed = (await observer.getConversation(conversation.conversationId)).turns[0];
				expect(observed?.status).toBe("running");
				expect(observed?.executionOwnershipWarning).toBeTruthy();
				expect(observed?.errorMessage).toBeNull();
			} finally {
				await observer.close();
			}
		},
	);
	it("模型活动在执行中落盘并推送，失败后保留召回用量、失败阶段和有界时间线", async () => {
		const { service: initial, dependencies } = await setup();
		await initial.close();
		const entered = createSynchronizationBarrier(),
			released = createSynchronizationBarrier();
		const notified = vi.fn();
		const service = createTaskLookupConversationService({
			...dependencies,
			onConversationUpdated: notified,
			executeAgent: async (request) => {
				if (JSON.parse(request.queryText).phase === "recall") return dependencies.executeAgent(request);
				for (let index = 0; index < 220; index++)
					request.onExecutionActivity?.({
						eventKind: "agent_response_received",
						occurredAtEpochMs: Date.now(),
						message: `活动 ${index}`,
					});
				entered.release();
				await released.promise;
				const error = new StatelessTaskIndexingAgentExecutionError("execution_timeout", "模型超时");
				error.exitCode = null;
				error.signal = "SIGKILL";
				throw error;
			},
		});
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "activity",
			questionText: "进度",
		});
		await entered.promise;
		try {
			await vi.waitFor(
				async () =>
					expect(
						(await service.getConversation(conversation.conversationId)).turns[0]?.executionActivityTimeline?.at(
							-1,
						)?.message,
					).toBe("活动 219"),
				{ timeout: 10000 },
			);
			expect(notified).toHaveBeenCalled();
		} finally {
			released.release();
			await service.waitForIdle();
		}
		const turn = (await service.getConversation(conversation.conversationId)).turns[0];
		expect(turn).toMatchObject({
			status: "failed",
			executorSettings: { agentId: "codex" },
			executionFailureDiagnostic: {
				reasonCode: "execution_timeout",
				failedPhase: "explaining_candidates",
				signal: "SIGKILL",
			},
		});
		expect(turn?.executions).toHaveLength(1);
		expect(turn?.inputByteCount).toBeGreaterThan(0);
		expect(turn?.executionActivityTimeline).toHaveLength(200);
		expect(turn?.omittedExecutionActivityCount).toBeGreaterThan(0);
		await service.close();
	});
	it("另一服务初始化和读取历史不会中断仍在执行的轮次", async () => {
		const { service: initial, dependencies } = await setup();
		await initial.close();
		const entered = createSynchronizationBarrier();
		const released = createSynchronizationBarrier();
		const first = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				entered.release();
				await released.promise;
				return dependencies.executeAgent(request);
			},
		});
		const conversation = await first.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await first.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "live-owner",
			questionText: "保持执行",
		});
		await entered.promise;
		const second = createTaskLookupConversationService(dependencies);
		try {
			expect((await second.getConversation(conversation.conversationId)).turns[0]?.status).toBe("running");
			await expect(second.cancelTurn(conversation.conversationId)).rejects.toThrow("不由当前");
		} finally {
			released.release();
			await first.waitForIdle();
			await first.close();
			await second.close();
		}
		expect((await first.getConversation(conversation.conversationId)).turns[0]?.status).toBe("completed");
	});
	it.each(["completed", "owner_changed"] as const)(
		"观察方等待心跳时不占用会话锁，迟到失活观测不覆盖 %s 轮次",
		async (concurrentChange) => {
			const { service: initial, dependencies } = await setup();
			await initial.close();
			const executionStarted = createSynchronizationBarrier();
			const executionReleased = createSynchronizationBarrier();
			const heartbeatStarted = createSynchronizationBarrier();
			const heartbeatReleased = createSynchronizationBarrier();
			const owner = createTaskLookupConversationService({
				...dependencies,
				runtimeProcessInstanceId: "owner-runtime",
				executeAgent: async (request) => {
					executionStarted.release();
					await executionReleased.promise;
					return dependencies.executeAgent(request);
				},
			});
			const conversation = await owner.createConversation({
				contextWorkspaceId: "project-a",
				scope: { projectIds: [], columnIds: [] },
			});
			await owner.submitTurn({
				conversationId: conversation.conversationId,
				requestId: "complete-during-heartbeat-observation",
				questionText: "观察期间继续执行",
			});
			await executionStarted.promise;
			let heldConversationLockCount = 0;
			let heartbeatObservedWhileConversationLocked = false;
			const conversationPath = join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`);
			const withLock = lockedFileSystem.withLock.bind(lockedFileSystem);
			vi.spyOn(lockedFileSystem, "withLock").mockImplementation(
				async <T>(request: LockRequest, operation: () => Promise<T>) =>
					await withLock(request, async () => {
						if (request.path === conversationPath) heldConversationLockCount++;
						try {
							return await operation();
						} finally {
							if (request.path === conversationPath) heldConversationLockCount--;
						}
					}),
			);
			const observer = createTaskLookupConversationService({
				...dependencies,
				runtimeProcessInstanceId: "observer-runtime",
				readRuntimeOwnerLiveness: async (observedOwnerId) => {
					if (observedOwnerId === "replacement-runtime") return "live";
					heartbeatObservedWhileConversationLocked = heldConversationLockCount > 0;
					heartbeatStarted.release();
					await heartbeatReleased.promise;
					return "dead";
				},
			});
			const observation = observer.getConversation(conversation.conversationId);
			try {
				await heartbeatStarted.promise;
				expect(heartbeatObservedWhileConversationLocked).toBe(false);
				if (concurrentChange === "owner_changed") {
					const transferred = await owner.getConversation(conversation.conversationId);
					const turn = transferred.turns[0];
					if (!turn) throw new Error("缺少轮次");
					turn.owningRuntimeProcessInstanceId = "replacement-runtime";
					await lockedFileSystem.withLock({ path: conversationPath }, async () => {
						await lockedFileSystem.writeJsonFileAtomic(conversationPath, transferred, { lock: null });
					});
				}
				executionReleased.release();
				await owner.waitForIdle();
				heartbeatReleased.release();
				const observed = (await observation).turns[0];
				expect(observed).toMatchObject(
					concurrentChange === "completed"
						? { status: "completed", result: { answerText: "找到两个可能相关任务" } }
						: { status: "running", owningRuntimeProcessInstanceId: "replacement-runtime", result: null },
				);
				expect(observed?.executionFailureDiagnostic).toBeUndefined();
			} finally {
				executionReleased.release();
				heartbeatReleased.release();
				await Promise.all([observation, owner.close(), observer.close()]);
			}
		},
	);
	it("材料读取尚未结束也能取消，迟到返回不会启动模型", async () => {
		const { service: initial, dependencies, requests } = await setup();
		await initial.close();
		const entered = createSynchronizationBarrier();
		const released = createSynchronizationBarrier();
		const service = createTaskLookupConversationService({
			...dependencies,
			collectMaterials: async () => {
				entered.release();
				await released.promise;
				return dependencies.collectMaterials();
			},
		});
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "cancel-materials",
			questionText: "取消读取",
		});
		await entered.promise;
		try {
			const cancelled = await service.cancelTurn(conversation.conversationId);
			expect(cancelled.turns[0]).toMatchObject({
				status: "cancelled",
				executionFailureDiagnostic: { failedPhase: "collecting_materials" },
			});
		} finally {
			released.release();
			await service.close();
		}
		expect(requests).toHaveLength(0);
	});
	it.each(["cancel", "close"] as const)("保存结果阶段发生 %s 时不再提交成功结果", async (stopOperation) => {
		const { service: originalService, dependencies } = await setup();
		await originalService.close();
		const savingStarted = createSynchronizationBarrier();
		const savingReleased = createSynchronizationBarrier();
		const executionAborted = createSynchronizationBarrier();
		const service = createTaskLookupConversationService({
			...dependencies,
			executeAgent: async (request) => {
				request.abortSignal?.addEventListener("abort", executionAborted.release, { once: true });
				return dependencies.executeAgent(request);
			},
		});
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		const writeJsonFileAtomic = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (...parameters) => {
			const persisted = parameters[1];
			if (
				parameters[0] === join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`) &&
				persisted &&
				typeof persisted === "object" &&
				"turns" in persisted &&
				Array.isArray(persisted.turns) &&
				persisted.turns[0]?.phase === "saving_result"
			) {
				savingStarted.release();
				await savingReleased.promise;
			}
			await writeJsonFileAtomic(...parameters);
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "stop-while-saving-result",
			questionText: "保存期间停止",
		});
		await savingStarted.promise;
		const stopping = stopOperation === "cancel" ? service.cancelTurn(conversation.conversationId) : service.close();
		try {
			await executionAborted.promise;
		} finally {
			savingReleased.release();
			await stopping;
			await service.close();
		}
		const turn = (await service.getConversation(conversation.conversationId)).turns[0];
		expect(turn).toMatchObject({
			status: stopOperation === "cancel" ? "cancelled" : "interrupted",
			result: null,
			executionFailureDiagnostic: {
				reasonCode: stopOperation === "cancel" ? "user_cancelled" : "runtime_closed",
				failedPhase: "saving_result",
			},
		});
		expect(turn?.executionActivityTimeline?.some((activity) => activity.eventKind === "query_completed")).toBe(false);
	});
	it("旧候选字段的执行归属可读取，仍在线时不会当作无归属旧轮恢复", async () => {
		const { service, dependencies } = await setup();
		const conversation = await service.createConversation({
			contextWorkspaceId: "project-a",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "legacy-owner-field",
			questionText: "保留旧归属",
		});
		const saved = await waitForTurn(service, conversation.conversationId);
		await service.close();
		const turn = saved.turns[0];
		if (!turn) throw new Error("缺少查询轮次。");
		turn.executionOwnerRuntimeProcessInstanceId = turn.owningRuntimeProcessInstanceId;
		delete turn.owningRuntimeProcessInstanceId;
		turn.status = "running";
		await writeFile(
			join(dependencies.storageDirectoryPath, `${conversation.conversationId}.json`),
			JSON.stringify(saved),
		);
		const observer = createTaskLookupConversationService({
			...dependencies,
			readRuntimeOwnerLiveness: async () => "live",
		});
		try {
			expect((await observer.getConversation(conversation.conversationId)).turns[0]).toMatchObject({
				status: "running",
				owningRuntimeProcessInstanceId: turn.executionOwnerRuntimeProcessInstanceId,
			});
			await expect(
				observer.submitTurn({
					conversationId: conversation.conversationId,
					requestId: "forbidden-legacy-recovery",
					questionText: "不能结束活轮",
					explicitlyRecoveredUnownedTurnId: turn.turnId,
				}),
			).rejects.toThrow("仍有执行归属");
		} finally {
			await observer.close();
		}
	});
});
