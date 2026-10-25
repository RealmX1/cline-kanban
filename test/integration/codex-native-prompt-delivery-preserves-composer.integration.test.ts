import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { WebSocketServer } from "ws";
import { prepareCodexNativeSessionControlHostLaunch } from "../../src/codex-native-session-control-host/prepare-codex-native-session-control-host-launch";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";
import { createCodexNativePromptDeliveryJournal } from "../../src/core/codex-native-prompt-delivery-journal";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} from "../../src/core/task-message-injection-ledger";
import { withRunningCodexAppServerControlSocketConnection } from "../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import { deliverCodexNativePromptWithoutChangingComposer } from "../../src/terminal/codex-native-prompt-delivery";
import { type TaskChatInputDeliveryOutcome, TerminalSessionManager } from "../../src/terminal/session-manager";
import {
	createTerminalInputBoxOccupancyTrackerState,
	recordTerminalInputBytesIntoOccupancyTracker,
} from "../../src/terminal/terminal-input-box-occupancy";
import { TerminalStateMirror } from "../../src/terminal/terminal-state-mirror";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === "win32").each(["human_draft_edit", "question", "permission"] as const)(
	"原生请求已接受但读回在途时发生 %s，仍只读确认并保留四个身份 ID",
	async (intervention) => {
		// socket 临时路径必须短于 macOS 的 Unix socket 上限；不读取用户配置或生产会话。
		const directory = await mkdtemp("/tmp/kanban-native-confirmation-");
		const socketPath = join(directory, "s");
		const server = createServer();
		const controlSockets = new WebSocketServer({ server });
		const incarnationId = randomUUID();
		const prompt = "原生注入\n保留真人草稿😀  \n";
		const draft = "真人尚未提交的草稿😀  ";
		const manualDraftEdit = Buffer.from("继续编辑😀");
		const tracker = createTerminalInputBoxOccupancyTrackerState();
		recordTerminalInputBytesIntoOccupancyTracker(tracker, Buffer.from(draft), 1);
		const write = vi.fn();
		const manager = new TerminalSessionManager();
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "confirmation-conversation",
			agentId: "codex",
			workspacePath: directory,
			pid: 123,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			state: "awaiting_review",
			reviewReason: "hook",
			exitCode: null,
			runtimeSessionIncarnationId: incarnationId,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "confirmation-thread",
				transcriptPath: null,
				observedAt: 1,
			},
			codexNativeSessionControlEndpoint: {
				socketPath,
				workspaceId: "confirmation-workspace",
				conversationSessionId: "confirmation-conversation",
				runtimeSessionIncarnationId: incarnationId,
			},
		});
		const active = {
			session: { write },
			inputBoxOccupancyTracker: tracker,
			lastUserInputAt: null,
			deferredStartupPromptText: null,
			taskChatInputDeliveryTimer: null as NodeJS.Timeout | null,
			taskChatInputDeliveryGeneration: 0,
			submitConfirmTimer: null,
			submitConfirmGeneration: 0,
			programmaticDeliveryReceipt: null,
			outputReactionScanBuffer: null,
			outputReactionEngine: null,
			outputReactionSession: null,
			ptyOutputChunkArrivalSequenceNumber: 0,
			awaitingCodexPromptAfterEnter: false,
			suppressSubstantiveOutputUntilContinues: false,
			terminalSessionIncarnationToken: incarnationId,
		};
		(manager as unknown as { entries: Map<string, unknown> }).entries.set(summary.taskId, {
			summary,
			active,
			listeners: new Map(),
			restartRequest: { kind: "task", request: { workspaceId: "confirmation-workspace" } },
			terminalStateMirror: {
				getScreenSnapshot: async () => ({
					columnCount: 80,
					cursorRow: 0,
					cursorColumn: draft.length + 2,
					lines: [{ text: `› ${draft}`, isWrapped: false, dimmedTextColumnRanges: [] }],
				}),
				getViewportSnapshot: async () => ({ snapshot: `› ${draft}`, rows: 24, cols: 80 }),
			},
		});
		let releaseNativeAcceptance: (() => void) | undefined;
		let submittedClientMessageId: string | undefined;
		const turnStartRequests: unknown[] = [];
		onTestFinished(async () => {
			active.taskChatInputDeliveryGeneration += 1;
			if (active.taskChatInputDeliveryTimer) clearTimeout(active.taskChatInputDeliveryTimer);
			releaseNativeAcceptance?.();
			for (const socket of controlSockets.clients) socket.terminate();
			await new Promise<void>((done) => controlSockets.close(() => done()));
			await new Promise<void>((done) => server.close(() => done()));
			await rm(directory, { recursive: true, force: true });
		});
		controlSockets.on("connection", (socket) => {
			socket.on("message", (bytes) => {
				const request = JSON.parse(bytes.toString()) as {
					id?: number;
					method: string;
					params?: { clientUserMessageId: string };
				};
				if (!request.id) return;
				const respond = (result: unknown) => socket.send(JSON.stringify({ id: request.id, result }));
				if (request.method === "initialize") respond({});
				else if (request.method === "thread/loaded/list")
					respond({ data: ["confirmation-thread"], nextCursor: null });
				else if (request.method === "thread/read")
					respond({ thread: { id: "confirmation-thread", cwd: directory } });
				else if (request.method === "turn/start") {
					turnStartRequests.push(request.params);
					submittedClientMessageId = request.params?.clientUserMessageId;
					respond({ turn: { id: "confirmation-turn" } });
				} else if (request.method === "thread/turns/list") {
					if (!submittedClientMessageId) respond({ data: [], nextCursor: null });
					else
						releaseNativeAcceptance = () =>
							respond({
								data: [
									{
										id: "confirmation-turn",
										status: "inProgress",
										items: [
											{
												id: "confirmation-user-message",
												type: "userMessage",
												content: [{ type: "text", text: prompt }],
											},
										],
									},
								],
								nextCursor: null,
							});
				}
			});
		});
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(socketPath, done);
		});
		const outcomes: TaskChatInputDeliveryOutcome[] = [];
		manager.submitTaskChatInputWhenReady(summary.taskId, prompt, {
			idempotencyKey: "native-confirmation",
			deferWhileUserTurn: true,
			onDeliveryOutcome: (outcome) => outcomes.push(outcome),
		});
		await vi.waitFor(() => expect(releaseNativeAcceptance).toBeTypeOf("function"), { timeout: 10_000 });
		expect(outcomes).toEqual([]);
		if (intervention === "human_draft_edit") manager.writeInput(summary.taskId, manualDraftEdit);
		else {
			manager.transitionToRunning(summary.taskId);
			expect(manager.transitionToReview(summary.taskId, "hook", intervention)?.userTurnKind).toBe(intervention);
		}
		expect(outcomes).toEqual([]);
		expect(manager.cancelTaskChatInputDelivery(summary.taskId, "native-confirmation")).toBe("already_delivered");
		releaseNativeAcceptance?.();
		await vi.waitFor(() =>
			expect(outcomes).toEqual([
				{
					status: "delivered_and_submit_confirmed",
					reason: null,
					codexNativePromptDeliveryEvidence: {
						clientUserMessageId: submittedClientMessageId,
						nativeSessionId: "confirmation-thread",
						nativeTurnId: "confirmation-turn",
						nativeUserMessageId: "confirmation-user-message",
					},
				},
			]),
		);
		expect(submittedClientMessageId).toBeTypeOf("string");
		expect(turnStartRequests).toEqual([
			{
				threadId: "confirmation-thread",
				turnTrigger: "user",
				clientUserMessageId: submittedClientMessageId,
				input: [{ type: "text", text: prompt, text_elements: [] }],
			},
		]);
		expect(write.mock.calls).toEqual(intervention === "human_draft_edit" ? [[manualDraftEdit]] : []);
		expect(tracker.hasUncommittedInputFromInputSideByteTracking).toBe(true);
	},
);

