import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as waitForNextObservation } from "node:timers/promises";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType, Request } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { runAllProjectsRecentSectionRealBrowserCheck } from "./all-projects-recent-section-real-browser-check";
import { runPostDeployVerificationFollowUpTaskRealBrowserCheck } from "./post-deploy-verification-follow-up-task-real-browser-check";
import { runReferenceRelationModelingRealBrowserCheck } from "./reference-relation-modeling-real-browser-check";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";
import { runTaskRetainedCommittedLineChangeRealBrowserCheck } from "./task-retained-committed-line-change-real-browser-check";
import { runTaskSessionConnectionRetryGroupingRealBrowserCheck } from "./task-session-connection-retry-grouping-real-browser-check";
import { runTaskShelvingRealBrowserCheck } from "./task-shelving-real-browser-check";

// 显式启用真实浏览器检查，普通根套件不依赖 Chromium 安装；所有实体、PTY、账本都在 fixture HOME 内。
const runRelationModelingBrowserCheck =
	process.env.KANBAN_RUN_ISOLATED_REFERENCE_RELATION_MODELING_BROWSER_CHECK === "1";
const runPostDeployVerificationFollowUpBrowserCheck =
	process.env.KANBAN_RUN_ISOLATED_POST_DEPLOY_VERIFICATION_FOLLOW_UP_BROWSER_CHECK === "1";
const runAllProjectsRecentBrowserCheck = process.env.KANBAN_RUN_ISOLATED_ALL_PROJECTS_RECENT_BROWSER_CHECK === "1";
const runConnectionRetryGroupingBrowserCheck =
	process.env.KANBAN_RUN_ISOLATED_CONNECTION_RETRY_GROUPING_BROWSER_CHECK === "1";
const runTaskShelvingBrowserCheck = process.env.KANBAN_RUN_ISOLATED_TASK_SHELVING_BROWSER_CHECK === "1";
const runRealBrowserCheck =
	runTaskShelvingBrowserCheck ||
	runConnectionRetryGroupingBrowserCheck ||
	runAllProjectsRecentBrowserCheck ||
	process.env.KANBAN_RUN_ISOLATED_TASK_COMMITTED_LINE_CHANGE_BROWSER_CHECK === "1" ||
	runRelationModelingBrowserCheck ||
	runPostDeployVerificationFollowUpBrowserCheck ||
	process.env.KANBAN_RUN_ISOLATED_CROSS_PROJECT_CARD_ACTION_REAL_BROWSER_CHECK === "1";
