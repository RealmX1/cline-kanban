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
		async function runCli(arguments_: string[], cwd: string) {
			const child = spawnedChildProcessRegistry.register(
				spawn(process.execPath, [...nodeCliArguments, ...arguments_], {
					cwd,
					env: environment,
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
			startOwnedProcess(
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
			await row(dragStartId).locator("button").first().hover();
			const hoverCard = page.locator('[data-testid="cross-project-task-switcher-row-full-task-card-hover-overlay"]');
			await hoverCard.waitFor();
			await hoverCard.getByText("拖放启动", { exact: true }).waitFor();
			const hoverDirectory = hoverCard.locator("[data-task-directory]");
			await hoverDirectory.waitFor();
			await observeUntil(
				async () => (await hoverDirectory.textContent())?.includes("+1") === true,
				"hover 目录行 git 统计",
			);
			expect(await hoverDirectory.locator(".lucide-arrow-up").count()).toBe(1);
			await hoverCard.getByRole("button", { name: "Keep open", exact: true }).click();
			const expandedCard = row(dragStartId).locator("[data-task-directory]");
			await expandedCard.waitFor();
			expect(await expandedCard.textContent()).toContain("+1");
			expect(await expandedCard.locator(".lucide-arrow-up").count()).toBe(1);
			await page.screenshot({
				path: join(evidenceOutputDirectory, "compact-card-current-project-polled-worktree.png"),
			});
			recordCheck("当前项目非焦点卡 hover 与 Keep open 完整卡有目录、领先提交与未提交统计（阶段 5 截图）");
			await row(betaId).locator("button").first().hover();
			await hoverCard.waitFor();
			await hoverCard.getByText("别的项目任务", { exact: true }).waitFor();
			await hoverCard.getByTestId("cross-project-task-switcher-full-task-card").hover();
			await hoverCard.getByRole("button", { name: "Move task to validation", exact: true }).click();
			await assertColumn(betaId, "validation", betaWorkspaceId);
			expect(page.url()).toContain(`/${alphaWorkspaceId}`);
			recordCheck("对别的项目卡执行动作，当前项目与焦点不变");
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
			await row(createdByKeyboardId).click();
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
			recordCheck("任意项目 backlog 原地编辑，保存只改过的字段并保留并发改名");
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
