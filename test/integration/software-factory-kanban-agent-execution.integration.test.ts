import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeTaskConversationSessionCreateRequest } from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

// 独立仓库集成只在明确提供 Factory 源码与 Python 时启用，不隐式读取另一份 checkout。
const factorySourceDirectory = process.env.KANBAN_SOFTWARE_FACTORY_SOURCE_DIRECTORY;
const pythonExecutable = process.env.KANBAN_SOFTWARE_FACTORY_PYTHON_EXECUTABLE;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

interface FactoryExecution {
	agentExecutionRequestId: string;
	executionInputDigest: string;
	kanbanSessionCreateRequest: RuntimeTaskConversationSessionCreateRequest;
	providerHandle: unknown;
	resultEvidence: unknown;
}

interface FactoryRun {
	runId: string;
	stageAttemptId: string;
	stopReason: string | null;
	agentExecutions?: FactoryExecution[];
}

interface FactoryResponse {
	ok: boolean;
	currentRun: FactoryRun;
	error?: { code: string; message: string };
}

interface AgentTrace {
	kind: string;
	sessionId: string;
	nativeSessionId?: string;
	text?: string;
	pid?: number;
}

const commandExitDeadline = {
	waitedForDescription: "隔离 Factory/Kanban CLI 子进程退出",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};

