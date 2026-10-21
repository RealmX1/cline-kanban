import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskIndexingMaterial } from "../../../src/core/task-indexing-support-contract";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
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
const material = (taskId: string, workspaceId = "project-a"): TaskIndexingMaterial => ({
	taskReference: { workUnitType: "kanban_board_card", workspaceId, taskId, taskIncarnationCreatedAtEpochMs: 1 },
	projectName: workspaceId,
	title: `任务 ${taskId}`,
	prompt: "实现任务查卡和持久历史",
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
						? { candidateTaskReferences: materials.map((entry) => entry.taskReference) }
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
						? { candidateTaskReferences: [] }
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
		const restarted = createTaskLookupConversationService(dependencies);
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
});
