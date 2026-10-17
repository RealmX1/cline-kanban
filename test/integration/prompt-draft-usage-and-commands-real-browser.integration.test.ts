import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType, Page } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const runBrowserCheck = process.env.KANBAN_RUN_PROMPT_DRAFT_USAGE_BROWSER_CHECK === "1";
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!runBrowserCheck)(
	"打包态：提交 hook、跨项目推流、Command 编辑、窄屏及重启持久化",
	async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const sourcePath = resolve(import.meta.dirname, "../..");
		const cliPath = process.env.KANBAN_PROMPT_DRAFT_USAGE_PACKAGED_CLI_PATH;
		if (!cliPath || !existsSync(cliPath))
			throw new Error("必须提供本任务隔离构建的 KANBAN_PROMPT_DRAFT_USAGE_PACKAGED_CLI_PATH");
		const evidencePath =
			process.env.KANBAN_PROMPT_DRAFT_USAGE_BROWSER_EVIDENCE_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "browser-evidence");
		mkdirSync(evidencePath, { recursive: true });
		const projects = ["alpha", "beta"].map((name) =>
			fixture.createNonBareRepository({ repositoryDirectoryName: name }),
		);
		for (const project of projects) {
			writeFileSync(join(project.repositoryPath, "initial.txt"), "隔离浏览器验证\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化隔离仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const reservation = createServer();
		await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
		const address = reservation.address();
		if (!address || typeof address === "string") throw new Error("没有隔离端口");
		const port = address.port;
		await new Promise<void>((done) => reservation.close(() => done()));
		expect(port).not.toBe(3484);
		const origin = `http://127.0.0.1:${port}`;
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(port),
		});
		const shutdownHook = join(sourcePath, "test/integration/shutdown-ipc-hook.cjs");
		const startRuntime = async (label: string) => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", shutdownHook, cliPath, "--port", String(port), "--no-open", "--no-passcode"],
					{ cwd: projects[0].repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.on("exit", () => writeFileSync(join(evidencePath, `${label}.log`), output));
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${origin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		const createTask = async (projectPath: string, name: string) => {
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						shutdownHook,
						cliPath,
						"task",
						"create",
						"--title",
						name,
						"--prompt",
						name,
						"--agent-id",
						"claude",
						"--worktree-mode",
						"inplace",
						"--project-path",
						projectPath,
					],
					{ cwd: projectPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			let output = "";
			let errors = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			if (!(await waitForChildProcessExit(child, 45000)) || child.exitCode !== 0)
				throw new Error(`隔离建卡失败：${errors}`);
			return (JSON.parse(output) as { task: { id: string } }).task.id;
		};
		const requireFromWeb = createRequire(join(sourcePath, "web-ui/package.json"));
		const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
		let browser: Awaited<ReturnType<BrowserType["launch"]>> | null = null;
		const observedPages: Page[] = [];
		let runtime = await startRuntime("runtime-before-restart");
		try {
			const taskIds = await Promise.all(
				projects.map((project, index) => createTask(project.repositoryPath, `隔离草稿验证 ${index}`)),
			);
			const availableProjects = (await client().projects.list.query()).projects;
			const workspaceIds = projects.map((project) => {
				const id = availableProjects.find((entry) => entry.path === project.repositoryPath)?.id;
				if (!id) throw new Error("隔离项目未注册");
				return id;
			});
			for (let index = 0; index < workspaceIds.length; index += 1) {
				const scoped = client(workspaceIds[index]);
				const state = await scoped.workspace.getState.query();
				const taskId = taskIds[index];
				const backlog = state.board.columns.find((column) => column.id === "backlog");
				const card = backlog?.cards.find((entry) => entry.id === taskId);
				if (!backlog || !card) throw new Error("隔离任务缺失");
				backlog.cards = backlog.cards.filter((entry) => entry.id !== taskId);
				state.board.columns.find((column) => column.id === "review")?.cards.push(card);
				state.sessions[taskId] = {
					taskId,
					agentId: "claude",
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					workspacePath: projects[index].repositoryPath,
					pid: null,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: null,
					reviewReason: "hook",
					exitCode: 0,
					lastHookAt: null,
					latestHookActivity: null,
				};
				await scoped.workspace.saveState.mutate({
					board: state.board,
					sessions: state.sessions,
					expectedRevision: state.revision,
				});
			}
			const scoped = client(workspaceIds[0]);
			const draftTexts = [
				"请完整保存所有项目的通知历史以及每次筛选结果方便之后复核",
				"请修复当前项目的登录页面并补充完整的自动化测试",
				"请检查当前任务的按钮状态以及失败时的提示文字",
			];
			for (const [index, scope] of (["global", "repo", "task"] as const).entries())
				await scoped.runtime.mutateWorkspacePromptLibrary.mutate({
					mutation: {
						kind: "upsert_prompt",
						promptId: `draft-${index}`,
						text: draftTexts[index],
						scope,
						taskId: taskIds[0],
					},
				});
			browser = await chromium.launch({ headless: true });
			const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
			const page = await context.newPage();
			const otherProjectContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
			const otherProjectPage = await otherProjectContext.newPage();
			observedPages.push(page, otherProjectPage);
			const pageErrors: string[] = [];
			const promptLibraryFrames: string[] = [];
			const promptLibraryRequests: string[] = [];
			page.on("websocket", (socket) =>
				socket.on("framereceived", (frame) => {
					if (typeof frame.payload === "string" && frame.payload.includes("prompt_library_updated"))
						promptLibraryFrames.push(frame.payload);
				}),
			);
			page.on("request", (request) => {
				if (request.url().includes("getWorkspacePromptLibrary")) promptLibraryRequests.push(request.url());
			});
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.goto(`${origin}/${workspaceIds[0]}?task=${taskIds[0]}`);
			await otherProjectPage.goto(`${origin}/${workspaceIds[1]}?task=${taskIds[1]}`);
			for (const openedPage of observedPages)
				await openedPage
					.getByRole("dialog")
					.filter({ hasText: "Get started" })
					.getByRole("button", { name: "Close", exact: true })
					.click({ timeout: 10000 });
			await page.getByRole("tab", { name: "Prompts", exact: true }).click();
			await otherProjectPage.getByRole("tab", { name: "Prompts", exact: true }).click();
			await expect
				.poll(
					async () =>
						Promise.all(
							(await page.locator("[data-prompt-library-entry-id] textarea").all()).map((textarea) =>
								textarea.inputValue(),
							),
						),
					{ timeout: 15000 },
				)
				.toEqual([...draftTexts].reverse());
			await scoped.hooks.ingest.mutate({
				taskId: taskIds[0],
				workspaceId: workspaceIds[0],
				event: "to_in_progress",
				metadata: { source: "claude", hookEventName: "UserPromptSubmit" },
				submittedPromptText: draftTexts.join("\n"),
			});
			await expect
				.poll(
					async () =>
						(await scoped.runtime.getWorkspacePromptLibrary.query({})).library?.taskScopedPromptsByTaskId[
							taskIds[0]
						][0].draftUsage?.markedUsedAtEpochMs,
					{ timeout: 15000 },
				)
				.toBeTruthy();
			try {
				await expect
					.poll(() => page.getByRole("heading", { name: "已使用", exact: true }).count(), { timeout: 15000 })
					.toBe(1);
			} catch (error) {
				await page.screenshot({ path: join(evidencePath, "failure-after-hook.png") });
				writeFileSync(
					join(evidencePath, "failure-after-hook.json"),
					JSON.stringify(
						{
							url: page.url(),
							promptLibraryFrames,
							promptLibraryRequests,
							pageErrors,
							body: await page.locator("body").innerText(),
							library: await scoped.runtime.getWorkspacePromptLibrary.query({}),
						},
						null,
						2,
					),
				);
				throw error;
			}
			await expect
				.poll(() => otherProjectPage.getByRole("heading", { name: "已使用", exact: true }).count(), {
					timeout: 15000,
				})
				.toBe(1);
			const taskDraftRow = page.locator('[data-prompt-library-entry-id="draft-2"]');
			await taskDraftRow.hover();
			await taskDraftRow.getByRole("button", { name: "转为 Command", exact: true }).click();
			await taskDraftRow.getByRole("button", { name: "当前 Project", exact: true }).click();
			await page.getByRole("tab", { name: "Commands", exact: true }).click();
			const commandText = "可重复使用的项目检查命令，编辑后仍然长期保留";
			await page.locator('[data-prompt-library-entry-id="draft-2"] textarea').fill(commandText);
			await expect
				.poll(
					async () =>
						(await scoped.runtime.getWorkspacePromptLibrary.query({})).library?.repoScopedPrompts.find(
							(entry) => entry.id === "draft-2",
						)?.text,
					{ timeout: 15000 },
				)
				.toBe(commandText);
			await page.screenshot({ path: join(evidencePath, "desktop-commands.png") });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "Commands", exact: true }).click();
			await expect
				.poll(() => page.locator('[data-prompt-library-entry-id="draft-2"] textarea').inputValue())
				.toBe(commandText);
			await page.screenshot({ path: join(evidencePath, "mobile-commands.png") });
			runtime.kill("SIGINT");
			if (!(await waitForChildProcessExit(runtime, 20000))) throw new Error("隔离运行时未正常退出");
			runtime = await startRuntime("runtime-after-restart");
			await page.reload();
			await page.getByRole("button", { name: "Commands", exact: true }).click();
			await expect
				.poll(() => page.locator('[data-prompt-library-entry-id="draft-2"] textarea').inputValue(), {
					timeout: 15000,
				})
				.toBe(commandText);
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidencePath, "verification-result.json"),
				JSON.stringify(
					{
						passed: true,
						isolatedRuntimePort: port,
						checks: [
							"真实 hook 自动标记三范围",
							"跨项目全局失效推流",
							"Command 转换及正文编辑",
							"桌面和窄屏入口",
							"运行时重启持久化",
						],
					},
					null,
					2,
				),
			);
		} catch (error) {
			for (const [index, page] of observedPages.entries()) {
				await page.screenshot({ path: join(evidencePath, `failure-page-${index}.png`) }).catch(() => {});
				writeFileSync(
					join(evidencePath, `failure-page-${index}.json`),
					JSON.stringify(
						{
							url: page.url(),
							body: await page
								.locator("body")
								.innerText()
								.catch(() => "页面不可读"),
						},
						null,
						2,
					),
				);
			}
			throw error;
		} finally {
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 20000);
		}
	},
	180000,
);
