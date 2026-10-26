import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { expect, it, vi } from "vitest";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { collectTaskIndexingMaterials } from "../../src/task-indexing-support/collect-task-indexing-materials";
import { executeTaskAnalysisApi } from "../../src/task-indexing-support/task-analysis-api-executor";
import {
	loadAndAdvanceSharedTaskIndexingContext,
	readTaskIndexingSupportExecutorSettings,
} from "../../src/task-indexing-support/task-indexing-support-storage";
import {
	createTaskLookupConversationService,
	TASK_LOOKUP_INSTRUCTION_VERSION,
} from "../../src/task-indexing-support/task-lookup-conversation-service";
import { type RuntimeAppRouter, type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createTaskAssistanceOpenAiCompatibleHttpFixture,
	readTaskAssistanceHttpFixtureUserPrompt,
} from "../utilities/task-assistance-openai-compatible-http-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

it("真实 HTTP、共享 Context 与 API 执行器支持多轮查卡、预览和重启留档，原任务不变", { timeout: 60000 }, async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const projectPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "task-lookup-project");
	await mkdir(projectPath, { recursive: true });
	fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: projectPath, initialBranchName: "main" });
	const card = (id: string) => ({
		id,
		title: `持久查卡 ${id}`,
		prompt: "支持自然语言查卡、历史留档和补充条件。",
		createdAt: 1,
		updatedAt: 1,
		baseRef: "main",
		startInPlanMode: true,
	});
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [card("abc12")] },
				{ id: "in_progress", title: "In Progress", cards: [card("def34")] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		},
		sessions: {},
	});
	const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
	expect(await readTaskIndexingSupportExecutorSettings(workspace.workspaceId)).toEqual({
		agentId: "codex",
		modelId: null,
	});
	const originalBoard = await loadWorkspaceBoardById(workspace.workspaceId);
	const modelFixture = await createTaskAssistanceOpenAiCompatibleHttpFixture({
		isolatedHomeDirectoryPath: fixture.isolatedHomeDirectoryPath,
		respond: (request) => {
			const query = JSON.parse(
				readTaskAssistanceHttpFixtureUserPrompt(request).split("L4 本次查询：\n").at(-1) ?? "",
			);
			return query.phase === "recall"
				? { candidateTaskReferences: query.eligibleTaskReferences }
				: {
						answerText: "找到符合范围的任务，尚未核验是否已经实现。",
						candidates: query.completeCandidateRequirements.map(
							(material: { taskReference: unknown; prompt: string }) => ({
								taskReference: material.taskReference,
								matchingReason: "当前要求包含查卡与历史留档",
								evidence: [material.prompt],
								limitations: ["所在列不证明实现完成"],
							}),
						),
					};
		},
	});
	const storageDirectoryPath = join(fixture.isolatedHomeDirectoryPath, "task-lookup-conversations");
	const dependencies = {
		storageDirectoryPath,
		collectMaterials: (workspaceId: string) =>
			collectTaskIndexingMaterials({ workspaceId, listLiveSessionSummaries: () => [] }),
		getExecutorSettings: readTaskIndexingSupportExecutorSettings,
		getContext: (
			workspaceId: string,
			materials: Awaited<ReturnType<typeof collectTaskIndexingMaterials>>["materials"],
			settings: Parameters<typeof loadAndAdvanceSharedTaskIndexingContext>[0]["settings"],
		) =>
			loadAndAdvanceSharedTaskIndexingContext({
				workspaceId,
				materials,
				settings,
				instructionVersion: TASK_LOOKUP_INSTRUCTION_VERSION,
				now: Date.now(),
				forModelRequest: true,
			}),
		executeAgent: executeTaskAnalysisApi,
	};
	let service = createTaskLookupConversationService(dependencies);
	const server = createServer(
		createHTTPHandler({
			basePath: "/api/trpc/",
			router: runtimeAppRouter,
			createContext: () =>
				({
					taskLookupConversationApi: service,
					kanbanRequestOriginActorEvidence: {
						decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
					},
				}) as RuntimeTrpcContext,
		}),
	);
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("隔离 HTTP 未分配端口。");
		const client = createTRPCProxyClient<RuntimeAppRouter>({
			links: [httpBatchLink({ url: `http://127.0.0.1:${address.port}/api/trpc` })],
		});
		const conversation = await client.support.createTaskLookupConversation.mutate({
			contextWorkspaceId: workspace.workspaceId,
			scope: { projectIds: [], columnIds: [] },
		});
		await client.support.submitTaskLookupTurn.mutate({
			conversationId: conversation.conversationId,
			requestId: "first",
			questionText: "查找支持历史留档的任务",
		});
		await service.waitForIdle();
		const first = await client.support.getTaskLookupConversation.query({
			conversationId: conversation.conversationId,
		});
		expect(first.turns[0]?.result?.candidates).toHaveLength(2);
		const candidate = first.turns[0]?.result?.candidates[0];
		if (!candidate) throw new Error("缺少候选。");
		expect(
			await client.support.readTaskLookupCandidatePreview.query({
				conversationId: first.conversationId,
				taskReference: candidate.taskReference,
			}),
		).toMatchObject({ prompt: "支持自然语言查卡、历史留档和补充条件。" });
		await client.support.submitTaskLookupTurn.mutate({
			conversationId: conversation.conversationId,
			requestId: "second",
			questionText: "只看进行中的",
			scope: { projectIds: [], columnIds: ["in_progress"] },
		});
		await service.waitForIdle();
		const second = await client.support.getTaskLookupConversation.query({
			conversationId: conversation.conversationId,
		});
		expect(second.turns[1]?.result?.candidates.map((entry) => entry.taskReference.taskId)).toEqual(["def34"]);
		const calls = modelFixture.requests.map((request) =>
			JSON.parse(readTaskAssistanceHttpFixtureUserPrompt(request).split("L4 本次查询：\n").at(-1) ?? ""),
		);
		expect(calls).toHaveLength(4);
		expect(calls[2].history[0].questionText).toBe("查找支持历史留档的任务");
		await service.close();
		service = createTaskLookupConversationService(dependencies);
		expect(
			await client.support.getTaskLookupConversation.query({ conversationId: conversation.conversationId }),
		).toEqual(second);
		expect(await loadWorkspaceBoardById(workspace.workspaceId)).toEqual(originalBoard);
	} finally {
		await service.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		vi.unstubAllEnvs();
	}
});