it.skipIf(!factorySourceDirectory || !pythonExecutable)(
	"真实 Kanban runtime 承接 Factory 派发、遗失 handle 对账、原会话接续及精确取消",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 90_000,
			cliChildProcessSpawns: {
				cliChildProcessSpawnCount: 18,
				cliChildProcessExitTwoTierDeadline: commandExitDeadline,
			},
		}),
	},
	async (testContext) => {
		if (
			!factorySourceDirectory ||
			!pythonExecutable ||
			!isAbsolute(factorySourceDirectory) ||
			!isAbsolute(pythonExecutable)
		)
			throw new Error("需要明确指定 Factory 源码和 Python 的绝对路径");
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "factory-kanban-e2e-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "factory-engineering-project" });
		writeFileSync(join(repository.repositoryPath, "README.md"), "Factory 与真实 Kanban runtime 隔离验收\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化 Factory Provider 隔离项目",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const sourceDirectory = resolve(import.meta.dirname, "../..");
		const cliEntryPoint = join(sourceDirectory, "src/cli.ts");
		const tsxLoader = join(sourceDirectory, "node_modules/tsx/dist/loader.mjs");
		const sourceCliArguments = ["--import", tsxLoader, cliEntryPoint];
		const factoryCli = join(
			factorySourceDirectory,
			"plugins/software-factory/skills/software-factory-research-workflow/scripts/run_software_factory.py",
		);
		const evidenceDirectory =
			process.env.KANBAN_SOFTWARE_FACTORY_EVIDENCE_DIRECTORY ?? fixture.fixtureRootDirectoryPath;
		mkdirSync(evidenceDirectory, { recursive: true });
		const artifactDirectory = join(fixture.fixtureRootDirectoryPath, "factory-research-artifacts");
		mkdirSync(artifactDirectory);
		const questionFile = join(artifactDirectory, "research-question.md");
		writeFileSync(questionFile, "核验原派发未知时复用真实执行，重启后读取原结果。\n");
		const database = join(fixture.fixtureRootDirectoryPath, "factory-research-workflows.sqlite3");
		const agentTraceFile = join(fixture.fixtureRootDirectoryPath, "simulated-agent-native-protocol-trace.jsonl");
		const resultControlFile = join(fixture.fixtureRootDirectoryPath, "simulated-agent-result-controls.json");
		writeFileSync(agentTraceFile, "");
		writeFileSync(resultControlFile, "[]");
		const binaryDirectory = join(fixture.fixtureRootDirectoryPath, "simulated-agent-binaries");
		mkdirSync(binaryDirectory);
		const fakeAgentFile = join(binaryDirectory, "omp");
		writeFileSync(
			fakeAgentFile,
			String.raw`#!${process.execPath}
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('omp 2.1.200\n'); process.exit(0); }
if (args.includes('--mode') && args.includes('rpc')) {
 require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'get_state') process.stdout.write(JSON.stringify({id:command.id,type:'response',command:'get_state',success:true,data:{model:{provider:'fixture',id:'fixture-model'}}})+'\n');
 });
 return;
}
const sessionId = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
if (!sessionId) { process.stdout.write('omp 2.1.200\n'); process.exit(0); }
const trace = event => fs.appendFileSync(process.env.SOFTWARE_FACTORY_SIMULATED_AGENT_TRACE_FILE,JSON.stringify({sessionId,...event})+'\n');
trace({kind:'process_started',args,pid:process.pid});
let nativeSessionId;
const reply = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line); if (message.id === undefined) return;
 const params = message.params || {};
 switch (message.method) {
  case 'initialize': reply(message.id,{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{close:{}}}}); break;
  case 'session/new': nativeSessionId=randomUUID();trace({kind:'native_created',nativeSessionId});reply(message.id,{sessionId:nativeSessionId});break;
  case 'session/load': nativeSessionId=params.sessionId;trace({kind:'native_loaded',nativeSessionId});reply(message.id,{});break;
  case 'session/set_mode': reply(message.id,{});break;
  case 'session/set_config_option': reply(message.id,{configOptions:[]});break;
  case 'session/close': reply(message.id,{});break;
  case 'session/prompt': {
   const text=(params.prompt||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
   trace({kind:'prompt_accepted',nativeSessionId,text});
   for (const control of JSON.parse(fs.readFileSync(process.env.SOFTWARE_FACTORY_SIMULATED_AGENT_RESULT_CONTROLS_FILE,'utf8'))) {
    if (control.produceResult && text.includes(control.marker)) fs.writeFileSync(control.resultFile,JSON.stringify(control.resultContent));
   }
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:nativeSessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'隔离 Agent 已保存执行产物。'}}}})+'\n');
   reply(message.id,{stopReason:'end_turn'});break;
  }
  default: reply(message.id,{});
 }
});
setInterval(()=>{},1000);
`,
		);
		chmodSync(fakeAgentFile, 0o755);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|RVF_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("未取得隔离端口");
		const port = address.port;
		await new Promise<void>((done) => reservation.close(() => done()));
		expect(port).not.toBe(3484);
		Object.assign(environment, {
			PATH: `${binaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex-sqlite"),
			RVF_USER_LOCAL_DATA_ROOT: join(fixture.isolatedHomeDirectoryPath, ".rvf/user-local-data"),
			SOFTWARE_FACTORY_SIMULATED_AGENT_TRACE_FILE: agentTraceFile,
			SOFTWARE_FACTORY_SIMULATED_AGENT_RESULT_CONTROLS_FILE: resultControlFile,
			PYTHONDONTWRITEBYTECODE: "1",
		});
		let invocationSequence = 0;
		const runCommand = async (executable: string, arguments_: string[], prefix: string) => {
			const sequence = ++invocationSequence;
			const startedAtUtc = new Date().toISOString();
			const child = children.register(
				spawn(executable, arguments_, {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			try {
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, commandExitDeadline, {
					describeChildProcessOutputForFailureMessage: () => `${stderr}\n${stdout}`,
				});
			} finally {
				writeFileSync(join(evidenceDirectory, `${sequence}-${prefix}.stdout.log`), stdout);
				writeFileSync(join(evidenceDirectory, `${sequence}-${prefix}.stderr.log`), stderr);
				writeFileSync(
					join(evidenceDirectory, `${sequence}-${prefix}.command.json`),
					JSON.stringify(
						{
							executable,
							arguments: arguments_,
							workingDirectory: repository.repositoryPath,
							startedAtUtc,
							endedAtUtc: new Date().toISOString(),
							exitCode: child.exitCode,
							homeIsolated: environment.HOME === fixture.isolatedHomeDirectoryPath,
							codexStorageIsolated: environment.CODEX_HOME === join(fixture.isolatedHomeDirectoryPath, ".codex"),
						},
						null,
						2,
					),
				);
			}
			expect(child.exitCode, `${stderr}\n${stdout}`).toBe(0);
			return JSON.parse(stdout);
		};
		const runKanban = (arguments_: string[]) =>
			runCommand(process.execPath, [...sourceCliArguments, ...arguments_], "kanban");
		const runFactory = async (action: string, request?: Record<string, unknown>): Promise<FactoryResponse> => {
			const arguments_ = ["-B", factoryCli, "--database", database, action];
			if (request) {
				const filename = join(fixture.fixtureRootDirectoryPath, `factory-request-${invocationSequence + 1}.json`);
				writeFileSync(
					filename,
					JSON.stringify({ idempotencyKey: `e2e-request-${invocationSequence + 1}`, ...request }),
				);
				writeFileSync(
					join(evidenceDirectory, `${invocationSequence + 1}-factory.request.json`),
					readFileSync(filename),
				);
				arguments_.push("--request-file", filename);
			} else arguments_.push("--run-id", "factory-runtime-e2e");
			return runCommand(pythonExecutable, arguments_, "factory") as Promise<FactoryResponse>;
		};
		const trace = (): AgentTrace[] =>
			readFileSync(agentTraceFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		const startRuntime = async (generation: number) => {
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						join(sourceDirectory, "test/integration/shutdown-ipc-hook.cjs"),
						...sourceCliArguments,
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.once("exit", () =>
				writeFileSync(join(evidenceDirectory, `runtime-generation-${generation}.log`), output),
			);
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `http://127.0.0.1:${port}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		let runtime = await startRuntime(1);
		let stopSessions: (() => Promise<unknown>) | undefined;
		try {
			const created = await runKanban([
				"task",
				"create",
				"--start-in-plan-mode",
				"false",
				"--title",
				"Factory Provider 隔离宿主",
				"--prompt",
				"只验证模拟 Agent 的真实执行协议",
				"--agent-id",
				"omp",
				"--worktree-mode",
				"inplace",
				"--project-path",
				repository.repositoryPath,
			]);
			const taskId = created.task.id as string;
			const workspaceId = (await client().projects.list.query()).projects.find(
				(entry) => entry.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离工作区未注册");
			const scoped = client(workspaceId);
			stopSessions = () => scoped.runtime.stopTaskSession.mutate({ taskId });
			const state = await scoped.workspace.getState.query();
			const backlog = state.board.columns.find((column) => column.id === "backlog");
			const card = backlog?.cards.find((candidate) => candidate.id === taskId);
			if (!backlog || !card) throw new Error("隔离宿主 Task 不存在");
			backlog.cards = backlog.cards.filter((candidate) => candidate.id !== taskId);
			state.board.columns.find((column) => column.id === "in_progress")?.cards.push(card);
			await scoped.workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const mainStarted = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: "omp",
				prompt: "隔离主会话工作",
				baseRef: card.baseRef,
				worktreeMode: "inplace",
				startInPlanMode: false,
				requestedAgentSessionTransport: "acp_stdio_subprocess",
			});
			expect(mainStarted.ok).toBe(true);
			// 后续 Factory 命令来自这个已实际启动的隔离主会话，不能冒用未绑定的 CLI 来源。
			Object.assign(environment, {
				KANBAN_TASK_ID: taskId,
				KANBAN_TASK_CONVERSATION_SESSION_ID: taskId,
				KANBAN_WORKSPACE_ID: workspaceId,
			});
			await runFactory("configure-project", {
				projectId: "e2e-project",
				projectPath: repository.repositoryPath,
				intentClarificationMode: "Bypass",
			});
			await runFactory("create-work-item", {
				workItemId: "e2e-work-item",
				projectId: "e2e-project",
				title: "真实 Provider 对账",
				artifactDirectory,
			});
			const run = (
				await runFactory("create-research-run", {
					runId: "factory-runtime-e2e",
					workItemId: "e2e-work-item",
					materialFiles: [questionFile],
				})
			).currentRun;
			const agentExecutionRequestId = "e2e-completed-execution";
			const resultFile = join(artifactDirectory, "completed-agent-execution-result.json");
			const createRequest: RuntimeTaskConversationSessionCreateRequest = {
				taskId,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				creatorTaskConversationSessionId: taskId,
				idempotencyKey: "factory-provider-e2e-original-creation",
				sessionRole: "task_collaborator",
				contextSource: "fresh",
				agentId: "omp",
				startInPlanMode: false,
				taskAgentPermissionMode: "ask_for_every_tool_use",
				requestedAgentSessionTransport: "acp_stdio_subprocess",
				initialMessage: `执行隔离研究 ${agentExecutionRequestId}，将结果写入指定产物。`,
				creationReason: "Factory 独立研究执行",
			};
			const prepared = (
				await runFactory("prepare-agent-execution", {
					runId: run.runId,
					stageAttemptId: run.stageAttemptId,
					agentExecutionRequestId,
					kanbanCommand: [process.execPath, ...sourceCliArguments],
					kanbanProjectPath: repository.repositoryPath,
					kanbanRuntimePort: port,
					kanbanSessionCreateRequest: createRequest,
					resultFile,
				})
			).currentRun.agentExecutions?.find((entry) => entry.agentExecutionRequestId === agentExecutionRequestId);
			if (!prepared) throw new Error("Factory 未持久保存执行意图");
			const resultContent = {
				schemaVersion: 1,
				runId: run.runId,
				stageAttemptId: run.stageAttemptId,
				agentExecutionRequestId,
				executionInputDigest: prepared.executionInputDigest,
				outcome: "completed",
				summary: "已通过真实 runtime 保存独立 Agent 产物。",
			};
			writeFileSync(
				resultControlFile,
				JSON.stringify([{ marker: agentExecutionRequestId, produceResult: true, resultFile, resultContent }]),
			);
			const frozenRequestFile = join(fixture.fixtureRootDirectoryPath, "frozen-original-session-creation.json");
			writeFileSync(frozenRequestFile, JSON.stringify(prepared.kanbanSessionCreateRequest));
			writeFileSync(
				join(evidenceDirectory, "frozen-original-session-creation.json"),
				readFileSync(frozenRequestFile),
			);
			// 先制造宿主副作用，尚未让 Factory 获得 handle；恢复必须沿原请求查询。
			const direct = await runKanban([
				"task",
				"conversation-session",
				"create",
				"--project-path",
				repository.repositoryPath,
				"--request-file",
				frozenRequestFile,
			]);
			expect(direct.ok).toBe(true);
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				{
					waitedForDescription: "模拟 Agent 保存真实执行结果",
					softDeadlineMsExpectedOnUncontendedHost: 5_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				},
				() => existsSync(resultFile),
			);
			await runFactory("reconcile-agent-execution", { runId: run.runId, agentExecutionRequestId });
			await runFactory("reconcile-agent-execution", { runId: run.runId, agentExecutionRequestId });
			const observed = await runFactory("observe-agent-execution", { runId: run.runId, agentExecutionRequestId });
			expect(
				observed.currentRun.agentExecutions?.find(
					(entry) => entry.agentExecutionRequestId === agentExecutionRequestId,
				)?.resultEvidence,
			).toBeTruthy();
			const sessions = await scoped.runtime.listTaskConversationSessions.query({ taskId });
			expect(sessions.creations).toHaveLength(1);
			expect(
				trace().filter(
					(entry) => entry.kind === "prompt_accepted" && entry.text?.includes(agentExecutionRequestId),
				),
			).toHaveLength(1);
			await runFactory("resume-agent-execution", { runId: run.runId, agentExecutionRequestId });
			expect(
				trace().filter(
					(entry) => entry.kind === "prompt_accepted" && entry.text?.includes(agentExecutionRequestId),
				),
			).toHaveLength(1);
			const pendingExecutionId = "e2e-unfinished-execution";
			const pending = (
				await runFactory("prepare-agent-execution", {
					runId: run.runId,
					stageAttemptId: run.stageAttemptId,
					agentExecutionRequestId: pendingExecutionId,
					kanbanCommand: [process.execPath, ...sourceCliArguments],
					kanbanProjectPath: repository.repositoryPath,
					kanbanRuntimePort: port,
					kanbanSessionCreateRequest: {
						...createRequest,
						idempotencyKey: "factory-provider-e2e-unfinished-creation",
						initialMessage: `执行未完成的隔离研究 ${pendingExecutionId}。`,
					},
					resultFile: join(artifactDirectory, "unfinished-agent-execution-result.json"),
				})
			).currentRun.agentExecutions?.find((entry) => entry.agentExecutionRequestId === pendingExecutionId);
			if (!pending) throw new Error("Factory 未保存第二条隔离执行");
			await runFactory("reconcile-agent-execution", {
				runId: run.runId,
				agentExecutionRequestId: pendingExecutionId,
			});
			const pendingLookup = await scoped.runtime.lookupTaskConversationSessionCreation.query(
				pending.kanbanSessionCreateRequest,
			);
			const pendingSessionId = pendingLookup?.creation?.taskConversationSessionId;
			if (!pendingSessionId) throw new Error("未找到第二条原生会话");
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				{
					waitedForDescription: "第二条执行的原生输入接受",
					softDeadlineMsExpectedOnUncontendedHost: 5_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				},
				() => trace().some((entry) => entry.kind === "prompt_accepted" && entry.text?.includes(pendingExecutionId)),
			);
			await runFactory("observe-agent-execution", { runId: run.runId, agentExecutionRequestId: pendingExecutionId });
			const pendingHost = await scoped.runtime.getTaskConversationSession.query({
				taskId,
				taskConversationSessionId: pendingSessionId,
			});
			const nativeSessionId = pendingHost.summary?.agentNativeConversationSessionIdentity?.nativeSessionId;
			const pendingProcessId = pendingHost.summary?.pid;
			if (!nativeSessionId || !pendingProcessId) throw new Error("第二条执行缺少精确原生身份与进程");
			expect(pendingHost.taskConversationSessionExplicitlyStopped).toBe(false);
			expect(
				trace()
					.filter((entry) => entry.kind === "process_started" && entry.sessionId === pendingSessionId)
					.at(-1)?.pid,
			).toBe(pendingProcessId);
			// 模拟所属 Agent 故障退出，不登记用户 Stop；接续必须保留同一 native ID 且不重发输入。
			process.kill(pendingProcessId, "SIGKILL");
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				testContext,
				{
					waitedForDescription: "所属 Agent 故障退出被宿主观察",
					softDeadlineMsExpectedOnUncontendedHost: 5_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				},
				async () =>
					(
						await scoped.runtime.getTaskConversationSession.query({
							taskId,
							taskConversationSessionId: pendingSessionId,
						})
					).summary?.liveness === "exited",
			);
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: pendingSessionId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(false);
			await runFactory("resume-agent-execution", { runId: run.runId, agentExecutionRequestId: pendingExecutionId });
			expect(
				trace().some(
					(entry) =>
						entry.kind === "native_loaded" &&
						entry.sessionId === pendingSessionId &&
						entry.nativeSessionId === nativeSessionId,
				),
			).toBe(true);
			expect(
				trace().filter((entry) => entry.kind === "prompt_accepted" && entry.text?.includes(pendingExecutionId)),
			).toHaveLength(1);
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: direct.creation.taskConversationSessionId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(false);
			const stopped = await runFactory("stop", { runId: run.runId, reason: "隔离验收明确停止" });
			expect(stopped.currentRun.stopReason).toBe("隔离验收明确停止");
			const mainAfterStop = (await scoped.workspace.getState.query()).sessions[taskId];
			expect(mainAfterStop?.liveness).toBe("live");
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: pendingSessionId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(true);
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: taskId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(false);
			runtime.send?.({ type: "kanban.shutdown" });
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, runtime, commandExitDeadline);
			runtime = await startRuntime(2);
			const restored = await runFactory("status");
			expect(restored.currentRun.stopReason).toBe("隔离验收明确停止");
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: pendingSessionId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(true);
			expect(
				(
					await scoped.runtime.getTaskConversationSession.query({
						taskId,
						taskConversationSessionId: taskId,
					})
				).taskConversationSessionExplicitlyStopped,
			).toBe(false);
			await runFactory("cancel-agent-execution", { runId: run.runId, agentExecutionRequestId });
			expect((await scoped.runtime.listTaskConversationSessions.query({ taskId })).creations).toHaveLength(2);
			writeFileSync(
				join(evidenceDirectory, "factory-kanban-runtime-result.json"),
				JSON.stringify(
					{
						passed: true,
						externalModelsRequested: false,
						sourceRuntimeUsed: true,
						originalCreationRediscovered: true,
						originalNativeSessionResumedWithoutResendingPrompt: true,
						factoryRestartPreservedStop: true,
						duplicateAgentPromptCount: 0,
						taskId,
						workspaceId,
						artifactResult: JSON.parse(readFileSync(resultFile, "utf8")),
					},
					null,
					2,
				),
			);
		} finally {
			writeFileSync(
				join(evidenceDirectory, "simulated-agent-native-protocol-trace.jsonl"),
				readFileSync(agentTraceFile),
			);
			await stopSessions?.().catch(() => undefined);
			runtime.send?.({ type: "kanban.shutdown" });
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, runtime, commandExitDeadline);
		}
	},
);
