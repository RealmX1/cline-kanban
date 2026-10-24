// 真实 Kimi + 打包后的 hook CLI + 真实 hooks API；所有状态、模拟模型和证据都隔离在指定目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { initTRPC } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { runtimeHookIngestRequestSchema, type RuntimeHookIngestRequest } from "../src/core/api-contract";
import { createNativeAgentConversationActivityObserver } from "../src/server/native-agent-conversation-activity-observer";
import { getKanbanManagedKimiCodeHome } from "../src/terminal/kimi-hook-config";
import { PtySession } from "../src/terminal/pty-session";
import { TerminalSessionManager } from "../src/terminal/session-manager";
import { parseTerminalSessionAdoptionRecord } from "../src/terminal/terminal-session-adoption-record-for-runtime-restart";
import type {
	HostedTerminalPtyProcessSpawnRequest,
	TerminalPtyProcessHandle,
} from "../src/terminal/terminal-pty-process-handle";
import { createHooksApi } from "../src/trpc/hooks-api";

function requireProbeEnvironmentVariable(name: string): string {
	const value = process.env[name];
	assert(value, `缺少原生探针环境变量：${name}`);
	return value;
}
const outputDirectory = requireProbeEnvironmentVariable("KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY");
const binary = requireProbeEnvironmentVariable("KANBAN_KIMI_NATIVE_E2E_BINARY");
const packagedCli = requireProbeEnvironmentVariable("KANBAN_KIMI_NATIVE_E2E_PACKAGED_CLI");
assert(resolve(homedir()).startsWith(`${resolve(outputDirectory)}/`), "HOME 必须隔离在证据目录内部");
assert(!process.env.KANBAN_HOOK_TASK_ID && !process.env.KANBAN_HOOK_WORKSPACE_ID, "禁止继承真实任务身份");
await access(packagedCli);
// 产品从当前 CLI 入口生成 hook 命令；探针显式使用本次构建，不回指探针自身或在线安装。
process.argv[1] = packagedCli;
await mkdir(outputDirectory, { recursive: true });
const workspaceId = "isolated-kimi-native-hook-workflow";
type Scene = {
	taskId: string;
	cwd: string;
	rawOutput: Buffer[];
	writes: string[];
	spawnRequest: HostedTerminalPtyProcessSpawnRequest | null;
	handle: TerminalPtyProcessHandle | null;
	adoptionRecord: unknown;
	onData: HostedTerminalPtyProcessSpawnRequest["onData"] | null;
	onExit: HostedTerminalPtyProcessSpawnRequest["onExit"] | null;
	modelRequests: number;
	modelRequestBodies: string[];
};
const scenes = new Map<string, Scene>();
const allManagers: TerminalSessionManager[] = [];
function createManager() {
	const created = new TerminalSessionManager({
		hostedTerminalPtyProcessSpawner: {
			async spawnHostedTerminalPtyProcess(request) {
				const scene = scenes.get(request.taskId);
				assert(scene);
				scene.spawnRequest = request;
				scene.onData = request.onData;
				scene.onExit = request.onExit;
				const pty = PtySession.spawn({
					...request,
					onData: (chunk) => {
						scene.rawOutput.push(Buffer.from(chunk));
						appendFileSync(join(outputDirectory, `${scene.taskId}.ansi`), chunk);
						scene.onData?.(Buffer.from(chunk));
					},
					onExit: (event) => scene.onExit?.(event),
				});
				scene.handle = {
					pid: pty.pid,
					write: (bytes) => {
						scene.writes.push(bytes.toString());
						pty.write(bytes);
					},
					resize: (...args) => pty.resize(...args),
					pause: () => pty.pause(),
					resume: () => pty.resume(),
					stop: (options) => pty.stop(options),
					hasExited: () => pty.hasExited(),
					wasInterrupted: () => pty.wasInterrupted(),
					publishTerminalSessionAdoptionRecordForRuntimeRestart: (record) => {
						scene.adoptionRecord = record;
					},
				};
				return scene.handle;
			},
		},
	});
	allManagers.push(created);
	return created;
}
let manager = createManager();
const hookRequests: RuntimeHookIngestRequest[] = [];
const hookApi = createHooksApi({
	getWorkspacePathById: () => outputDirectory,
	ensureTerminalManagerForWorkspace: async () => manager,
	persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: async () => "already_persisted_without_write",
	broadcastRuntimeWorkspaceStateUpdated: () => {},
	broadcastTaskReadyForReview: () => {},
	captureTaskTurnCheckpoint: async () => {
		throw new Error("隔离原生探针不操作 Git checkpoint");
	},
});
const trpc = initTRPC.create();
const router = trpc.router({
	hooks: trpc.router({
		ingest: trpc.procedure.input(runtimeHookIngestRequestSchema).mutation(async ({ input }) => {
			const result = await hookApi.ingest(input);
			hookRequests.push(input);
			appendFileSync(
				join(outputDirectory, "packaged-cli-hook-ingests.jsonl"),
				`${JSON.stringify({ input, result, summary: manager.getSummary(input.taskId) })}\n`,
			);
			return result;
		}),
	}),
});
const hookServer = createServer(createHTTPHandler({ basePath: "/api/trpc/", router }));
await new Promise<void>((ready) => hookServer.listen(0, "127.0.0.1", ready));
const hookAddress = hookServer.address();
assert(hookAddress && typeof hookAddress !== "string");
const hookPort = hookAddress.port;
let currentScene: Scene;
let responseMode: "complete" | "question" | "blocked_model" = "complete";
let questionIssued = false;
const blockedModelResponses = new Set<ServerResponse>();
const modelServer = createServer(async (request, response) => {
	const requestChunks: Buffer[] = [];
	for await (const chunk of request) requestChunks.push(Buffer.from(chunk));
	if (request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	currentScene.modelRequests += 1;
	// 完整正文只在内存中比对，不把模型上下文写入证据。
	currentScene.modelRequestBodies.push(Buffer.concat(requestChunks).toString("utf8"));
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	if (responseMode === "blocked_model") {
		blockedModelResponses.add(response);
		response.once("close", () => blockedModelResponses.delete(response));
		response.write(": 等待原生中断\n\n");
		return;
	}
	const asksQuestion = responseMode === "question" && !questionIssued;
	questionIssued ||= asksQuestion;
	// 2.3.1 的瞬时 Stop 会取消飞行中的异步 PostToolUse；保留真实模型延迟，观察答复后的 agent 态。
	// 后面的取消用例另验缺少 PostToolUse 时由 Stop 收口，不能把缺事件误写成已收到。
	if (responseMode === "question" && !asksQuestion) await delay(2_500);
	const delta = asksQuestion
		? {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "isolated-native-question-tool-call",
						type: "function",
						function: {
							name: "AskUserQuestion",
							arguments: JSON.stringify({
								questions: [
									{
										question: "请选择隔离核验答案？",
										header: "核验",
										multi_select: false,
										options: [
											{ label: "选项甲", description: "仅测试" },
											{ label: "选项乙", description: "仅测试" },
										],
									},
								],
							}),
						},
					},
				],
			}
		: { role: "assistant", content: "隔离原生工作流核验完成。" };
	for (const [chunk, finishReason] of [
		[delta, null],
		[{}, asksQuestion ? "tool_calls" : "stop"],
	]) {
		response.write(
			`data: ${JSON.stringify({ id: "isolated-response", object: "chat.completion.chunk", model: "isolated-model", choices: [{ index: 0, delta: chunk, finish_reason: finishReason }] })}\n\n`,
		);
	}
	response.end("data: [DONE]\n\n");
});
await new Promise<void>((ready) => modelServer.listen(0, "127.0.0.1", ready));
const modelAddress = modelServer.address();
assert(modelAddress && typeof modelAddress !== "string");
const globalKimiHome = join(homedir(), ".kimi-code");
const emptySkills = join(outputDirectory, "empty-skills");
await mkdir(globalKimiHome, { recursive: true });
await mkdir(emptySkills, { recursive: true });
await writeFile(join(globalKimiHome, "tui.toml"), "[upgrade]\nauto_install = false\n");
await writeFile(
	join(globalKimiHome, "config.toml"),
	`default_model = "isolated-model"
merge_all_available_skills = false
builtin_product_skills = false
telemetry = false
auto_session_title = false
disable_feedback_survey = true
[providers.isolated]
type = "openai"
base_url = "http://127.0.0.1:${modelAddress.port}/v1"
api_key = "isolated-test-key"
[models.isolated-model]
provider = "isolated"
model = "isolated-model"
max_context_size = 32768
capabilities = []
`,
);
const observer = createNativeAgentConversationActivityObserver({
	onAccepted: (observation) => {
		assert(observation.eventId && observation.runtimeSessionIncarnationId);
		manager.confirmAcceptedAgentConversationInput(observation.conversationSessionId, {
			...observation,
			eventId: observation.eventId,
			runtimeSessionIncarnationId: observation.runtimeSessionIncarnationId,
		});
	},
});
async function waitFor(label: string, predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 45_000;
	while (Date.now() < deadline) {
		const summary = manager.getSummary(currentScene.taskId);
		assert(summary?.liveness !== "exited", `Kimi 提前退出：${label}`);
		if (summary)
			await observer.observeTaskSessionSummary(workspaceId, summary, () => manager.getSummary(currentScene.taskId));
		if (await predicate()) return;
		await delay(100);
	}
	throw new Error(`等待失败：${label}`);
}
async function startScene(taskId: string, ownedWorktree: boolean, prompt: string, explicitYolo = false) {
	const cwd = ownedWorktree
		? join(homedir(), ".cline", "worktrees", taskId, "isolated-repository")
		: join(outputDirectory, taskId, "arbitrary-working-directory");
	await mkdir(cwd, { recursive: true });
	currentScene = {
		taskId,
		cwd,
		rawOutput: [],
		writes: [],
		spawnRequest: null,
		handle: null,
		adoptionRecord: null,
		onData: null,
		onExit: null,
		modelRequests: 0,
		modelRequestBodies: [],
	};
	scenes.set(taskId, currentScene);
	await writeFile(join(outputDirectory, `${taskId}.ansi`), "");
	await manager.startTaskSession({
		taskId,
		agentId: "kimi",
		binary,
		cwd,
		prompt,
		cols: 90,
		rows: 14,
		args: ["--model", "isolated-model", "--skills-dir", emptySkills, ...(explicitYolo ? ["--yolo"] : [])],
		taskAgentPermissionMode: "bypass_all_permission_prompts",
		autoContinueOnConnectionDropEnabled: false,
		workspaceId,
		env: { KIMI_CODE_HOME: globalKimiHome, KANBAN_RUNTIME_HOST: "127.0.0.1", KANBAN_RUNTIME_PORT: String(hookPort) },
	});
	return currentScene;
}
const results: Record<string, unknown> = {};
try {
	const startupMarker = "隔离延迟信任首条正文只应提交一次\n第二行保留中文、标点和原始换行。";
	const startup = await startScene("isolated-kimi-delayed-trust", false, startupMarker);
	await waitFor("显示原生信任提示", () =>
		Buffer.concat(startup.rawOutput).includes(Buffer.from("Trust this folder?")),
	);
	await delay(5_500);
	assert.equal(startup.modelRequests, 0);
	assert(!startup.writes.some((bytes) => bytes.includes(startupMarker)), "超时不能绕过信任模态写入正文");
	assert.equal(startup.spawnRequest?.env.KIMI_CODE_TRUST_WORKSPACE, undefined);
	const summaryBeforeAdoption = manager.getSummary(startup.taskId);
	assert(summaryBeforeAdoption?.pid && summaryBeforeAdoption.startedAt);
	assert.equal(parseTerminalSessionAdoptionRecord(startup.adoptionRecord).kind, "usable_adoption_record");
	manager = createManager();
	manager.hydrateFromRecord({ [startup.taskId]: summaryBeforeAdoption }, new Set([startup.taskId]));
	await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
		{
			taskId: startup.taskId,
			hostedSessionKind: "task_agent_session",
			pid: summaryBeforeAdoption.pid,
			spawnedAtEpochMs: summaryBeforeAdoption.startedAt,
			cols: 90,
			rows: 14,
			exitedWhileRuntimeWasAbsent: false,
			terminalSessionAdoptionRecord: startup.adoptionRecord,
			async adoptHostedTerminalPtyProcess(callbacks) {
				callbacks.onCatchUpOutput(Buffer.concat(startup.rawOutput));
				startup.onData = callbacks.onData;
				startup.onExit = callbacks.onExit;
				assert(startup.handle);
				return startup.handle;
			},
			terminateHostedTerminalPtyProcessAfterRefusedAdoption() {
				throw new Error("不应拒绝隔离 PTY 接管");
			},
		},
	]);
	await delay(700);
	assert.equal(startup.modelRequests, 0);
	assert(!startup.writes.some((bytes) => bytes.includes(startupMarker)));
	assert(startup.handle);
	manager.writeInput(startup.taskId, Buffer.from("\r"));
	await waitFor(
		"信任确认后首条正文被原生接受",
		() =>
			startup.modelRequests === 1 &&
			manager.getSummary(startup.taskId)?.agentConversationPromptSubmissionAcceptance?.status === "accepted",
	);
	await waitFor("首条回合结束", () => manager.getSummary(startup.taskId)?.userTurnKind === "review");
	const businessPromptWrites = startup.writes.filter((bytes) => bytes.includes(startupMarker));
	assert.equal(businessPromptWrites.length, 1);
	const startupPromptPaste = businessPromptWrites[0];
	assert(startupPromptPaste?.startsWith("\u001b[200~") && startupPromptPaste.endsWith("\u001b[201~"));
	const fullStartupPromptText = startupPromptPaste.slice("\u001b[200~".length, -"\u001b[201~".length);
	assert.equal(startup.modelRequestBodies.length, 1);
	assert(
		startup.modelRequestBodies[0]?.includes(JSON.stringify(fullStartupPromptText).slice(1, -1)),
		"原生模型请求必须包含完整首发正文，保留中文与换行",
	);
	results.delayedTrustAcrossAdoption = {
		delayMs: 5_500,
		modelRequests: startup.modelRequests,
		businessPromptWrites: 1,
		fullStartupPromptAcceptedByModel: true,
		confirmationInputEntry: "manager.writeInput",
		accepted: true,
	};
	manager.stopTaskSession(startup.taskId);

	const owned = await startScene("isolated-kimi-owned-worktree", true, "隔离托管工作树首条正文");
	await waitFor(
		"托管工作树自动信任并执行",
		() => owned.modelRequests === 1 && manager.getSummary(owned.taskId)?.userTurnKind === "review",
	);
	assert.equal(owned.spawnRequest?.env.KIMI_CODE_TRUST_WORKSPACE, "1");
	assert(owned.spawnRequest?.args.includes("--auto"));
	assert(!owned.spawnRequest?.args.includes("--yolo"));
	assert(!Buffer.concat(owned.rawOutput).includes(Buffer.from("Trust this folder?")));
	results.ownedWorktreeBypass = {
		args: owned.spawnRequest?.args,
		processTrust: "1",
		trustModalVisible: false,
		modelRequests: owned.modelRequests,
	};
	manager.stopTaskSession(owned.taskId);

	responseMode = "question";
	const question = await startScene("isolated-kimi-question-interrupt", true, "隔离原生提问核验", true);
	await waitFor(
		"前台问题由原生 hook 显示待答",
		() => manager.getSummary(question.taskId)?.userTurnKind === "question",
	);
	assert(!question.spawnRequest?.args.includes("--auto"));
	await delay(400);
	manager.writeInput(question.taskId, Buffer.from("\r"));
	await waitFor("原生问题的提交确认页", () =>
		Buffer.concat(question.rawOutput).includes(Buffer.from("Ready to submit your answers?")),
	);
	assert.equal(manager.getSummary(question.taskId)?.userTurnKind, "question");
	manager.writeInput(question.taskId, Buffer.from("\r"));
	await waitFor("原生答复完成", () =>
		hookRequests.some(
			(body) =>
				body.taskId === question.taskId &&
				body.metadata?.hookEventName === "PostToolUse" &&
				body.metadata.toolName === "AskUserQuestion",
		),
	);
	assert.equal(manager.getSummary(question.taskId)?.turnOwner, "agent");
	await waitFor("答复后回合结束", () => manager.getSummary(question.taskId)?.userTurnKind === "review");
	const questionToolEvents = hookRequests.filter(
		(body) => body.taskId === question.taskId && body.metadata?.toolName === "AskUserQuestion",
	);
	assert(questionToolEvents.length >= 2);
	assert(
		questionToolEvents.every(
			(body) => body.agentToolCallExecutionOutcome?.toolUseId === "isolated-native-question-tool-call",
		),
	);
	assert(questionToolEvents.every((body) => !body.agentRaisedUserQuestion));
	results.nativeQuestionAnswered = {
		nativeToolCallIdentityPreserved: true,
		unsafePanelQuestionCreated: false,
		eventCount: questionToolEvents.length,
	};

	questionIssued = false;
	manager.submitTaskChatInputWhenReady(question.taskId, "隔离原生取消提问核验");
	await waitFor("第二个前台问题", () => manager.getSummary(question.taskId)?.userTurnKind === "question");
	await delay(400);
	manager.writeInput(question.taskId, Buffer.from("\u001b"));
	await waitFor("取消问题不残留待答状态", () => manager.getSummary(question.taskId)?.userTurnKind === "review");
	results.nativeQuestionCancelled = { userTurnKind: manager.getSummary(question.taskId)?.userTurnKind };

	responseMode = "blocked_model";
	const previousRequestCount = question.modelRequests;
	manager.submitTaskChatInputWhenReady(question.taskId, "隔离原生中断核验");
	await waitFor("真实模型请求开始等待", () => question.modelRequests > previousRequestCount);
	await delay(400);
	manager.writeInput(question.taskId, Buffer.from("\u001b"));
	await waitFor("原生 Interrupt 收口", () => manager.getSummary(question.taskId)?.userTurnKind === "interrupted");
	assert(hookRequests.some((body) => body.taskId === question.taskId && body.metadata?.hookEventName === "Interrupt"));
	results.nativeInterrupt = { userTurnKind: manager.getSummary(question.taskId)?.userTurnKind };
	results.status = "passed";
	results.kimiVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
	results.packagedCli = packagedCli;
	results.hookHome = getKanbanManagedKimiCodeHome();
} finally {
	await writeFile(join(outputDirectory, "result.json"), JSON.stringify(results, null, 2));
	for (const scene of scenes.values()) {
		await writeFile(
			join(outputDirectory, `${scene.taskId}-summary.json`),
			JSON.stringify(manager.getSummary(scene.taskId), null, 2),
		);
		scene.handle?.stop({ force: true });
	}
	observer.dispose();
	for (const created of allManagers) created.dispose();
	for (const response of blockedModelResponses) response.end();
	for (const server of [modelServer, hookServer]) {
		server.closeAllConnections();
		await new Promise<void>((closed) => server.close(() => closed()));
	}
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
