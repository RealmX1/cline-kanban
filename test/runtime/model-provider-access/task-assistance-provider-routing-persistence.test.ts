import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { notificationIntelligenceSettingsSchema } from "../../../src/core/notification-intelligence-settings-contract";
import {
	readTaskAssistanceModelProviderRoutingSettings,
	saveKanbanModelProviderProfile,
	saveNotificationIntelligenceSettings,
	saveTaskAssistanceModelProviderRoutingSettings,
} from "../../../src/model-provider-access/kanban-model-provider-settings";
import { requestTaskAssistanceJsonObject } from "../../../src/model-provider-access/task-assistance-model-provider-routing";
import { createTempDir } from "../../utilities/temp-dir";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
it("新请求读取持久配置，MiniMax 从未配置到可用后自动优先，档案变化解除冷却", async () => {
	const directory = createTempDir("task-assistance-provider-persistence-");
	vi.stubEnv("KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT", directory.path);
	vi.stubEnv("KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY", "fixture-minimax");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY", "fixture-deepseek");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_MINIMAX_BASE_URL", "");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID", "");
	const response = () =>
		new Response(JSON.stringify({ model: "actual-model", choices: [{ message: { content: '{"accepted":true}' } }] }));
	const fetchImplementation = vi.fn().mockImplementation(async () => response());
	const request = {
		modelUsagePurpose: "task_project_assignment_analysis" as const,
		operationId: "persisted-route",
		stage: "project_assignment",
		systemPrompt: "输出 JSON",
		userPrompt: "判断归属",
	};
	const profile = {
		modelProviderId: "deepseek",
		displayName: "DeepSeek",
		providerProtocol: "openai_compatible" as const,
		credentialSource: "environment" as const,
		baseUrl: "https://deepseek.invalid",
		defaultModelId: "configured-deepseek",
		alibabaRegion: "beijing" as const,
	};
	try {
		expect(await readTaskAssistanceModelProviderRoutingSettings()).toEqual({
			preferredModelProviderId: "minimax",
			fallbackModelProviderId: "deepseek",
		});
		await saveKanbanModelProviderProfile({ profile });
		const settingsPath = join(directory.path, "kanban-model-provider-settings.json");
		const previousSettingsText = await readFile(settingsPath, "utf8");
		await writeFile(settingsPath, "invalid persisted JSON");
		expect(
			await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), { fetchImplementation }),
		).toMatchObject({ status: "unavailable", unavailableReason: "model_provider_not_configured" });
		expect(fetchImplementation).not.toHaveBeenCalled();
		await writeFile(settingsPath, previousSettingsText);
		await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), { fetchImplementation });
		expect(fetchImplementation.mock.calls[0]?.[0]).toContain("deepseek.invalid");
		const minimaxProfile = {
			...profile,
			modelProviderId: "minimax",
			displayName: "MiniMax",
			baseUrl: "https://minimax.invalid/v1",
			defaultModelId: "MiniMax-M2.5",
		};
		await saveKanbanModelProviderProfile({ profile: minimaxProfile });
		fetchImplementation.mockImplementationOnce(async () => new Response("", { status: 503 }));
		await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), { fetchImplementation });
		expect(fetchImplementation.mock.calls[1]?.[0]).toContain("minimax.invalid");
		expect(fetchImplementation.mock.calls[2]?.[0]).toContain("deepseek.invalid");
		await saveKanbanModelProviderProfile({ profile: { ...minimaxProfile, defaultModelId: "MiniMax-M3" } });
		await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), { fetchImplementation });
		expect(JSON.parse(fetchImplementation.mock.calls[3]?.[1].body).model).toBe("MiniMax-M3");
		await saveTaskAssistanceModelProviderRoutingSettings({
			preferredModelProviderId: "deepseek",
			fallbackModelProviderId: null,
		});
		await saveNotificationIntelligenceSettings(notificationIntelligenceSettingsSchema.parse({}));
		expect(await readTaskAssistanceModelProviderRoutingSettings()).toEqual({
			preferredModelProviderId: "deepseek",
			fallbackModelProviderId: null,
		});
		await requestTaskAssistanceJsonObject(request, z.object({ accepted: z.boolean() }), { fetchImplementation });
		expect(fetchImplementation.mock.calls[4]?.[0]).toContain("deepseek.invalid");
	} finally {
		directory.cleanup();
	}
});
