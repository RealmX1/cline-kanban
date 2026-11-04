import type { TRPCClient } from "@trpc/client";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerTaskConversationSessionCommands } from "../../../src/commands/task-conversation-session";
import type { RuntimeAppRouter } from "../../../src/trpc/app-router";

async function run(argumentsAfterCreate: string[]) {
	const create = vi.fn(async () => ({ ok: true }));
	const preview = vi.fn(async () => ({ ok: true }));
	const resolveWorkspace = vi.fn(async () => "workspace");
	const createClient = vi.fn(
		() =>
			({
				runtime: {
					createTaskConversationSession: { mutate: create },
					previewTaskConversationSession: { query: preview },
				},
			}) as unknown as TRPCClient<RuntimeAppRouter>,
	);
	let error: unknown;
	const command = new Command();
	registerTaskConversationSessionCommands(command, {
		resolveWorkspace,
		createClient,
		run: async (handler) => {
			try {
				await handler();
			} catch (cause) {
				error = cause;
			}
		},
	});
	await command.parseAsync([
		"node",
		"kanban",
		"conversation-session",
		"create",
		"--task-id",
		"abcde",
		"--role",
		"task_collaborator",
		"--reason",
		"验证共享设置",
		"--idempotency-key",
		"stable",
		...argumentsAfterCreate,
	]);
	return { create, preview, resolveWorkspace, createClient, error };
}
describe("侧会话 CLI 的显式 Plan 门禁", () => {
	it("缺参零副作用，在解析项目及建立客户端前明确报错", async () => {
		const result = await run([]);
		expect(String(result.error)).toContain("--start-in-plan-mode");
		expect(result.resolveWorkspace).not.toHaveBeenCalled();
		expect(result.createClient).not.toHaveBeenCalled();
		expect(result.create).not.toHaveBeenCalled();
	});
	it("显式 false、模型与权限保持独立，预览不调用创建", async () => {
		const result = await run([
			"--start-in-plan-mode",
			"false",
			"--model",
			"selected-model",
			"--task-agent-permission-mode",
			"bypass_all_permission_prompts",
			"--preview",
		]);
		expect(result.error).toBeUndefined();
		expect(result.create).not.toHaveBeenCalled();
		expect(result.preview).toHaveBeenCalledWith(
			expect.objectContaining({
				startInPlanMode: false,
				modelId: "selected-model",
				taskAgentPermissionMode: "bypass_all_permission_prompts",
			}),
		);
	});
});
