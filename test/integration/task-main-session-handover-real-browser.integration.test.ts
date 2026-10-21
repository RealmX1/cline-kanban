import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
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

const packagedCliPath = process.env.KANBAN_MAIN_SESSION_HANDOVER_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath).each(["new_codex_session", "existing_codex_session"] as const)(
	"打包态主会话交接 %s：真实浏览器、PTY、迟到 hook 与冷恢复",
	async (destinationKind) => {
		const mainAgentId = "claude";
		const collaborationAgentId = "codex";

		if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI 路径");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const nativeCodexId = "22222222-2222-4222-8222-222222222222";
		const codexSessionsDirectoryPath = join(fixture.isolatedHomeDirectoryPath, ".codex", "sessions");
		mkdirSync(codexSessionsDirectoryPath, { recursive: true });
		const codexTranscriptPath = join(codexSessionsDirectoryPath, `rollout-${nativeCodexId}.jsonl`);
		writeFileSync(
			codexTranscriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeCodexId, source: "cli" } })}\n`,
		);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "collaboration-browser" });
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离协作测试\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const evidenceDirectory = join(
			process.env.KANBAN_MAIN_SESSION_HANDOVER_BROWSER_EVIDENCE_DIRECTORY ??
				join(fixture.fixtureRootDirectoryPath, "browser-evidence"),
			`${mainAgentId}-to-${collaborationAgentId}-${destinationKind}`,
		);
		mkdirSync(evidenceDirectory, { recursive: true });
		const fakeAgentBinaryDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-binaries");
		mkdirSync(fakeAgentBinaryDirectory);
		const fakeAgentProgram = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const agent = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version') || !process.env.KANBAN_TASK_CONVERSATION_SESSION_ID) {
  process.stdout.write(agent + ' 2.1.200\n'); process.exit(0);
}
const sessionId = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
fs.writeFileSync(path.join(process.cwd(), 'launch-' + sessionId + '.json'), JSON.stringify({ agent, args, pid: process.pid, cwd: process.cwd(), sessionId, workspaceTaskId: process.env.KANBAN_TASK_ID }));
process.stdout.write('Claude Code · OpenAI Codex\n› \n❯ ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => {
 fs.appendFileSync(path.join(process.cwd(), 'input-' + sessionId + '.txt'), chunk);
 if (chunk.toString() === '\r') {
  process.stdout.write('\x1b[2J\x1b[HWorking…\n');
  let ticks = 0;
  const output = setInterval(() => { process.stdout.write('只读核对材料…\n'); if (++ticks >= 12) clearInterval(output); }, 150);
 } else process.stdout.write(chunk);
});
setInterval(() => {}, 1000);
`;
		for (const agent of ["claude", "codex"]) {
			const binaryPath = join(fakeAgentBinaryDirectory, agent);
			writeFileSync(binaryPath, fakeAgentProgram);
			chmodSync(binaryPath, 0o755);
		}
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		const portReservation = createServer();
		await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
		const address = portReservation.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		const port = address.port;
		await new Promise<void>((done) => portReservation.close(() => done()));
		expect(port).not.toBe(3484);
		Object.assign(environment, {
			PATH: `${fakeAgentBinaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
		});
		const shutdownHook = join(sourcePath, "test/integration/shutdown-ipc-hook.cjs");
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, packagedCliPath, "--port", String(port), "--no-open", "--no-passcode"],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
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
		let stopTestTaskSessions: (() => Promise<unknown>) | undefined;
		try {
			const createTaskProcess = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						shutdownHook,
						packagedCliPath,
						"task",
						"create",
						"--title",
						"协作会话隔离验收",
						"--prompt",
						"主会话工作",
						"--agent-id",
						mainAgentId,
						"--worktree-mode",
						"inplace",
						"--project-path",
						repository.repositoryPath,
					],
					{
						cwd: repository.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				),
			);
			let createdTaskOutput = "";
			createTaskProcess.stdout?.on("data", (chunk) => {
				createdTaskOutput += String(chunk);
			});
			expect(await waitForChildProcessExit(createTaskProcess, 45_000)).toBe(true);
			expect(createTaskProcess.exitCode).toBe(0);
			const taskId = (JSON.parse(createdTaskOutput) as { task: { id: string } }).task.id;
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
			stopTestTaskSessions = () => scoped.runtime.stopTaskSession.mutate({ taskId });
			const state = await scoped.workspace.getState.query();
			const backlog = state.board.columns.find((column) => column.id === "backlog");
			const card = backlog?.cards.find((candidate) => candidate.id === taskId);
			if (!backlog || !card) throw new Error("隔离主卡片不存在");
			backlog.cards = backlog.cards.filter((candidate) => candidate.id !== taskId);
			card.startInPlanMode = false;
			card.taskAgentPermissionMode = "bypass_all_permission_prompts";
			state.board.columns.find((column) => column.id === "in_progress")?.cards.push(card);
			await scoped.workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const mainStarted = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: mainAgentId,
				prompt: "主会话工作",
				baseRef: card.baseRef,
				worktreeMode: "inplace",
				startInPlanMode: false,
			});
			expect(mainStarted.ok).toBe(true);
			const nativeClaudeId = "11111111-1111-4111-8111-111111111111";
			const sourceTranscriptPath = join(fixture.isolatedHomeDirectoryPath, "old-claude-transcript.jsonl");
			writeFileSync(
				sourceTranscriptPath,
				`${JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "已完成材料整理，等待接任。" }] },
				})}\n`,
			);
			await scoped.hooks.ingest.mutate({
				taskId,
				workspaceId,
				event: "agent_conversation_session_identity_observed",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "claude",
					nativeSessionId: nativeClaudeId,
					transcriptPath: sourceTranscriptPath,
					observedAt: Date.now(),
				},
			});
			await scoped.hooks.ingest.mutate({
				taskId,
				workspaceId,
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop" },
			});

			const existingPeerId = "task-conversation-session-33333333-3333-4333-8333-333333333333";
			if (destinationKind === "existing_codex_session") {
				const started = await scoped.runtime.startTaskSession.mutate({
					taskId: existingPeerId,
					workspaceTaskId: taskId,
					agentId: "codex",
					prompt: "既有协作工作",
					baseRef: card.baseRef,
					worktreeMode: "inplace",
					startInPlanMode: false,
					taskConversationSessionMetadata: {
						workspaceTaskId: taskId,
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: "既有协作工作",
					},
				});
				expect(started.ok, started.error).toBe(true);
				await scoped.hooks.ingest.mutate({
					taskId: existingPeerId,
					workspaceId,
					event: "agent_conversation_session_identity_observed",
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: nativeCodexId,
						transcriptPath: codexTranscriptPath,
						observedAt: Date.now(),
					},
				});
				await scoped.hooks.ingest.mutate({
					taskId: existingPeerId,
					workspaceId,
					event: "to_review",
					metadata: { source: "codex", hookEventName: "Stop" },
				});
			}
			const requireFromWeb = createRequire(join(sourcePath, "web-ui/package.json"));
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
			page.setDefaultTimeout(20_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
			const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
			await onboarding.waitFor({ state: "visible" });
			await onboarding.getByRole("button", { name: "Close", exact: true }).click();
			await page.getByRole("tab", { name: "Sessions", exact: true }).click();
			await page.screenshot({ path: join(evidenceDirectory, "sessions-before-handover.png") });
			writeFileSync(join(evidenceDirectory, "sessions-before-handover.html"), await page.content());
			await page.getByRole("button", { name: "交接给 Codex", exact: true }).click();
			await expect.poll(() => page.getByLabel("接收会话").inputValue()).toBe("new_codex_session");
			if (destinationKind === "existing_codex_session")
				await page.getByLabel("接收会话").selectOption(existingPeerId);
			await page.getByLabel("补充交接说明").fill("真实浏览器交接验收：只读报告后等待用户。");
			await page.screenshot({ path: join(evidenceDirectory, "handover-material-preview.png") });
			await page.getByRole("button", { name: "确认交接", exact: true }).click();
			await expect
				.poll(
					async () =>
						(await scoped.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record
							?.materialDirectoryPath,
					{ timeout: 30_000 },
				)
				.toBeTruthy();
			const record = (await scoped.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record;
			if (!record) throw new Error("缺少已持久化的交接记录");
			const targetId = record.targetTaskConversationSessionId;
			if (destinationKind === "existing_codex_session") expect(targetId).toBe(existingPeerId);
			await expect
				.poll(() => existsSync(join(repository.repositoryPath, `launch-${targetId}.json`)), { timeout: 30_000 })
				.toBe(true);
			await expect
				.poll(
					async () => {
						const status = await scoped.runtime.getTaskMainSessionHandoverStatus.query({ taskId });
						if (status.record?.status === "failed") throw new Error(status.record.errorMessage ?? "交接失败");
						const file = join(repository.repositoryPath, `input-${targetId}.txt`);
						return existsSync(file) ? readFileSync(file, "utf8") : "";
					},
					{ timeout: 30_000 },
				)
				.toContain("KANBAN_MAIN_SESSION_HANDOVER_REPORT:");
			await scoped.hooks.ingest.mutate({
				taskId: targetId,
				workspaceId,
				event: "agent_conversation_session_identity_observed",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: nativeCodexId,
					transcriptPath: codexTranscriptPath,
					observedAt: Date.now(),
				},
			});
			await scoped.hooks.ingest.mutate({
				taskId: targetId,
				workspaceId,
				event: "to_in_progress",
				submittedPromptText: "KANBAN_MAIN_SESSION_HANDOVER_REPORT:真实投递确认",
				metadata: { source: "codex", hookEventName: "UserPromptSubmit" },
			});
			await scoped.hooks.ingest.mutate({
				taskId: targetId,
				workspaceId,
				event: "to_review",
				metadata: {
					source: "codex",
					hookEventName: "Stop",
					finalMessage: "计划总览：核对原计划。已经实现：材料已读取。有待进行：等待用户。",
				},
			});
			await expect
				.poll(
					async () => (await scoped.runtime.getTaskMainSessionHandoverStatus.query({ taskId })).record?.status,
					{ timeout: 15_000 },
				)
				.toBe("awaiting_user_message");
			await page.reload();
			await page.getByRole("tab", { name: "Sessions", exact: true }).click();
			await expect.poll(() => page.getByText("前主会话", { exact: true }).count()).toBe(1);
			await page.screenshot({ path: join(evidenceDirectory, "codex-main-former-claude.png") });
			const beforeLateHook = await scoped.workspace.getState.query();
			const columnOfTask = (state: typeof beforeLateHook) =>
				state.board.columns.find((column) => column.cards.some((entry) => entry.id === taskId))?.id;
			await scoped.hooks.ingest.mutate({
				taskId,
				workspaceId,
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "PreToolUse" },
			});
			await scoped.hooks.ingest.mutate({
				taskId,
				workspaceId,
				event: "to_review",
				metadata: { source: "claude", hookEventName: "Stop", finalMessage: "迟到的原会话消息" },
			});
			const afterLateHook = await scoped.workspace.getState.query();
			expect(columnOfTask(afterLateHook)).toBe(columnOfTask(beforeLateHook));
			expect(afterLateHook.sessions[targetId].agentId).toBe("codex");
			expect(afterLateHook.sessions[taskId].taskConversationSessionMetadata?.taskConversationSessionRole).toBe(
				"task_collaborator",
			);
			await browser.close();
			browser = undefined;
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15_000)).toBe(true);
			runtime = await startRuntime();
			const coldState = await scoped.workspace.getState.query();
			expect(
				coldState.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId)
					?.mainTaskConversationSessionId,
			).toBe(targetId);
			const restarted = await scoped.runtime.startTaskSession.mutate({
				taskId,
				agentId: "claude",
				baseRef: card.baseRef,
				prompt: "绝不能重投旧 Claude 原始 prompt",
				worktreeMode: "inplace",
			});
			expect(restarted.ok, restarted.error).toBe(true);
			expect(restarted.summary?.taskId).toBe(targetId);
			expect(restarted.summary?.agentId).toBe("codex");
			await expect
				.poll(
					() => JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${targetId}.json`), "utf8")).args,
					{ timeout: 20_000 },
				)
				.toContain("22222222-2222-4222-8222-222222222222");
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidenceDirectory, "handover-result.json"),
				JSON.stringify(
					{ taskId, targetId, pageErrors, lateHookIsolationVerified: true, coldResumeVerified: true },
					null,
					2,
				),
			);
		} finally {
			try {
				await stopTestTaskSessions?.();
			} finally {
				await browser?.close();
				runtime.kill("SIGINT");
				await waitForChildProcessExit(runtime, 15_000);
				fixture.cleanup();
			}
		}
	},
	180_000,
);
