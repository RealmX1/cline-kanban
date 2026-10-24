// 手动按需运行的原生集成探针：隔离 HOME、真实 Kimi TUI、本地模拟模型，不消耗真实模型额度。
// 先按运行时的 esbuild ESM/CJS shim 设置打包，再以隔离环境运行；完整命令见 Kimi 接入指南。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { createNativeAgentConversationActivityObserver } from "../src/server/native-agent-conversation-activity-observer";
import { getKanbanManagedKimiCodeHome } from "../src/terminal/kimi-hook-config";
import { PtySession } from "../src/terminal/pty-session";
import { TerminalSessionManager } from "../src/terminal/session-manager";
import type {
	HostedTerminalPtyProcessSpawnRequest,
	TerminalPtyProcessHandle,
} from "../src/terminal/terminal-pty-process-handle";
import { parseTerminalSessionAdoptionRecord } from "../src/terminal/terminal-session-adoption-record-for-runtime-restart";

const outputDirectory = process.env.KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY;
const binary = process.env.KANBAN_KIMI_NATIVE_E2E_BINARY;
const startInPlanMode = process.env.KANBAN_KIMI_NATIVE_E2E_START_IN_PLAN_MODE === "1";
assert(outputDirectory && binary, "必须显式提供持久证据目录和 Kimi 二进制路径");
assert(resolve(homedir()).startsWith(`${resolve(outputDirectory)}/`), "HOME 必须隔离在证据目录内部");
assert(!process.env.KANBAN_HOOK_TASK_ID && !process.env.KANBAN_HOOK_WORKSPACE_ID, "探针不得继承真实任务 hook 身份");
await mkdir(outputDirectory, { recursive: true });
const cwd = join(outputDirectory, "isolated-agent-working-directory");
const emptySkills = join(outputDirectory, "empty-skills");
const home = getKanbanManagedKimiCodeHome();
await Promise.all([
	mkdir(cwd, { recursive: true }),
	mkdir(emptySkills, { recursive: true }),
	mkdir(home, { recursive: true }),
]);
const permissionProbeFixturePath = join(cwd, "permission-probe-fixture.txt");
const permissionProbeFixtureSentinel = "isolated-permission-probe-tool-output-sentinel";
await writeFile(permissionProbeFixturePath, `${permissionProbeFixtureSentinel}\n`);
const hookEventsPath = join(outputDirectory, "native-hook-events.jsonl");
await writeFile(hookEventsPath, "");
const hookScript = join(outputDirectory, "capture-native-hook.mjs");
await writeFile(
	hookScript,
	`import {appendFileSync} from 'node:fs'; let body=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>body+=s); process.stdin.on('end',()=>{appendFileSync(${JSON.stringify(hookEventsPath)},JSON.stringify({event:process.argv[2],time:Date.now(),payload:JSON.parse(body)})+'\\n');});`,
);
let modelRequests = 0;
let permissionProbeToolCallRequested = false;
let permissionProbeToolCallCompleted = false;
const mockModelRequestSchema = z.object({
	messages: z.array(
		z.object({ role: z.string(), tool_call_id: z.string().optional(), content: z.unknown().optional() }),
	),
});
const modelServer = createServer(async (request, response) => {
	const modelRequestBodyChunks: Buffer[] = [];
	for await (const chunk of request) modelRequestBodyChunks.push(Buffer.from(chunk));
	if (request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	modelRequests += 1;
	const requestBody = Buffer.concat(modelRequestBodyChunks).toString();
	const requestPermissionProbeToolCall =
		!permissionProbeToolCallRequested && requestBody.includes("isolated-bypass-permission-verification");
	if (requestPermissionProbeToolCall) permissionProbeToolCallRequested = true;
	const modelRequest = mockModelRequestSchema.parse(JSON.parse(requestBody));
	const permissionProbeToolResult = modelRequest.messages.find(
		(message) => message.role === "tool" && message.tool_call_id === "isolated-permission-probe-tool-call",
	);
	if (JSON.stringify(permissionProbeToolResult?.content)?.includes(permissionProbeFixtureSentinel)) {
		permissionProbeToolCallCompleted = true;
	}
	const content = Array.from(
		{ length: 75 },
		(_, index) => `kimi-real-response-${modelRequests}-line-${String(index).padStart(3, "0")}`,
	).join("\n");
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const messageDelta = requestPermissionProbeToolCall
		? {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "isolated-permission-probe-tool-call",
						type: "function",
						function: {
							name: "Bash",
							arguments: JSON.stringify({ command: "cat permission-probe-fixture.txt", cwd }),
						},
					},
				],
			}
		: { role: "assistant", content };
	for (const [delta, finishReason] of [
		[messageDelta, null],
		[{}, requestPermissionProbeToolCall ? "tool_calls" : "stop"],
	] as const) {
		response.write(
			`data: ${JSON.stringify({ id: `mock-${modelRequests}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "isolated-mock", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
		);
	}
	response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolveReady) => modelServer.listen(0, "127.0.0.1", resolveReady));
