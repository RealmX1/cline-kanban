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

const packagedCliPath = process.env.KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath).each([
	["claude", "codex"],
	["codex", "claude"],
	["claude", "claude"],
] as const)(
	"打包态 %s → %s：可写协作、独立恢复与卡片生命周期",
	async (mainAgentId, collaborationAgentId) => {
		if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI 路径");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "collaboration-browser" });
		writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离协作测试\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const evidenceDirectory = join(
			process.env.KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY ??
				join(fixture.fixtureRootDirectoryPath, "browser-evidence"),
			`${mainAgentId}-to-${collaborationAgentId}`,
		);
		mkdirSync(evidenceDirectory, { recursive: true });
		const fakeAgentBinaryDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-binaries");
		mkdirSync(fakeAgentBinaryDirectory);
		const fakeAgentProgram = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const agent = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version') || !process.env.KANBAN_TASK_CONVERSATION_SESSION_ID) {
  process.stdout.write(agent + ' 2.1.200\\n'); process.exit(0);
}
const sessionId = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
fs.writeFileSync(path.join(process.cwd(), 'launch-' + sessionId + '.json'), JSON.stringify({ agent, args, pid: process.pid, cwd: process.cwd(), sessionId, workspaceTaskId: process.env.KANBAN_TASK_ID }));
if (sessionId.startsWith('task-conversation-session-')) {
  fs.writeFileSync(path.join(process.cwd(), 'collaboration-write-proof.txt'), sessionId);
}
process.stdout.write('Claude Code · OpenAI Codex\\n❯ ');
process.stdin.resume();
process.stdin.on('data', chunk => process.stdout.write(chunk));
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
			const requireFromWeb = createRequire(join(sourcePath, "web-ui/package.json"));
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
			const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
			await onboarding.waitFor({ state: "visible" });
			await onboarding.getByRole("button", { name: "Close", exact: true }).click();
			await page
				.getByRole("tab", { name: "Create session", exact: true })
				.click()
				.catch(async (error: unknown) => {
					await page.screenshot({ path: join(evidenceDirectory, "failed-session-form-navigation.png") });
					writeFileSync(join(evidenceDirectory, "failed-session-form-navigation.html"), await page.content());
					writeFileSync(
						join(evidenceDirectory, "failed-session-form-navigation-errors.json"),
						JSON.stringify(pageErrors),
					);
					throw error;
				});
			expect(await page.locator("#task-conversation-session-role").inputValue()).toBe("task_collaborator");
			await page.locator("#task-conversation-session-agent").selectOption(collaborationAgentId);
			await page.locator("#task-conversation-initial-question").fill("实现协作部分");
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-create-form.png") });
			await page.getByRole("button", { name: "Create session", exact: true }).click();
			await expect
				.poll(() => existsSync(join(repository.repositoryPath, "collaboration-write-proof.txt")), {
					timeout: 20_000,
				})
				.toBe(true);
			const sideSessionId = readFileSync(join(repository.repositoryPath, "collaboration-write-proof.txt"), "utf8");
			const sideLaunch = JSON.parse(
				readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"),
			) as { agent: string; args: string[]; workspaceTaskId: string };
			expect(sideLaunch).toMatchObject({ agent: collaborationAgentId, workspaceTaskId: taskId });
			expect(sideLaunch.args).not.toContain("read-only");
			expect(sideLaunch.args).not.toContain("fork");
			const identity = {
				sourceAgentId: collaborationAgentId,
				nativeSessionId: "11111111-1111-4111-8111-111111111111",
				transcriptPath: null,
				observedAt: Date.now(),
			};
			await scoped.hooks.ingest.mutate({
				taskId: sideSessionId,
				workspaceId,
				event: "agent_conversation_session_identity_observed",
				agentNativeConversationSessionIdentity: identity,
			});
			await scoped.hooks.ingest.mutate({
				taskId: sideSessionId,
				workspaceId,
				event: "to_review",
				metadata: { source: collaborationAgentId, hookEventName: "Stop" },
			});
			const afterSideCompletion = await scoped.workspace.getState.query();
			expect(
				afterSideCompletion.board.columns.find((column) =>
					column.cards.some((candidate) => candidate.id === taskId),
				)?.id,
			).toBe("in_progress");
			const mainPid = mainStarted.summary?.pid;
			const restarted = await scoped.runtime.refreshTaskTerminal.mutate({
				taskId: sideSessionId,
				cols: 100,
				rows: 30,
			});
			expect(restarted.ok).toBe(true);
			expect(restarted.summary?.agentId).toBe(collaborationAgentId);
			await expect
				.poll(
					() =>
						JSON.parse(
							readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8"),
						).args.includes(identity.nativeSessionId),
					{ timeout: 15_000 },
				)
				.toBe(true);
			expect((await scoped.workspace.getState.query()).sessions[taskId]?.pid).toBe(mainPid);
			await page.reload();
			await page.getByRole("tab", { name: "Sessions", exact: true }).click();
			await expect.poll(() => page.getByText("协作会话", { exact: true }).count(), { timeout: 15_000 }).toBe(1);
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-desktop.png") });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "Sessions", exact: true }).click();
			await expect.poll(() => page.getByText("协作会话", { exact: true }).count()).toBe(1);
			await page.screenshot({ path: join(evidenceDirectory, "collaboration-mobile.png") });
			expect(pageErrors).toEqual([]);
			await scoped.runtime.stopTaskSession.mutate({ taskId: sideSessionId });
			expect((await scoped.workspace.getState.query()).sessions[taskId]?.pid).toBe(mainPid);
			// 关闭浏览器后重启整个运行时，验证恢复不依赖浏览器内存或仍存在的活体对象。
			await browser.close();
			browser = undefined;
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15_000)).toBe(true);
			runtime = await startRuntime();
			const afterRuntimeRestart = await scoped.workspace.getState.query();
			expect(afterRuntimeRestart.sessions[sideSessionId]).toMatchObject({
				agentId: collaborationAgentId,
				agentNativeConversationSessionIdentity: { nativeSessionId: identity.nativeSessionId },
				taskConversationSessionMetadata: {
					workspaceTaskId: taskId,
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionLaunchSettings: {
						sessionTransport: "pty_terminal",
						taskAgentPermissionMode: "bypass_all_permission_prompts",
					},
				},
			});
			const coldRestarted = await scoped.runtime.refreshTaskTerminal.mutate({
				taskId: sideSessionId,
				cols: 100,
				rows: 30,
			});
			expect(coldRestarted.ok).toBe(true);
			await expect
				.poll(
					() =>
						JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8")).pid,
					{ timeout: 15_000 },
				)
				.toBe(coldRestarted.summary?.pid);
			expect(
				JSON.parse(readFileSync(join(repository.repositoryPath, `launch-${sideSessionId}.json`), "utf8")).args,
			).toContain(identity.nativeSessionId);
			await scoped.runtime.stopTaskSession.mutate({ taskId });
			const stoppedState = await scoped.workspace.getState.query();
			expect(stoppedState.sessions[sideSessionId]?.pid).toBeNull();
			expect(stoppedState.sessions[taskId]?.pid).toBeNull();
			writeFileSync(
				join(evidenceDirectory, "browser-result.json"),
				JSON.stringify(
					{ taskId, sideSessionId, pageErrors, sideLaunch, runtimeRestartPersistenceVerified: true },
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
			}
		}
	},
	180_000,
);
