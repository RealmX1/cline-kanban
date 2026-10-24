import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { type RuntimeTaskSessionSummary, runtimeBoardDataSchema } from "../../src/core/api-contract";
import { resolveSessionFacets } from "../../src/core/session-activity";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_RVF_SESSION_DELIVERY_PACKAGED_CLI_PATH;
const nativeCodexBinary = process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY;
const rvfRepository = process.env.KANBAN_RVF_BOUNDARY_CONSUMER_REPOSITORY;
const evidenceRoot = process.env.KANBAN_RVF_SESSION_DELIVERY_EVIDENCE_DIRECTORY;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

function shellArgument(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

it.skipIf(!packagedCliPath || !nativeCodexBinary || !rvfRepository)(
	"真实 RVF Stop 经打包 CLI 投递到独立主会话，原生 user message 与 UPS 正文各一次",
	async () => {
		if (!packagedCliPath || !nativeCodexBinary || !rvfRepository) throw new Error("缺少隔离原生联调参数");
		if (evidenceRoot) mkdirSync(evidenceRoot, { recursive: true });
		// 仅 socket 用短临时路径；交付证据在 finally 复制到指定持久目录。
		vi.stubEnv("TMPDIR", "/tmp");
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "rvf-delivery-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "project" });
		writeFileSync(join(repository.repositoryPath, "implementation.txt"), "初始实现\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离测试",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
		const rvfHome = join(fixture.fixtureRootDirectoryPath, "rvf-state");
		mkdirSync(codexHome, { recursive: true });
		const scripts = join(rvfRepository, "plugins/review-validate-fix/skills/review-validate-fix/scripts");
		const modelRequests: string[] = [];
		const modelServer = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			if (request.method !== "POST") {
				response.end(JSON.stringify({ data: [] }));
				return;
			}
			modelRequests.push(Buffer.concat(chunks).toString("utf8"));
			const n = modelRequests.length;
			const text = `隔离模型回复 ${n}`;
			const message = {
				id: `msg_${n}`,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const result = {
				id: `resp_${n}`,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				status: "completed",
				model: "gpt-5.4",
				output: [message],
				usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
			};
			const events = [
				["response.created", { response: { ...result, status: "in_progress", output: [] } }],
				[
					"response.output_item.added",
					{ output_index: 0, item: { ...message, status: "in_progress", content: [] } },
				],
				[
					"response.content_part.added",
					{
						item_id: message.id,
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					},
				],
				["response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: text }],
				["response.output_text.done", { item_id: message.id, output_index: 0, content_index: 0, text }],
				["response.output_item.done", { output_index: 0, item: message }],
				["response.completed", { response: result }],
			] as const;
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const [type, payload] of events)
				response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
			response.end();
		});
		modelServer.listen(0, "127.0.0.1");
		await once(modelServer, "listening");
		const modelAddress = modelServer.address();
		if (!modelAddress || typeof modelAddress === "string") throw new Error("隔离模型端口缺失");
		writeFileSync(
			join(codexHome, "config.toml"),
			`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${modelAddress.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
		);
		writeFileSync(
			join(codexHome, "hooks.json"),
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{
							hooks: [
								{
									type: "command",
									command: `python3 ${shellArgument(join(scripts, "rvf_user_prompt_submit.py"))}`,
									timeout: 30,
								},
							],
						},
					],
				},
			}),
		);
		const taskId = "rvf01";
		const sessionId = "task-conversation-session-isolated-main";
		await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: runtimeBoardDataSchema.parse({
				columns: [
					{
						id: "in_progress",
						title: "进行中",
						cards: [
							{
								id: taskId,
								title: "隔离主会话",
								prompt: "仅回复测试就绪",
								agentId: "codex",
								startInPlanMode: false,
								taskAgentPermissionMode: "bypass_all_permission_prompts",
								worktreeMode: "inplace",
								baseRef: "main",
								mainTaskConversationSessionId: sessionId,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			}),
			sessions: {},
		});
		const workspace = await loadWorkspaceContext(repository.repositoryPath, { autoCreateIfMissing: false });
		const portReservation = createServer();
		portReservation.listen(0, "127.0.0.1");
		await once(portReservation, "listening");
		const address = portReservation.address();
		if (!address || typeof address === "string") throw new Error("隔离 runtime 端口缺失");
		const port = address.port;
		await new Promise<void>((done) => portReservation.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(nativeCodexBinary)}:${dirname(process.execPath)}:/usr/bin:/bin`,
			CODEX_HOME: codexHome,
			RVF_HOME: rvfHome,
			CODEX_RVF_STATE_DIR: join(rvfHome, "run-logs"),
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_RVF_CLINE_KANBAN_TASK_CMD: `${shellArgument(process.execPath)} ${shellArgument(packagedCliPath)} task`,
			CODEX_SESSION_INDEX_PATH: join(rvfHome, "empty-session-index.jsonl"),
			PYTHONDONTWRITEBYTECODE: "1",
		});
		const runtime = children.register(
			spawn(
				process.execPath,
				[
					"--require",
					resolve("test/integration/shutdown-ipc-hook.cjs"),
					packagedCliPath,
					"--port",
					String(port),
					"--no-open",
					"--no-passcode",
				],
				{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
			),
		);
		let runtimeOutput = "";
		runtime.stdout?.on("data", (chunk) => {
			runtimeOutput += String(chunk);
		});
		runtime.stderr?.on("data", (chunk) => {
			runtimeOutput += String(chunk);
		});
		const api = createTRPCProxyClient<RuntimeAppRouter>({
			links: [
				httpLink({
					url: `http://127.0.0.1:${port}/api/trpc`,
					headers: { "x-kanban-workspace-id": workspace.workspaceId },
				}),
			],
		});
		const sockets: WebSocket[] = [];
		let terminalOutput = "";
		let stopOutput = "";
		const driverActions: string[] = [];
		async function runChild(binary: string, args: string[], input?: string) {
			const child = children.register(
				spawn(binary, args, { cwd: repository.repositoryPath, env: environment, stdio: ["pipe", "pipe", "pipe"] }),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			child.stdin?.end(input);
			expect(await waitForChildProcessExit(child, 45_000), stderr).toBe(true);
			expect(child.exitCode, `${stdout}\n${stderr}`).toBe(0);
			return stdout;
		}
		try {
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
			const started = await api.runtime.startTaskSession.mutate({
				taskId: sessionId,
				workspaceTaskId: taskId,
				agentId: "codex",
				prompt: "仅回复测试就绪",
				baseRef: "main",
				worktreeMode: "inplace",
				startInPlanMode: false,
				cols: 140,
				rows: 42,
				taskConversationSessionMetadata: {
					workspaceTaskId: taskId,
					taskConversationSessionRole: "main",
					taskConversationSessionRoleAtCreation: "task_collaborator",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				},
			});
			expect(started.ok, started.error).toBe(true);
			const query = `taskId=${sessionId}&workspaceId=${workspace.workspaceId}&clientId=isolated-rvf-test`;
			const io = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/io?${query}`);
			const control = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/control?${query}`);
			sockets.push(io, control);
			let hooksTrustSelectionAt = 0;
			let hooksTrustConfirmed = false;
			io.on("message", (chunk: Buffer) => {
				terminalOutput += chunk.toString("utf8");
				if (control.readyState === WebSocket.OPEN)
					control.send(JSON.stringify({ type: "output_ack", bytes: chunk.byteLength }));
				if (chunk.includes(Buffer.from("\x1b[6n"))) io.send("\x1b[1;1R");
				if (chunk.includes(Buffer.from("\x1b[c"))) io.send("\x1b[?1;2c");
			});
			control.on("message", (chunk: Buffer) => {
				const message = JSON.parse(chunk.toString("utf8"));
				if (message.type === "restore") {
					terminalOutput += message.snapshot ?? "";
					control.send(JSON.stringify({ type: "restore_complete" }));
				}
			});
			let summary: RuntimeTaskSessionSummary | undefined;
			await vi.waitFor(
				async () => {
					// 选择与确认分开发送，避免启动时的原生终端能力探测吞掉同一批字节。
					if (
						!modelRequests.length &&
						terminalOutput.includes("new or changed.") &&
						io.readyState === WebSocket.OPEN
					) {
						if (!hooksTrustSelectionAt) {
							io.send("2");
							hooksTrustSelectionAt = Date.now();
							driverActions.push("选择信任隔离 hook");
						} else if (!hooksTrustConfirmed && Date.now() - hooksTrustSelectionAt >= 500) {
							io.send("\r");
							hooksTrustConfirmed = true;
							driverActions.push("确认信任隔离 hook");
						}
					}
					summary = (await api.workspace.getState.query()).sessions[sessionId];
					expect(modelRequests.length, terminalOutput.slice(-1200)).toBeGreaterThan(0);
					expect(summary?.agentNativeConversationSessionIdentity?.nativeSessionId).toBeTruthy();
					expect(resolveSessionFacets(summary).turnOwner).toBe("user");
				},
				{ timeout: 60_000, interval: 250 },
			);
			const nativeId = summary?.agentNativeConversationSessionIdentity?.nativeSessionId;
			const transcript = summary?.agentNativeConversationSessionIdentity?.transcriptPath;
			if (!nativeId || !transcript) throw new Error("真实原生身份或转录缺失");
			Object.assign(environment, {
				KANBAN_TASK_ID: taskId,
				KANBAN_ATTEMPT_ID: sessionId,
				KANBAN_PROJECT_PATH: repository.repositoryPath,
			});
			writeFileSync(join(repository.repositoryPath, "implementation.txt"), "待审实现\n");
			stopOutput = await runChild(
				"python3",
				[join(scripts, "stop_review_validate_fix.py")],
				JSON.stringify({
					cwd: repository.repositoryPath,
					session_id: nativeId,
					transcript_path: transcript,
					stop_hook_active: false,
					last_user_message: "实现完成，请停下。",
				}),
			);
			const tokenDirectory = join(rvfHome, "agentic-initiation-decision-tokens");
			let token = "";
			await vi.waitFor(
				() => {
					token =
						readdirSync(tokenDirectory)
							.find((name) => /^[0-9a-f]{16}\.json$/u.test(name))
							?.slice(0, -5) ?? "";
					expect(token, stopOutput).toBeTruthy();
					expect(
						JSON.parse(readFileSync(join(tokenDirectory, `${token}.json`), "utf8")).state,
						terminalOutput.slice(-1500),
					).toBe("injected");
				},
				{ timeout: 60_000, interval: 250 },
			);
			const tokenRecord = JSON.parse(readFileSync(join(tokenDirectory, `${token}.json`), "utf8"));
			const key = `rvf-decision-point-${token}`;
			// UPS 先观测到原生消息，终端确认 observer 随后才镜像账本；二者不是同步提交。
			await vi.waitFor(
				() => {
					const records = JSON.parse(
						readFileSync(join(workspace.statePath, "task-message-injections.json"), "utf8"),
					) as { idempotency_key: string; terminal_delivery_status: string }[];
					expect(records.find((record) => record.idempotency_key === key)?.terminal_delivery_status).toBe(
						"delivered_and_submit_confirmed",
					);
				},
				{ timeout: 20_000, interval: 250 },
			);
			const receipt = JSON.parse(
				await runChild(process.execPath, [
					packagedCliPath,
					"task",
					"message-status",
					"--project-path",
					repository.repositoryPath,
					"--task-id",
					taskId,
					"--idempotency-key",
					key,
				]),
			);
			expect(receipt).toMatchObject({
				task_id: taskId,
				attempt_id: sessionId,
				terminal_delivery_status: "delivered_and_submit_confirmed",
				codex_native_prompt_delivery_evidence: {
					clientUserMessageId: expect.any(String),
					nativeSessionId: nativeId,
					nativeTurnId: expect.any(String),
					nativeUserMessageId: expect.any(String),
				},
			});
			const nativeUserMessages = () =>
				readFileSync(transcript, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
					.filter(
						(entry) =>
							entry.type === "response_item" &&
							entry.payload?.type === "message" &&
							entry.payload?.role === "user",
					);
			expect(
				nativeUserMessages().filter((entry) => JSON.stringify(entry).includes(`RVF_DECISION_TOKEN=${token}`)),
			).toHaveLength(1);
			const bannerFirstLine = "=== REVIEW-VALIDATE-FIX 发起决策点：由你自主决定 start 或 decline ===";
			await vi.waitFor(() => expect(modelRequests.some((body) => body.includes(bannerFirstLine))).toBe(true), {
				timeout: 10_000,
			});
			const deliveredRequest = modelRequests.find((body) => body.includes(bannerFirstLine));
			expect(deliveredRequest?.split(bannerFirstLine)).toHaveLength(2);
			const marker = await runChild("python3", [
				"-c",
				"import sys;sys.path.insert(0,sys.argv[1]);import rvf_decision_token_store as store;sys.stdout.write(store.render_decision_point_out_of_band_boundary_marker(token=sys.argv[2]))",
				scripts,
				token,
			]);
			const duplicate = JSON.parse(
				await runChild(process.execPath, [
					packagedCliPath,
					"task",
					"message",
					"--project-path",
					repository.repositoryPath,
					"--task-id",
					taskId,
					"--attempt-id",
					sessionId,
					"--prompt",
					marker,
					"--source",
					"review-validate-fix",
					"--idempotency-key",
					key,
					"--deliver-when-agent-idle",
					"--max-wait-for-agent-idle-ms",
					"600000",
					"--require-native-independent-user-turn-for-session",
					nativeId,
				]),
			);
			expect(duplicate).toMatchObject({
				task_id: taskId,
				attempt_id: sessionId,
				terminal_delivery_status: "delivered_and_submit_confirmed",
			});
			expect(duplicate.codex_native_prompt_delivery_evidence).toEqual(receipt.codex_native_prompt_delivery_evidence);
			expect(
				nativeUserMessages().filter((entry) => JSON.stringify(entry).includes(`RVF_DECISION_TOKEN=${token}`)),
			).toHaveLength(1);
			if (evidenceRoot)
				writeFileSync(
					join(evidenceRoot, "native-delivery-result.json"),
					JSON.stringify(
						{
							taskId,
							sessionId,
							nativeId,
							receipt,
							duplicate,
							tokenRecord,
							nativeUserMessages: nativeUserMessages(),
						},
						null,
						2,
					),
				);
		} finally {
			for (const socket of sockets) socket.terminate();
			await api.runtime.stopTaskSession.mutate({ taskId }).catch(() => undefined);
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			await new Promise<void>((done) => modelServer.close(() => done()));
			if (evidenceRoot) {
				mkdirSync(evidenceRoot, { recursive: true });
				writeFileSync(join(evidenceRoot, "runtime.log"), runtimeOutput);
				writeFileSync(join(evidenceRoot, "native-terminal.log"), terminalOutput);
				writeFileSync(join(evidenceRoot, "rvf-stop-output.json"), stopOutput);
				writeFileSync(join(evidenceRoot, "test-driver-actions.json"), JSON.stringify(driverActions));
				writeFileSync(join(evidenceRoot, "isolated-model-requests.json"), JSON.stringify(modelRequests, null, 2));
				for (const [source, destination] of [
					[rvfHome, "rvf-state"],
					[join(codexHome, "sessions"), "native-sessions"],
					[workspace.statePath, "kanban-workspace"],
				])
					if (existsSync(source)) cpSync(source, join(evidenceRoot, destination), { recursive: true });
			}
		}
	},
	180_000,
);
