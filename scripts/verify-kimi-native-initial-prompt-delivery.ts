// 真实 Kimi 首发回归：隔离 HOME、loopback 模型、完整正文核验，不调用真实账号或创建真实看板任务。
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeAgentConversationActivityObserver } from "../src/server/native-agent-conversation-activity-observer";
import { getKanbanManagedKimiCodeHome } from "../src/terminal/kimi-hook-config";
import { PtySession } from "../src/terminal/pty-session";
import { TerminalSessionManager } from "../src/terminal/session-manager";
import type { TerminalPtyProcessHandle } from "../src/terminal/terminal-pty-process-handle";
import { parseTerminalSessionAdoptionRecord } from "../src/terminal/terminal-session-adoption-record-for-runtime-restart";

const requestedOutputDirectory = process.env.KANBAN_KIMI_NATIVE_E2E_OUTPUT_DIRECTORY;
const binary = process.env.KANBAN_KIMI_NATIVE_E2E_BINARY;
assert(requestedOutputDirectory && binary, "必须显式提供证据目录与 Kimi 路径");
const outputDirectory = resolve(requestedOutputDirectory);
assert(resolve(homedir()).startsWith(`${outputDirectory}/`), "HOME 必须位于隔离证据目录");
assert(!process.env.KANBAN_HOOK_TASK_ID && !process.env.KANBAN_HOOK_WORKSPACE_ID, "不得继承真实任务身份");
const home = getKanbanManagedKimiCodeHome();
await mkdir(home, { recursive: true });
let modelRequests = 0;
const modelServer = createServer(async (request, response) => {
	for await (const _chunk of request) {
		/* 不保存模型请求上下文。 */
	}
	if (request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	modelRequests += 1;
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	response.write(
		`data: ${JSON.stringify({ id: "isolated-initial-prompt", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "已收到完整初始任务。" }, finish_reason: null }] })}\n\n`,
	);
	response.write(
		`data: ${JSON.stringify({ id: "isolated-initial-prompt", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
});
await new Promise<void>((resolveReady) => modelServer.listen(0, "127.0.0.1", resolveReady));
const address = modelServer.address();
assert(address && typeof address !== "string");

async function verifyInitialPromptScenario(managedWorktree: boolean, terminalColumns: number) {
	const startupScenarioKind = managedWorktree
		? "managed-worktree-automatic-startup"
		: "delayed-trust-and-runtime-adoption";
	const scenarioName = `${startupScenarioKind}-${terminalColumns}x24`;
	const scenarioDirectory = join(outputDirectory, scenarioName);
	const cwd = managedWorktree
		? join(homedir(), ".cline", "worktrees", "isolated-initial-prompt", "isolated-repository")
		: join(scenarioDirectory, "user-selected-working-directory");
	const emptySkills = join(scenarioDirectory, "empty-skills");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(emptySkills, { recursive: true })]);
	const hookEventsPath = join(scenarioDirectory, "native-hook-events.jsonl");
	const hookScript = join(scenarioDirectory, "capture-native-hook.mjs");
	await writeFile(hookEventsPath, "");
	await writeFile(
		hookScript,
		`import {appendFileSync} from 'node:fs';let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>body+=s);process.stdin.on('end',()=>appendFileSync(${JSON.stringify(hookEventsPath)},JSON.stringify({event:process.argv[2],time:Date.now(),payload:JSON.parse(body)})+'\\n'));`,
	);
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
	const taskId = `isolated-kimi-${scenarioName}`;
	const initialPromptText = `初始提示词唯一投递标记：${scenarioName}\n中文、多行和特殊字符 $ \\ < > 必须完整保留。`;
	const rawOutput: Buffer[] = [];
	const terminalWrites: Array<{ elapsedMs: number; bytes: number; includesInitialPrompt: boolean }> = [];
	const rawOutputPath = join(scenarioDirectory, "native-terminal-output.ansi");
	await writeFile(rawOutputPath, "");
	const startedAt = Date.now();
	let handle: TerminalPtyProcessHandle | undefined;
	let adoptionRecord: unknown;
	let outputSink: ((chunk: Buffer) => void) | undefined;
	let exitSink: ((event: { exitCode: number; signal: number | null }) => void) | undefined;
	let resolvePtyExit: (() => void) | undefined;
	const ptyExited = new Promise<void>((resolveExited) => {
		resolvePtyExit = resolveExited;
	});
	let spawnEnvironment: Record<string, string> | undefined;
	let manager = new TerminalSessionManager({
		hostedTerminalPtyProcessSpawner: {
			async spawnHostedTerminalPtyProcess(request) {
				spawnEnvironment = request.env;
				outputSink = request.onData;
				exitSink = request.onExit;
				const pty = PtySession.spawn({
					...request,
					onData: (chunk) => {
						rawOutput.push(Buffer.from(chunk));
						appendFileSync(rawOutputPath, chunk);
						outputSink?.(Buffer.from(chunk));
					},
					onExit: (event) => {
						exitSink?.(event);
						resolvePtyExit?.();
					},
				});
				const originalWrite = pty.write.bind(pty);
				pty.write = (text) => {
					terminalWrites.push({
						elapsedMs: Date.now() - startedAt,
						bytes: text.length,
						includesInitialPrompt: text.toString().includes(initialPromptText),
					});
					originalWrite(text);
				};
				handle = Object.assign(pty, {
					publishTerminalSessionAdoptionRecordForRuntimeRestart: (record: unknown) => {
						adoptionRecord = record;
					},
				});
				return handle;
			},
		},
	});
	let previousRuntimeManager: TerminalSessionManager | undefined;
	const observer = createNativeAgentConversationActivityObserver({
		onAccepted: (observation) => {
			assert(observation.eventId && observation.runtimeSessionIncarnationId);
			manager.confirmAcceptedAgentConversationInput(taskId, {
				...observation,
				eventId: observation.eventId,
				runtimeSessionIncarnationId: observation.runtimeSessionIncarnationId,
			});
		},
	});
	let hookEventCount = 0;
	async function observeNativeEvidence() {
		const events = (await readFile(hookEventsPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		for (const event of events.slice(hookEventCount)) {
			if (event.event === "SessionStart") {
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
		const summary = manager.getSummary(taskId);
		if (summary)
			await observer.observeTaskSessionSummary("isolated-workspace", summary, () => manager.getSummary(taskId));
	}
	async function waitFor(label: string, predicate: () => boolean) {
		const deadline = Date.now() + 45_000;
		while (Date.now() < deadline) {
			await observeNativeEvidence();
			if (manager.getSummary(taskId)?.liveness === "exited") throw new Error(`Kimi 提前退出：${label}`);
			if (predicate()) return;
			await delay(100);
		}
		throw new Error(`等待原生证据超时：${label}`);
	}
	const requestCountBeforeScenario = modelRequests;
	try {
		await manager.startTaskSession({
			taskId,
			agentId: "kimi",
			binary,
			args: ["--model", "isolated-mock", "--skills-dir", emptySkills],
			cwd,
			prompt: initialPromptText,
			cols: terminalColumns,
			rows: 24,
			startInPlanMode: true,
			taskAgentPermissionMode: "bypass_all_permission_prompts",
			env: { KIMI_CODE_HOME: home },
		});
		if (managedWorktree) {
			assert.equal(spawnEnvironment?.KIMI_CODE_TRUST_WORKSPACE, "1");
		} else {
			await waitFor("显示原生信任模态", () => Buffer.concat(rawOutput).includes(Buffer.from("Trust this folder?")));
			await delay(7_000);
			assert.equal(terminalWrites.filter((write) => write.includesInitialPrompt).length, 0);
			assert.equal(modelRequests, requestCountBeforeScenario);
			assert.equal(manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance, null);
			const summary = manager.getSummary(taskId);
			assert(summary?.pid && summary.startedAt && handle);
			assert.equal(parseTerminalSessionAdoptionRecord(adoptionRecord).kind, "usable_adoption_record");
			previousRuntimeManager = manager;
			manager = new TerminalSessionManager();
			manager.hydrateFromRecord({ [taskId]: summary }, new Set([taskId]));
			await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
				{
					taskId,
					hostedSessionKind: "task_agent_session",
					pid: summary.pid,
					spawnedAtEpochMs: summary.startedAt,
					cols: terminalColumns,
					rows: 24,
					exitedWhileRuntimeWasAbsent: false,
					terminalSessionAdoptionRecord: adoptionRecord,
					async adoptHostedTerminalPtyProcess(callbacks) {
						outputSink = callbacks.onData;
						exitSink = callbacks.onExit;
						for (const chunk of rawOutput) callbacks.onCatchUpOutput(chunk);
						assert(handle);
						return handle;
					},
					terminateHostedTerminalPtyProcessAfterRefusedAdoption() {
						handle?.stop({ force: true });
					},
				},
			]);
			assert.equal(terminalWrites.filter((write) => write.includesInitialPrompt).length, 0);
			manager.writeInput(taskId, Buffer.from("\r"));
			assert.equal(manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance, null);
		}
		await waitFor(
			"真实首条正文被原生接受并完成响应",
			() =>
				manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance?.status === "accepted" &&
				manager.getSummary(taskId)?.userTurnKind === "review" &&
				modelRequests > requestCountBeforeScenario,
		);
		await delay(750);
		assert.equal(modelRequests - requestCountBeforeScenario, 1);
		assert.equal(terminalWrites.filter((write) => write.includesInitialPrompt).length, 1);
		const summary = manager.getSummary(taskId);
		assert(summary);
		const sessionId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
		const sessionIndex = (await readFile(join(home, "session_index.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const indexEntry = sessionIndex.find((entry) => entry.sessionId === sessionId && entry.workDir === cwd);
		assert(indexEntry, "原生会话索引必须匹配本次会话与工作目录");
		const records = (await readFile(join(indexEntry.sessionDir, "agents/main/wire.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const realUserMessages = records.filter(
			(record) =>
				record.type === "context.append_message" &&
				record.agentId === "main" &&
				record.message?.role === "user" &&
				record.message.origin?.kind === "user",
		);
		assert.equal(realUserMessages.length, 1);
		assert(
			realUserMessages[0].message.content.some(
				(part: { type: string; text?: string }) => part.type === "text" && part.text?.includes(initialPromptText),
			),
			"原生用户消息须包含完整多行初始正文",
		);
		assert(
			records.some((record) => record.type === "plan_mode.enter"),
			"Plan 起步必须保留",
		);
		const snapshot = await manager.getRestoreSnapshot(taskId);
		assert(!Buffer.concat(rawOutput).includes(Buffer.from("Trust this folder?")) || !managedWorktree);
		await writeFile(join(scenarioDirectory, "terminal-restore-snapshot.ansi"), snapshot?.snapshot ?? "");
		const result = {
			status: "passed",
			scenarioName,
			terminalColumns,
			terminalRows: 24,
			modelRequests: modelRequests - requestCountBeforeScenario,
			realUserMessageCount: realUserMessages.length,
			promptWriteCount: terminalWrites.filter((write) => write.includesInitialPrompt).length,
			acceptance: summary.agentConversationPromptSubmissionAcceptance,
			planModePreserved: true,
			runtimeAdoptionVerified: !managedWorktree,
			terminalWrites,
		};
		await writeFile(join(scenarioDirectory, "result.json"), JSON.stringify(result, null, 2));
		return result;
	} finally {
		try {
			const snapshot = await manager.getRestoreSnapshot(taskId);
			await writeFile(join(scenarioDirectory, "latest-terminal-snapshot.ansi"), snapshot?.snapshot ?? "");
			await writeFile(
				join(scenarioDirectory, "terminal-writes.json"),
				JSON.stringify({ terminalWrites, modelRequests: modelRequests - requestCountBeforeScenario }, null, 2),
			);
			await writeFile(
				join(scenarioDirectory, "latest-session-summary.json"),
				JSON.stringify(manager.getSummary(taskId), null, 2),
			);
		} finally {
			observer.dispose();
			manager.stopTaskSession(taskId, { force: true });
			manager.dispose();
			previousRuntimeManager?.dispose();
			if (handle) {
				let exitTimeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						ptyExited,
						new Promise<never>((_resolve, reject) => {
							exitTimeout = setTimeout(() => reject(new Error("隔离 Kimi 进程未退出")), 5_000);
						}),
					]);
				} finally {
					clearTimeout(exitTimeout);
				}
			}
		}
	}
}

try {
	const scenarios = [];
	for (const terminalColumns of [30, 104]) {
		for (const managedWorktree of [true, false])
			scenarios.push(await verifyInitialPromptScenario(managedWorktree, terminalColumns));
	}
	const result = { status: "passed", scenarios };
	await writeFile(join(outputDirectory, "result.json"), JSON.stringify(result, null, 2));
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
	modelServer.closeAllConnections();
	await new Promise<void>((resolveClosed) => modelServer.close(() => resolveClosed()));
}
