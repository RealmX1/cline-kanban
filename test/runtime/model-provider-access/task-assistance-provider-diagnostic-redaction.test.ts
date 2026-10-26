import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
	getDiagnosticEventJournalActiveFilePath,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { saveTaskAssistanceModelProviderRoutingSettings } from "../../../src/model-provider-access/kanban-model-provider-settings";
import { requestTaskAssistanceJsonObject } from "../../../src/model-provider-access/task-assistance-model-provider-routing";
import { executeTaskAnalysisApi } from "../../../src/task-indexing-support/task-analysis-api-executor";
import { createTaskLookupConversationService } from "../../../src/task-indexing-support/task-lookup-conversation-service";
import { createTempDir } from "../../utilities/temp-dir";

const responseOnlyTaskMaterial = "机密正文";
const fixtureCredential = "sk-PRIVATE_KEY";
const routingSettings = { preferredModelProviderId: "deepseek", fallbackModelProviderId: "minimax" };
const request = {
	modelUsagePurpose: "task_lookup_candidate_recall" as const,
	operationId: "diagnostic-redaction",
	stage: "candidate_recall",
	systemPrompt: "输出 JSON",
	userPrompt: "查找任务",
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function expectNoUpstreamEcho(value: unknown) {
	const serialized = JSON.stringify(value);
	expect(serialized).not.toContain(responseOnlyTaskMaterial);
	expect(serialized).not.toContain(fixtureCredential);
}

it("真实 HTTP 非 JSON 响应不把正文或凭据写入 attempts、journal、冷却状态及查卡历史", async () => {
	const directory = createTempDir("task-assistance-diagnostic-redaction-");
	vi.stubEnv("HOME", directory.path);
	vi.stubEnv("KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT", directory.path);
	vi.stubEnv(DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR, join(directory.path, "diagnostic-event-journals"));
	const server = createServer(async (incomingRequest, response) => {
		for await (const _chunk of incomingRequest) {
			// 读取请求直到结束，随后模拟网关把机密内容回显为非 JSON 正文。
		}
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(`${responseOnlyTaskMaterial}${fixtureCredential}`);
	});
	let service: ReturnType<typeof createTaskLookupConversationService> | undefined;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("隔离 HTTP 未分配端口。");
		const environmentVariables = {
			KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: fixtureCredential,
			KANBAN_MODEL_PROVIDER_DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/preferred`,
			KANBAN_MODEL_PROVIDER_DEEPSEEK_MODEL_ID: "fixture-preferred-model",
			KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY: fixtureCredential,
			KANBAN_MODEL_PROVIDER_MINIMAX_BASE_URL: `http://127.0.0.1:${address.port}/fallback`,
			KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID: "fixture-fallback-model",
		};
		const observations: unknown[] = [];
		const result = await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), {
			environmentVariables,
			routingSettings,
			storageDirectoryPath: join(directory.path, "direct-routing-state"),
			onAttempt: (attempt) => observations.push(attempt),
			observeAttempt: async (observation) => {
				observations.push(observation);
			},
		});
		expect(result).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });
		expect(result.attempts).toHaveLength(2);
		const directRecovery = JSON.parse(
			await readFile(join(directory.path, "direct-routing-state", "provider-recovery-state.json"), "utf8"),
		);

		for (const [name, value] of Object.entries(environmentVariables)) vi.stubEnv(name, value);
		await saveTaskAssistanceModelProviderRoutingSettings(routingSettings);
		const conversationDirectoryPath = join(directory.path, "task-lookup-conversations");
		const dependencies = {
			storageDirectoryPath: conversationDirectoryPath,
			runtimeProcessInstanceId: "diagnostic-redaction-runtime",
			collectMaterials: async () => ({ materials: [], missingContextParts: [] }),
			getExecutorSettings: async () => ({ agentId: "codex" as const, modelId: null }),
			getContext: async () => ({
				schemaVersion: 1 as const,
				workspaceId: "diagnostic-redaction-project",
				levelOneBoardTaskIndexText: "",
				levelTwoProjectTaskRecapsText: "",
				levelThreeAppendedChangesText: "",
				snapshotFingerprint: "fixture",
				contextCompleteness: [],
				asOf: 1,
				rebuildReason: null,
			}),
			executeAgent: executeTaskAnalysisApi,
		};
		service = createTaskLookupConversationService(dependencies);
		const conversation = await service.createConversation({
			contextWorkspaceId: "diagnostic-redaction-project",
			scope: { projectIds: [], columnIds: [] },
		});
		await service.submitTurn({
			conversationId: conversation.conversationId,
			requestId: "diagnostic-redaction-turn",
			questionText: "查找任务",
			questionImages: [],
		});
		await service.waitForIdle();
		const history = await service.getConversation(conversation.conversationId);
		expect(history.turns[0]).toMatchObject({ status: "failed", providerAttempts: [{}, {}] });
		const persistedHistory = await readFile(
			join(conversationDirectoryPath, `${conversation.conversationId}.json`),
			"utf8",
		);
		const upperRecovery = await readFile(
			join(directory.path, "task-assistance-model-routing", "provider-recovery-state.json"),
			"utf8",
		);
		await waitForPendingDiagnosticEventJournalWrites();
		const journal = await readFile(getDiagnosticEventJournalActiveFilePath("task-assistance-routing"), "utf8");
		for (const value of [result, observations, directRecovery, journal, history, persistedHistory, upperRecovery])
			expectNoUpstreamEcho(value);
		const safeReason = "模型服务返回了无法解析的 JSON 响应。";
		expect(result.attempts[0]?.failureReason).toBe(safeReason);
		expect(directRecovery.deepseek.lastFailure.reason).toBe(safeReason);
		expect(history.turns[0]?.executionFailureDiagnostic?.detail).toBe(safeReason);
		await service.close();
		service = createTaskLookupConversationService(dependencies);
		expect(await service.getConversation(conversation.conversationId)).toEqual(history);
	} finally {
		await service?.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await waitForPendingDiagnosticEventJournalWrites();
		directory.cleanup();
	}
});

it.each([
	new Error(`Authorization: Bearer ${fixtureCredential} ${responseOnlyTaskMaterial}`),
	`${responseOnlyTaskMaterial}: api_key=${fixtureCredential}`,
])("注入请求异常不把异常正文泄漏到诊断出口 %#", async (failure) => {
	const directory = createTempDir("task-assistance-diagnostic-exception-redaction-");
	vi.stubEnv(DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR, join(directory.path, "diagnostic-event-journals"));
	try {
		const result = await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), {
			routingSettings: { preferredModelProviderId: "deepseek", fallbackModelProviderId: null },
			environmentVariables: { KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: fixtureCredential },
			storageDirectoryPath: directory.path,
			fetchImplementation: vi.fn().mockRejectedValue(failure),
		});
		await waitForPendingDiagnosticEventJournalWrites();
		expectNoUpstreamEcho(result);
		expectNoUpstreamEcho(await readFile(join(directory.path, "provider-recovery-state.json"), "utf8"));
		expectNoUpstreamEcho(await readFile(getDiagnosticEventJournalActiveFilePath("task-assistance-routing"), "utf8"));
	} finally {
		await waitForPendingDiagnosticEventJournalWrites();
		directory.cleanup();
	}
});
