import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, expect, it, vi } from "vitest";
import { assessCodexConfigurationAutomaticProcessReplacement } from "../../src/codex-configuration-sync/codex-configuration-automatic-process-replacement-policy";
import { createCodexConfigurationSyncService } from "../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	closeCodexConfigurationSyncDatabase,
	readCodexConfigurationSyncStore,
} from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { withCodexAppServerRequestConnection } from "../../src/codex-native-session-protocol/codex-app-server-request-connection";
import type { CodexAppServerRequestPort } from "../../src/codex-native-session-protocol/codex-native-conversation-history";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(async () => {
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
});

it.skipIf(!process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY)(
	"真实 Codex 的显示模式续接保持请求前缀，范围撤回保留局部值",
	async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({
			fixtureRootDirectoryNamePrefix: "codex-display-mode-native-",
		});
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "display-mode-native" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离原生配置核验\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离原生核验仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const home = join(fixture.isolatedHomeDirectoryPath, ".codex");
		vi.stubEnv("CODEX_HOME", home);
		vi.stubEnv("CODEX_SQLITE_HOME", home);
		await mkdir(home);
		const requests: Record<string, unknown>[] = [];
		const model = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (!request.url?.includes("responses")) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end('{"data":[]}');
				return;
			}
			requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			const sequence = requests.length;
			const item = {
				type: "message",
				id: `message-${sequence}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "隔离本地模型回放完成", annotations: [] }],
			};
			const result = {
				id: `response-${sequence}`,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				status: "completed",
				output: [item],
				usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const event of [
				{ type: "response.created", response: { ...result, status: "in_progress", output: [] } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...item, status: "in_progress", content: [] },
				},
				{
					type: "response.content_part.added",
					item_id: item.id,
					output_index: 0,
					content_index: 0,
					part: { type: "output_text", text: "", annotations: [] },
				},
				{
					type: "response.output_text.delta",
					item_id: item.id,
					output_index: 0,
					content_index: 0,
					delta: "隔离本地模型回放完成",
				},
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: result },
			])
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
		await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
		test.onTestFinished(async () => {
			model.closeAllConnections();
			await new Promise<void>((done) => model.close(() => done()));
		});
		const address = model.address();
		if (!address || typeof address === "string") throw new Error("本地模型未分配端口。");
		const original = stringify({
			model: "gpt-5.4",
			model_provider: "isolated_display_mode",
			tui: { alternate_screen: "always" },
			check_for_update_on_startup: false,
			features: { memories: false },
			analytics: { enabled: false },
			feedback: { enabled: false },
			model_providers: {
				isolated_display_mode: {
					name: "本地隔离回放",
					base_url: `http://127.0.0.1:${address.port}/v1`,
					wire_api: "responses",
					requires_openai_auth: false,
					supports_websockets: false,
				},
			},
			projects: { [repository.repositoryPath]: { trust_level: "trusted" } },
		});
		await writeFile(join(home, "config.toml"), original);
		const first = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: home,
			workspaceId: "native-display-fixture",
			conversationSessionId: "native-display-session",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const sessions: Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }> = [];
		const service = createCodexConfigurationSyncService({
			getSessionSummary: (workspaceId, conversationSessionId) =>
				sessions.find(
					(session) => session.workspaceId === workspaceId && session.summary.taskId === conversationSessionId,
				)?.summary ?? null,
			listSessions: () => sessions,
			onUpdated: () => {},
		});
		test.onTestFinished(() => service.close());
		let nativeId = "";
		const summaryFor = (binding: typeof first, transcriptPath: string) =>
			runtimeTaskSessionSummarySchema.parse({
				taskId: "native-display-session",
				agentId: "codex",
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
				workspacePath: repository.repositoryPath,
				pid: 10,
				startedAt: binding.createdAt,
				updatedAt: Date.now(),
				lastOutputAt: null,
				reviewReason: "hook",
				exitCode: null,
				runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
				codexConfigurationWriterBinding: binding,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: nativeId,
					transcriptPath,
					observedAt: Date.now(),
				},
			});
		const runTurn = async (port: CodexAppServerRequestPort) => {
			await port.request("turn/start", {
				threadId: nativeId,
				input: [{ type: "text", text: "只回复本地回放结果。" }],
			});
			await vi.waitFor(
				async () => {
					const result = (await port.request("thread/read", { threadId: nativeId, includeTurns: true })) as {
						thread: { turns: Array<{ status: string }> };
					};
					expect(result.thread.turns.at(-1)?.status).toBe("completed");
				},
				{ timeout: 30_000, interval: 50 },
			);
		};
		const binary = process.env.KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY ?? "codex";
		const connect = (binding: typeof first, operation: (port: CodexAppServerRequestPort) => Promise<void>) =>
			withCodexAppServerRequestConnection(
				{
					binary,
					experimentalApi: true,
					workingDirectory: repository.repositoryPath,
					environment: fixture.createIsolatedChildProcessEnvironment(
						buildCodexConfigurationWriterEnvironment(binding),
					),
				},
				operation,
			);
		await connect(first, async (port) => {
			const response = (await port.request("thread/start", {
				cwd: repository.repositoryPath,
				approvalPolicy: "never",
				sandbox: "danger-full-access",
				persistExtendedHistory: true,
			})) as { thread: { id: string; path: string } };
			nativeId = response.thread.id;
			sessions.push({ workspaceId: "native-display-fixture", summary: summaryFor(first, response.thread.path) });
			await runTurn(port);
			const configuration = parse(await readFile(join(first.configurationHomeDirectoryPath, "config.toml"), "utf8"));
			configuration.tui = { alternate_screen: "never" };
			await writeFile(join(first.configurationHomeDirectoryPath, "config.toml"), stringify(configuration));
			await service.scan();
			const store = await readCodexConfigurationSyncStore();
			const writer = store.writers[first.writerId];
			expect(
				assessCodexConfigurationAutomaticProcessReplacement(
					writer,
					store.profiles[writer.codexConfigurationProfileId ?? ""],
				).allowed,
			).toBe(true);
		});
		const second = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: home,
			workspaceId: "native-display-fixture",
			conversationSessionId: "native-display-session",
			runtimeSessionIncarnationId: randomUUID(),
			previousBinding: first,
		});
		await connect(second, async (port) => {
			const response = (await port.request("thread/resume", {
				threadId: nativeId,
				cwd: repository.repositoryPath,
				approvalPolicy: "never",
				sandbox: "danger-full-access",
				persistExtendedHistory: true,
			})) as { thread: { id: string; path: string } };
			expect(response.thread.id).toBe(nativeId);
			sessions[0] = { workspaceId: "native-display-fixture", summary: summaryFor(second, response.thread.path) };
			const configuration = (await port.request("config/read", { includeLayers: false })) as {
				config: { tui: { alternate_screen: string } };
			};
			expect(configuration.config.tui.alternate_screen).toBe("never");
			await runTurn(port);
			expect(requests).toHaveLength(2);
			for (const field of ["model", "instructions", "tools", "reasoning", "prompt_cache_key"])
				expect(requests[1]?.[field]).toEqual(requests[0]?.[field]);
			const firstInput = requests[0]?.input as unknown[];
			expect((requests[1]?.input as unknown[]).slice(0, firstInput.length)).toEqual(firstInput);
			await service.scan();
			const change = (await service.getState()).changes.find(
				(entry) =>
					entry.sourceWriterId === first.writerId &&
					entry.fieldKey === JSON.stringify(["config.toml", "tui", "alternate_screen"]),
			);
			if (!change) throw new Error("未取得原生显示配置的共享记录。");
			await service.setChangeSharingScope({
				changeId: change.changeId,
				expectedVersion: change.version,
				targetScope: "session_only",
				idempotencyKey: randomUUID(),
			});
			const store = await readCodexConfigurationSyncStore();
			expect(
				store.profiles[second.codexConfigurationProfileId ?? ""].fields[
					JSON.stringify(["config.toml", "tui", "alternate_screen"])
				]?.value,
			).toBe("always");
			const third = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: home,
				workspaceId: "native-display-fixture",
				conversationSessionId: "native-display-session",
				runtimeSessionIncarnationId: randomUUID(),
				previousBinding: second,
			});
			expect(
				parse(await readFile(join(third.configurationHomeDirectoryPath, "config.toml"), "utf8")).tui,
			).toMatchObject({ alternate_screen: "never" });
		});
		expect(await readFile(join(home, "config.toml"), "utf8")).toBe(original);
		const evidenceDirectory = process.env.KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY;
		if (evidenceDirectory) {
			await mkdir(evidenceDirectory, { recursive: true });
			await writeFile(
				join(evidenceDirectory, "native-display-mode-result.json"),
				JSON.stringify(
					{
						passed: true,
						sameNativeSession: true,
						localModelResponseCount: requests.length,
						requestPrefixUnchanged: true,
						sourceConfigurationUnchanged: true,
						sessionOnlySurvivesContinuation: true,
					},
					null,
					2,
				),
			);
		}
	},
	90_000,
);