const spawnedChildProcessRegistry = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => spawnedChildProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!runRealBrowserCheck)(
	"阶段 3/4/5：真实隔离浏览器执行服务端卡片动作、跨项目建卡与完整卡元数据",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const sourceCheckoutPath = resolve(import.meta.dirname, "../..");
		const evidenceOutputDirectory =
			process.env.KANBAN_ISOLATED_REAL_BROWSER_CHECK_EVIDENCE_OUTPUT_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "browser-check-evidence");
		mkdirSync(evidenceOutputDirectory, { recursive: true });
		const requireFromSourceCheckout = createRequire(join(sourceCheckoutPath, "package.json"));
		const requireFromWebUi = createRequire(join(sourceCheckoutPath, "web-ui/package.json"));
		const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
		const firstProject = fixture.createNonBareRepository({ repositoryDirectoryName: "e2e-project-alpha" });
		const secondProject = fixture.createNonBareRepository({ repositoryDirectoryName: "e2e-project-beta" });
		for (const project of [firstProject, secondProject]) {
			writeFileSync(join(project.repositoryPath, "initial.txt"), "initial\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化浏览器验证仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const reserveAvailablePort = async () => {
			const server = createServer();
			await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("无法分配隔离端口");
			const port = address.port;
			await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
			return port;
		};
		const runtimePort = await reserveAvailablePort();
		const webUiPort = await reserveAvailablePort();
		expect(runtimePort).not.toBe(3484);
		expect(webUiPort).not.toBe(3484);
		const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
		const packagedRuntimeCliPath = process.env.KANBAN_ISOLATED_REAL_BROWSER_CHECK_PACKAGED_RUNTIME_CLI_PATH;
		const usePackagedRuntimeAndWebUi =
			packagedRuntimeCliPath !== undefined ||
			process.env.KANBAN_RUN_ISOLATED_TASK_COMMITTED_LINE_CHANGE_BROWSER_CHECK_WITH_PACKAGED_RUNTIME === "1";
		const webUiOrigin = usePackagedRuntimeAndWebUi ? runtimeOrigin : `http://127.0.0.1:${webUiPort}`;
		const isolatedExecutableDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-stub-executables");
		mkdirSync(isolatedExecutableDirectory);
		const agentLaunchEvidencePath = join(fixture.fixtureRootDirectoryPath, "isolated-agent-launch-evidence.jsonl");
		const retryActivationPath = join(fixture.fixtureRootDirectoryPath, "activate-connection-retry-output");
		const retryRecoveryPath = join(fixture.fixtureRootDirectoryPath, "stop-connection-retry-output");
		writeFileSync(
			join(isolatedExecutableDirectory, "claude"),
			`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('2.1.288 (Claude Code)'); process.exit(0); }
const lineBreak = String.fromCharCode(10);
fs.appendFileSync(process.env.ISOLATED_AGENT_LAUNCH_EVIDENCE_PATH, JSON.stringify({ pid: process.pid, cwd: process.cwd(), resumePriorConversation: process.argv.includes('--continue') || process.argv.includes('--resume') }) + lineBreak);
process.stdout.write('Claude Code v2.1.288' + lineBreak + '> ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
let connectionRetryFixtureStarted = false;
let connectionRetryOutputStopped = false;
function startConnectionRetryFixture(prompt) {
 if (connectionRetryFixtureStarted || !prompt.includes('NETWORK_RETRY_GROUPING_BROWSER_FIXTURE')) return;
 connectionRetryFixtureStarted = true;
 process.stdout.write("ModuleNotFoundError: No module named 'yaml'" + lineBreak + '> ');
 fs.appendFileSync(process.env.ISOLATED_AGENT_LAUNCH_EVIDENCE_PATH, JSON.stringify({ event: 'python_error_fixture_emitted' }) + lineBreak);
}
startConnectionRetryFixture(process.argv.join(' '));
process.stdin.on('data', bytes => {
 if (bytes.includes(3)) process.exit(0);
 startConnectionRetryFixture(bytes.toString());
});
setInterval(() => {
 if (!connectionRetryFixtureStarted || connectionRetryOutputStopped) return;
 if (fs.existsSync(process.env.ISOLATED_AGENT_CONNECTION_RETRY_RECOVERY_MARKER_PATH)) {
  connectionRetryOutputStopped = true;
  fs.appendFileSync(process.env.ISOLATED_AGENT_LAUNCH_EVIDENCE_PATH, JSON.stringify({ event: 'connection_retry_output_stopped' }) + lineBreak);
 } else if (fs.existsSync(process.env.ISOLATED_AGENT_CONNECTION_RETRY_ACTIVATION_MARKER_PATH)) {
  process.stdout.write(lineBreak + 'API Error: Connection closed mid-response. The response above may be incomplete.' + lineBreak + '> ');
 }
}, 500);
setInterval(() => {}, 1000);
`,
			{ mode: 0o755 },
		);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment)) {
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/.test(key))
				delete environment[key];
		}
		Object.assign(environment, {
			PATH: `${isolatedExecutableDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
			NODE_ENV: "development",
			KANBAN_RUNTIME_PORT: String(runtimePort),
			ISOLATED_AGENT_LAUNCH_EVIDENCE_PATH: agentLaunchEvidencePath,
			ISOLATED_AGENT_CONNECTION_RETRY_ACTIVATION_MARKER_PATH: retryActivationPath,
			ISOLATED_AGENT_CONNECTION_RETRY_RECOVERY_MARKER_PATH: retryRecoveryPath,
		});
		const nodeCliArguments = [
			"--require",
			join(sourceCheckoutPath, "test/integration/shutdown-ipc-hook.cjs"),
			"--import",
			requireFromSourceCheckout.resolve("tsx"),
			packagedRuntimeCliPath ?? join(sourceCheckoutPath, usePackagedRuntimeAndWebUi ? "dist/cli.js" : "src/cli.ts"),
		];
		const processEvidence: Array<{ pid: number; role: string; child: ChildProcess }> = [];
		function startOwnedProcess(role: string, executable: string, arguments_: string[], cwd: string) {
			const child = spawnedChildProcessRegistry.register(
				spawn(executable, arguments_, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] }),
			);
			if (!child.pid) throw new Error(`${role} 无 PID`);
			processEvidence.push({ pid: child.pid, role, child });
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.on("exit", () => writeFileSync(join(evidenceOutputDirectory, `${role}.log`), output));
			return child;
		}
		const runtimeClient = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${runtimeOrigin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		async function runCli(arguments_: string[], cwd: string, actorEnvironment: Record<string, string> = {}) {
			const child = spawnedChildProcessRegistry.register(
				spawn(process.execPath, [...nodeCliArguments, ...arguments_], {
					cwd,
					env: { ...environment, ...actorEnvironment },
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				}),
			);
			let output = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			if (!(await waitForChildProcessExit(child, 45000))) throw new Error(`隔离 CLI 未退出：${stderr}`);
			if (child.exitCode !== 0) throw new Error(`隔离 CLI 失败：${stderr}\n${output}`);
			return JSON.parse(output);
		}
		async function createTask(projectPath: string, title: string, extraArguments: string[] = []) {
			const result = await runCli(
				[
					"task",
					"create",
					"--title",
					title,
					"--prompt",
					title,
					"--agent-id",
					"claude",
					"--project-path",
					projectPath,
					...extraArguments,
				],
				projectPath,
			);
			return result.task.id as string;
		}
		async function observeUntil(predicate: () => Promise<boolean>, description: string) {
			const deadline = Date.now() + 20000;
			while (Date.now() < deadline) {
				if (await predicate()) return;
				await waitForNextObservation(200);
			}
			throw new Error(`观察超时：${description}`);
		}
		let browser: Awaited<ReturnType<BrowserType["launch"]>> | null = null;
		const checks: string[] = [];
		const taskCardActionRequestEvidence: Array<{ url: string; body: string | null }> = [];
		const recordCheck = (description: string) => {
			checks.push(description);
			console.log(`通过：${description}`);
		};
		try {
			const initialRuntimeProcess = startOwnedProcess(
				"isolated-runtime",
				process.execPath,
				[...nodeCliArguments, "--port", String(runtimePort), "--no-open", "--no-passcode"],
				firstProject.repositoryPath,
			);
			await observeUntil(
				async () =>
					fetch(`${runtimeOrigin}/api/trpc/projects.list`)
						.then((r) => r.ok)
						.catch(() => false),
				"隔离 runtime 启动",
			);
			const singleStartId = await createTask(firstProject.repositoryPath, "单张启动");
			const allReadyId = await createTask(firstProject.repositoryPath, "全部就绪启动");
			const retryId = await createTask(firstProject.repositoryPath, "重试启动");
			const dragStartId = await createTask(firstProject.repositoryPath, "拖放启动");
			const focusId = await createTask(firstProject.repositoryPath, "焦点锚点");
			const autoActionId = await createTask(firstProject.repositoryPath, "取消自动动作", [
				"--auto-review-enabled",
				"true",
			]);
			const betaId = await createTask(secondProject.repositoryPath, "别的项目任务");
			const { projects } = await runtimeClient().projects.list.query();
			const alphaWorkspaceId = projects.find((p) => p.path === firstProject.repositoryPath)?.id;
			const betaWorkspaceId = projects.find((p) => p.path === secondProject.repositoryPath)?.id;
			if (!alphaWorkspaceId || !betaWorkspaceId) throw new Error("隔离项目未注册");
			const state = await runtimeClient(alphaWorkspaceId).workspace.getState.query();
			for (const [taskId, targetColumn] of [
				[retryId, "in_progress"],
				[focusId, "review"],
			]) {
				const backlog = state.board.columns.find((c) => c.id === "backlog");
				const card = backlog?.cards.find((c) => c.id === taskId);
				if (!card || !backlog) throw new Error("缺少 fixture 卡片");
				backlog.cards = backlog.cards.filter((c) => c.id !== taskId);
				state.board.columns.find((c) => c.id === targetColumn)?.cards.push(card);
			}
			await runtimeClient(alphaWorkspaceId).workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const betaFixtureState = await runtimeClient(betaWorkspaceId).workspace.getState.query();
			const betaFixtureBacklog = betaFixtureState.board.columns.find((column) => column.id === "backlog");
			const betaFixtureCard = betaFixtureBacklog?.cards.find((task) => task.id === betaId);
			if (!betaFixtureCard || !betaFixtureBacklog) throw new Error("缺少另一个项目的 fixture 卡片");
			betaFixtureBacklog.cards = betaFixtureBacklog.cards.filter((task) => task.id !== betaId);
			betaFixtureState.board.columns.find((column) => column.id === "review")?.cards.push(betaFixtureCard);
			await runtimeClient(betaWorkspaceId).workspace.saveState.mutate({
				board: betaFixtureState.board,
				sessions: betaFixtureState.sessions,
				expectedRevision: betaFixtureState.revision,
			});
			const viteConfigurationPath = join(fixture.fixtureRootDirectoryPath, "isolated-real-browser-vite.config.mts");
			writeFileSync(
				viteConfigurationPath,
				`import baseConfiguration from ${JSON.stringify(join(sourceCheckoutPath, "web-ui/vite.config.ts"))};
export default { ...baseConfiguration, optimizeDeps: { entries: [${JSON.stringify(join(sourceCheckoutPath, "web-ui/index.html"))}], include: ["react", "react-dom/client", "react/jsx-runtime", "@xyflow/react", "@dagrejs/dagre"] }, cacheDir: ${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-dependency-cache"))}, server: { ...baseConfiguration.server, host: "127.0.0.1", port: ${webUiPort}, strictPort: true, proxy: { "/api": { target: ${JSON.stringify(runtimeOrigin)}, changeOrigin: true, ws: true, headers: { origin: ${JSON.stringify(runtimeOrigin)} } } } } };`,
			);
			startOwnedProcess(
				"isolated-vite",
				process.execPath,
				[
					"--require",
					join(sourceCheckoutPath, "test/integration/shutdown-ipc-hook.cjs"),
					join(sourceCheckoutPath, "web-ui/node_modules/vite/bin/vite.js"),
					"--config",
					viteConfigurationPath,
				],
				join(sourceCheckoutPath, "web-ui"),
			);
			await observeUntil(
				async () =>
					fetch(webUiOrigin)
						.then((r) => r.ok)
						.catch(() => false),
				"隔离 Vite 启动",
			);
			browser = await chromium.launch({ headless: true });
			const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
			const page = await context.newPage();
			page.setDefaultTimeout(10000);
			const pageErrors: string[] = [];
			writeFileSync(join(evidenceOutputDirectory, "page-errors.json"), "[]");
			page.on("pageerror", (error) => {
				pageErrors.push(error.stack ?? error.message);
				writeFileSync(join(evidenceOutputDirectory, "page-errors.json"), JSON.stringify(pageErrors, null, 2));
			});
			page.on("console", (message) => {
				if (message.type() === "error")
					writeFileSync(join(evidenceOutputDirectory, "last-browser-console-error.txt"), message.text());
			});
			const pageRequests: string[] = [];
			const pendingTaskCardActionRequests = new Set<Request>();
			page.on("requestfinished", (request) => pendingTaskCardActionRequests.delete(request));
			page.on("requestfailed", (request) => pendingTaskCardActionRequests.delete(request));
			page.on("request", (request) => {
				if (request.url().includes("/api/trpc/")) pageRequests.push(request.url());
				if (request.url().includes("taskCardAction.")) {
					pendingTaskCardActionRequests.add(request);
					taskCardActionRequestEvidence.push({ url: request.url(), body: request.postData() });
				}
			});
			await page.goto(`${webUiOrigin}/${alphaWorkspaceId}`);
			await page.locator('[data-column-id="backlog"]').first().waitFor();
			await page
				.getByRole("dialog")
				.filter({ hasText: "Get started" })
				.getByRole("button", { name: "Close", exact: true })
				.click({ timeout: 10000 });
			if (runTaskShelvingBrowserCheck) {
				await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
					taskId: focusId,
					taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
					taskPinboardPinReason: null,
				});
				const olderShelvingFixtureState = await runtimeClient(betaWorkspaceId).workspace.getState.query();
				const olderShelvingFixtureCard = olderShelvingFixtureState.board.columns
					.flatMap((column) => column.cards)
					.find((card) => card.id === betaId);
				if (!olderShelvingFixtureCard) throw new Error("缺少旧搁置任务夹具");
				olderShelvingFixtureCard.updatedAt = olderShelvingFixtureCard.taskDescriptionLastUpdatedAt = 1;
				await runtimeClient(betaWorkspaceId).workspace.saveState.mutate({
					board: olderShelvingFixtureState.board,
					sessions: olderShelvingFixtureState.sessions,
					expectedRevision: olderShelvingFixtureState.revision,
				});
				await runTaskShelvingRealBrowserCheck({
					page,
					webUiOrigin,
					workspaceId: alphaWorkspaceId,
					otherWorkspaceId: betaWorkspaceId,
					focusTaskId: focusId,
					backlogTaskId: singleStartId,
					additionalFocusNavigationTaskId: retryId,
					otherTaskId: betaId,
					evidenceOutputDirectory,
					observeUntil,
					readBoard: async (workspaceId) => (await runtimeClient(workspaceId).workspace.getState.query()).board,
					queryAllProjectsShelved: () =>
						runCli(["task", "list", "--all-projects", "--group", "shelved"], firstProject.repositoryPath),
					runCli: (workspaceId, arguments_) => {
						const projectPath =
							workspaceId === alphaWorkspaceId ? firstProject.repositoryPath : secondProject.repositoryPath;
						return runCli([...arguments_, "--project-path", projectPath], projectPath);
					},
					restartRuntime: async () => {
						initialRuntimeProcess.send({ type: "kanban.shutdown" });
						await observeUntil(async () => hasChildProcessExited(initialRuntimeProcess), "隔离 runtime 停止");
						startOwnedProcess(
							"isolated-runtime-restarted",
							process.execPath,
							[...nodeCliArguments, "--port", String(runtimePort), "--no-open", "--no-passcode"],
							firstProject.repositoryPath,
						);
						await observeUntil(
							async () =>
								fetch(`${runtimeOrigin}/api/trpc/projects.list`)
									.then((response) => response.ok)
									.catch(() => false),
							"隔离 runtime 重启",
						);
					},
				});
				expect(pageErrors).toEqual([]);
				return;
			}
			if (process.env.KANBAN_RUN_ISOLATED_TASK_COMMITTED_LINE_CHANGE_BROWSER_CHECK === "1") {
				const client = runtimeClient(alphaWorkspaceId);
				await runTaskRetainedCommittedLineChangeRealBrowserCheck({
					page,
					repository: firstProject,
					workspaceId: alphaWorkspaceId,
					taskId: focusId,
					webUiOrigin,
					evidenceOutputDirectory,
					observeUntil,
					ensureWorktree: () => client.workspace.ensureWorktree.mutate({ taskId: focusId, baseRef: "main" }),
					readHistory: () =>
						client.workspace.getTaskRetainedCommittedLineChangeHistory.query({
							taskId: focusId,
							baseRef: "main",
						}),
					restartRuntime: async () => {
						initialRuntimeProcess.send({ type: "kanban.shutdown" });
						await observeUntil(async () => hasChildProcessExited(initialRuntimeProcess), "隔离 runtime 停止");
						startOwnedProcess(
							"isolated-runtime-restarted",
							process.execPath,
							[...nodeCliArguments, "--port", String(runtimePort), "--no-open", "--no-passcode"],
							firstProject.repositoryPath,
						);
						await observeUntil(
							async () =>
								fetch(`${runtimeOrigin}/api/trpc/projects.list`)
									.then((response) => response.ok)
									.catch(() => false),
							"隔离 runtime 重启",
						);
					},
				});
				expect(pageErrors).toEqual([]);
				return;
			}
			if (runConnectionRetryGroupingBrowserCheck) {
				const taskId = await createTask(firstProject.repositoryPath, "NETWORK_RETRY_GROUPING_BROWSER_FIXTURE");
				await runtimeClient(alphaWorkspaceId).taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress.mutate(
					{ taskId },
				);
				await observeUntil(
					async () =>
						existsSync(agentLaunchEvidencePath) &&
						readFileSync(agentLaunchEvidencePath, "utf8").includes("python_error_fixture_emitted"),
					"隔离 Agent 已输出 Python 错误",
				);
				await runTaskSessionConnectionRetryGroupingRealBrowserCheck({
					page,
					webUiOrigin,
					workspaceId: alphaWorkspaceId,
					taskId,
					evidenceOutputDirectory,
					observeUntil,
					readSession: async () =>
						(await runtimeClient(alphaWorkspaceId).workspace.getState.query()).sessions[taskId],
					activateErrorOutput: () => writeFileSync(retryActivationPath, "1"),
					stopErrorOutput: async () => {
						writeFileSync(retryRecoveryPath, "1");
						await observeUntil(
							async () =>
								readFileSync(agentLaunchEvidencePath, "utf8").includes("connection_retry_output_stopped"),
							"隔离 Agent 停止输出连接错误",
						);
					},
					recordTrustedRecovery: async () => {
						await runtimeClient(alphaWorkspaceId).hooks.ingest.mutate({
							workspaceId: alphaWorkspaceId,
							taskId,
							event: "activity",
							metadata: { source: "claude", hookEventName: "PostToolUse", toolName: "Bash" },
						});
					},
				});
				expect(pageErrors).toEqual([]);
				return;
			}
			if (runAllProjectsRecentBrowserCheck) {
				const betaBacklogTaskId = await createTask(secondProject.repositoryPath, "跨项目近期待办");
				const olderBacklogTaskId = await createTask(firstProject.repositoryPath, "二十天前的待办");
				const expiredBacklogTaskId = await createTask(firstProject.repositoryPath, "六十天前的待办");
				const validationTaskId = await createTask(firstProject.repositoryPath, "待验证任务");
				const doneTaskId = await createTask(firstProject.repositoryPath, "已完成任务");
				const recentFixtureClient = runtimeClient(alphaWorkspaceId);
				const recentFixtureState = await recentFixtureClient.workspace.getState.query();
				const recentFixtureBacklog = recentFixtureState.board.columns.find((column) => column.id === "backlog");
				if (!recentFixtureBacklog) throw new Error("缺少隔离待办列");
				for (const [taskId, ageDays] of [
					[singleStartId, 1],
					[olderBacklogTaskId, 20],
					[expiredBacklogTaskId, 60],
				] as const) {
					const card = recentFixtureBacklog.cards.find((card) => card.id === taskId);
					if (!card) throw new Error("缺少时间窗口测试卡片");
					card.updatedAt = card.taskDescriptionLastUpdatedAt = Date.now() - ageDays * 24 * 60 * 60_000;
				}
				for (const [taskId, columnId] of [
					[validationTaskId, "validation"],
					[doneTaskId, "trash"],
				] as const) {
					const card = recentFixtureBacklog.cards.find((card) => card.id === taskId);
					if (!card) throw new Error("缺少阶段测试卡片");
					recentFixtureBacklog.cards = recentFixtureBacklog.cards.filter((card) => card.id !== taskId);
					recentFixtureState.board.columns.find((column) => column.id === columnId)?.cards.push(card);
				}
				await recentFixtureClient.workspace.saveState.mutate({
					board: recentFixtureState.board,
					sessions: recentFixtureState.sessions,
					expectedRevision: recentFixtureState.revision,
				});
				const betaRecentFixtureClient = runtimeClient(betaWorkspaceId);
				const betaRecentFixtureState = await betaRecentFixtureClient.workspace.getState.query();
				const betaRecentFixtureCard = betaRecentFixtureState.board.columns
					.find((column) => column.id === "backlog")
					?.cards.find((card) => card.id === betaBacklogTaskId);
				if (!betaRecentFixtureCard) throw new Error("缺少跨项目排序测试卡片");
				betaRecentFixtureCard.updatedAt = betaRecentFixtureCard.taskDescriptionLastUpdatedAt =
					Date.now() - 2 * 24 * 60 * 60_000;
				await betaRecentFixtureClient.workspace.saveState.mutate({
					board: betaRecentFixtureState.board,
					sessions: betaRecentFixtureState.sessions,
					expectedRevision: betaRecentFixtureState.revision,
				});
				await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
					taskId: singleStartId,
					taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
					taskPinboardPinReason: "隔离 Recent 置顶副本验证",
				});
				await runAllProjectsRecentSectionRealBrowserCheck({
					page,
					webUiOrigin,
					alphaWorkspaceId,
					betaWorkspaceId,
					alphaBacklogTaskId: singleStartId,
					betaBacklogTaskId,
					olderBacklogTaskId,
					expiredBacklogTaskId,
					validationTaskId,
					doneTaskId,
					alphaFocusTaskId: focusId,
					betaFocusTaskId: betaId,
					evidenceOutputDirectory,
					observeUntil,
					readBetaBacklogTask: async () => {
						const boardState = await runtimeClient(betaWorkspaceId).workspace.getState.query();
						const column = boardState.board.columns.find((c) =>
							c.cards.some((card) => card.id === betaBacklogTaskId),
						);
						const card = column?.cards.find((card) => card.id === betaBacklogTaskId);
						if (!column || !card) throw new Error("跨项目 Backlog 卡片不存在");
						return { columnId: column.id, prompt: card.prompt };
					},
				});
				expect(pageErrors).toEqual([]);
				return;
			}
			if (runPostDeployVerificationFollowUpBrowserCheck) {
				const client = runtimeClient(alphaWorkspaceId);
				const sourceState = await client.workspace.getState.query();
				const sourceColumn = sourceState.board.columns.find((column) =>
					column.cards.some((card) => card.id === focusId),
				);
				const sourceCard = sourceColumn?.cards.find((card) => card.id === focusId);
				if (!sourceColumn || !sourceCard) throw new Error("缺少 PDV 来源任务");
				sourceColumn.cards = sourceColumn.cards.filter((card) => card.id !== focusId);
				sourceState.board.columns.find((column) => column.id === "validation")?.cards.push(sourceCard);
				await client.workspace.saveState.mutate({
					board: sourceState.board,
					sessions: sourceState.sessions,
					expectedRevision: sourceState.revision,
				});
				await runCli(
					[
						"deployment",
						"record",
						"--project-path",
						firstProject.repositoryPath,
						"--source-checkout-path",
						firstProject.repositoryPath,
						"--new-commit",
						firstProject.runGit(["rev-parse", "HEAD"]).stdout.trim(),
					],
					firstProject.repositoryPath,
				);
				const verification = await client.deployment.getPostDeployVerificationState.query({ activeOnly: true });
				const deploymentId = verification.activeDeploymentId;
				if (!deploymentId) throw new Error("未创建隔离部署记录");
				for (const label of ["浏览器核对项甲", "浏览器核对项乙"]) {
					await client.deployment.updateVerificationChecklist.mutate({
						operation: "add_custom_checklist_item",
						deploymentId,
						taskId: focusId,
						label,
					});
				}
				await runPostDeployVerificationFollowUpTaskRealBrowserCheck({
					page,
					sourceWorkspaceId: alphaWorkspaceId,
					otherWorkspaceId: betaWorkspaceId,
					sourceTaskId: focusId,
					webUiOrigin,
					evidenceOutputDirectory,
					observeUntil,
					recordCheck,
					readSourceBoard: async () => (await client.workspace.getState.query()).board,
					readOtherBoard: async () => (await runtimeClient(betaWorkspaceId).workspace.getState.query()).board,
					readSourceVerificationTask: async () => {
						const state = await client.deployment.getPostDeployVerificationState.query({ activeOnly: true });
						const task = state.deploymentGroups
							.flatMap((group) => group.tasks)
							.find((task) => task.taskId === focusId);
						if (!task) throw new Error("来源核对任务缺失");
						return task;
					},
					readNeighborhood: (taskId) =>
						client.workUnit.getRelationNeighborhoodSummary.query({
							workUnit: {
								workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
								bareTaskId: taskId,
								workspaceId: alphaWorkspaceId,
							},
						}),
					readNavigationTargets: (taskId) =>
						client.deployment.resolveTaskPostDeployVerificationEntryNavigationTargets.query({ taskId }),
					recordAnotherDeployment: async () => {
						await runCli(
							[
								"deployment",
								"record",
								"--project-path",
								firstProject.repositoryPath,
								"--source-checkout-path",
								firstProject.repositoryPath,
								"--new-commit",
								firstProject.runGit(["rev-parse", "HEAD"]).stdout.trim(),
							],
							firstProject.repositoryPath,
						);
					},
					restartRuntime: async () => {
						initialRuntimeProcess.kill("SIGINT");
						await observeUntil(
							async () => hasChildProcessExited(initialRuntimeProcess),
							"来源持久化验收前关闭隔离 runtime",
						);
						startOwnedProcess(
							"isolated-runtime-after-source-persistence-restart",
							process.execPath,
							[...nodeCliArguments, "--port", String(runtimePort), "--no-open", "--no-passcode"],
							firstProject.repositoryPath,
						);
						await observeUntil(
							async () =>
								fetch(`${runtimeOrigin}/api/trpc/projects.list`)
									.then((response) => response.ok)
									.catch(() => false),
							"重启后隔离 runtime 就绪",
						);
					},
				});
				expect(pageErrors).toEqual([]);
				writeFileSync(
					join(evidenceOutputDirectory, "browser-check-results.json"),
					JSON.stringify({ checks, pageErrors, runtimePort, webUiPort }, null, 2),
				);
				return;
			}
			if (runRelationModelingBrowserCheck) {
				await runReferenceRelationModelingRealBrowserCheck({
					page,
					workspaceId: alphaWorkspaceId,
					webUiOrigin,
					evidenceOutputDirectory,
					focusId,
					chainStartId: singleStartId,
					chainMiddleId: allReadyId,
					chainEndId: retryId,
					observeUntil,
					recordCheck,
					seedRelation: (subjectTaskId, anchorTaskId) =>
						runCli(
							[
								"work-unit",
								"assert-reference-relation",
								"--is-generally-related-with",
								`${alphaWorkspaceId}/${anchorTaskId}`,
								"--relation-assertion-rationale",
								"隔离浏览器多跳图种子",
								"--json",
							],
							firstProject.repositoryPath,
							{
								KANBAN_TASK_ID: subjectTaskId,
								KANBAN_HOOK_WORKSPACE_ID: alphaWorkspaceId,
								KANBAN_TASK_CONVERSATION_SESSION_ID: subjectTaskId,
							},
						),
					readBoard: async () => (await runtimeClient(alphaWorkspaceId).workspace.getState.query()).board,
					readNeighborhood: (taskId) =>
						runtimeClient(alphaWorkspaceId).workUnit.getRelationNeighborhoodSummary.query({
							workUnit: {
								workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
								bareTaskId: taskId,
								workspaceId: alphaWorkspaceId,
							},
						}),
				});
				expect(pageErrors).toEqual([]);
				writeFileSync(
					join(evidenceOutputDirectory, "browser-check-results.json"),
					JSON.stringify({ checks, pageErrors, runtimePort, webUiPort }, null, 2),
				);
				return;
			}

			const card = (taskId: string) => page.locator(`[data-task-id="${taskId}"]`).first();
			const clickCardAction = async (taskId: string, action: string) => {
				// 服务端已移列不代表上一个命令的响应已回到浏览器；在途闸尚未释放时下一次点击会被正确拒绝。
				await observeUntil(async () => pendingTaskCardActionRequests.size === 0, "前一个卡片动作请求完成");
				// 上个动作的 tooltip 可能覆盖卡片中心；先离开，再从卡片左上角进入，保留真实命中检查。
				await page.mouse.move(1500, 950);
				await card(taskId).hover({ position: { x: 4, y: 4 } });
				await card(taskId).getByRole("button", { name: action, exact: true }).click();
			};
			const taskState = async (taskId: string, workspaceId = alphaWorkspaceId) => {
				const currentState = await runtimeClient(workspaceId).workspace.getState.query();
				const column = currentState.board.columns.find((c) => c.cards.some((t) => t.id === taskId));
				return {
					columnId: column?.id,
					card: column?.cards.find((t) => t.id === taskId),
					summary: currentState.sessions[taskId],
				};
			};
			const assertColumn = async (taskId: string, columnId: string, workspaceId = alphaWorkspaceId) =>
				observeUntil(
					async () => (await taskState(taskId, workspaceId)).columnId === columnId,
					`${taskId} 进入 ${columnId}`,
				);
			const markReview = async (taskId: string, workspaceId = alphaWorkspaceId) => {
				await runtimeClient(workspaceId).hooks.ingest.mutate({
					taskId,
					workspaceId,
					event: "to_review",
					metadata: { finalMessage: "隔离 agent 桩已完成一轮" },
				});
				await assertColumn(taskId, "review", workspaceId);
			};
			await clickCardAction(singleStartId, "Start task");
			await assertColumn(singleStartId, "in_progress");
			await observeUntil(async () => (await taskState(singleStartId)).summary?.pid != null, "单卡 PTY 启动");
			recordCheck("单张启动，board 与真实 PTY 同步");
			await clickCardAction(retryId, "Retry task start");
			await observeUntil(async () => (await taskState(retryId)).summary?.pid != null, "重试 PTY 启动");
			recordCheck("重试未启动成功的 In Progress 卡");
			// DnD 走键盘传感器，避免鼠标拖拽中的布局/滚动噪音，仍执行真实拖放回调。
			await card(dragStartId).focus();
			await page.keyboard.press("Space");
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press("Space");
			await assertColumn(dragStartId, "in_progress");
			recordCheck("拖放 backlog 卡启动");
			await page.getByRole("button", { name: "Start all ready backlog tasks", exact: true }).click();
			await page
				.getByRole("alertdialog")
				.getByRole("button", { name: /^Start \d+ tasks$/ })
				.click();
			await assertColumn(allReadyId, "in_progress");
			await assertColumn(autoActionId, "in_progress");
			await observeUntil(async () => pendingTaskCardActionRequests.size === 0, "批量启动请求完成");
			await page.waitForTimeout(300);
			recordCheck("启动全部就绪卡");
			await clickCardAction(autoActionId, "Cancel Auto-commit");
			await observeUntil(
				async () => (await taskState(autoActionId)).card?.autoReviewEnabled !== true,
				"取消自动动作",
			);
			recordCheck("取消自动动作");
			await markReview(singleStartId);
			await card(singleStartId).getByRole("button", { name: "Edit task title", exact: true }).click();
			await card(singleStartId).locator("textarea").fill("行内改名已生效");
			await card(singleStartId).locator("textarea").press("Enter");
			await observeUntil(async () => (await taskState(singleStartId)).card?.title === "行内改名已生效", "行内改名");
			recordCheck("行内改名");
			await clickCardAction(singleStartId, "Pin task to pinboard");
			// 置顶可能有原因对话框。
			const pinDialog = page.getByRole("dialog").filter({ hasText: /Pin task|Pin to/ });
			if (await pinDialog.count()) await pinDialog.getByRole("button", { name: /Pin/ }).last().click();
			await observeUntil(async () => (await taskState(singleStartId)).card?.pinnedToTaskPinboardAt != null, "置顶");
			await clickCardAction(singleStartId, "Unpin task from pinboard");
			await observeUntil(
				async () => (await taskState(singleStartId)).card?.pinnedToTaskPinboardAt == null,
				"取消置顶",
			);
			recordCheck("置顶与取消置顶统一走 taskCardAction");
			await clickCardAction(singleStartId, "Move task to validation");
			await assertColumn(singleStartId, "validation");
			await page.getByRole("button", { name: "Expand Validation column", exact: true }).click();
			await card(singleStartId).focus();
			await page.keyboard.press("Space");
			await page.keyboard.press("ArrowLeft");
			await page.keyboard.press("Space");
			await assertColumn(singleStartId, "review");
			recordCheck("进入 Validation、拖放退回 Review");
			await clickCardAction(retryId, "Move task to review");
			await assertColumn(retryId, "review");
			recordCheck("终端 In Progress 卡按钮移到 Review");
			const beforeDoneSummary = (await taskState(singleStartId)).summary;
			expect(beforeDoneSummary?.pid).toBeTypeOf("number");
			const worktreePath = beforeDoneSummary?.workspacePath;
			if (!worktreePath) throw new Error("启动后缺 worktree 路径");
			expect(existsSync(worktreePath)).toBe(true);
			await clickCardAction(singleStartId, "Move task to done");
			await page.getByRole("alertdialog").getByRole("button", { name: "Move to Done", exact: true }).click();
			await assertColumn(singleStartId, "trash");
			const expandDoneColumnButton = page.getByRole("button", { name: "Expand Done column", exact: true });
			if (await expandDoneColumnButton.count()) await expandDoneColumnButton.click();
			await observeUntil(
				async () => !existsSync(worktreePath) && !(await taskState(singleStartId)).summary?.pid,
				"Done 停终端删 worktree",
			);
			await waitForNextObservation(1200);
			expect((await taskState(singleStartId)).columnId).toBe("trash");
			recordCheck("移入 Done 无回弹、真实 PTY 停止与 worktree 删除");
			await clickCardAction(singleStartId, "Restore task from done");
			await assertColumn(singleStartId, "review");
			await observeUntil(
				async () => existsSync(worktreePath) && Boolean((await taskState(singleStartId)).summary?.pid),
				"从 Done 恢复续跑",
			);
			const launchEvidence = readFileSync(agentLaunchEvidencePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(launchEvidence.some((item) => item.cwd === worktreePath && item.resumePriorConversation)).toBe(true);
			recordCheck("从 Done 恢复重建 worktree 并续跑旧对话");
			await clickCardAction(singleStartId, "Move task to done");
			await page.getByRole("alertdialog").getByRole("button", { name: "Move to Done", exact: true }).click();
			await assertColumn(singleStartId, "trash");
			await clickCardAction(singleStartId, "Delete task permanently");
			await page.getByRole("alertdialog").getByRole("button", { name: "Continue", exact: true }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Delete Task", exact: true }).click();
			await observeUntil(async () => !(await taskState(singleStartId)).card, "永久删除");
			recordCheck("永久删除 Done 卡");
			await markReview(retryId);
			await clickCardAction(retryId, "Move task to done");
			await page.getByRole("alertdialog").getByRole("button", { name: "Move to Done", exact: true }).click();
			await assertColumn(retryId, "trash");
			await page.getByRole("button", { name: "Clear done", exact: true }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Clear Done", exact: true }).click();
			await observeUntil(async () => !(await taskState(retryId)).card, "清空 Done");
			recordCheck("清空 Done");

			// 切入 Board Scope Focus View，当前项目的非焦点卡仅由面板轮询补齐 git 元数据。
			await markReview(dragStartId);
			const nonFocusedTaskWorktreePath = (await taskState(dragStartId)).summary?.workspacePath;
			if (!nonFocusedTaskWorktreePath) throw new Error("非焦点卡缺 worktree 路径");
			writeFileSync(join(nonFocusedTaskWorktreePath, "committed-browser-check.txt"), "ahead\n");
			firstProject.runGit(["add", "committed-browser-check.txt"], {
				workingDirectoryPath: nonFocusedTaskWorktreePath,
			});
			firstProject.runGit(["commit", "-m", "验证目录行领先提交数"], {
				workingDirectoryPath: nonFocusedTaskWorktreePath,
			});
			writeFileSync(join(nonFocusedTaskWorktreePath, "initial.txt"), "initial\nchanged\n");
			// 别的项目里一张没起过会话的 In progress 卡：旧设计在完整卡首行画 Spinner，标题因此右移约 23px。
			// 只改 beta 的 board（浏览器此刻停在 alpha，不会并发写 beta）。
			const betaInProgressGeometryAnchorId = await createTask(secondProject.repositoryPath, "进行中几何锚点");
			// 别的项目里的 backlog 卡：点它展开后卡片的上沿，应当原地打开编辑框（可观察、不换焦点、不起会话）。
			const betaBacklogClickAnchorId = await createTask(secondProject.repositoryPath, "顶部点击锚点");
			const betaGeometryState = await runtimeClient(betaWorkspaceId).workspace.getState.query();
			const betaGeometryBacklog = betaGeometryState.board.columns.find((column) => column.id === "backlog");
			const betaGeometryCard = betaGeometryBacklog?.cards.find((task) => task.id === betaInProgressGeometryAnchorId);
			if (!betaGeometryCard || !betaGeometryBacklog) throw new Error("缺少几何锚点卡");
			betaGeometryBacklog.cards = betaGeometryBacklog.cards.filter(
				(task) => task.id !== betaInProgressGeometryAnchorId,
			);
			betaGeometryState.board.columns.find((column) => column.id === "in_progress")?.cards.push(betaGeometryCard);
			await runtimeClient(betaWorkspaceId).workspace.saveState.mutate({
				board: betaGeometryState.board,
				sessions: betaGeometryState.sessions,
				expectedRevision: betaGeometryState.revision,
			});
			await page.evaluate(() => {
				sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
				localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
			});
			await page.goto(`${webUiOrigin}/${alphaWorkspaceId}?task=${focusId}`);
			await page.locator('[data-testid="cross-project-task-switcher-section-remaining"]').waitFor();
			const row = (taskId: string) => page.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).first();
			await observeUntil(
				async () => (await row(dragStartId).textContent())?.includes("+1") === true,
				"非焦点精简行轮询已刷新",
			);
			const rowInPlaceExpansionStateAttribute = "data-cross-project-task-switcher-row-in-place-expansion-state";
			const rowInPlaceExpandedByHover = (taskId: string) =>
				page
					.locator(
						`[data-cross-project-task-switcher-task-id="${taskId}"][${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`,
					)
					.first();
			const inListExpansionToggleTestId =
				"cross-project-task-switcher-full-task-card-in-list-expansion-toggle-button";
			const panel = page.locator('[data-testid="cross-project-recently-active-task-switcher-panel"]');
			// 阶段 6：精简行 → hover 原地展开 → 固定展开三态之间标题首行一像素不动、展开开关同一坐标；
			// 往下挪到下一行时交接、新行停在指针下（面板有滚动余量时）、静止的光标下不连锁展开。
			type MeasuredRect = { left: number; top: number; width: number; height: number };
			const measureRect = (locator: ReturnType<typeof page.locator>) =>
				locator.evaluate((element): MeasuredRect => {
					const rect = element.getBoundingClientRect();
					return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
				});
			const titleAndToggleGeometryEvidence: Record<string, unknown> = {};
			const expectSamePlacementWithinOnePixel = (actual: MeasuredRect, expected: MeasuredRect, label: string) => {
				expect(Math.abs(actual.left - expected.left), `${label} left`).toBeLessThanOrEqual(1);
				expect(Math.abs(actual.top - expected.top), `${label} top`).toBeLessThanOrEqual(1);
			};
			// hover 动作组 = 展开开关所在的那一组（开关是它最右一格）。
			const measureHoverActionGroupBottomPx = (toggleLocator: ReturnType<typeof page.locator>) =>
				toggleLocator.evaluate((element) => element.parentElement?.getBoundingClientRect().bottom ?? Number.NaN);
			// 动作组叠在首行上方：底边最多伸进首行行盒顶上的行距留白（leading-snug 下 ≈2.4px），不压到字。
			const expectHoverActionGroupAboveFirstLine = (
				geometry: { title: MeasuredRect; hoverActionGroupBottomPx: number },
				label: string,
			) => {
				expect(
					geometry.hoverActionGroupBottomPx - geometry.title.top,
					`${label} 动作组不压首行`,
				).toBeLessThanOrEqual(2.5);
			};
			const measureCompactRow = async (taskId: string, compactRow = row(taskId)) => {
				return {
					row: await measureRect(compactRow),
					title: await measureRect(compactRow.locator("[data-cross-project-task-switcher-row-title]")),
					toggle: await measureRect(compactRow.getByTestId(inListExpansionToggleTestId).filter({ visible: true })),
					hoverActionGroupBottomPx: await measureHoverActionGroupBottomPx(
						compactRow.getByTestId(inListExpansionToggleTestId).filter({ visible: true }),
					),
					leadingActivityIndicator: await compactRow
						.locator("[data-cross-project-task-switcher-row-leading-activity-indicator]")
						.first()
						.getAttribute("data-cross-project-task-switcher-row-leading-activity-indicator", { timeout: 200 })
						.catch(() => null),
				};
			};
			const measureExpandedRow = async (expandedRow: ReturnType<typeof page.locator>) => ({
				row: await measureRect(expandedRow),
				title: await measureRect(expandedRow.locator("[data-task-card-title]")),
				toggle: await measureRect(expandedRow.getByTestId(inListExpansionToggleTestId).filter({ visible: true })),
				hoverActionGroupBottomPx: await measureHoverActionGroupBottomPx(
					expandedRow.getByTestId(inListExpansionToggleTestId).filter({ visible: true }),
				),
			});
			const hoverRowUntilExpandedInPlace = async (taskId: string, title: string) => {
				await row(taskId).locator("button:visible").first().hover();
				await rowInPlaceExpandedByHover(taskId)
					.locator("[data-task-card-title]")
					.filter({ hasText: title })
					.waitFor();
				return rowInPlaceExpandedByHover(taskId);
			};
			const leavePanelAndWaitForHoverExpansionToCollapse = async () => {
				await page.mouse.move(1500, 950);
				await page
					.locator(`[${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`)
					.first()
					.waitFor({ state: "detached" });
			};
			// 分区第一行的 hover 动作组伸出行顶边 12px，最右一格展开开关的命中区伪元素（after:-top-1）再向上扩 4px；上方是本分区
			// header：动作组盒子与开关命中区的顶边都不得高于 header 底边，否则盖住 header 里的折叠按钮（Pinned / Running）/ 排序
			// 下拉框（Recent）的右下沿、截走点击。夹具里有行的分区都量；Recent 必须量到（它的 header 有排序下拉框），带折叠按钮的
			// Pinned 也必须量到：本夹具的置顶在阶段 2 就取消了、下一次置顶在阶段 6 之后，Running 分区又默认收起，不先置顶就只量得到
			// 没有折叠按钮的分区。所以先经 runtime 置顶焦点锚点让 Pinned 分区有行，量完取消置顶、等 Pinned 分区消失再往下走
			// （后续断言按原夹具布局）。
			await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskId: focusId,
				taskPinboardPinReason: null,
			});
			const pinnedSectionTestId = "cross-project-task-switcher-section-pinned";
			const pinnedSection = page.locator(`[data-testid="${pinnedSectionTestId}"]`);
			await pinnedSection.locator(`[data-cross-project-task-switcher-task-id="${focusId}"]`).waitFor();
			// 静态几何（动作组常驻 DOM、只切透明度，不必 hover）：动作组盒子顶边，以及按开关 ::after 的 top 算出的命中区顶边。
			// 根 tsconfig 不带 DOM lib：浏览器端脚本以字符串交给页面执行。
			const firstRowHoverActionGroupAgainstSectionHeaderGeometry = (await page.evaluate(`(() => {
				const toggleTestId = ${JSON.stringify(inListExpansionToggleTestId)};
				return [...document.querySelectorAll('[data-testid^="cross-project-task-switcher-section-"]')].flatMap((sectionElement) => {
					const firstRow = sectionElement.querySelector("[data-cross-project-task-switcher-task-id]");
					const inListExpansionToggle = firstRow?.querySelector('[data-testid="' + toggleTestId + '"]:not([inert] *)');
					const hoverActionGroup = inListExpansionToggle?.parentElement;
					if (!hoverActionGroup) return [];
					const sectionHeader = sectionElement.firstElementChild;
					const headerInteractiveControlBottomsPx = [...sectionHeader.querySelectorAll("button, select")].map(
						(control) => control.getBoundingClientRect().bottom,
					);
					return [{
						sectionTestId: sectionElement.getAttribute("data-testid"),
						hoverActionGroupTopPx: hoverActionGroup.getBoundingClientRect().top,
						inListExpansionToggleHitAreaTopPx:
							inListExpansionToggle.getBoundingClientRect().top +
							Number.parseFloat(getComputedStyle(inListExpansionToggle, "::after").top),
						sectionHeaderBottomPx: sectionHeader.getBoundingClientRect().bottom,
						headerInteractiveControlBottomsPx,
						sortSelectBottomPx: sectionHeader.querySelector("select")?.getBoundingClientRect().bottom ?? null,
					}];
				});
			})()`)) as Array<{
				sectionTestId: string;
				hoverActionGroupTopPx: number;
				inListExpansionToggleHitAreaTopPx: number;
				sectionHeaderBottomPx: number;
				headerInteractiveControlBottomsPx: number[];
				sortSelectBottomPx: number | null;
			}>;
			titleAndToggleGeometryEvidence.first_row_hover_action_group_against_section_header =
				firstRowHoverActionGroupAgainstSectionHeaderGeometry;
			const remainingSectionFirstRowGeometry = firstRowHoverActionGroupAgainstSectionHeaderGeometry.find(
				(geometry) => geometry.sectionTestId === "cross-project-task-switcher-section-remaining",
			);
			expect(remainingSectionFirstRowGeometry?.sortSelectBottomPx, "Recent 首行与排序下拉框都已渲染").toBeTypeOf(
				"number",
			);
			const pinnedSectionFirstRowGeometry = firstRowHoverActionGroupAgainstSectionHeaderGeometry.find(
				(geometry) => geometry.sectionTestId === pinnedSectionTestId,
			);
			expect(
				pinnedSectionFirstRowGeometry?.headerInteractiveControlBottomsPx.length ?? 0,
				"Pinned 首行与折叠按钮都已渲染",
			).toBeGreaterThan(0);
			for (const geometry of firstRowHoverActionGroupAgainstSectionHeaderGeometry) {
				for (const [measuredTopEdgeLabel, measuredTopEdgePx] of [
					["动作组盒子", geometry.hoverActionGroupTopPx],
					["展开开关命中区", geometry.inListExpansionToggleHitAreaTopPx],
				] as const) {
					expect(
						measuredTopEdgePx,
						`${geometry.sectionTestId} 首行${measuredTopEdgeLabel}顶边不高于 header 底边`,
					).toBeGreaterThanOrEqual(geometry.sectionHeaderBottomPx - 0.5);
					for (const controlBottomPx of geometry.headerInteractiveControlBottomsPx) {
						expect(
							measuredTopEdgePx,
							`${geometry.sectionTestId} 首行${measuredTopEdgeLabel}不压 header 控件`,
						).toBeGreaterThanOrEqual(controlBottomPx);
					}
				}
			}
			// 命中区只在 hover（group-hover 打开 pointer-events）时生效，且包括伪元素：hover 每个有行的分区的首行，在 header 底边
			// 内侧 0.5px、以及 header 里每个控件底边内侧 1px 处，横向取开关命中区覆盖的 x（按钮左沿内侧、中心、右侧扩展区）用
			// elementFromPoint 取点：命中的不得是动作组里的元素，落在控件范围内的点必须命中控件本身。hover 刚开始（意图计时未到，
			// 一般还是精简行）与 hover 原地展开后各量一次：两态动作组同一坐标，但 DOM 是两套。
			type FirstRowHoverActionGroupHitTestingAgainstSectionHeaderControls = {
				sectionTestId: string;
				firstRowInPlaceExpansionState: string | null;
				inListExpansionTogglePointerEvents: string;
				inListExpansionToggleExtendedHitAreaCornerHitsToggle: boolean;
				hitTestingProbes: Array<{
					probedTargetKind:
						| "section_header_bottom_edge_inner_side"
						| "section_header_interactive_control_bottom_edge_inner_side";
					probedHeaderControlDescription: string | null;
					probeXPx: number;
					probeYPx: number;
					hitElementDescription: string | null;
					hitElementIsInsideHoverActionGroup: boolean;
					hitElementIsInsideProbedHeaderControl: boolean | null;
				}>;
			};
			const hitTestFirstRowHoverActionGroupAgainstSectionHeaderControls = async (sectionTestId: string) =>
				(await page.evaluate(`(() => {
					const toggleTestId = ${JSON.stringify(inListExpansionToggleTestId)};
					const sectionElement = document.querySelector('[data-testid="' + ${JSON.stringify(sectionTestId)} + '"]');
					const firstRow = sectionElement.querySelector("[data-cross-project-task-switcher-task-id]");
					const inListExpansionToggle = firstRow.querySelector('[data-testid="' + toggleTestId + '"]:not([inert] *)');
					const hoverActionGroup = inListExpansionToggle.parentElement;
					const sectionHeader = sectionElement.firstElementChild;
					const toggleRect = inListExpansionToggle.getBoundingClientRect();
					const probeXsPx = [toggleRect.left + 1, toggleRect.left + toggleRect.width / 2, toggleRect.right + 2];
					const describeElement = (element) =>
						element
							? element.tagName.toLowerCase() +
								(element.getAttribute("aria-label") ? '[aria-label="' + element.getAttribute("aria-label") + '"]' : "") +
								(element.getAttribute("data-testid") ? '[data-testid="' + element.getAttribute("data-testid") + '"]' : "")
							: null;
					const hitTestingProbes = [];
					const probe = (probedTargetKind, probedHeaderControl, probeXPx, probeYPx) => {
						const hitElement = document.elementFromPoint(probeXPx, probeYPx);
						hitTestingProbes.push({
							probedTargetKind,
							probedHeaderControlDescription: probedHeaderControl ? describeElement(probedHeaderControl) : null,
							probeXPx,
							probeYPx,
							hitElementDescription: describeElement(hitElement),
							hitElementIsInsideHoverActionGroup: hitElement !== null && hoverActionGroup.contains(hitElement),
							hitElementIsInsideProbedHeaderControl: probedHeaderControl
								? hitElement !== null && probedHeaderControl.contains(hitElement)
								: null,
						});
					};
					const sectionHeaderBottomPx = sectionHeader.getBoundingClientRect().bottom;
					for (const probeXPx of probeXsPx) {
						probe("section_header_bottom_edge_inner_side", null, probeXPx, sectionHeaderBottomPx - 0.5);
					}
					for (const headerControl of sectionHeader.querySelectorAll("button, select")) {
						const controlRect = headerControl.getBoundingClientRect();
						for (const probeXPx of probeXsPx) {
							if (probeXPx < controlRect.left || probeXPx >= controlRect.right) continue;
							probe("section_header_interactive_control_bottom_edge_inner_side", headerControl, probeXPx, controlRect.bottom - 1);
						}
					}
					// 阳性对照：命中区此刻确实生效（伪元素扩出的右上角命中开关），上面「没命中动作组」才不是因为动作组隐形。
					const extendedHitAreaCornerHitElement = document.elementFromPoint(toggleRect.right + 2, toggleRect.top - 2);
					return {
						sectionTestId: ${JSON.stringify(sectionTestId)},
						firstRowInPlaceExpansionState: firstRow.getAttribute(${JSON.stringify(rowInPlaceExpansionStateAttribute)}),
						inListExpansionTogglePointerEvents: getComputedStyle(inListExpansionToggle).pointerEvents,
						inListExpansionToggleExtendedHitAreaCornerHitsToggle:
							extendedHitAreaCornerHitElement !== null && inListExpansionToggle.contains(extendedHitAreaCornerHitElement),
						hitTestingProbes,
					};
				})()`)) as FirstRowHoverActionGroupHitTestingAgainstSectionHeaderControls;
			const firstRowHoverActionGroupHitTestingEvidence: FirstRowHoverActionGroupHitTestingAgainstSectionHeaderControls[] =
				[];
			for (const { sectionTestId } of firstRowHoverActionGroupAgainstSectionHeaderGeometry) {
				const sectionFirstRow = page
					.locator(`[data-testid="${sectionTestId}"] [data-cross-project-task-switcher-task-id]`)
					.first();
				await page.mouse.move(1500, 950);
				await sectionFirstRow.locator("button:visible").first().hover();
				firstRowHoverActionGroupHitTestingEvidence.push(
					await hitTestFirstRowHoverActionGroupAgainstSectionHeaderControls(sectionTestId),
				);
				await sectionFirstRow
					.and(page.locator(`[${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`))
					.getByTestId(inListExpansionToggleTestId)
					.filter({ visible: true })
					.waitFor();
				firstRowHoverActionGroupHitTestingEvidence.push(
					await hitTestFirstRowHoverActionGroupAgainstSectionHeaderControls(sectionTestId),
				);
				await leavePanelAndWaitForHoverExpansionToCollapse();
			}
			titleAndToggleGeometryEvidence.first_row_hover_action_group_hit_testing_against_section_header_controls =
				firstRowHoverActionGroupHitTestingEvidence;
			expect(
				firstRowHoverActionGroupHitTestingEvidence.some(
					(hitTesting) => hitTesting.firstRowInPlaceExpansionState === "expanded_in_place_by_hover",
				),
			).toBe(true);
			expect(
				firstRowHoverActionGroupHitTestingEvidence.some(
					(hitTesting) =>
						hitTesting.sectionTestId === pinnedSectionTestId &&
						hitTesting.hitTestingProbes.some(
							(hitTestingProbe) =>
								hitTestingProbe.probedTargetKind ===
								"section_header_interactive_control_bottom_edge_inner_side",
						),
				),
				"Pinned 折叠按钮底沿被取点",
			).toBe(true);
			for (const hitTesting of firstRowHoverActionGroupHitTestingEvidence) {
				const hitTestingLabel = `${hitTesting.sectionTestId} 首行（${hitTesting.firstRowInPlaceExpansionState}）`;
				expect(hitTesting.inListExpansionTogglePointerEvents, `${hitTestingLabel} 动作组可点`).toBe("auto");
				expect(
					hitTesting.inListExpansionToggleExtendedHitAreaCornerHitsToggle,
					`${hitTestingLabel} 开关命中区生效`,
				).toBe(true);
				for (const hitTestingProbe of hitTesting.hitTestingProbes) {
					const hitTestingProbeLabel = `${hitTestingLabel} ${hitTestingProbe.probedTargetKind} ${hitTestingProbe.probedHeaderControlDescription ?? ""} (${hitTestingProbe.probeXPx}, ${hitTestingProbe.probeYPx}) 命中 ${hitTestingProbe.hitElementDescription}`;
					expect(hitTestingProbe.hitElementIsInsideHoverActionGroup, `${hitTestingProbeLabel}：不得截走`).toBe(
						false,
					);
					if (hitTestingProbe.hitElementIsInsideProbedHeaderControl !== null) {
						expect(
							hitTestingProbe.hitElementIsInsideProbedHeaderControl,
							`${hitTestingProbeLabel}：应命中 header 控件`,
						).toBe(true);
					}
				}
			}
			await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
				taskPinboardPinAction: "unpin_task_card",
				taskId: focusId,
			});
			await pinnedSection.waitFor({ state: "detached" });
			recordCheck(
				"阶段 6 分区首行 hover 动作组与展开开关命中区顶边不高于本分区 header 底边，hover 时 elementFromPoint 在折叠按钮（Pinned）/ 排序下拉框（Recent）底沿命中控件本身",
			);
			for (const [taskId, title, geometryCaseLabel] of [
				[betaInProgressGeometryAnchorId, "进行中几何锚点", "other_project_in_progress_without_session"],
				[betaId, "别的项目任务", "other_project_review"],
			] as const) {
				await row(taskId).waitFor();
				const compactRowGeometry = await measureCompactRow(taskId);
				const expandedRowGeometry = await measureExpandedRow(await hoverRowUntilExpandedInPlace(taskId, title));
				// 悬浮展开：行的占位、上沿与左沿均不动，卡片覆盖相邻内容。
				expectSamePlacementWithinOnePixel(
					expandedRowGeometry.row,
					compactRowGeometry.row,
					`${geometryCaseLabel} 行`,
				);
				expect(expandedRowGeometry.row.height).toBe(compactRowGeometry.row.height);
				expectSamePlacementWithinOnePixel(
					expandedRowGeometry.title,
					compactRowGeometry.title,
					`${geometryCaseLabel} 标题`,
				);
				expectSamePlacementWithinOnePixel(
					expandedRowGeometry.toggle,
					compactRowGeometry.toggle,
					`${geometryCaseLabel} 开关`,
				);
				expectHoverActionGroupAboveFirstLine(compactRowGeometry, `${geometryCaseLabel} 精简行`);
				expectHoverActionGroupAboveFirstLine(expandedRowGeometry, `${geometryCaseLabel} hover 展开`);
				titleAndToggleGeometryEvidence[geometryCaseLabel] = { compactRowGeometry, expandedRowGeometry };
				await leavePanelAndWaitForHoverExpansionToCollapse();
			}

			// 两处宿主共用同一量法：展开、收起与切换均保持列表占位和滚动尺寸。
			// 浮层可能遮住下一行，先移出卡片让遮蔽解除，再进入下一行。

			type CrossProjectTaskSwitcherHandOffMeasurementScrollContainerHost = {
				scrollContainer: ReturnType<typeof page.locator>;
				remainingSectionSelector: string;
				leaveScrollContainerAndWaitForHoverExpansionToCollapse: () => Promise<void>;
			};
			const focusViewLeftColumnPanelHandOffMeasurementScrollContainerHost: CrossProjectTaskSwitcherHandOffMeasurementScrollContainerHost =
				{
					scrollContainer: panel,
					remainingSectionSelector: '[data-testid="cross-project-task-switcher-section-remaining"]',
					leaveScrollContainerAndWaitForHoverExpansionToCollapse: leavePanelAndWaitForHoverExpansionToCollapse,
				};
			const measureHandOffToNextRowBelow = async (
				handOffCaseLabel: string,
				handOffMeasurementScrollContainerHost: CrossProjectTaskSwitcherHandOffMeasurementScrollContainerHost = focusViewLeftColumnPanelHandOffMeasurementScrollContainerHost,
			) => {
				const {
					scrollContainer,
					remainingSectionSelector,
					leaveScrollContainerAndWaitForHoverExpansionToCollapse,
				} = handOffMeasurementScrollContainerHost;
				const remainingRows = page.locator(
					`${remainingSectionSelector} [data-cross-project-task-switcher-task-id]`,
				);
				const upperRow = remainingRows.nth(-2);
				const lowerRow = remainingRows.last();
				await leaveScrollContainerAndWaitForHoverExpansionToCollapse();
				await scrollContainer.evaluate((element) => {
					element.scrollTop = element.scrollHeight;
				});
				const readScrollState = () =>
					scrollContainer.evaluate((element) => ({
						scrollTop: element.scrollTop,
						scrollHeight: element.scrollHeight,
						paddingTop: element.style.paddingTop,
					}));
				const scrollStateBeforeExpansion = await readScrollState();
				const upperRowBeforeExpansion = await measureRect(upperRow);
				const lowerRowBeforeExpansion = await measureRect(lowerRow);
				const hoverFloatingCard = (targetRow: ReturnType<typeof page.locator>) =>
					targetRow.locator("[data-cross-project-task-switcher-hover-floating-card]");
				await upperRow.locator("button:visible").first().hover();
				await hoverFloatingCard(upperRow).locator("[data-task-card-title]").waitFor();
				expect(await readScrollState(), `${handOffCaseLabel} 展开不改变滚动尺寸`).toEqual(
					scrollStateBeforeExpansion,
				);
				expect(await measureRect(upperRow)).toEqual(upperRowBeforeExpansion);
				expect(await measureRect(lowerRow)).toEqual(lowerRowBeforeExpansion);
				await leaveScrollContainerAndWaitForHoverExpansionToCollapse();
				expect(await readScrollState(), `${handOffCaseLabel} 收起不改变滚动尺寸`).toEqual(
					scrollStateBeforeExpansion,
				);
				await lowerRow.locator("button:visible").first().hover();
				await hoverFloatingCard(lowerRow).locator("[data-task-card-title]").waitFor();
				await waitForNextObservation(700);
				const lowerFloatingCard = await measureRect(hoverFloatingCard(lowerRow));
				const scrollViewport = await measureRect(scrollContainer);
				expect(await upperRow.getAttribute(rowInPlaceExpansionStateAttribute)).toBe("compact_row");
				expect(await lowerRow.getAttribute(rowInPlaceExpansionStateAttribute)).toBe("expanded_in_place_by_hover");
				expect(await measureRect(upperRow)).toEqual(upperRowBeforeExpansion);
				expect(await measureRect(lowerRow)).toEqual(lowerRowBeforeExpansion);
				expect(await readScrollState(), `${handOffCaseLabel} 切换不改变滚动尺寸`).toEqual(
					scrollStateBeforeExpansion,
				);
				expect(lowerFloatingCard.top).toBeGreaterThanOrEqual(scrollViewport.top - 1);
				expect(lowerFloatingCard.top + lowerFloatingCard.height).toBeLessThanOrEqual(
					scrollViewport.top + scrollViewport.height + 1,
				);
				titleAndToggleGeometryEvidence[handOffCaseLabel] = {
					scrollStateBeforeExpansion,
					upperRowBeforeExpansion,
					lowerRowBeforeExpansion,
					lowerFloatingCard,
					scrollViewport,
				};
				await leaveScrollContainerAndWaitForHoverExpansionToCollapse();
				expect(await readScrollState()).toEqual(scrollStateBeforeExpansion);
				await scrollContainer.evaluate((element) => {
					element.scrollTop = 0;
				});
			};

			// 高视口与矮视口都保持占位和滚动尺寸。
			await measureHandOffToNextRowBelow("hand_off_to_next_row_below_panel_viewport_1000px");
			// 矮视口覆盖滚到底和向上避让。
			await page.setViewportSize({ width: 1600, height: 420 });
			await measureHandOffToNextRowBelow("hand_off_to_next_row_below_panel_viewport_420px_scrollable");
			await page.setViewportSize({ width: 1600, height: 1000 });

			await page.mouse.move(1500, 950);
			const panelBoundingBox = await panel.boundingBox();
			if (!panelBoundingBox) throw new Error("面板未渲染");
			await page.screenshot({
				path: join(evidenceOutputDirectory, "cross-project-row-1-compact-before-hover.png"),
				clip: panelBoundingBox,
			});
			const currentProjectCompactRowGeometry = await measureCompactRow(dragStartId);
			const currentProjectExpandedRow = await hoverRowUntilExpandedInPlace(dragStartId, "拖放启动");
			const hoverDirectory = currentProjectExpandedRow.locator("[data-task-directory]");
			await hoverDirectory.waitFor();
			await observeUntil(
				async () => (await hoverDirectory.textContent())?.includes("+1") === true,
				"hover 目录行 git 统计",
			);
			expect(await hoverDirectory.locator(".lucide-arrow-up").count()).toBe(1);
			const currentProjectHoverExpandedGeometry = await measureExpandedRow(currentProjectExpandedRow);
			expectSamePlacementWithinOnePixel(
				currentProjectHoverExpandedGeometry.title,
				currentProjectCompactRowGeometry.title,
				"current_project_review 标题",
			);
			expectSamePlacementWithinOnePixel(
				currentProjectHoverExpandedGeometry.toggle,
				currentProjectCompactRowGeometry.toggle,
				"current_project_review 开关",
			);
			// 开关命中区用伪元素向上、向右扩到 24×24，按钮盒子不动：点按钮外右上角 2px 处也命中开关。
			expect(
				await currentProjectExpandedRow
					.getByTestId(inListExpansionToggleTestId)
					.filter({ visible: true })
					.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return element.contains(element.ownerDocument.elementFromPoint(bounds.right + 2, bounds.top - 2));
					}),
			).toBe(true);
			// 展开发生在静止的光标下：开关第一帧就可见、可点（不必先晃一下鼠标）。
			await page.screenshot({
				path: join(evidenceOutputDirectory, "cross-project-row-2-expanded-in-place-by-hover.png"),
				clip: panelBoundingBox,
			});
			await currentProjectExpandedRow.getByTestId(inListExpansionToggleTestId).filter({ visible: true }).click();
			const expandedCard = row(dragStartId).locator("[data-task-directory]");
			await expandedCard.waitFor();
			expect(await expandedCard.textContent()).toContain("+1");
			expect(await expandedCard.locator(".lucide-arrow-up").count()).toBe(1);
			expect(await row(dragStartId).getAttribute(rowInPlaceExpansionStateAttribute)).toBe("kept_expanded_in_list");
			const keptExpandedToggle = row(dragStartId).getByTestId(inListExpansionToggleTestId).filter({ visible: true });
			expect(
				await keptExpandedToggle.getAttribute(
					"data-cross-project-task-switcher-full-task-card-in-list-expansion-state",
				),
			).toBe("kept_expanded_in_list");
			const currentProjectKeptExpandedGeometry = await measureExpandedRow(row(dragStartId));
			expectSamePlacementWithinOnePixel(
				currentProjectKeptExpandedGeometry.title,
				currentProjectCompactRowGeometry.title,
				"current_project_review 固定展开标题",
			);
			expectSamePlacementWithinOnePixel(
				currentProjectKeptExpandedGeometry.toggle,
				currentProjectCompactRowGeometry.toggle,
				"current_project_review 固定展开开关",
			);
			expectHoverActionGroupAboveFirstLine(currentProjectHoverExpandedGeometry, "current_project_review hover 展开");
			expectHoverActionGroupAboveFirstLine(currentProjectKeptExpandedGeometry, "current_project_review 固定展开");
			// 固定展开恢复完整高度占位。
			expect(currentProjectKeptExpandedGeometry.row.height).toBeGreaterThan(
				currentProjectHoverExpandedGeometry.row.height,
			);
			titleAndToggleGeometryEvidence.current_project_review = {
				compactRowGeometry: currentProjectCompactRowGeometry,
				hoverExpandedGeometry: currentProjectHoverExpandedGeometry,
				keptExpandedGeometry: currentProjectKeptExpandedGeometry,
			};
			await page.screenshot({
				path: join(evidenceOutputDirectory, "cross-project-row-3-kept-expanded-in-list.png"),
				clip: panelBoundingBox,
			});
			await page.screenshot({
				path: join(evidenceOutputDirectory, "compact-card-current-project-polled-worktree.png"),
			});
			recordCheck("当前项目非焦点卡 hover 与固定展开的完整卡有目录、领先提交与未提交统计（阶段 5 截图）");
			writeFileSync(
				join(evidenceOutputDirectory, "cross-project-row-title-and-toggle-geometry.json"),
				JSON.stringify(titleAndToggleGeometryEvidence, null, 2),
			);
			recordCheck(
				"阶段 6 精简行 / hover 原地展开 / 固定展开三态标题首行左上角相差 ≤1px、展开开关同一坐标、hover 动作组叠在首行上方不压字（In progress 与 Review、当前与其他项目）",
			);
			recordCheck("阶段 6 往下挪到下一行：交接一次、不连锁；列表占位、行坐标、scrollTop 与 scrollHeight 保持不变");
			const betaExpandedRow = await hoverRowUntilExpandedInPlace(betaId, "别的项目任务");
			await betaExpandedRow.getByRole("button", { name: "Move task to validation", exact: true }).click();
			await assertColumn(betaId, "validation", betaWorkspaceId);
			expect(page.url()).toContain(`/${alphaWorkspaceId}`);
			recordCheck("对别的项目卡执行动作，当前项目与焦点不变");
			// 点展开卡片原来顶条所在的位置（卡框上沿往下 0–18px）= 点精简行：backlog 行原地打开编辑框。
			await leavePanelAndWaitForHoverExpansionToCollapse();
			await page.getByRole("button", { name: "Expand Backlog", exact: true }).click();
			await hoverRowUntilExpandedInPlace(betaBacklogClickAnchorId, "顶部点击锚点");
			const backlogExpandedRowBox = await rowInPlaceExpandedByHover(betaBacklogClickAnchorId).boundingBox();
			if (!backlogExpandedRowBox) throw new Error("展开的 backlog 行未渲染");
			await page.mouse.click(
				backlogExpandedRowBox.x + backlogExpandedRowBox.width * 0.4,
				backlogExpandedRowBox.y + 3,
			);
			const backlogEditor = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
			await backlogEditor.waitFor();
			await page.keyboard.press("Escape");
			await backlogEditor.waitFor({ state: "detached" });
			recordCheck("阶段 6 点展开卡片原顶条位置等于点精简行（backlog 原地打开编辑框）");
			async function createOtherProjectTaskViaDialog(title: string) {
				const dialog = page.getByRole("dialog").filter({ hasText: "New task" });
				await dialog.locator('[data-testid="task-creation-target-project-field"]').getByRole("button").click();
				await page
					.getByRole("button", { name: /e2e-project-beta/ })
					.last()
					.click();
				await dialog.getByPlaceholder("Describe the task...").fill(title);
				await dialog.getByRole("button", { name: "Create", exact: true }).click();
				await observeUntil(
					async () =>
						(await runtimeClient(betaWorkspaceId).workspace.getState.query()).board.columns.some((c) =>
							c.cards.some((t) => t.prompt === title),
						),
					"目标项目建卡",
				);
				expect(page.url()).toContain(`/${alphaWorkspaceId}`);
				const createdState = await runtimeClient(betaWorkspaceId).workspace.getState.query();
				return createdState.board.columns.flatMap((c) => c.cards).find((t) => t.prompt === title)?.id;
			}
			await page.keyboard.press("c");
			const createdByKeyboardId = await createOtherProjectTaskViaDialog("c 键往另一个项目建卡");
			if (!createdByKeyboardId) throw new Error("缺创建结果");
			recordCheck("Board Scope c 键往别的项目建卡不切项目");
			await row(createdByKeyboardId).locator("button:visible").first().hover();
			await rowInPlaceExpandedByHover(createdByKeyboardId)
				.getByTestId(inListExpansionToggleTestId)
				.filter({ visible: true })
				.click();
			expect(await row(createdByKeyboardId).getAttribute(rowInPlaceExpansionStateAttribute)).toBe(
				"kept_expanded_in_list",
			);
			await row(createdByKeyboardId).hover();
			const expandedBacklogPencil = row(createdByKeyboardId).getByRole("button", {
				name: "Edit task title",
				exact: true,
			});
			expect(
				await expandedBacklogPencil.evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return element.contains(
						element.ownerDocument.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
					);
				}),
			).toBe(true);
			await expandedBacklogPencil.click();
			const editor = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
			await editor
				.locator('[data-testid="task-creation-target-project-field"]')
				.getByText("e2e-project-beta", { exact: true })
				.waitFor();
			await editor.getByPlaceholder("Describe the task...").fill("仅保存修改的 prompt");
			await runtimeClient(betaWorkspaceId).taskCardAction.updateTaskCardFieldValues.mutate({
				taskId: createdByKeyboardId,
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
					taskCardFieldValuePatch: { title: "并发外部改名保持不变" },
				},
			});
			await editor.getByRole("button", { name: "Save changes", exact: true }).click();
			await observeUntil(
				async () => (await taskState(createdByKeyboardId, betaWorkspaceId)).card?.prompt === "仅保存修改的 prompt",
				"原地编辑保存",
			);
			expect((await taskState(createdByKeyboardId, betaWorkspaceId)).card?.title).toBe("并发外部改名保持不变");
			const browserEditorSaveRequest = taskCardActionRequestEvidence
				.filter((request) => request.url.includes("taskCardAction.updateTaskCardFieldValues"))
				.at(-1);
			if (!browserEditorSaveRequest?.body) throw new Error("缺编辑保存请求证据");
			const editorFieldPatch = JSON.parse(browserEditorSaveRequest.body)["0"].taskCardFieldUpdate
				.taskCardFieldValuePatch;
			expect(editorFieldPatch).toEqual({ prompt: "仅保存修改的 prompt" });
			expect(page.url()).toContain(`task=${focusId}`);
			recordCheck("跨项目 expanded compact Pencil 中心命中编辑器；只保存改过字段并保留并发改名");
			await page.getByRole("button", { name: "Create task", exact: true }).click();
			await createOtherProjectTaskViaDialog("面板按钮往另一个项目建卡");
			recordCheck("面板顶部 Create task 入口");
			await page.getByRole("button", { name: "Back to board", exact: true }).click();

			// 阶段 7：Back 落回的 All projects 首页（分区列看板，取代原 Board Overview）。同一组分区横排成列，每列的内容容器
			// 自己滚动、自持一个 hover 原地展开；断言沿用阶段 6 的量法，只是滚动容器换成列。
			const boardScopeHomePageSelector =
				'[data-testid="board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board"]';
			const boardScopeHomePage = page.locator(boardScopeHomePageSelector);
			await boardScopeHomePage.waitFor();
			await boardScopeHomePage.getByRole("button", { name: "Create task", exact: true }).click();
			await createOtherProjectTaskViaDialog("首页按钮往另一个项目建卡");
			recordCheck("All projects 首页页头 Create task 入口");
			const homePageSectionColumnSelector = (sectionTestIdSuffix: string) =>
				`${boardScopeHomePageSelector} [data-testid="cross-project-task-switcher-section-${sectionTestIdSuffix}"]`;
			const homePageSectionColumnScrollContainer = (sectionTestIdSuffix: string) =>
				boardScopeHomePage.locator(
					`[data-testid="cross-project-task-switcher-section-column-scroll-container-${sectionTestIdSuffix}"]`,
				);
			const homePageRow = (sectionTestIdSuffix: string, taskId: string) =>
				page
					.locator(homePageSectionColumnSelector(sectionTestIdSuffix))
					.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
			const homePageRowInExpansionState = (
				sectionTestIdSuffix: string,
				taskId: string,
				inPlaceExpansionState: "compact_row" | "expanded_in_place_by_hover" | "kept_expanded_in_list",
			) =>
				homePageRow(sectionTestIdSuffix, taskId).and(
					page.locator(`[${rowInPlaceExpansionStateAttribute}="${inPlaceExpansionState}"]`),
				);
			// 首页的列铺满宽度，阶段 6 那个「挪到右下角」可能落进 Running 列：改挪到首页页头的标题上。
			const leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse = async () => {
				const homePageTitleBox = await boardScopeHomePage.locator("h1").boundingBox();
				if (!homePageTitleBox) throw new Error("首页页头未渲染");
				await page.mouse.move(
					homePageTitleBox.x + homePageTitleBox.width / 2,
					homePageTitleBox.y + homePageTitleBox.height / 2,
				);
				await boardScopeHomePage
					.locator(`[${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`)
					.first()
					.waitFor({ state: "detached" });
			};
			// 固定展开按任务记、跨重挂载保留：阶段 6 在左栏固定展开的卡，在首页同样固定展开。验证后全部收起，后面按精简行量。
			const keptExpandedRowsOnHomePage = boardScopeHomePage.locator(
				`[${rowInPlaceExpansionStateAttribute}="kept_expanded_in_list"]`,
			);
			await keptExpandedRowsOnHomePage
				.and(page.locator(`[data-cross-project-task-switcher-task-id="${dragStartId}"]`))
				.first()
				.waitFor();
			while ((await keptExpandedRowsOnHomePage.count()) > 0) {
				const keptExpandedRowCountBeforeCollapse = await keptExpandedRowsOnHomePage.count();
				// 动作组（含开关）只在指针停在卡上时才开放 pointer-events：先把指针移到这一行上，再点开关。
				await keptExpandedRowsOnHomePage.first().hover();
				await keptExpandedRowsOnHomePage
					.first()
					.getByTestId(inListExpansionToggleTestId)
					.filter({ visible: true })
					.click();
				await observeUntil(
					async () => (await keptExpandedRowsOnHomePage.count()) < keptExpandedRowCountBeforeCollapse,
					"首页收起固定展开的卡",
				);
			}
			await leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse();
			// 让 Pinned 列有行（它的 header 在列呈现下没有折叠按钮，但首行同样要让位于 header）。
			await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskId: focusId,
				taskPinboardPinReason: null,
			});
			await homePageRow("pinned", focusId).waitFor();
			expect(
				await boardScopeHomePage
					.locator('section[data-testid^="cross-project-task-switcher-section-"]')
					.evaluateAll((sectionColumns) =>
						sectionColumns.map((sectionColumn) => sectionColumn.getAttribute("data-testid")),
					),
				"首页列序与 Focus View 一致",
			).toEqual([
				"cross-project-task-switcher-section-pinned",
				"cross-project-task-switcher-section-running",
				"cross-project-task-switcher-section-prompt-cache-warm",
				"cross-project-task-switcher-section-remaining",
				"cross-project-task-switcher-section-shelved",
			]);
			expect(
				await page.getByTestId("toggle-board-scope-all-projects-button").getAttribute("aria-pressed"),
				"顶栏 All projects 按钮处于按下态",
			).toBe("true");
			await page.screenshot({
				path: join(evidenceOutputDirectory, "board-scope-all-projects-home-page-section-columns.png"),
			});
			recordCheck(
				"阶段 7 All projects 首页分区列看板：列序 Pinned | Running | Cache warm · your turn | Recent；左栏固定展开的卡在首页同样固定展开",
			);
			// 各列首行：动作组盒子与展开开关命中区的顶边不高于列 header 底边（不截 header 控件的点击），也不高于列滚动容器的上沿
			// （不被 overflow 裁掉）。行必须是滚动容器的直接子节点，行根节点的 first:mt-4 才作用在首行上。
			const homePageSectionColumnFirstRowHoverActionGroupGeometry = (await page.evaluate(`(() => {
				const toggleTestId = ${JSON.stringify(inListExpansionToggleTestId)};
				const boardScopeHomePage = document.querySelector(${JSON.stringify(boardScopeHomePageSelector)});
				return [...boardScopeHomePage.querySelectorAll('section[data-testid^="cross-project-task-switcher-section-"]')].flatMap((sectionColumn) => {
					const sectionHeader = sectionColumn.children[0];
					const sectionColumnScrollContainer = sectionColumn.querySelector('[data-testid^="cross-project-task-switcher-section-column-scroll-container-"]');
					const firstRow = sectionColumnScrollContainer.querySelector("[data-cross-project-task-switcher-task-id]");
					const inListExpansionToggle = firstRow?.querySelector('[data-testid="' + toggleTestId + '"]:not([inert] *)');
					const hoverActionGroup = inListExpansionToggle?.parentElement;
					if (!hoverActionGroup) return [];
					return [{
						sectionTestId: sectionColumn.getAttribute("data-testid"),
						firstRowIsFirstChildOfSectionColumnScrollContainer: sectionColumnScrollContainer.firstElementChild === firstRow,
						sectionColumnScrollContainerScrollTop: sectionColumnScrollContainer.scrollTop,
						hoverActionGroupTopPx: hoverActionGroup.getBoundingClientRect().top,
						inListExpansionToggleHitAreaTopPx:
							inListExpansionToggle.getBoundingClientRect().top +
							Number.parseFloat(getComputedStyle(inListExpansionToggle, "::after").top),
						sectionHeaderBottomPx: sectionHeader.getBoundingClientRect().bottom,
						sectionColumnScrollContainerTopPx: sectionColumnScrollContainer.getBoundingClientRect().top,
						headerInteractiveControlBottomsPx: [...sectionHeader.querySelectorAll("button, select")].map(
							(control) => control.getBoundingClientRect().bottom,
						),
					}];
				});
			})()`)) as Array<{
				sectionTestId: string;
				firstRowIsFirstChildOfSectionColumnScrollContainer: boolean;
				sectionColumnScrollContainerScrollTop: number;
				hoverActionGroupTopPx: number;
				inListExpansionToggleHitAreaTopPx: number;
				sectionHeaderBottomPx: number;
				sectionColumnScrollContainerTopPx: number;
				headerInteractiveControlBottomsPx: number[];
			}>;
			titleAndToggleGeometryEvidence.board_scope_home_page_section_column_first_row_hover_action_group_geometry =
				homePageSectionColumnFirstRowHoverActionGroupGeometry;
			expect(
				homePageSectionColumnFirstRowHoverActionGroupGeometry.map((geometry) => geometry.sectionTestId),
				"Pinned 与 Recent 列首行都已渲染",
			).toEqual(
				expect.arrayContaining([
					"cross-project-task-switcher-section-pinned",
					"cross-project-task-switcher-section-remaining",
				]),
			);
			for (const geometry of homePageSectionColumnFirstRowHoverActionGroupGeometry) {
				expect(
					geometry.firstRowIsFirstChildOfSectionColumnScrollContainer,
					`${geometry.sectionTestId} 首行是滚动容器首个子节点`,
				).toBe(true);
				expect(geometry.sectionColumnScrollContainerScrollTop, `${geometry.sectionTestId} 列从顶部开始`).toBe(0);
				for (const [measuredTopEdgeLabel, measuredTopEdgePx] of [
					["动作组盒子", geometry.hoverActionGroupTopPx],
					["展开开关命中区", geometry.inListExpansionToggleHitAreaTopPx],
				] as const) {
					expect(
						measuredTopEdgePx,
						`${geometry.sectionTestId} 首行${measuredTopEdgeLabel}顶边不高于列 header 底边`,
					).toBeGreaterThanOrEqual(geometry.sectionHeaderBottomPx - 0.5);
					expect(
						measuredTopEdgePx,
						`${geometry.sectionTestId} 首行${measuredTopEdgeLabel}不被列滚动容器上沿裁掉`,
					).toBeGreaterThanOrEqual(geometry.sectionColumnScrollContainerTopPx - 0.5);
					for (const controlBottomPx of geometry.headerInteractiveControlBottomsPx) {
						expect(
							measuredTopEdgePx,
							`${geometry.sectionTestId} 首行${measuredTopEdgeLabel}不压列 header 控件`,
						).toBeGreaterThanOrEqual(controlBottomPx);
					}
				}
			}
			// hover 时取点（与阶段 6 同一个取点函数）：开关命中区右上角的阳性对照还顺带证明动作组没被列的 overflow 裁掉
			// （被裁掉的部分 elementFromPoint 命中不到）。
			const homePageSectionColumnFirstRowHitTestingEvidence: FirstRowHoverActionGroupHitTestingAgainstSectionHeaderControls[] =
				[];
			for (const { sectionTestId } of homePageSectionColumnFirstRowHoverActionGroupGeometry) {
				const sectionColumnFirstRow = page
					.locator(
						`${boardScopeHomePageSelector} [data-testid="${sectionTestId}"] [data-cross-project-task-switcher-task-id]`,
					)
					.first();
				await leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse();
				await sectionColumnFirstRow.locator("button:visible").first().hover();
				homePageSectionColumnFirstRowHitTestingEvidence.push(
					await hitTestFirstRowHoverActionGroupAgainstSectionHeaderControls(sectionTestId),
				);
				await sectionColumnFirstRow
					.and(page.locator(`[${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`))
					.getByTestId(inListExpansionToggleTestId)
					.filter({ visible: true })
					.waitFor();
				homePageSectionColumnFirstRowHitTestingEvidence.push(
					await hitTestFirstRowHoverActionGroupAgainstSectionHeaderControls(sectionTestId),
				);
			}
			await leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse();
			titleAndToggleGeometryEvidence.board_scope_home_page_section_column_first_row_hit_testing =
				homePageSectionColumnFirstRowHitTestingEvidence;
			expect(
				homePageSectionColumnFirstRowHitTestingEvidence.some(
					(hitTesting) =>
						hitTesting.sectionTestId === "cross-project-task-switcher-section-remaining" &&
						hitTesting.hitTestingProbes.some(
							(hitTestingProbe) =>
								hitTestingProbe.probedTargetKind ===
								"section_header_interactive_control_bottom_edge_inner_side",
						),
				),
				"Recent 列排序下拉框底沿被取点",
			).toBe(true);
			for (const hitTesting of homePageSectionColumnFirstRowHitTestingEvidence) {
				const hitTestingLabel = `首页 ${hitTesting.sectionTestId} 首行（${hitTesting.firstRowInPlaceExpansionState}）`;
				expect(hitTesting.inListExpansionTogglePointerEvents, `${hitTestingLabel} 动作组可点`).toBe("auto");
				expect(
					hitTesting.inListExpansionToggleExtendedHitAreaCornerHitsToggle,
					`${hitTestingLabel} 开关命中区生效且没被列裁掉`,
				).toBe(true);
				for (const hitTestingProbe of hitTesting.hitTestingProbes) {
					const hitTestingProbeLabel = `${hitTestingLabel} ${hitTestingProbe.probedTargetKind} ${hitTestingProbe.probedHeaderControlDescription ?? ""} (${hitTestingProbe.probeXPx}, ${hitTestingProbe.probeYPx}) 命中 ${hitTestingProbe.hitElementDescription}`;
					expect(hitTestingProbe.hitElementIsInsideHoverActionGroup, `${hitTestingProbeLabel}：不得截走`).toBe(
						false,
					);
					if (hitTestingProbe.hitElementIsInsideProbedHeaderControl !== null) {
						expect(
							hitTestingProbe.hitElementIsInsideProbedHeaderControl,
							`${hitTestingProbeLabel}：应命中列 header 控件`,
						).toBe(true);
					}
				}
			}
			recordCheck(
				"阶段 7 各列首行 hover 动作组与展开开关命中区顶边不高于列 header 底边、不被列滚动容器上沿裁掉，hover 时 elementFromPoint 在排序下拉框底沿命中控件本身",
			);
			// 列内三态：精简行 → hover 原地展开 → 固定展开，标题首行与开关同一坐标，动作组叠在首行上方不压字。
			await homePageRow("remaining", betaInProgressGeometryAnchorId).waitFor();
			const homePageCompactRowGeometry = await measureCompactRow(
				betaInProgressGeometryAnchorId,
				homePageRow("remaining", betaInProgressGeometryAnchorId),
			);
			await homePageRow("remaining", betaInProgressGeometryAnchorId).locator("button:visible").first().hover();
			await homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "expanded_in_place_by_hover")
				.locator("[data-task-card-title]")
				.filter({ hasText: "进行中几何锚点" })
				.waitFor();
			const homePageHoverExpandedRowGeometry = await measureExpandedRow(
				homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "expanded_in_place_by_hover"),
			);
			await homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "expanded_in_place_by_hover")
				.getByTestId(inListExpansionToggleTestId)
				.filter({ visible: true })
				.click();
			await homePageRowInExpansionState(
				"remaining",
				betaInProgressGeometryAnchorId,
				"kept_expanded_in_list",
			).waitFor();
			const homePageKeptExpandedRowGeometry = await measureExpandedRow(
				homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "kept_expanded_in_list"),
			);
			for (const [expandedGeometryLabel, expandedGeometry] of [
				["hover 展开", homePageHoverExpandedRowGeometry],
				["固定展开", homePageKeptExpandedRowGeometry],
			] as const) {
				expectSamePlacementWithinOnePixel(
					expandedGeometry.row,
					homePageCompactRowGeometry.row,
					`首页 Recent 列${expandedGeometryLabel} 行`,
				);
				expectSamePlacementWithinOnePixel(
					expandedGeometry.title,
					homePageCompactRowGeometry.title,
					`首页 Recent 列${expandedGeometryLabel} 标题`,
				);
				expectSamePlacementWithinOnePixel(
					expandedGeometry.toggle,
					homePageCompactRowGeometry.toggle,
					`首页 Recent 列${expandedGeometryLabel} 开关`,
				);
				expectHoverActionGroupAboveFirstLine(expandedGeometry, `首页 Recent 列${expandedGeometryLabel}`);
			}
			expectHoverActionGroupAboveFirstLine(homePageCompactRowGeometry, "首页 Recent 列精简行");
			titleAndToggleGeometryEvidence.board_scope_home_page_recent_column_other_project_in_progress_without_session =
				{
					compactRowGeometry: homePageCompactRowGeometry,
					hoverExpandedGeometry: homePageHoverExpandedRowGeometry,
					keptExpandedGeometry: homePageKeptExpandedRowGeometry,
				};
			await homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "kept_expanded_in_list")
				.getByTestId(inListExpansionToggleTestId)
				.filter({ visible: true })
				.click();
			await homePageRowInExpansionState("remaining", betaInProgressGeometryAnchorId, "compact_row").waitFor();
			await leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse();
			recordCheck("阶段 7 列内精简行 / hover 原地展开 / 固定展开三态标题首行左上角相差 ≤1px、展开开关同一坐标");
			// 列内往下挪到下一行：与阶段 6 同一个测量函数，滚动容器换成 Recent 列。
			const boardScopeHomePageRecentColumnHandOffMeasurementScrollContainerHost: CrossProjectTaskSwitcherHandOffMeasurementScrollContainerHost =
				{
					scrollContainer: homePageSectionColumnScrollContainer("remaining"),
					remainingSectionSelector: homePageSectionColumnSelector("remaining"),
					leaveScrollContainerAndWaitForHoverExpansionToCollapse:
						leaveHomePageSectionColumnsAndWaitForHoverExpansionToCollapse,
				};
			await measureHandOffToNextRowBelow(
				"board_scope_home_page_recent_column_hand_off_viewport_1000px",
				boardScopeHomePageRecentColumnHandOffMeasurementScrollContainerHost,
			);
			await page.setViewportSize({ width: 1600, height: 420 });
			await measureHandOffToNextRowBelow(
				"board_scope_home_page_recent_column_hand_off_viewport_420px_scrollable",
				boardScopeHomePageRecentColumnHandOffMeasurementScrollContainerHost,
			);
			recordCheck(
				"阶段 7 列内往下挪到下一行：交接一次、不连锁；列表占位、行坐标、scrollTop 与 scrollHeight 保持不变",
			);
			// 点行进 Focus View（首页被卸载），Back 回首页：Recent 列的滚动位置原样还原。矮视口下 Recent 列可滚。
			const homePageRecentColumnScrollContainer = homePageSectionColumnScrollContainer("remaining");
			await homePageRecentColumnScrollContainer.evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await waitForNextObservation(300);
			const homePageRecentColumnScrollTopBeforeOpeningTaskPx = await homePageRecentColumnScrollContainer.evaluate(
				(element) => element.scrollTop,
			);
			expect(homePageRecentColumnScrollTopBeforeOpeningTaskPx, "矮视口下 Recent 列可滚").toBeGreaterThan(0);
			await homePageRow("pinned", focusId).locator("button:visible").first().click();
			await observeUntil(async () => page.url().includes(`task=${focusId}`), "首页点行进 Focus View");
			await boardScopeHomePage.waitFor({ state: "detached" });
			await page.getByRole("button", { name: "Back to board", exact: true }).click();
			await boardScopeHomePage.waitFor();
			const homePageRecentColumnScrollTopAfterBackPx = await homePageRecentColumnScrollContainer.evaluate(
				(element) => element.scrollTop,
			);
			titleAndToggleGeometryEvidence.board_scope_home_page_recent_column_scroll_top_across_focus_view_round_trip = {
				homePageRecentColumnScrollTopBeforeOpeningTaskPx,
				homePageRecentColumnScrollTopAfterBackPx,
			};
			expect(
				Math.abs(homePageRecentColumnScrollTopAfterBackPx - homePageRecentColumnScrollTopBeforeOpeningTaskPx),
				"Back 回首页后 Recent 列滚动位置保留",
			).toBeLessThanOrEqual(1);
			recordCheck("阶段 7 点首页的行进 Focus View，Back 回首页后列滚动位置保留");
			await page.setViewportSize({ width: 1600, height: 1000 });
			await runtimeClient(alphaWorkspaceId).taskCardAction.setTaskPinboardPinStateOfTaskCard.mutate({
				taskPinboardPinAction: "unpin_task_card",
				taskId: focusId,
			});
			await page.locator(homePageSectionColumnSelector("pinned")).waitFor({ state: "detached" });
			writeFileSync(
				join(evidenceOutputDirectory, "cross-project-row-title-and-toggle-geometry.json"),
				JSON.stringify(titleAndToggleGeometryEvidence, null, 2),
			);
			// 顶栏 All projects 按钮（Layers）与 ⌘⇧E / Ctrl+Shift+E 是同一个处理器：tooltip 写明快捷键；收窄到当前项目看板后切回首页。
			const boardScopeToggleButton = page.getByTestId("toggle-board-scope-all-projects-button");
			await boardScopeToggleButton.hover();
			await page
				.getByRole("tooltip")
				.filter({ hasText: /^Show only the current project \((⌘⇧E|Ctrl\+Shift\+E)\)$/ })
				.first()
				.waitFor();
			await boardScopeToggleButton.click();
			await boardScopeHomePage.waitFor({ state: "detached" });
			await page.locator('[data-column-id="backlog"]').first().waitFor();
			expect(await boardScopeToggleButton.getAttribute("aria-pressed")).toBe("false");
			expect(page.url()).toContain(`/${alphaWorkspaceId}`);
			await page.mouse.move(800, 600);
			await page.keyboard.press("ControlOrMeta+Shift+e");
			await boardScopeHomePage.waitFor();
			expect(await boardScopeToggleButton.getAttribute("aria-pressed")).toBe("true");
			recordCheck(
				"顶栏 All projects 按钮 tooltip 写明 ⌘⇧E / Ctrl+Shift+E，点它收窄到当前项目看板，新快捷键切回 All projects 首页",
			);
			// 移动端放不下多列：首页回落竖排的切换面板。
			await page.setViewportSize({ width: 700, height: 900 });
			await page.locator('[data-testid="board-scope-all-projects-home-page-stacked-panel-on-mobile"]').waitFor();
			await page.locator('[data-testid="cross-project-recently-active-task-switcher-panel"]').waitFor();
			await page.screenshot({
				path: join(evidenceOutputDirectory, "board-scope-all-projects-home-page-mobile-stacked-panel.png"),
			});
			await page.setViewportSize({ width: 1600, height: 1000 });
			await boardScopeHomePage.waitFor();
			recordCheck("移动端视口下 All projects 首页回落竖排切换面板");

			await page.evaluate(() => {
				sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "single_project_scope");
				localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "single_project_scope");
			});
			await page.goto(`${webUiOrigin}/${alphaWorkspaceId}?task=${focusId}`);
			await observeUntil(
				async () => (await card(dragStartId).textContent())?.includes("+1") === true,
				"This project 紧凑卡 git 统计",
			);
			expect(await card(dragStartId).textContent()).toContain("隔离 agent 桩已完成一轮");
			for (const iconClass of ["lucide-clock", "lucide-activity", "lucide-messages-square", "lucide-arrow-up"]) {
				expect(await card(dragStartId).locator(`.${iconClass}`).count(), iconClass).toBeGreaterThan(0);
			}
			await card(dragStartId).locator("[data-task-resource-usage-pill]").waitFor();
			await clickCardAction(dragStartId, "Pin task to pinboard");
			await page
				.getByRole("dialog")
				.filter({ hasText: /Pin task|Pin to/ })
				.getByRole("button", { name: /Pin/ })
				.last()
				.click();
			await observeUntil(
				async () => (await taskState(dragStartId)).card?.pinnedToTaskPinboardAt != null,
				"紧凑卡置顶分身",
			);
			const pinnedCopy = page
				.locator('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]')
				.filter({ hasText: "拖放启动" });
			await pinnedCopy.waitFor();
			expect(await pinnedCopy.locator("[data-task-card-compact-metadata-row]").count()).toBe(1);
			expect(await pinnedCopy.textContent()).toContain("Review");
			await page.mouse.move(800, 600);
			await page.screenshot({
				path: join(evidenceOutputDirectory, "compact-card-this-project-canonical-and-pinboard.png"),
			});
			recordCheck("阶段 5 This project 紧凑卡：标题、agent、活动、三颗时长、目录/git、资源与置顶分身截图");
			await page.goto(`${webUiOrigin}/${alphaWorkspaceId}?task=${dragStartId}`);
			await page.setViewportSize({ width: 1600, height: 650 });
			await card(dragStartId).waitFor({ state: "attached" });
			await page.locator(".kb-detail-task-list-scroll").evaluate((element) => {
				element.scrollTop = 0;
			});
			const focusedCardRailCopy = page.locator(
				'[data-task-card-render-role="focused_card_copy_under_sticky_stage_header"]',
			);
			await focusedCardRailCopy.waitFor();
			expect(await focusedCardRailCopy.textContent()).toContain("拖放启动");
			expect(await focusedCardRailCopy.textContent()).toContain("隔离 agent 桩已完成一轮");
			expect(await focusedCardRailCopy.locator("[data-task-card-compact-metadata-row]").count()).toBe(1);
			expect(await focusedCardRailCopy.locator("[data-task-directory]").textContent()).toContain("+1");
			await page.screenshot({
				path: join(evidenceOutputDirectory, "compact-card-this-project-focused-stage-header-rail.png"),
			});
			recordCheck("阶段 5 rail 焦点卡克隆保留相同标题、活动和目录/git 内容");
			const actorEnvironment = {
				KANBAN_PROJECT_PATH: firstProject.repositoryPath,
				KANBAN_TASK_ID: dragStartId,
				KANBAN_TASK_CONVERSATION_SESSION_ID: dragStartId,
			};
			await runCli(
				["task", "set-current-work-phase-goal", "--goal", "验证当前阶段的最终行为"],
				firstProject.repositoryPath,
				actorEnvironment,
			);
			await observeUntil(
				async () =>
					(await taskState(dragStartId)).summary?.agentCurrentWorkPhaseGoal?.goalText === "验证当前阶段的最终行为",
				"CLI 写入阶段目标",
			);
			await page
				.locator('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]')
				.filter({ hasText: "拖放启动" })
				.locator("[data-agent-current-work-phase-goal]")
				.waitFor();
			await focusedCardRailCopy.locator("[data-agent-current-work-phase-goal]").waitFor();
			expect(await page.locator("[data-agent-current-work-phase-goal]").count()).toBeGreaterThanOrEqual(3);
			await runCli(
				[
					"task",
					"rename-current-task",
					"--title",
					"[FIX,UI]验证 Task 名称与阶段目标",
					"--reason",
					"已核对完整任务范围",
				],
				firstProject.repositoryPath,
				actorEnvironment,
			);
			expect((await taskState(dragStartId)).card?.taskCommentEntries?.at(-1)?.commentText).toContain(
				"已核对完整任务范围",
			);
			const commentsBeforeRetry = (await taskState(dragStartId)).card?.taskCommentEntries?.length;
			await runCli(
				["task", "rename-current-task", "--title", "[FIX,UI]验证 Task 名称与阶段目标", "--reason", "同名重试"],
				firstProject.repositoryPath,
				actorEnvironment,
			);
			expect((await taskState(dragStartId)).card?.taskCommentEntries?.length).toBe(commentsBeforeRetry);
			await expect(
				runCli(
					["task", "rename-current-task", "--title", "不得改名", "--reason", "身份缺失"],
					firstProject.repositoryPath,
				),
			).rejects.toThrow("隔离 CLI 失败");
			const byTheWayConversationId = "task-conversation-session-isolated-phase-goal";
			const byTheWayStart = await runtimeClient(alphaWorkspaceId).runtime.startTaskSession.mutate({
				taskId: byTheWayConversationId,
				workspaceTaskId: dragStartId,
				prompt: "旁支问题",
				baseRef: "main",
				agentId: "claude",
				taskConversationSessionMetadata: {
					workspaceTaskId: dragStartId,
					taskConversationSessionRole: "by_the_way",
					taskConversationSessionContextSource: "started_from_scratch",
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: "旁支问题",
				},
			});
			expect(byTheWayStart.ok).toBe(true);
			await runCli(
				["task", "set-current-work-phase-goal", "--goal", "只属于旁支的阶段目标"],
				firstProject.repositoryPath,
				{ ...actorEnvironment, KANBAN_TASK_CONVERSATION_SESSION_ID: byTheWayConversationId },
			);
			expect((await taskState(dragStartId)).summary?.agentCurrentWorkPhaseGoal?.goalText).toBe(
				"验证当前阶段的最终行为",
			);
			expect((await taskState(byTheWayConversationId)).summary?.agentCurrentWorkPhaseGoal?.goalText).toBe(
				"只属于旁支的阶段目标",
			);
			await expect(
				runCli(["task", "set-current-work-phase-goal", "--goal", "不属于这个 Task"], firstProject.repositoryPath, {
					...actorEnvironment,
					KANBAN_TASK_ID: focusId,
					KANBAN_TASK_CONVERSATION_SESSION_ID: byTheWayConversationId,
				}),
			).rejects.toThrow("隔离 CLI 失败");
			await runCli(["task", "clear-current-work-phase-goal"], firstProject.repositoryPath, actorEnvironment);
			expect((await taskState(dragStartId)).summary?.agentCurrentWorkPhaseGoal).toBeNull();
			recordCheck("CLI 自改名按环境归属且同名幂等；阶段目标同步主卡、置顶分身、rail 与会话详情");

			await page.setViewportSize({ width: 1600, height: 1000 });
			const namingBacklogId = await createTask(firstProject.repositoryPath, "Backlog 已保存名称");
			await observeUntil(async () => (await card(namingBacklogId).count()) > 0, "新 Backlog 卡广播");
			await clickCardAction(namingBacklogId, "Pin task to pinboard");
			const namingPinDialog = page.getByRole("dialog").filter({ hasText: /Pin task|Pin to/ });
			if (await namingPinDialog.count()) await namingPinDialog.getByRole("button", { name: /Pin/ }).last().click();
			// 置顶副本是乐观渲染的，比置顶命令返回得早；命令在途时保存会被浏览器侧按卡幂等闸拒绝（编辑存回草稿并提示）。
			// 等置顶落盘、在途请求清空，再打开编辑器。
			await observeUntil(
				async () => (await taskState(namingBacklogId)).card?.pinnedToTaskPinboardAt != null,
				"Backlog 卡置顶落盘",
			);
			await observeUntil(async () => pendingTaskCardActionRequests.size === 0, "置顶请求完成");
			const compactNamingCard = page
				.locator('[data-task-card-render-role="pinned_card_copy_in_task_pinboard"]')
				.filter({ hasText: "Backlog 已保存名称" });
			await compactNamingCard.waitFor();
			await compactNamingCard.hover();
			const pencil = compactNamingCard.getByRole("button", { name: "Edit task title", exact: true });
			const pencilCenterHitsPencil = await pencil.evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				return element.contains(
					element.ownerDocument.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
				);
			});
			expect(pencilCenterHitsPencil).toBe(true);
			await pencil.click();
			const namingEditor = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
			expect(await namingEditor.getByLabel("Task name", { exact: true }).inputValue()).toBe("Backlog 已保存名称");
			await namingEditor.getByLabel("Task name", { exact: true }).fill("[FIX,UI]补齐 Backlog 名称编辑");
			await namingEditor.getByRole("button", { name: "Save changes", exact: true }).click();
			await observeUntil(
				async () => (await taskState(namingBacklogId)).card?.title === "[FIX,UI]补齐 Backlog 名称编辑",
				"Backlog 名称保存",
			);
			expect((await taskState(namingBacklogId)).columnId).toBe("backlog");
			expect((await taskState(namingBacklogId)).summary?.pid ?? null).toBeNull();
			await page.screenshot({
				path: join(evidenceOutputDirectory, "task-naming-compact-backlog-pencil-and-phase-goal.png"),
			});
			recordCheck("compact pinboard 编辑按钮中心命中 Pencil，名称预填并保存，不会意外启动 Task");

			// 真实浏览器仍持有启动响应时放行 AI，覆盖回填撞交互锁的窗口，不调用外部模型。
			for (const entry of ["同项目单卡", "跨项目单卡", "清空名称保存后启动"]) {
				const workspaceId = entry === "跨项目单卡" ? betaWorkspaceId : alphaWorkspaceId;
				const suggestedTitle = `[FIX]${entry}后台回填已生效`;
				const prompt = `${entry}起名竞争验证`;
				let releaseSuggestion!: () => void;
				let releaseStartResponse!: () => void;
				const suggestionMayReturn = new Promise<void>((resolve) => {
					releaseSuggestion = resolve;
				});
				const startResponseMayReturn = new Promise<void>((resolve) => {
					releaseStartResponse = resolve;
				});
				let startResponseIsHeld = false;
				let suggestionRequestCount = 0;
				const suggestionRoute = "**/api/trpc/*runtime.suggestTaskNamesFromTaskDescription*";
				const startRoute = "**/api/trpc/taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress*";
				await page.route(suggestionRoute, async (route) => {
					suggestionRequestCount += 1;
					// 起名会与 saveConfig 合批；只替换起名响应，其余 procedure 仍由真实 runtime 执行。
					const suggestionProcedureIndex = new URL(route.request().url()).pathname
						.split("/")
						.at(-1)
						?.split(",")
						.indexOf("runtime.suggestTaskNamesFromTaskDescription");
					if (suggestionProcedureIndex === undefined || suggestionProcedureIndex < 0)
						throw new Error("未找到合批请求中的起名 procedure");
					const requestBody: Record<string, unknown> = route.request().postDataJSON();
					requestBody[String(suggestionProcedureIndex)] = { taskDescription: "" };
					const response = await route.fetch({ postData: JSON.stringify(requestBody) });
					const batchResponse: unknown[] = await response.json();
					batchResponse[suggestionProcedureIndex] = {
						result: { data: { status: "suggested", suggestedTaskNames: [suggestedTitle] } },
					};
					await suggestionMayReturn;
					await route.fulfill({ response, json: batchResponse });
				});
				await page.route(startRoute, async (route) => {
					const response = await route.fetch();
					startResponseIsHeld = true;
					await startResponseMayReturn;
					await route.fulfill({ response });
				});
				try {
					await page.evaluate(
						(boardScope) => {
							sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", boardScope);
							localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", boardScope);
						},
						entry === "跨项目单卡" ? "board_scope_all_projects" : "single_project_scope",
					);
					await page.goto(`${webUiOrigin}/${alphaWorkspaceId}${entry === "跨项目单卡" ? `?task=${focusId}` : ""}`);
					if (entry === "跨项目单卡") {
						const runningSectionToggle = page
							.getByTestId("cross-project-task-switcher-section-running")
							.getByRole("button", { name: /^Running/ });
						if ((await runningSectionToggle.getAttribute("aria-expanded")) === "false")
							await runningSectionToggle.click();
					}
					if (entry === "清空名称保存后启动") {
						await clickCardAction(namingBacklogId, "Edit task title");
						const editDialog = page.getByRole("dialog").filter({ hasText: "Edit backlog task" });
						await editDialog.getByLabel("Task name", { exact: true }).fill("");
						await editDialog.getByRole("button", { name: "Save and start", exact: true }).click();
					} else {
						await page.getByRole("button", { name: "Create task", exact: true }).click();
						const createDialog = page.getByRole("dialog").filter({ hasText: "New task" });
						if (entry === "跨项目单卡") {
							await createDialog
								.locator('[data-testid="task-creation-target-project-field"]')
								.getByRole("button")
								.click();
							await page
								.getByRole("button", { name: /e2e-project-beta/ })
								.last()
								.click();
						}
						await createDialog.getByPlaceholder("Describe the task...").fill(prompt);
						await createDialog.getByRole("button", { name: "Start task", exact: true }).click();
					}
					await observeUntil(async () => startResponseIsHeld, "AI 尚未返回时真实 agent 已启动");
					const cards = (await runtimeClient(workspaceId).workspace.getState.query()).board.columns.flatMap(
						(column) => column.cards,
					);
					const taskId =
						entry === "清空名称保存后启动" ? namingBacklogId : cards.find((task) => task.prompt === prompt)?.id;
					if (!taskId) throw new Error("未找到起名竞争验证卡片");
					const beforeBackfill = await taskState(taskId, workspaceId);
					expect(beforeBackfill.columnId).toBe("in_progress");
					expect(beforeBackfill.summary?.pid).toBeTypeOf("number");
					writeFileSync(
						join(evidenceOutputDirectory, `task-ai-name-backfill-${entry}-requests.json`),
						JSON.stringify({ suggestionRequestCount, recentRequests: pageRequests.slice(-30) }, null, 2),
					);
					expect(suggestionRequestCount).toBe(1);
					releaseSuggestion();
					await observeUntil(
						async () => (await taskState(taskId, workspaceId)).card?.title === suggestedTitle,
						"启动响应在途时 AI 回填落盘",
					);
					await page.getByText(suggestedTitle, { exact: true }).first().waitFor();
					expect(suggestionRequestCount).toBe(1);
					releaseStartResponse();
					await observeUntil(async () => pendingTaskCardActionRequests.size === 0, "启动响应完成");
					expect((await taskState(taskId, workspaceId)).card?.title).toBe(suggestedTitle);
					await page.screenshot({ path: join(evidenceOutputDirectory, `task-ai-name-backfill-${entry}.png`) });
					recordCheck(`${entry}：AI 与真实 PTY 启动独立，启动响应在途时回填落盘并广播`);
				} finally {
					releaseSuggestion();
					releaseStartResponse();
					await page.unroute(suggestionRoute);
					await page.unroute(startRoute);
				}
			}

			await runCli(
				["task", "set-current-work-phase-goal", "--goal", "跨运行时重启保留的阶段目标"],
				firstProject.repositoryPath,
				actorEnvironment,
			);
			const phaseGoalBeforeRestart = (await taskState(dragStartId)).summary?.agentCurrentWorkPhaseGoal;
			initialRuntimeProcess.send({ type: "kanban.shutdown" });
			await observeUntil(async () => hasChildProcessExited(initialRuntimeProcess), "隔离 runtime 优雅退出");
			startOwnedProcess(
				"isolated-runtime-after-restart",
				process.execPath,
				[...nodeCliArguments, "--port", String(runtimePort), "--no-open", "--no-passcode"],
				firstProject.repositoryPath,
			);
			await observeUntil(async () => {
				try {
					return (
						JSON.stringify((await taskState(dragStartId)).summary?.agentCurrentWorkPhaseGoal) ===
						JSON.stringify(phaseGoalBeforeRestart)
					);
				} catch {
					return false;
				}
			}, "阶段目标跨运行时进程重启持久保存");
			expect((await taskState(dragStartId)).card?.title).toBe("[FIX,UI]验证 Task 名称与阶段目标");
			recordCheck("当前主对话与旁支目标分别归属；错误 Task 身份被拒绝；目标与名称跨 runtime 重启保存");

			expect(pageErrors).toEqual([]);
			expect(pageRequests.some((url) => url.includes(":3484/"))).toBe(false);
			expect(pageRequests.some((url) => url.includes("workspace.setTaskPinboardPinStateOfTaskCard"))).toBe(false);
			expect(pageRequests.some((url) => url.includes("taskCardAction.setTaskPinboardPinStateOfTaskCard"))).toBe(
				true,
			);
			writeFileSync(
				join(evidenceOutputDirectory, "browser-check-results.json"),
				JSON.stringify({ checks, pageErrors, runtimePort, webUiPort }, null, 2),
			);
		} finally {
			const captureDiagnosticBestEffort = async (capture: () => unknown | Promise<unknown>) => {
				try {
					await capture();
				} catch (error) {
					console.warn("隔离浏览器诊断采集失败，继续清理", error);
				}
			};
			try {
				await captureDiagnosticBestEffort(() =>
					writeFileSync(
						join(evidenceOutputDirectory, "task-card-action-browser-requests.json"),
						JSON.stringify(taskCardActionRequestEvidence, null, 2),
					),
				);
				const lastPage = browser?.contexts()[0]?.pages()[0];
				if (lastPage) {
					await captureDiagnosticBestEffort(() =>
						lastPage.screenshot({ path: join(evidenceOutputDirectory, "last-browser-state.png") }),
					);
					await captureDiagnosticBestEffort(async () =>
						writeFileSync(join(evidenceOutputDirectory, "last-browser-state.html"), await lastPage.content()),
					);
				}
				await captureDiagnosticBestEffort(() =>
					writeFileSync(
						join(evidenceOutputDirectory, "owned-process-identities.json"),
						JSON.stringify(
							processEvidence.map(({ pid, role, child }) => ({
								pid,
								role,
								spawnedPidMatches: child.pid === pid,
							})),
							null,
							2,
						),
					),
				);
			} finally {
				try {
					await browser?.close();
				} finally {
					try {
						// 只处理启动时记录的子进程对象与 PID，不按端口/名称扫杀；身份核实先于发信号。
						for (const { child, pid } of processEvidence.reverse()) {
							expect(child.pid, "隔离进程身份不匹配，拒绝发送停止信号").toBe(pid);
							if (!hasChildProcessExited(child)) child.kill("SIGINT");
							await observeUntil(async () => hasChildProcessExited(child), "隔离进程退出");
						}
					} finally {
						await spawnedChildProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit();
					}
				}
			}
		}
	},
	300000,
);