it.skipIf(!process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY || process.platform === "win32")(
	"真实 Codex 注入保留草稿、Ctrl+G 与 Plan 模式，提问和审批仍由原 TUI 接收",
	async (test) => {
		vi.stubEnv("TMPDIR", "/tmp");
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "kcp-native-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "native-delivery" });
		await writeFile(join(repository.repositoryPath, "fixture.txt"), "隔离初始文件\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离初始提交",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const codexHome = join(fixture.fixtureRootDirectoryPath, "codex-home");
		await mkdir(codexHome);
		const observedHooksPath = join(codexHome, "observed-hooks.jsonl");
		const observedEditorPath = join(codexHome, "observed-editor.jsonl");
		const hookPath = join(codexHome, "observe-hooks.cjs");
		const editorPath = join(codexHome, "user-configured-editor.cjs");
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		await writeFile(
			hookPath,
			`const fs=require("node:fs");let raw="";process.stdin.on("data",s=>raw+=s);process.stdin.on("end",()=>fs.appendFileSync(${JSON.stringify(observedHooksPath)},raw.trim()+"\\n"));`,
		);
		await writeFile(
			editorPath,
			`const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(observedEditorPath)},JSON.stringify({text:fs.readFileSync(process.argv.at(-1),"utf8")})+"\\n");`,
		);
		await writeFile(
			join(codexHome, "hooks.json"),
			JSON.stringify({
				hooks: Object.fromEntries(
					["UserPromptSubmit", "Stop"].map((event) => [
						event,
						[{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookPath)}` }] }],
					]),
				),
			}),
		);
		const modelRequests: string[] = [];
		const approvalOutputPath = join(fixture.fixtureRootDirectoryPath, "approved-command-output.txt");
		const modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			if (request.method !== "POST") {
				response.end(JSON.stringify({ data: [] }));
				return;
			}
			modelRequests.push(body);
			const number = modelRequests.length;
			const parsed = JSON.parse(body) as {
				input?: {
					type?: string;
					role?: string;
					content?: { text?: string }[];
					call_id?: string;
					output?: string;
				}[];
			};
			const lastPrompt = parsed.input
				?.filter((item) => item.role === "user")
				.at(-1)
				?.content?.map((part) => part.text ?? "")
				.join("");
			const interactiveCallId = lastPrompt === "NATIVE_INJECTION_KEEP_DRAFT" ? "native_question" : "native_approval";
			const needsInteractiveTool =
				lastPrompt?.startsWith("NATIVE_INJECTION_") &&
				!parsed.input?.some((item) => item.type === "function_call_output" && item.call_id === interactiveCallId);
			const text = `NATIVE_DELIVERY_REPLY_${number}`;
			const message = {
				id: `message_${number}`,
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			};
			const item = needsInteractiveTool
				? {
						id: `tool_${number}`,
						type: "function_call",
						status: "completed",
						call_id: interactiveCallId,
						name: interactiveCallId === "native_question" ? "request_user_input" : "exec_command",
						arguments: JSON.stringify(
							interactiveCallId === "native_question"
								? {
										questions: [
											{
												id: "native_delivery_choice",
												header: "选择",
												question: "NATIVE_DELIVERY_CHOICE 请保留草稿",
												options: [
													{ label: "保留草稿", description: "保留当前未提交的文字。" },
													{ label: "稍后再答", description: "稍后继续这次选择。" },
												],
											},
										],
									}
								: {
										cmd: `printf NATIVE_APPROVAL_SUCCEEDED > ${quote(approvalOutputPath)}`,
										sandbox_permissions: "require_escalated",
										justification: "NATIVE_DELIVERY_APPROVAL 仅写隔离测试文件",
										max_output_tokens: 100,
									},
						),
					}
				: message;
			const result = {
				id: `response_${number}`,
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
				["response.output_text.delta", { item_id: message.id, output_index: 0, content_index: 0, delta: text }],
				["response.output_item.done", { output_index: 0, item }],
				["response.completed", { response: result }],
			] as const)
				response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
			response.end();
		});
		test.onTestFinished(async () => {
			if (modelServer.listening) {
				modelServer.closeAllConnections();
				await new Promise<void>((done) => modelServer.close(() => done()));
			}
		});
		await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
		const address = modelServer.address();
		if (!address || typeof address === "string") throw new Error("隔离模型端口分配失败");
		await writeFile(
			join(codexHome, "config.toml"),
			`model="gpt-5.4"\nmodel_provider="isolated_loopback"\ncheck_for_update_on_startup=false\n[features]\nhooks=true\n[model_providers.isolated_loopback]\nname="隔离回环模型"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[projects.${JSON.stringify(repository.repositoryPath)}]\ntrust_level="trusted"\n`,
		);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|RVF_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/u.test(key)) delete environment[key];
		Object.assign(environment, {
			CODEX_HOME: codexHome,
			TERM: "xterm-256color",
			VISUAL: `${quote(process.execPath)} ${quote(editorPath)}`,
			EDITOR: `${quote(process.execPath)} ${quote(editorPath)}`,
		});
		const runtimeSessionIncarnationId = randomUUID();
		const launch = await prepareCodexNativeSessionControlHostLaunch({
			binary: process.env.KANBAN_CODEX_NATIVE_RVF_CLOSEOUT_SMOKE_BINARY ?? "codex",
			arguments: [
				"--dangerously-bypass-hook-trust",
				"--no-alt-screen",
				"-a",
				"on-request",
				"-s",
				"read-only",
				"-C",
				repository.repositoryPath,
				"NATIVE_INITIAL_PROMPT",
			],
			workingDirectoryPath: repository.repositoryPath,
			environment,
			workspaceId: "isolated-workspace",
			conversationSessionId: "isolated-conversation",
			runtimeSessionIncarnationId,
		});
		if (!launch) throw new Error("本机 Codex 不支持原生控制宿主");
		test.onTestFinished(launch.cleanup);
		const pty = spawnPty(launch.binary, launch.args, {
			cwd: repository.repositoryPath,
			env: environment as Record<string, string>,
			cols: 120,
			rows: 36,
		});
		const terminalStateMirror = new TerminalStateMirror(120, 36);
		let output = "";
		let lastObservedCurrentScreenText = "";
		const readCurrentScreen = async () => {
			const screen = await terminalStateMirror.getScreenSnapshot();
			lastObservedCurrentScreenText = screen.lines.map((line) => line.text.trimEnd()).join("\n");
			return screen;
		};
		let exited = false;
		const exit = new Promise<void>((done) =>
			pty.onExit(() => {
				exited = true;
				done();
			}),
		);
		pty.onData((text) => {
			output += text;
			terminalStateMirror.applyOutput(Buffer.from(text));
			if (text.includes("\u001b[6n")) pty.write("\u001b[1;1R");
			if (text.includes("\u001b[c")) pty.write("\u001b[?1;2c");
		});
		const wait = (description: string, condition: () => Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: description,
					softDeadlineMsExpectedOnUncontendedHost: 8_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 35_000,
				},
				async () => {
					if (exited) throw new Error(`隔离 Codex 提前退出：${output.slice(-1500)}`);
					return condition();
				},
				{ describeLastObservedStateForFailureMessage: () => lastObservedCurrentScreenText || output.slice(-3000) },
			);
		const hooks = async () =>
			(await readFile(observedHooksPath, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							hook_event_name: string;
							session_id: string;
							prompt?: string;
						},
				);
		try {
			await wait("隔离初始回合完成", async () => (await hooks()).some((event) => event.hook_event_name === "Stop"));
			const nativeSessionId = (await hooks())[0]?.session_id;
			if (!nativeSessionId) throw new Error("缺少隔离原生会话身份");
			await wait("初始 TUI 回到可输入状态", async () => output.includes("state=done:app=codex"));
			// 初始回合结束后，由用户正常切换模式；投递本身不得替换当前模式或权限。
			pty.write("/plan");
			await wait("当前 TUI 输入框已完整接收 plan 命令", async () => {
				const screen = await readCurrentScreen();
				return screen.cursorRow !== undefined && screen.lines[screen.cursorRow]?.text.trim() === "› /plan";
			});
			pty.write("\r");
			// 命令候选本身就含有「switch to Plan mode」，不能用历史输出证明模式已经生效。
			// 只认当前屏幕底部的状态栏，原生发送后的模型请求还会独立验证实际模式。
			await wait("当前 TUI 状态栏确认 Plan 模式已生效", async () => {
				const screen = await readCurrentScreen();
				const footer =
					screen.lines
						.map((line) => line.text.trim())
						.filter(Boolean)
						.at(-1) ?? "";
				return /\bPlan mode\b/u.test(footer) && !/^\s*›/u.test(footer);
			});
			const draft = `HUMAN_UNSENT_DRAFT\n${"中文😀 保留空格  ".repeat(190)}\n末尾  `;
			pty.write(`\u001b[200~${draft}\u001b[201~`);
			await wait("当前 TUI 输入框已接收完整未提交草稿", async () => {
				const screen = await readCurrentScreen();
				return (
					screen.cursorRow !== undefined &&
					screen.lines[screen.cursorRow]?.text.includes(`[Pasted Content ${Array.from(draft).length} chars]`) ===
						true
				);
			});
			const prompt = "NATIVE_INJECTION_KEEP_DRAFT";
			const ledgerPath = getTaskMessageInjectionLedgerPath(
				join(fixture.fixtureRootDirectoryPath, "native-delivery-ledger"),
			);
			const ledgerBinding = {
				ledgerPath,
				ledgerTaskId: "isolated-card",
				idempotencyKey: "isolated-native-injection",
			};
			await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
				records: [
					createPendingTaskMessageInjectionRecord({
						taskId: "isolated-card",
						attemptId: "isolated-conversation",
						source: "rvf",
						idempotencyKey: ledgerBinding.idempotencyKey,
						promptSha256: createHash("sha256").update(prompt).digest("hex"),
						nowIso: new Date().toISOString(),
					}),
				],
				result: undefined,
			}));
			const summary = runtimeTaskSessionSummarySchema.parse({
				taskId: "isolated-conversation",
				agentId: "codex",
				workspacePath: repository.repositoryPath,
				pid: pty.pid,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				state: "awaiting_review",
				reviewReason: "hook",
				exitCode: null,
				runtimeSessionIncarnationId,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId,
					transcriptPath: null,
					observedAt: 1,
				},
				codexNativeSessionControlEndpoint: launch.endpoint,
			});
			const result = await deliverCodexNativePromptWithoutChangingComposer({
				summary,
				workspaceId: "isolated-workspace",
				text: prompt,
				clientUserMessageId: randomUUID(),
				deliveryJournal: createCodexNativePromptDeliveryJournal(ledgerBinding),
				isCurrent: () => !exited,
				beforeSubmit: async () => true,
				onRequestAttempted: () => {},
			});
			expect(result.status).toBe("confirmed");
			await wait("原有 TUI 收到注入回合的用户提问", async () => output.includes("NATIVE_DELIVERY_CHOICE"));
			expect((await hooks()).filter((event) => event.hook_event_name === "Stop")).toHaveLength(1);
			pty.write("\r");
			await wait(
				"回答用户提问后原生注入回合完成",
				async () => (await hooks()).filter((event) => event.hook_event_name === "Stop").length >= 2,
			);
			const recovered = await deliverCodexNativePromptWithoutChangingComposer({
				summary,
				workspaceId: "isolated-workspace",
				text: prompt,
				clientUserMessageId: randomUUID(),
				deliveryJournal: createCodexNativePromptDeliveryJournal(ledgerBinding),
				reconcileAcceptanceOnly: true,
				isCurrent: () => !exited,
				beforeSubmit: async () => false,
				onRequestAttempted: () => {
					throw new Error("重建投递器后只能补证");
				},
			});
			expect(recovered.status).toBe("confirmed");
			expect(
				(await readTaskMessageInjectionLedger(ledgerPath))[0]?.codex_native_prompt_delivery_operation
					?.actualSendAttemptCount,
			).toBe(1);
			const injectionRequest = modelRequests.find((body) => body.includes(prompt));
			expect(injectionRequest).toBeDefined();
			expect(injectionRequest).toMatch(/plan mode/iu);
			expect(modelRequests.every((body) => !body.includes("HUMAN_UNSENT_DRAFT"))).toBe(true);
			expect(
				(await hooks()).filter((event) => event.hook_event_name === "UserPromptSubmit" && event.prompt === prompt),
			).toHaveLength(1);
			expect(
				modelRequests.some((body) => body.includes("native_delivery_choice") && body.includes("保留草稿")),
			).toBe(true);
			await withRunningCodexAppServerControlSocketConnection(
				async (port) => {
					const page = (await port.request("thread/turns/list", {
						threadId: nativeSessionId,
						limit: 10,
						sortDirection: "desc",
						itemsView: "full",
					})) as { data: { items: { type: string; content?: { text?: string }[] }[] }[] };
					expect(
						page.data
							.flatMap((turn) => turn.items)
							.filter(
								(item) =>
									item.type === "userMessage" &&
									item.content?.map((part) => part.text ?? "").join("") === prompt,
							),
					).toHaveLength(1);
				},
				{ socketPath: launch.endpoint.socketPath },
			);
			const approvalResult = await deliverCodexNativePromptWithoutChangingComposer({
				summary,
				workspaceId: "isolated-workspace",
				text: "NATIVE_INJECTION_REQUIRE_APPROVAL",
				clientUserMessageId: randomUUID(),
				isCurrent: () => !exited,
				beforeSubmit: async () => true,
				onRequestAttempted: () => {},
			});
			expect(approvalResult.status).toBe("confirmed");
			await wait("原有 TUI 收到注入回合的权限确认", async () => output.includes("NATIVE_DELIVERY_APPROVAL"));
			expect(await stat(approvalOutputPath).catch(() => null)).toBeNull();
			expect((await hooks()).filter((event) => event.hook_event_name === "Stop")).toHaveLength(2);
			pty.write("\r");
			await wait(
				"用户批准后隔离命令执行成功",
				async () => (await readFile(approvalOutputPath, "utf8").catch(() => "")) === "NATIVE_APPROVAL_SUCCEEDED",
			);
			await wait(
				"审批后的原生回合完成",
				async () => (await hooks()).filter((event) => event.hook_event_name === "Stop").length >= 3,
			);
			expect(modelRequests.every((body) => !body.includes("HUMAN_UNSENT_DRAFT"))).toBe(true);
			pty.write("\u0007");
			await wait(
				"手动 Ctrl+G 调用用户配置的外部编辑器",
				async () => !!(await readFile(observedEditorPath, "utf8").catch(() => "")),
			);
			const edits = (await readFile(observedEditorPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { text: string });
			expect(edits).toEqual([{ text: draft }]);
		} finally {
			if (!exited) pty.kill("SIGTERM");
			const escalation = setTimeout(() => {
				if (!exited) pty.kill("SIGKILL");
			}, 3_000);
			try {
				await exit;
			} finally {
				clearTimeout(escalation);
			}
			await launch.cleanup();
			terminalStateMirror.dispose();
			modelServer.closeAllConnections();
			await new Promise<void>((done) => modelServer.close(() => done()));
		}
	},
	180_000,
);
