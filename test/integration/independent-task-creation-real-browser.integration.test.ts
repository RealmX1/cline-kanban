import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_INDEPENDENT_TASK_CREATION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath)(
	"打包浏览器：固定来源、模型建议、独立原生身份、三种工作树、草稿重启与幂等",
	async () => {
		if (!packagedCliPath) throw new Error("缺少本任务隔离构建的 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "independent-task-browser",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "local main\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const evidenceDirectory =
			process.env.KANBAN_INDEPENDENT_TASK_CREATION_BROWSER_EVIDENCE_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "browser-evidence");
		const launchDirectory = join(fixture.fixtureRootDirectoryPath, "agent-launch-records");
		const nativeDirectory = join(fixture.fixtureRootDirectoryPath, "native-session-histories");
		const binaryDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-binaries");
		for (const directory of [evidenceDirectory, launchDirectory, nativeDirectory, binaryDirectory])
			mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(binaryDirectory, "codex"),
			`#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const args = process.argv.slice(2); const histories = process.env.KANBAN_INDEPENDENT_TASK_NATIVE_HISTORY_DIRECTORY;
if (args.includes('app-server')) {
 require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  let result = {};
  if (request.method === 'thread/turns/list') result = { data: [{ id: 'complete-turn', status: 'completed', items: [] }], nextCursor: null };
  if (request.method === 'thread/fork') { const id = crypto.randomUUID(); const target = path.join(histories, id + '.jsonl'); fs.copyFileSync(path.join(histories, request.params.threadId + '.jsonl'), target); result = { thread: { id, path: target, cwd: request.params.cwd } }; }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
 });
} else if (args.includes('--version') || !process.env.KANBAN_TASK_CONVERSATION_SESSION_ID) { process.stdout.write('codex-cli 0.145.0\\n'); }
else {
 const id = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
 fs.writeFileSync(path.join(process.env.KANBAN_INDEPENDENT_TASK_LAUNCH_RECORD_DIRECTORY, id + '.json'), JSON.stringify({ args, cwd: process.cwd(), taskId: process.env.KANBAN_TASK_ID, sessionId: id }));
 process.stdout.write('OpenAI Codex\\n› '); process.stdin.resume(); setInterval(() => {}, 1000);
}
`,
		);
		chmodSync(join(binaryDirectory, "codex"), 0o755);
		const modelContexts: string[] = [];
		const modelServer = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			const parsed = JSON.parse(body) as { messages: { content: string }[]; model: string };
			modelContexts.push(parsed.messages.map((message) => message.content).join("\n"));
			expect(parsed.model).toBe("deepseek-v4-flash");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									suggestedTaskDescription: "实现独立解析器",
									title: "[FEAT]实现独立解析器",
									initialPrompt: "实现侧会话中讨论的独立解析器，保留真人选择。",
								}),
							},
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
				}),
			);
		});
		await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done));
		const modelAddress = modelServer.address();
		if (!modelAddress || typeof modelAddress === "string") throw new Error("模型 mock 端口分配失败");
		const portServer = createServer();
		await new Promise<void>((done) => portServer.listen(0, "127.0.0.1", done));
		const portAddress = portServer.address();
		if (!portAddress || typeof portAddress === "string") throw new Error("运行时端口分配失败");
		const port = portAddress.port;
		await new Promise<void>((done) => portServer.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${binaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
			KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "isolated-fake-key",
			KANBAN_MODEL_PROVIDER_DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelAddress.port}`,
			KANBAN_INDEPENDENT_TASK_NATIVE_HISTORY_DIRECTORY: nativeDirectory,
			KANBAN_INDEPENDENT_TASK_LAUNCH_RECORD_DIRECTORY: launchDirectory,
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const shutdownHook = join(sourcePath, "test/integration/shutdown-ipc-hook.cjs");
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, packagedCliPath, "--port", String(port), "--no-open", "--no-passcode"],
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
			child.on("exit", () => writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), output));
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		let runtime = await startRuntime();
		let browser: Browser | undefined;
		try {
			const creation = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						shutdownHook,
						packagedCliPath,
						"task",
						"create",
						"--title",
						"[TEST]来源任务",
						"--prompt",
						"主任务原始需求",
						"--agent-id",
						"codex",
						"--project-path",
						repository.repositoryPath,
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			creation.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			expect(await waitForChildProcessExit(creation, 45_000)).toBe(true);
			expect(creation.exitCode).toBe(0);
			const taskId = (JSON.parse(output) as { task: { id: string } }).task.id;
			const origin = `http://127.0.0.1:${port}`;
			const client = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${origin}/api/trpc`,
							headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
						}),
					],
				});
			const workspaceId = (await client().projects.list.query()).projects.find(
				(project) => project.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离项目未注册");
			const scoped = client(workspaceId);
			const mainStarted = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: "codex",
				prompt: "主任务原始需求",
				baseRef: "main",
				startInPlanMode: false,
			});
			expect(mainStarted.ok).toBe(true);
			const sourceCwd = mainStarted.summary?.workspacePath;
			if (!sourceCwd) throw new Error("来源工作树未创建");
			const mainNativeId = randomUUID();
			const peerNativeId = randomUUID();
			const mainTranscript = join(nativeDirectory, `${mainNativeId}.jsonl`);
			const peerTranscript = join(nativeDirectory, `${peerNativeId}.jsonl`);
			const record = (time: number, role: string, text: string) =>
				JSON.stringify({
					timestamp: new Date(time).toISOString(),
					type: "response_item",
					payload: {
						type: "message",
						role,
						content: [{ type: role === "user" ? "input_text" : "output_text", text }],
					},
				});
			writeFileSync(
				mainTranscript,
				`${record(Date.now() - 10000, "user", "主任务原始需求")}\n${record(Date.now() - 9000, "assistant", "主会话最后回答")}\n`,
			);
			await scoped.hooks.ingest.mutate({
				taskId,
				workspaceId,
				event: "agent_conversation_session_identity_observed",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: mainNativeId,
					transcriptPath: mainTranscript,
					observedAt: Date.now(),
				},
			});
			const peerId = `task-conversation-session-${randomUUID()}`;
			const peerStarted = await scoped.runtime.startTaskSession.mutate({
				taskId: peerId,
				workspaceTaskId: taskId,
				agentId: "codex",
				prompt: "侧会话的独立解析器需求",
				baseRef: "main",
				startInPlanMode: false,
				taskConversationSessionMetadata: {
					workspaceTaskId: taskId,
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: "原始需求",
					latestUserMessagePreview: "侧会话的独立解析器需求",
				},
			});
			expect(peerStarted.ok).toBe(true);
			writeFileSync(
				peerTranscript,
				`${record(Date.now(), "user", "侧会话的独立解析器需求")}\n${JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call", name: "request_user_input", call_id: "question", arguments: '{"questions":[{"question":"选择模式"}]}' } })}\n${JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call_output", call_id: "question", output: '{"answers":{"mode":{"answers":["真人选择答案"]}}}' } })}\n${JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(), payload: { type: "function_call_output", call_id: "ordinary", output: "不得发送的工具正文" } })}\n${record(Date.now(), "assistant", "侧会话完整回答")}\n`,
			);
			await scoped.hooks.ingest.mutate({
				taskId: peerId,
				workspaceId,
				event: "agent_conversation_session_identity_observed",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: peerNativeId,
					transcriptPath: peerTranscript,
					observedAt: Date.now(),
				},
			});
			for (const id of [taskId, peerId])
				await scoped.hooks.ingest.mutate({
					taskId: id,
					workspaceId,
					event: "to_review",
					metadata: { source: "codex", hookEventName: "Stop" },
				});
			writeFileSync(join(sourceCwd, "source-commit.txt"), "来源尚未合入的提交\n");
			repository.runGit(["add", "source-commit.txt"], { workingDirectoryPath: sourceCwd });
			repository.runGit(["commit", "-m", "来源任务提交"], { workingDirectoryPath: sourceCwd });
			writeFileSync(join(sourceCwd, "initial.txt"), "staged\n");
			repository.runGit(["add", "initial.txt"], { workingDirectoryPath: sourceCwd });
			writeFileSync(join(sourceCwd, "initial.txt"), "unstaged\n");
			writeFileSync(join(sourceCwd, "untracked.txt"), "新文件\n");
			const sourceStatus = repository.runGit(["status", "--porcelain=v1"], {
				workingDirectoryPath: sourceCwd,
			}).stdout;
			const { chromium } = createRequire(join(sourcePath, "web-ui/package.json"))("playwright-core") as {
				chromium: BrowserType;
			};
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
			const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
			await onboarding.waitFor({ state: "visible" });
			await onboarding.getByRole("button", { name: "Close", exact: true }).click();
			await page.getByRole("tab", { name: "Sessions", exact: true }).click();
			await page.getByRole("button", { name: "分出独立任务", exact: true }).click();
			await expect
				.poll(() => page.getByLabel("Initial Prompt", { exact: true }).inputValue())
				.toContain("独立解析器");
			expect(modelContexts).toHaveLength(1);
			expect(modelContexts[0]).toContain("主任务原始需求");
			expect(modelContexts[0]).toContain("主会话最后回答");
			expect(modelContexts[0]).toContain("真人选择答案");
			expect(modelContexts[0]).not.toContain("不得发送的工具正文");
			appendFileSync(peerTranscript, `${record(Date.now() + 10, "user", "固定时点之后的聊天")}\n`);
			await page.getByLabel("本次分出说明", { exact: true }).fill("仅分出解析器");
			await page.getByRole("button", { name: "更新草稿", exact: true }).click();
			await expect.poll(() => modelContexts.length).toBe(2);
			expect(modelContexts[1]).toContain("仅分出解析器");
			expect(modelContexts[1]).not.toContain("固定时点之后的聊天");
			await page.getByLabel("Initial Prompt", { exact: true }).fill("用户手改的完整需求");
			await page.getByRole("button", { name: "关闭", exact: true }).click();
			await page.getByRole("dialog", { name: "分出独立任务", exact: true }).waitFor({ state: "hidden" });
			await page.reload();
			await page.getByRole("tab", { name: "Sessions", exact: true }).click();
			await page.getByRole("button", { name: "分出独立任务", exact: true }).click();
			await expect
				.poll(() => page.getByLabel("Initial Prompt", { exact: true }).inputValue())
				.toBe("用户手改的完整需求");
			await page.screenshot({ path: join(evidenceDirectory, "independent-task-creation-desktop.png") });
			await page.getByRole("button", { name: "创建并启动", exact: true }).click();
			await page.getByRole("link", { name: "打开 [FEAT]实现独立解析器", exact: true }).waitFor();
			const firstDraft = await scoped.independentTaskCreation.latestDraft.query({
				sourceTaskId: taskId,
				sourceTaskConversationSessionId: peerId,
			});
			expect(firstDraft).toBeNull();
			const derived = await scoped.independentTaskCreation.list.query({
				sourceTaskId: taskId,
				sourceTaskConversationSessionId: peerId,
			});
			expect(derived.tasks).toHaveLength(1);
			const firstTaskId = derived.tasks[0]?.taskId;
			if (!firstTaskId) throw new Error("新任务缺失");
			await expect.poll(() => existsSync(join(launchDirectory, `${firstTaskId}.json`))).toBe(true);
			const firstLaunch = JSON.parse(readFileSync(join(launchDirectory, `${firstTaskId}.json`), "utf8")) as {
				cwd: string;
				args: string[];
				taskId: string;
			};
			expect(firstLaunch.cwd).not.toBe(sourceCwd);
			expect(firstLaunch.taskId).toBe(firstTaskId);
			expect(firstLaunch.args).toContain("fork");
			expect(firstLaunch.args).not.toContain(peerNativeId);
			expect(existsSync(join(firstLaunch.cwd, "source-commit.txt"))).toBe(false);
			expect(readFileSync(join(firstLaunch.cwd, "initial.txt"), "utf8")).toBe("local main\n");
			// 同一来源再分出 Backlog：不创建树，直接启动和卡片启动均受服务端门禁。
			const backlogRequestId = randomUUID();
			let backlogDraft = await scoped.independentTaskCreation.prepare.mutate({
				sourceTaskId: taskId,
				sourceTaskConversationSessionId: peerId,
				requestId: backlogRequestId,
			});
			backlogDraft = await scoped.independentTaskCreation.saveDraft.mutate({
				...backlogDraft,
				expectedRevision: backlogDraft.revision,
				contextInheritance: "fresh_conversation",
				worktreeSource: "local_main_after_source_task_landed",
				title: "[FEAT]等待来源落地",
				initialPrompt: "等待来源落地后再执行",
				initialPromptWasEditedByUser: true,
			});
			backlogDraft = await scoped.independentTaskCreation.create.mutate({ requestId: backlogRequestId });
			if (!backlogDraft.createdTaskId) throw new Error("Backlog 卡缺失");
			const denied = await scoped.runtime.startTaskSession.mutate({
				taskId: backlogDraft.createdTaskId,
				agentId: "codex",
				baseRef: "main",
				prompt: "不可绕过",
			});
			expect(denied.ok).toBe(false);
			expect(existsSync(join(launchDirectory, `${backlogDraft.createdTaskId}.json`))).toBe(false);
			// 复制来源 dirty：HEAD、index 与工作文件均保留，来源状态不变。
			const copyRequestId = randomUUID();
			let copyDraft = await scoped.independentTaskCreation.prepare.mutate({
				sourceTaskId: taskId,
				sourceTaskConversationSessionId: peerId,
				requestId: copyRequestId,
			});
			copyDraft = await scoped.independentTaskCreation.saveDraft.mutate({
				...copyDraft,
				expectedRevision: copyDraft.revision,
				contextInheritance: "fresh_conversation",
				worktreeSource: "copy_source_git_working_state_immediately",
				title: "[FEAT]复制来源状态",
				initialPrompt: "继续复制状态中的独立工作",
				initialPromptWasEditedByUser: true,
			});
			const [copyCreated, copyRepeated] = await Promise.all([
				scoped.independentTaskCreation.create.mutate({ requestId: copyRequestId }),
				scoped.independentTaskCreation.create.mutate({ requestId: copyRequestId }),
			]);
			expect(copyCreated.createdTaskId).toBe(copyRepeated.createdTaskId);
			const copiedId = copyCreated.createdTaskId;
			if (!copiedId) throw new Error("复制卡缺失");
			await expect.poll(() => existsSync(join(launchDirectory, `${copiedId}.json`))).toBe(true);
			const copyLaunch = JSON.parse(readFileSync(join(launchDirectory, `${copiedId}.json`), "utf8")) as {
				cwd: string;
			};
			expect(readFileSync(join(copyLaunch.cwd, "initial.txt"), "utf8")).toBe("unstaged\n");
			expect(readFileSync(join(copyLaunch.cwd, "source-commit.txt"), "utf8")).toBe("来源尚未合入的提交\n");
			expect(repository.runGit(["show", ":initial.txt"], { workingDirectoryPath: copyLaunch.cwd }).stdout).toBe(
				"staged\n",
			);
			expect(repository.runGit(["status", "--porcelain=v1"], { workingDirectoryPath: sourceCwd }).stdout).toBe(
				sourceStatus,
			);
			expect((await scoped.independentTaskCreation.list.query({ sourceTaskId: taskId })).tasks).toHaveLength(3);
			await page.getByRole("button", { name: "关闭", exact: true }).click();
			await scoped.independentTaskCreation.prepare.mutate({
				sourceTaskId: taskId,
				sourceTaskConversationSessionId: peerId,
				requestId: randomUUID(),
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).click();
			await page.getByRole("button", { name: "Sessions", exact: true }).click();
			await page.getByRole("button", { name: "分出独立任务", exact: true }).click();
			await expect.poll(() => page.getByLabel("本次分出说明", { exact: true }).count()).toBe(1);
			await page.screenshot({ path: join(evidenceDirectory, "independent-task-creation-mobile.png") });
			expect(pageErrors).toEqual([]);
			await browser.close();
			browser = undefined;
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15_000)).toBe(true);
			runtime = await startRuntime();
			expect((await scoped.independentTaskCreation.list.query({ sourceTaskId: taskId })).tasks).toHaveLength(3);
			expect((await scoped.independentTaskCreation.create.mutate({ requestId: copyRequestId })).createdTaskId).toBe(
				copiedId,
			);
			expect(modelContexts).toHaveLength(2);
			writeFileSync(
				join(evidenceDirectory, "browser-result.json"),
				JSON.stringify(
					{
						taskId,
						peerId,
						firstTaskId,
						copiedId,
						backlogTaskId: backlogDraft.createdTaskId,
						pageErrors,
						paidRequestCount: modelContexts.length,
						restartPersistenceVerified: true,
					},
					null,
					2,
				),
			);
		} finally {
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 15_000);
			await new Promise<void>((done) => modelServer.close(() => done()));
		}
	},
	180_000,
);
