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
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

// 显式启用真实浏览器检查，普通根套件不依赖 Chromium 安装；所有实体、PTY、账本都在 fixture HOME 内。
const runRealBrowserCheck = process.env.KANBAN_RUN_ISOLATED_CROSS_PROJECT_CARD_ACTION_REAL_BROWSER_CHECK === "1";
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
		const webUiOrigin = `http://127.0.0.1:${webUiPort}`;
		const isolatedExecutableDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-stub-executables");
		mkdirSync(isolatedExecutableDirectory);
		const agentLaunchEvidencePath = join(fixture.fixtureRootDirectoryPath, "isolated-agent-launch-evidence.jsonl");
		writeFileSync(
			join(isolatedExecutableDirectory, "claude"),
			`#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version') || process.argv.includes('--help')) { console.log('2.1.288 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.ISOLATED_AGENT_LAUNCH_EVIDENCE_PATH, JSON.stringify({ pid: process.pid, cwd: process.cwd(), resumePriorConversation: process.argv.includes('--continue') || process.argv.includes('--resume') }) + '\\n');
process.stdout.write('Claude Code v2.1.288\\n> ');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', bytes => { if (bytes.includes(3)) process.exit(0); });
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
		});
		const nodeCliArguments = [
			"--require",
			join(sourceCheckoutPath, "test/integration/shutdown-ipc-hook.cjs"),
			"--import",
			requireFromSourceCheckout.resolve("tsx"),
			join(sourceCheckoutPath, "src/cli.ts"),
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
			if (child.exitCode !== 0) throw new Error(`隔离 CLI 失败：${stderr}`);
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
export default { ...baseConfiguration, cacheDir: ${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-dependency-cache"))}, server: { ...baseConfiguration.server, host: "127.0.0.1", port: ${webUiPort}, strictPort: true, proxy: { "/api": { target: ${JSON.stringify(runtimeOrigin)}, changeOrigin: true, ws: true, headers: { origin: ${JSON.stringify(runtimeOrigin)} } } } } };`,
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
			page.on("pageerror", (error) => pageErrors.push(error.message));
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
			const card = (taskId: string) => page.locator(`[data-task-id="${taskId}"]`).first();
			const clickCardAction = async (taskId: string, action: string) => {
				await card(taskId).hover();
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
			const measureCompactRow = async (taskId: string, compactRow = row(taskId)) => {
				return {
					row: await measureRect(compactRow),
					title: await measureRect(compactRow.locator("[data-cross-project-task-switcher-row-title]")),
					toggle: await measureRect(compactRow.getByTestId(inListExpansionToggleTestId)),
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
				toggle: await measureRect(expandedRow.getByTestId(inListExpansionToggleTestId)),
			});
			const hoverRowUntilExpandedInPlace = async (taskId: string, title: string) => {
				await row(taskId).locator("button").first().hover();
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
			for (const [taskId, title, geometryCaseLabel] of [
				[betaInProgressGeometryAnchorId, "进行中几何锚点", "other_project_in_progress_without_session"],
				[betaId, "别的项目任务", "other_project_review"],
			] as const) {
				await row(taskId).waitFor();
				const compactRowGeometry = await measureCompactRow(taskId);
				const expandedRowGeometry = await measureExpandedRow(await hoverRowUntilExpandedInPlace(taskId, title));
				// 原地展开：行的上沿与左沿不动，只向下长。
				expectSamePlacementWithinOnePixel(
					expandedRowGeometry.row,
					compactRowGeometry.row,
					`${geometryCaseLabel} 行`,
				);
				expect(expandedRowGeometry.row.height).toBeGreaterThan(compactRowGeometry.row.height);
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
				titleAndToggleGeometryEvidence[geometryCaseLabel] = { compactRowGeometry, expandedRowGeometry };
				await leavePanelAndWaitForHoverExpansionToCollapse();
			}

			// 往下挪到下一行：上一行不在离开时收起，下一行停够意图时长后交接；收起的行在上方，新行被带着上移的距离
			// 先由面板滚动补回，scrollTop 不够时差额垫成面板顶部空白——两种视口下新行都停在指针下不动。
			// 之后指针静止，不得再有任何展开 / 收起。
			const measureHandOffToNextRowBelow = async (handOffCaseLabel: string) => {
				const remainingRowTaskIds = await page
					.locator(
						'[data-testid="cross-project-task-switcher-section-remaining"] [data-cross-project-task-switcher-task-id]',
					)
					.evaluateAll((rows) =>
						rows.map((element) => element.getAttribute("data-cross-project-task-switcher-task-id")),
					);
				const upperTaskId = remainingRowTaskIds.at(-2);
				const lowerTaskId = remainingRowTaskIds.at(-1);
				if (!upperTaskId || !lowerTaskId) throw new Error("Recent 区不足两行，无法验证交接");
				// 同一个任务可能也在 Pinned：只认 Recent 区里的那两行。
				const remainingRow = (taskId: string) =>
					page
						.locator('[data-testid="cross-project-task-switcher-section-remaining"]')
						.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
				const remainingRowExpandedByHover = (taskId: string) =>
					remainingRow(taskId).and(
						page.locator(`[${rowInPlaceExpansionStateAttribute}="expanded_in_place_by_hover"]`),
					);
				await panel.evaluate((element) => {
					element.scrollTop = element.scrollHeight;
				});
				const upperRowCompactHeight = (await measureRect(remainingRow(upperTaskId))).height;
				await remainingRow(upperTaskId).locator("button").first().hover();
				await remainingRowExpandedByHover(upperTaskId).waitFor();
				const upperRowGrowthPx = (await measureRect(remainingRow(upperTaskId))).height - upperRowCompactHeight;
				// 展开后内容变高：再滚到底，让下一行进入视野（也让面板有尽量多的滚动余量）。
				await panel.evaluate((element) => {
					element.scrollTop = element.scrollHeight;
				});
				const panelScrollTopBeforeHandOffPx = await panel.evaluate((element) => element.scrollTop);
				const lowerRowCompactGeometry = await measureCompactRow(lowerTaskId, remainingRow(lowerTaskId));
				// 根 tsconfig 不带 DOM lib：浏览器端脚本以字符串交给页面执行。
				await page.evaluate(`(() => {
					const attributeName = ${JSON.stringify(rowInPlaceExpansionStateAttribute)};
					const recordedExpansionStateChanges = [];
					window.recordedExpansionStateChanges = recordedExpansionStateChanges;
					new MutationObserver((mutations) => {
						for (const mutation of mutations) {
							recordedExpansionStateChanges.push(
								mutation.target.getAttribute("data-cross-project-task-switcher-task-id") + ":" + mutation.target.getAttribute(attributeName),
							);
						}
					}).observe(document.querySelector('[data-testid="cross-project-recently-active-task-switcher-panel"]'), {
						subtree: true,
						attributes: true,
						attributeFilter: [attributeName],
					});
				})()`);
				const pointerX = lowerRowCompactGeometry.row.left + lowerRowCompactGeometry.row.width * 0.4;
				const pointerY = lowerRowCompactGeometry.row.top + 6;
				await page.mouse.move(pointerX, pointerY, { steps: 4 });
				await remainingRowExpandedByHover(lowerTaskId).waitFor();
				const lowerRowExpandedGeometry = await measureExpandedRow(remainingRowExpandedByHover(lowerTaskId));
				// 指针静止 1.2s：布局位移不得引发连锁展开 / 收起。
				await waitForNextObservation(1200);
				const recordedExpansionStateChanges = (await page.evaluate(
					"window.recordedExpansionStateChanges",
				)) as string[];
				const uncompensablePartOfUpperRowGrowthPx = Math.max(0, upperRowGrowthPx - panelScrollTopBeforeHandOffPx);
				const panelTopPaddingDuringHandOff = await panel.evaluate((element) => element.style.paddingTop);
				const lowerRowTitleShiftPx = lowerRowExpandedGeometry.title.top - lowerRowCompactGeometry.title.top;
				titleAndToggleGeometryEvidence[handOffCaseLabel] = {
					upperTaskId,
					lowerTaskId,
					upperRowGrowthPx,
					panelScrollTopBeforeHandOffPx,
					uncompensablePartOfUpperRowGrowthPx,
					panelTopPaddingDuringHandOff,
					lowerRowTitleShiftPx,
					pointerY,
					lowerRowExpandedGeometry,
					recordedExpansionStateChanges,
				};
				expect(Math.abs(lowerRowTitleShiftPx), `${handOffCaseLabel} 新展开的下一行标题不动`).toBeLessThanOrEqual(
					1.5,
				);
				// scrollTop 不够补时才垫顶部空白。
				expect(panelTopPaddingDuringHandOff === "", `${handOffCaseLabel} 顶部空白`).toBe(
					uncompensablePartOfUpperRowGrowthPx === 0,
				);
				expect(recordedExpansionStateChanges.sort(), `${handOffCaseLabel} 只交接一次、不连锁`).toEqual(
					[`${lowerTaskId}:expanded_in_place_by_hover`, `${upperTaskId}:compact_row`].sort(),
				);
				// 指针仍在新展开的那一行里：再动一下也不会去展开再下一行。
				expect(pointerY).toBeGreaterThanOrEqual(lowerRowExpandedGeometry.row.top);
				expect(pointerY).toBeLessThan(lowerRowExpandedGeometry.row.top + lowerRowExpandedGeometry.row.height);
				await leavePanelAndWaitForHoverExpansionToCollapse();
				// 收起时顶部空白一并撤掉。
				expect(await panel.evaluate((element) => element.style.paddingTop)).toBe("");
				await panel.evaluate((element) => {
					element.scrollTop = 0;
				});
				return uncompensablePartOfUpperRowGrowthPx;
			};
			// 面板不可滚（scrollTop 0）：差额全部垫成顶部空白。
			expect(await measureHandOffToNextRowBelow("hand_off_to_next_row_below_panel_viewport_1000px")).toBeGreaterThan(
				0,
			);
			// 矮视口：面板可滚，交接时收起的行的增量应当被滚动完全补回。
			await page.setViewportSize({ width: 1600, height: 420 });
			expect(await measureHandOffToNextRowBelow("hand_off_to_next_row_below_panel_viewport_420px_scrollable")).toBe(
				0,
			);
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
				await currentProjectExpandedRow.getByTestId(inListExpansionToggleTestId).evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return element.contains(element.ownerDocument.elementFromPoint(bounds.right + 2, bounds.top - 2));
				}),
			).toBe(true);
			// 展开发生在静止的光标下：开关第一帧就可见、可点（不必先晃一下鼠标）。
			await page.screenshot({
				path: join(evidenceOutputDirectory, "cross-project-row-2-expanded-in-place-by-hover.png"),
				clip: panelBoundingBox,
			});
			await currentProjectExpandedRow.getByTestId(inListExpansionToggleTestId).click();
			const expandedCard = row(dragStartId).locator("[data-task-directory]");
			await expandedCard.waitFor();
			expect(await expandedCard.textContent()).toContain("+1");
			expect(await expandedCard.locator(".lucide-arrow-up").count()).toBe(1);
			expect(await row(dragStartId).getAttribute(rowInPlaceExpansionStateAttribute)).toBe("kept_expanded_in_list");
			const keptExpandedToggle = row(dragStartId).getByTestId(inListExpansionToggleTestId);
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
			// hover 展开 → 固定展开：高度不变，下方的行不动。
			expect(
				Math.abs(currentProjectKeptExpandedGeometry.row.height - currentProjectHoverExpandedGeometry.row.height),
			).toBeLessThanOrEqual(1);
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
				"阶段 6 精简行 / hover 原地展开 / 固定展开三态标题首行左上角相差 ≤1px、展开开关同一坐标（In progress 与 Review、当前与其他项目）",
			);
			recordCheck(
				"阶段 6 往下挪到下一行：交接一次、不连锁；新行停在指针下不动（面板可滚用 scrollTop 补，滚到顶用顶部空白补）",
			);
			const betaExpandedRow = await hoverRowUntilExpandedInPlace(betaId, "别的项目任务");
			await betaExpandedRow.getByRole("button", { name: "Move task to validation", exact: true }).click();
			await assertColumn(betaId, "validation", betaWorkspaceId);
			expect(page.url()).toContain(`/${alphaWorkspaceId}`);
			recordCheck("对别的项目卡执行动作，当前项目与焦点不变");
			// 点展开卡片原来顶条所在的位置（卡框上沿往下 0–18px）= 点精简行：backlog 行原地打开编辑框。
			await leavePanelAndWaitForHoverExpansionToCollapse();
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
			await row(createdByKeyboardId).locator("button").first().hover();
			await rowInPlaceExpandedByHover(createdByKeyboardId).getByTestId(inListExpansionToggleTestId).click();
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

			await page.getByRole("button", { name: /New task$/ }).click();
			await createOtherProjectTaskViaDialog("概览按钮往另一个项目建卡");
			recordCheck("Board Overview New task 入口");

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
