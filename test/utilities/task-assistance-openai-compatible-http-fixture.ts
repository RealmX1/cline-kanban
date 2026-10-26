import { createServer } from "node:http";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import { saveTaskAssistanceModelProviderRoutingSettings } from "../../src/model-provider-access/kanban-model-provider-settings";

export interface TaskAssistanceHttpFixtureRequest {
	model: string;
	messages: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
	}>;
}
/** 真实本机 HTTP 边界；每个测试独立配置与端口，不接触外部模型或钥匙串。 */
export async function createTaskAssistanceOpenAiCompatibleHttpFixture(input: {
	isolatedHomeDirectoryPath: string;
	respond: (request: TaskAssistanceHttpFixtureRequest) => unknown;
}) {
	const requests: TaskAssistanceHttpFixtureRequest[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TaskAssistanceHttpFixtureRequest;
		requests.push(body);
		try {
			const result = input.respond(body);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					model: "fixture-resolved-model",
					choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
					usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
				}),
			);
		} catch {
			response.writeHead(500);
			response.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	onTestFinished(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("模型 fixture 未分配端口");
	vi.stubEnv(
		"KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT",
		join(input.isolatedHomeDirectoryPath, "model-provider-settings-fixture"),
	);
	vi.stubEnv("KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY", "");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY", "isolated-fixture-key");
	vi.stubEnv("KANBAN_MODEL_PROVIDER_DEEPSEEK_BASE_URL", `http://127.0.0.1:${address.port}`);
	vi.stubEnv("KANBAN_MODEL_PROVIDER_DEEPSEEK_MODEL_ID", "fixture-requested-model");
	await saveTaskAssistanceModelProviderRoutingSettings({
		preferredModelProviderId: "minimax",
		fallbackModelProviderId: "deepseek",
	});
	return { requests };
}

export function readTaskAssistanceHttpFixtureUserPrompt(request: TaskAssistanceHttpFixtureRequest): string {
	const content = request.messages.find((message) => message.role === "user")?.content;
	return typeof content === "string" ? content : (content?.find((part) => part.type === "text")?.text ?? "");
}