const address = modelServer.address();
assert(address && typeof address !== "string");
const quoteShell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
await writeFile(
	join(home, "config.toml"),
	`default_model = "isolated-mock"
merge_all_available_skills = false
builtin_product_skills = false
telemetry = false
auto_session_title = false
disable_feedback_survey = true
[providers.isolated]
type = "openai"
base_url = "http://127.0.0.1:${address.port}/v1"
api_key = "isolated-test-key"
[models.isolated-mock]
provider = "isolated"
model = "isolated-mock"
max_context_size = 32768
capabilities = []
${["SessionStart", "UserPromptSubmit", "Stop"].map((event) => `[[hooks]]\nevent = "${event}"\ncommand = ${JSON.stringify(`${quoteShell(process.execPath)} ${quoteShell(hookScript)} ${event}`)}\ntimeout = 5`).join("\n")}
`,
);
await writeFile(join(home, "tui.toml"), "[upgrade]\nauto_install = false\n");
const taskId = "isolated-kimi-native-e2e";
let spawnRequest: HostedTerminalPtyProcessSpawnRequest | null = null;
let adoptionRecord: unknown;
let handle: TerminalPtyProcessHandle;
const rawOutput: Buffer[] = [];
await writeFile(join(outputDirectory, "native-terminal-output.ansi"), "");
let outputSink: ((chunk: Buffer) => void) | null = null;
let exitSink: HostedTerminalPtyProcessSpawnRequest["onExit"] | null = null;
let manager = new TerminalSessionManager({
	hostedTerminalPtyProcessSpawner: {
		async spawnHostedTerminalPtyProcess(request) {
			spawnRequest = request;
			outputSink = request.onData;
			exitSink = request.onExit;
			const pty = PtySession.spawn({
				...request,
				onData: (data) => {
					rawOutput.push(Buffer.from(data));
					appendFileSync(join(outputDirectory, "native-terminal-output.ansi"), data);
					outputSink?.(Buffer.from(data));
				},
				onExit: (event) => exitSink?.(event),
			});
			handle = Object.assign(pty, {
				publishTerminalSessionAdoptionRecordForRuntimeRestart: (record: unknown) => {
					adoptionRecord = record;
				},
			});
			return handle;
		},
	},
});
const readCurrentSummary = () => manager.getSummary(taskId);
const observer = createNativeAgentConversationActivityObserver({
	onAccepted: (observation) => {
		assert(observation.runtimeSessionIncarnationId);
		assert(observation.eventId);
		manager.confirmAcceptedAgentConversationInput(taskId, {
			...observation,
			eventId: observation.eventId,
			runtimeSessionIncarnationId: observation.runtimeSessionIncarnationId,
		});
	},
});
let hookEventCount = 0;
let trustedOwnedFixtureDirectory = false;
async function pollNativeEvidence() {
	// 仅批准本探针刚创建的夹具目录，不改变产品中的 trust 策略。
	if (!trustedOwnedFixtureDirectory && Buffer.concat(rawOutput).toString().includes("Trust this folder?")) {
		trustedOwnedFixtureDirectory = true;
		handle.write("\r");
	}
	const events = (await readFile(hookEventsPath, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	for (const event of events.slice(hookEventCount)) {
		if (event.event === "SessionStart") {
			assert.equal(typeof event.payload.session_id, "string");
			manager.applyAgentNativeConversationSessionIdentity(taskId, {
				sourceAgentId: "kimi",
				nativeSessionId: event.payload.session_id,
				transcriptPath: null,
				observedAt: event.time,
			});
		}
		if (event.event === "Stop") manager.transitionToReview(taskId, "hook");
	}
	hookEventCount = events.length;
	const summary = readCurrentSummary();
	if (summary) await observer.observeTaskSessionSummary("isolated-workspace", summary, readCurrentSummary);
}
async function waitFor(label: string, predicate: () => Promise<boolean> | boolean) {
	const started = Date.now();
	while (Date.now() - started < 45_000) {
		if (readCurrentSummary()?.liveness === "exited")
			throw new Error(`Kimi 提前退出：${Buffer.concat(rawOutput).toString().slice(-2000)}`);
		await pollNativeEvidence();
		if (await predicate()) return;
		await delay(100);
	}
	throw new Error(`等待失败：${label}`);
}
const resizeResults: Array<{ cols: number; rows: number; markerOccurrences: number }> = [];
try {
	await manager.startTaskSession({
		taskId,
		agentId: "kimi",
		binary,
		// 探针固定本地模拟模型，跳过生产默认模型目录刷新。
		args: ["--model", "isolated-mock", "--skills-dir", emptySkills],
		cwd,
		prompt: "",
		startInPlanMode,
		taskAgentPermissionMode: "bypass_all_permission_prompts",
		cols: 90,
		rows: 14,
		env: { KIMI_CODE_HOME: home },
	});
	await waitFor("原生输入框就绪", () => Buffer.concat(rawOutput).toString().includes("No session yet"));
	await waitFor("Bypass 的原生状态栏显示 Never Ask", async () => {
		const snapshot = await manager.getRestoreSnapshot(taskId);
		return stripVTControlCharacters(snapshot?.snapshot ?? "").includes("Never Ask");
	});
	const startupSnapshot = await manager.getRestoreSnapshot(taskId);
	if (startInPlanMode) {
		assert(stripVTControlCharacters(startupSnapshot!.snapshot).includes("Never Ask plan"), "原生 Plan 起步必须保留");
	}
	await writeFile(join(outputDirectory, "native-permission-startup-snapshot.ansi"), startupSnapshot!.snapshot);
	await delay(500);
	for (let turn = 1; turn <= 2; turn += 1) {
		const prompt = `原生核验输入 ${turn}，请回复固定测试文本。`;
		manager.writeInput(taskId, Buffer.from(`\u001b[200~${prompt}\u001b[201~`));
		await delay(150);
		manager.writeInput(taskId, Buffer.from("\r"));
		assert.equal(readCurrentSummary()?.agentConversationPromptSubmissionAcceptance?.status, "pending");
		await waitFor(
			`第 ${turn} 次真实输入接受`,
			() => readCurrentSummary()?.agentConversationPromptSubmissionAcceptance?.status === "accepted",
		);
		await waitFor(
			`第 ${turn} 次模型响应与 Stop`,
			async () =>
				modelRequests >= turn && (await readFile(hookEventsPath, "utf8")).split('"event":"Stop"').length > turn,
		);
		await delay(250);
	}
	const deliveryOutcomes: Array<{ status: string; reason: string | null }> = [];
	manager.submitTaskChatInputWhenReady(taskId, "程序化核验输入，请回复固定测试文本。", {
		onDeliveryOutcome: (outcome) => deliveryOutcomes.push(outcome),
	});
	await waitFor("程序化输入获得正文、写前游标与身份关联的回执", () => deliveryOutcomes.length > 0);
	assert.equal(deliveryOutcomes[0]?.status, "delivered_and_submit_confirmed");
	await waitFor(
		"程序化输入的模型响应与 Stop",
		async () => modelRequests === 3 && (await readFile(hookEventsPath, "utf8")).split('"event":"Stop"').length === 4,
	);
	// 只读取本探针的普通夹具文件；Never Ask 不代表解除 harness 的静态拒绝规则。
	manager.submitTaskChatInputWhenReady(taskId, "isolated-bypass-permission-verification");
	await waitFor(
		"夹具工具在 Never Ask 下免人工授权完成回合",
		async () =>
			permissionProbeToolCallCompleted &&
			modelRequests === 5 &&
			(await readFile(hookEventsPath, "utf8")).split('"event":"Stop"').length === 5,
	);
	for (const [cols, rows] of [
		[84, 12],
		[100, 18],
		[90, 14],
	]) {
		const previousLength = rawOutput.length;
		manager.resize(taskId, cols, rows);
		await waitFor("原生 resize 重绘", () => rawOutput.length > previousLength);
		await delay(300);
		const snapshot = await manager.getRestoreSnapshot(taskId);
		const markerOccurrences = snapshot?.snapshot.split("kimi-real-response-1-line-000").length! - 1;
		assert.equal(markerOccurrences, 1, "原生重绘后第一条历史标记必须只有一份");
		resizeResults.push({ cols, rows, markerOccurrences });
	}
	assert(spawnRequest);
	const parsed = parseTerminalSessionAdoptionRecord(adoptionRecord);
	assert.equal(parsed.kind, "usable_adoption_record");
	if (parsed.kind !== "usable_adoption_record") throw new Error("接管记录不可用");
	const capturedSummary = readCurrentSummary();
	assert(capturedSummary);
	const oldManager = manager;
	manager = new TerminalSessionManager();
	manager.hydrateFromRecord({ [taskId]: capturedSummary }, new Set([taskId]));
	await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
		{
			taskId,
			hostedSessionKind: "task_agent_session",
			pid: capturedSummary.pid!,
			spawnedAtEpochMs: capturedSummary.startedAt!,
			cols: 90,
			rows: 14,
			exitedWhileRuntimeWasAbsent: false,
			terminalSessionAdoptionRecord: {
				...parsed.adoptionRecord,
				rederivationInputs: { ...parsed.adoptionRecord.rederivationInputs, suppressScrollbackErasure: true },
			},
			async adoptHostedTerminalPtyProcess(callbacks) {
				outputSink = callbacks.onData;
				exitSink = callbacks.onExit;
				for (const chunk of rawOutput) callbacks.onCatchUpOutput(chunk);
				return handle;
			},
			terminateHostedTerminalPtyProcessAfterRefusedAdoption() {
				handle.stop({ force: true });
			},
		},
	]);
	await delay(750);
	const restoredSnapshot = await manager.getRestoreSnapshot(taskId);
	assert.equal(restoredSnapshot?.snapshot.split("kimi-real-response-1-line-000").length! - 1, 1);
	await writeFile(join(outputDirectory, "terminal-restore-snapshot.ansi"), restoredSnapshot!.snapshot);
	await writeFile(join(outputDirectory, "native-terminal-output.ansi"), Buffer.concat(rawOutput));
	await writeFile(
		join(outputDirectory, "accepted-session-summary.json"),
		JSON.stringify(readCurrentSummary(), null, 2),
	);
	const result = {
		status: "passed",
		nodeVersion: process.version,
		kimiVersion: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(),
		modelRequests,
		nativePermissionMode: "Never Ask",
		startInPlanMode,
		permissionProbeToolCallCompletedWithoutHumanApproval: permissionProbeToolCallCompleted,
		deliveryOutcomes,
		acceptanceStatus: readCurrentSummary()?.agentConversationPromptSubmissionAcceptance?.status,
		resizeResults,
		adoptedOldSuppressionSetting: true,
		rawScrollbackClearCount: Buffer.concat(rawOutput).toString().split("\u001b[3J").length - 1,
	};
	await writeFile(join(outputDirectory, "result.json"), JSON.stringify(result, null, 2));
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	// 此 manager 的句柄已转交新 manager，先结束新 manager，再清理旧 manager 的监听和计时器。
	manager.stopTaskSession(taskId);
	oldManager.dispose();
} finally {
	await writeFile(join(outputDirectory, "native-terminal-output.ansi"), Buffer.concat(rawOutput));
	await writeFile(join(outputDirectory, "latest-session-summary.json"), JSON.stringify(readCurrentSummary(), null, 2));
	observer.dispose();
	manager.stopTaskSession(taskId);
	manager.dispose();
	modelServer.closeAllConnections();
	await new Promise<void>((resolveClosed) => modelServer.close(() => resolveClosed()));
}
