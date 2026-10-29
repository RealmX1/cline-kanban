import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
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

const packagedCliPath = process.env.KANBAN_TASK_EDITOR_CREATION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath)(
	"打包浏览器：保存即关闭、跨项目独立创建、响应丢失、批量与重启恢复",
	async () => {
		if (!packagedCliPath) throw new Error("缺少本任务隔离构建的 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repositories = ["editor-creation-source", "editor-creation-target"].map((repositoryDirectoryName) => {
			const repository = fixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" });
			writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离任务创建浏览器验收\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "建立隔离项目",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			return repository;
		});
		const [source, target] = repositories;
		if (!source || !target) throw new Error("隔离仓库初始化失败");
		const evidenceDirectory =
			process.env.KANBAN_TASK_EDITOR_CREATION_BROWSER_EVIDENCE_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "browser-evidence");
		mkdirSync(evidenceDirectory, { recursive: true });
		const socket = createServer();
		await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
		const address = socket.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		const port = address.port;
		await new Promise<void>((done) => socket.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			KANBAN_RUNTIME_PORT: String(port),
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"),
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		const origin = `http://127.0.0.1:${port}`;
		let runtimeOutput = "";
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					[
						"--require",
						join(sourcePath, "test/integration/shutdown-ipc-hook.cjs"),
						packagedCliPath,
						"--port",
						String(port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: source.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			child.stdout?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				runtimeOutput += String(chunk);
			});
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		let runtime = await startRuntime();
		let browser: Browser | undefined;
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${origin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		try {
			const addedSource = await client().projects.add.mutate({ path: source.repositoryPath });
			const addedTarget = await client().projects.add.mutate({ path: target.repositoryPath });
			const sourceId = addedSource.project?.id;
			const targetId = addedTarget.project?.id;
			if (!sourceId || !targetId) throw new Error("隔离项目注册失败");
			const sourceClient = client(sourceId);
			const targetClient = client(targetId);
			await sourceClient.runtime.saveConfig.mutate({ selectedAgentId: "codex" });
			await targetClient.runtime.saveConfig.mutate({ selectedAgentId: "codex" });
			const { chromium } = createRequire(join(sourcePath, "web-ui/package.json"))("playwright-core") as {
				chromium: BrowserType;
			};
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const openCreate = async (workspaceId: string, prompt: string, title: string) => {
				const workspaceRuntimeConfigurationResponse = page.waitForResponse(
					(response) =>
						response.url().includes("runtime.getConfig") &&
						response.request().headers()["x-kanban-workspace-id"] === workspaceId &&
						response.ok(),
				);
				await page.goto(`${origin}/${workspaceId}`);
				await (await workspaceRuntimeConfigurationResponse).finished();
				// 首屏配置尚未进入 React 时，创建入口会按既有门禁忽略点击；等默认设置生效后再验收建卡。
				await page.evaluate(
					"new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))",
				);
				await page.getByRole("button", { name: "Create task", exact: true }).first().click();
				const editor = page
					.getByRole("dialog")
					.filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
				const nameInput = editor.getByRole("textbox", { name: "任务名称（可选）", exact: true });
				await nameInput.click();
				await nameInput.fill(title);
				const promptInput = editor.locator("textarea").first();
				await promptInput.click();
				await promptInput.fill(prompt);
				expect(await nameInput.inputValue()).toBe(title);
				expect(await promptInput.inputValue()).toBe(prompt);
				return editor;
			};
			const editorA = await openCreate(sourceId, "任务 A 的原始正文", "[TEST]独立任务 A");
			await editorA.getByRole("button", { name: "创建并启动", exact: true }).click();
			await editorA.waitFor({ state: "hidden" });
			const cardsA = (await sourceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards);
			expect(cardsA).toHaveLength(1);
			const cardA = cardsA[0];
			if (!cardA) throw new Error("任务 A 尚未保存");
			await expect
				.poll(
					async () =>
						(
							await sourceClient.taskEditorCreation.listForTask.query({
								taskId: cardA.id,
								taskIncarnationCreatedAtEpochMs: cardA.createdAt,
							})
						)[0]?.phase,
				)
				.toBe("waiting_for_dependency");
			await page.goto(`${origin}/${sourceId}?task=${cardA.id}`);
			await page
				.locator(`[data-verification-anchor="task-editor-creation-progress:${cardA.id}"]`)
				.waitFor({ state: "visible" });
			await page.screenshot({ path: join(evidenceDirectory, "saved-task-with-pending-start-desktop.png") });
			const sourceBeforeB = (await sourceClient.workspace.getState.query()).board.columns.flatMap(
				(column) => column.cards,
			);
			const editorB = await openCreate(targetId, "任务 B 的独立正文", "[TEST]独立任务 B");
			await editorB.getByRole("button", { name: "创建任务", exact: true }).click();
			await editorB.waitFor({ state: "hidden" });
			expect(
				(await sourceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toEqual(sourceBeforeB);
			const cardsB = (await targetClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards);
			expect(cardsB).toHaveLength(1);
			expect(cardsB[0]?.id).not.toBe(cardA.id);
			expect(cardsB[0]?.prompt).toBe("任务 B 的独立正文");
			let droppedSubmissionResponse = false;
			await page.route("**/api/trpc/**", async (route) => {
				if (!droppedSubmissionResponse && route.request().url().includes("taskEditorCreation.submit")) {
					droppedSubmissionResponse = true;
					await route.fetch();
					await route.abort("failed");
				} else await route.continue();
			});
			const editorLost = await openCreate(targetId, "响应丢失仍只创建一张卡", "[TEST]丢失响应任务");
			await editorLost.getByRole("button", { name: "创建任务", exact: true }).click();
			await editorLost.waitFor({ state: "hidden" });
			expect(droppedSubmissionResponse).toBe(true);
			expect(
				(await targetClient.workspace.getState.query()).board.columns
					.flatMap((column) => column.cards)
					.filter((card) => card.prompt === "响应丢失仍只创建一张卡"),
			).toHaveLength(1);
			await page.unroute("**/api/trpc/**");
			const editorBatch = await openCreate(targetId, "- 第一张批量任务\n- 第二张批量任务", "");
			await editorBatch.getByRole("button", { name: "Split into 2 tasks", exact: true }).click();
			await editorBatch.getByRole("button", { name: "Create 2 tasks", exact: true }).click();
			await editorBatch.waitFor({ state: "hidden" });
			expect(
				(await targetClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toHaveLength(4);
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 30_000)).toBe(true);
			runtime = await startRuntime();
			await page.goto(`${origin}/${sourceId}?task=${cardA.id}`);
			await page
				.locator(`[data-verification-anchor="task-editor-creation-progress:${cardA.id}"]`)
				.waitFor({ state: "visible" });
			expect(
				(await sourceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toEqual(sourceBeforeB);
			expect(
				(await targetClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toHaveLength(4);
			await page.setViewportSize({ width: 390, height: 844 });
			await page.screenshot({ path: join(evidenceDirectory, "creation-progress-after-runtime-restart-mobile.png") });
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidenceDirectory, "browser-verification.json"),
				JSON.stringify(
					{ sourceId, targetId, cardA: cardA.id, targetTaskCount: 4, droppedSubmissionResponse, pageErrors },
					null,
					2,
				),
			);
		} catch (error) {
			const failedPage = browser?.contexts()[0]?.pages()[0];
			if (failedPage) {
				writeFileSync(join(evidenceDirectory, "failed-page.txt"), await failedPage.locator("body").innerText());
				await failedPage.screenshot({ path: join(evidenceDirectory, "failed-page.png") });
			}
			const projects = await client().projects.list.query();
			for (const project of projects.projects)
				writeFileSync(
					join(evidenceDirectory, `failed-state-${project.id}.json`),
					JSON.stringify(await client(project.id).workspace.getState.query(), null, 2),
				);
			throw error;
		} finally {
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 30_000);
			writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), runtimeOutput);
		}
	},
	180_000,
);
