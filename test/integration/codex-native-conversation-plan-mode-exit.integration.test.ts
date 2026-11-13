import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type IPty, spawn as spawnPty } from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/codex-native-session-protocol/codex-app-server-control-socket-request-connection";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import { exitCodexNativeConversationPlanMode } from "../../src/terminal/codex-native-conversation-plan-mode-exit";
import { TerminalStateMirror } from "../../src/terminal/terminal-state-mirror";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
const ptys = new Set<{ process: IPty; exited: Promise<void> }>();
async function stopTuis() {
	for (const pty of ptys) {
		pty.process.kill("SIGKILL");
		await pty.exited;
	}
	ptys.clear();
}
afterEach(async () => {
	await stopTuis();
	await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY || process.platform === "win32")(
	"真实恢复 TUI 的模式列表缺失时，退出接口保留草稿和权限，下一回合及重启后仍是 Default",
	async (test) => {
		vi.stubEnv("TMPDIR", "/tmp");
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kpm-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-plan-mode" });
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
		await mkdir(codexHome);
		const nativeSocketPath = join(fixture.fixtureRootDirectoryPath, "n");
		const proxySocketPath = join(fixture.fixtureRootDirectoryPath, "p");
		const modelRequests: string[] = [];
		const modelServer = createServer(async (request, response) => {
			if (request.method !== "POST") {
				response.end(JSON.stringify({ data: [] }));
				return;
			}
			let body = "";
			for await (const chunk of request) body += String(chunk);
			modelRequests.push(body);
			const index = modelRequests.length;
			const text = `隔离计划与答复 ${index}。`;
			const item = {
				id: `message_${index}`,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const result = {
				id: `response_${index}`,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				status: "completed",
				model: "gpt-5.4",
				output: [item],
				usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			for (const [type, fields] of [
				["response.created", { response: { ...result, status: "in_progress", output: [] } }],
				["response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } }],
				["response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text }],
				["response.output_item.done", { output_index: 0, item }],
				["response.completed", { response: result }],
			] as const)
				response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
			response.end();
		});
		test.onTestFinished(async () => {
			modelServer.closeAllConnections();
			await new Promise<void>((done) => modelServer.close(() => done()));
		});
		await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
		const address = modelServer.address();
		if (!address || typeof address === "string") throw new Error("隔离模型端口分配失败");
		await writeFile(
			join(codexHome, "config.toml"),
			`model="gpt-5.4"\nmodel_reasoning_effort="high"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
		);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		Object.assign(environment, { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome, TERM: "xterm-256color" });
		const binary = process.env.KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY ?? "codex";
		let stderr = "";
		let screenText = "";
		let lastNativeRequestMethod = "";
		const wait = (description: string, condition: () => boolean | Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: description,
					softDeadlineMsExpectedOnUncontendedHost: 8_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 35_000,
				},
				condition,
				{ describeLastObservedStateForFailureMessage: () => `${screenText}\n${stderr.slice(-2000)}` },
			);
		const startServer = async () => {
			await rm(nativeSocketPath, { force: true });
			const child = childProcesses.register(
				spawn(binary, ["app-server", "--listen", `unix://${nativeSocketPath}`], {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			await wait("原生控制端点创建", async () =>
				access(nativeSocketPath).then(
					() => true,
					() => false,
				),
			);
			return child;
		};
		let server = await startServer();
		const proxyHttpServer = createServer();
		const proxy = new WebSocketServer({ server: proxyHttpServer });
		let blockedCatalogRequestCount = 0;
		const tuiSubmittedTurns: unknown[] = [];
		const tuiResumedThreadIds: string[] = [];
		proxy.on("connection", (client) => {
			const upstream = new WebSocket(`ws+unix://${nativeSocketPath}:/`);
			const buffered: string[] = [];
			upstream.on("open", () => {
				for (const frame of buffered) upstream.send(frame);
				buffered.length = 0;
			});
			client.on("message", (data) => {
				const frame = JSON.parse(data.toString()) as { id?: number; method?: string; params?: unknown };
				if (frame.method === "collaborationMode/list") {
					blockedCatalogRequestCount += 1;
					client.send(JSON.stringify({ id: frame.id, result: { data: [] } }));
					return;
				}
				if (frame.method === "turn/start") tuiSubmittedTurns.push(frame.params);
				if (frame.method === "thread/resume")
					tuiResumedThreadIds.push(z.object({ threadId: z.string() }).parse(frame.params).threadId);
				if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
				else buffered.push(data.toString());
			});
			upstream.on("message", (data) => {
				const frame = JSON.parse(data.toString()) as { error?: { message?: string } };
				if (frame.error) stderr += `\n原生隔离错误：${frame.error.message ?? "无正文"}`;
				if (client.readyState === WebSocket.OPEN) client.send(data.toString());
			});
			upstream.on("error", () => client.close());
			upstream.on("close", () => client.close());
			client.on("close", () => upstream.close());
		});
		test.onTestFinished(async () => {
			for (const client of proxy.clients) client.terminate();
			await new Promise<void>((done) => proxy.close(() => done()));
			await new Promise<void>((done) => proxyHttpServer.close(() => done()));
		});
		await new Promise<void>((done) => proxyHttpServer.listen(proxySocketPath, done));
		const startTui = (nativeSessionId: string) => {
			const process = spawnPty(
				binary,
				["--remote", `unix://${proxySocketPath}`, "--no-alt-screen", "resume", nativeSessionId],
				{ cwd: repository.repositoryPath, env: environment as Record<string, string>, cols: 120, rows: 36 },
			);
			const mirror = new TerminalStateMirror(120, 36, { onInputResponse: (text) => process.write(text) });
			const exited = new Promise<void>((done) => process.onExit(() => done()));
			const ownedPty = { process, exited };
			ptys.add(ownedPty);
			process.onExit(() => ptys.delete(ownedPty));
			process.onData((text) => mirror.applyOutput(Buffer.from(text)));
			const readScreen = async () => {
				const screen = await mirror.getScreenSnapshot();
				screenText = screen.lines.map((line) => line.text.trimEnd()).join("\n");
				return screenText;
			};
			return { process, readScreen, mirror };
		};
		const settingsSchema = z.object({
			thread: z.object({ id: z.string(), status: z.object({ type: z.string() }) }),
			model: z.string(),
			reasoningEffort: z.string().nullable(),
			approvalPolicy: z.unknown(),
			sandbox: z.unknown(),
			collaborationMode: z.object({ mode: z.string() }),
		});
		let nativeSessionId = "";
		let previousSettings: z.infer<typeof settingsSchema> | null = null;
		const evidence: Record<string, unknown> = {};
		await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				const created = z.object({ thread: z.object({ id: z.string() }) }).parse(
					await port.request("thread/start", {
						cwd: repository.repositoryPath,
						approvalPolicy: "on-request",
						sandbox: "read-only",
						model: "gpt-5.4",
					}),
				);
				nativeSessionId = created.thread.id;
				const selectPlanMode = () =>
					port.request("thread/settings/update", {
						threadId: nativeSessionId,
						collaborationMode: {
							mode: "plan",
							settings: { model: "gpt-5.4", reasoning_effort: "high", developer_instructions: null },
						},
					});
				await selectPlanMode();
				await port.request("turn/start", {
					threadId: nativeSessionId,
					input: [{ type: "text", text: "隔离初始计划草稿", text_elements: [] }],
				});
				const readSettings = async () =>
					settingsSchema.parse(
						await port.request("thread/resume", { threadId: nativeSessionId, excludeTurns: true }),
					);
				await wait("原生初始计划回合结束", async () => {
					// 新线程的首条转录尚未刷盘时，原生 read 会暂时报 rollout is empty；只读补证，不重发回合。
					try {
						return (
							modelRequests.length > 0 &&
							z
								.object({ thread: z.object({ status: z.object({ type: z.string() }) }) })
								.parse(await port.request("thread/read", { threadId: nativeSessionId, includeTurns: false }))
								.thread.status.type === "idle"
						);
					} catch {
						return false;
					}
				});
				await wait("首回合完成后的原生设置可读", async () => {
					try {
						previousSettings = await readSettings();
						return (
							previousSettings.thread.status.type === "idle" &&
							previousSettings.collaborationMode.mode === "plan"
						);
					} catch {
						return false;
					}
				});
				if (!previousSettings) throw new Error("缺少初始计划模式设置");
				tuiSubmittedTurns.length = 0;
				const tui = startTui(nativeSessionId);
				await wait(
					"恢复 TUI 显示 Plan 且已取得空模式列表",
					async () => blockedCatalogRequestCount > 0 && /Plan mode/u.test(await tui.readScreen()),
				);
				tui.process.write("\u001b[Z");
				await delay(250);
				expect(await tui.readScreen()).toMatch(/Plan mode/u);
				// 原生提交会裁去整段末尾空白；用可见末尾标记核验各行换行及内部空格逐字保留。
				const draft = "恢复后的草稿  English  \n第二行中文😀    连续空格  \n末尾  END";
				tui.process.write(`\u001b[200~${draft}\u001b[201~`);
				await wait("未提交草稿进入原生输入框", async () => /末尾|Pasted Content/u.test(await tui.readScreen()));
				const summary = runtimeTaskSessionSummarySchema.parse({
					taskId: "isolated-conversation",
					agentId: "codex",
					workspacePath: repository.repositoryPath,
					pid: tui.process.pid,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: null,
					reviewReason: "hook",
					exitCode: null,
					turnOwner: "user",
					liveness: "live",
					userTurnKind: "review",
					runtimeSessionIncarnationId: randomUUID(),
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId,
						transcriptPath: null,
						observedAt: 1,
					},
				});
				summary.codexNativeSessionControlEndpoint = {
					socketPath: proxySocketPath,
					workspaceId: "isolated-workspace",
					conversationSessionId: summary.taskId,
					runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? "",
				};
				const exitPlanMode = () =>
					exitCodexNativeConversationPlanMode({
						workspaceId: "isolated-workspace",
						summary,
						getCurrentLiveSummary: () => summary,
					});
				const requestsBeforeExit = modelRequests.length;
				expect(await exitPlanMode()).toEqual({ status: "exited" });
				await wait("TUI 同步退出 Plan 模式", async () => !/Plan mode/u.test(await tui.readScreen()));
				expect(modelRequests).toHaveLength(requestsBeforeExit);
				expect(tuiSubmittedTurns).toHaveLength(0);
				const confirmed = await readSettings();
				for (const field of ["model", "reasoningEffort", "approvalPolicy", "sandbox"] as const)
					expect(confirmed[field]).toEqual(previousSettings[field]);
				evidence.screenAfterExit = screenText;
				tui.process.write("\r");
				await wait("草稿由原 TUI 提交为 Default 回合", () => tuiSubmittedTurns.length === 1);
				const submitted = z
					.object({
						threadId: z.string(),
						input: z.array(z.object({ type: z.string(), text: z.string() })),
						collaborationMode: z.object({ mode: z.string() }),
					})
					.parse(tuiSubmittedTurns[0]);
				expect(submitted.threadId).toBe(nativeSessionId);
				expect(submitted.collaborationMode.mode).toBe("default");
				expect(submitted.input.map((item) => item.text).join("")).toBe(draft);
				await wait(
					"草稿回合完成",
					async () =>
						modelRequests.length > requestsBeforeExit && (await readSettings()).thread.status.type === "idle",
				);
				await selectPlanMode();
				expect(await exitPlanMode()).toEqual({ status: "exited" });
				evidence.draftPreservedExactly = true;
				evidence.nextTuiTurnMode = submitted.collaborationMode.mode;
				await stopTuis();
				tui.mirror.dispose();
			},
			{
				socketPath: proxySocketPath,
				requestTimeoutMs: 20_000,
				onDiagnostic: (diagnostic) => {
					if (diagnostic.method) lastNativeRequestMethod = diagnostic.method;
				},
			},
		).catch((error: unknown) => {
			throw new Error(`原生隔离验证失败，最后请求 ${lastNativeRequestMethod}：${String(error)}\n${stderr}`);
		});
		expect(await sigkillChildProcessAndWaitForExit(server)).toBe(true);
		server = await startServer();
		const requestsBeforeRestart = modelRequests.length;
		const tuiResumeCountBeforeRestart = tuiResumedThreadIds.length;
		await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				const restored = settingsSchema.parse(
					await port.request("thread/resume", { threadId: nativeSessionId, excludeTurns: true }),
				);
				expect(restored.collaborationMode.mode).toBe("default");
				if (!previousSettings) throw new Error("缺少重启前的原生设置");
				for (const field of ["model", "reasoningEffort", "approvalPolicy", "sandbox"] as const)
					expect(restored[field]).toEqual(previousSettings[field]);
				const tui = startTui(nativeSessionId);
				await wait(
					"新一代 TUI 恢复同一会话",
					async () =>
						/gpt-5.4/u.test(await tui.readScreen()) &&
						tuiResumedThreadIds.length > tuiResumeCountBeforeRestart &&
						tuiResumedThreadIds.at(-1) === nativeSessionId,
				);
				expect(await tui.readScreen()).not.toMatch(/Plan mode/u);
				expect(modelRequests).toHaveLength(requestsBeforeRestart);
				evidence.modeAfterNativeHostRestartWithoutNewTurn = restored.collaborationMode.mode;
				evidence.blockedCatalogRequestCount = blockedCatalogRequestCount;
				evidence.modelRequestCount = modelRequests.length;
				evidence.screenAfterRestart = screenText;
				await stopTuis();
				tui.mirror.dispose();
			},
			{ socketPath: nativeSocketPath, requestTimeoutMs: 20_000 },
		);
		const evidenceDirectory = process.env.KANBAN_CODEX_PLAN_MODE_EXIT_EVIDENCE_DIRECTORY;
		if (evidenceDirectory) {
			await mkdir(evidenceDirectory, { recursive: true });
			await writeFile(
				join(evidenceDirectory, "native-plan-mode-exit-evidence.json"),
				JSON.stringify(evidence, null, 2),
			);
		}
	},
	240_000,
);
