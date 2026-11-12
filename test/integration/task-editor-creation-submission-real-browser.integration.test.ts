import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildAllProjectsTaskGroupQueryResult } from "../../src/core/all-projects-task-group-query";
import { lockedFileSystem } from "../../src/fs/locked-file-system";
import type { Browser } from "../../web-ui/node_modules/playwright-core";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

import { createTaskEditorPackagedRuntimeBrowserTestFixture } from "./task-editor-packaged-runtime-browser-test-fixture";

const packagedCliPath = process.env.KANBAN_TASK_EDITOR_CREATION_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(!packagedCliPath)(
	"打包浏览器：保存即关闭、跨项目独立创建、响应丢失、批量与重启恢复",
	async () => {
		if (!packagedCliPath) throw new Error("缺少本任务隔离构建的 CLI");
		const browserFixture = await createTaskEditorPackagedRuntimeBrowserTestFixture(packagedCliPath, children);
		const { fixture, evidenceDirectory, client, origin } = browserFixture;
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
		const isolatedAgentExecutableDirectory = join(fixture.isolatedHomeDirectoryPath, "isolated-agent-executables");
		mkdirSync(isolatedAgentExecutableDirectory, { recursive: true });
		writeFileSync(
			join(isolatedAgentExecutableDirectory, "claude"),
			`#!${process.execPath}\nif(process.argv.includes('--version'))process.stdout.write('2.1.0 (Claude Code)\\n');else if(process.argv.includes('--help'))process.stdout.write('--settings --session-id --model');else{process.stdout.write('Claude Code v2.1.0\\n> ');process.stdin.resume();setInterval(()=>{},1000);}\n`,
			{ mode: 0o700 },
		);
		browserFixture.environment.PATH = `${isolatedAgentExecutableDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`;
		const startRuntime = () => browserFixture.startRuntime(source.repositoryPath);
		let runtime = await startRuntime();
		let browser: Browser | undefined;
		let releaseWorktreeSetup = () => {};
		let heldWorktreeSetup: Promise<void> | undefined;
		let blockedStartupStartedAt = 0;
		let blockedStartupDurationMs = 0;
		let savedConfirmationToVisibleMs = 0;
		let launchedFixtureTaskId: string | undefined;
		let fixtureTaskWorkspaceId: string | undefined;
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
			browser = await browserFixture.launchBrowser();
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
				const promptInput = editor.getByRole("textbox", { name: "任务正文", exact: true });
				await promptInput.click();
				await promptInput.fill(prompt);
				expect(await nameInput.inputValue()).toBe(title);
				expect(await promptInput.inputValue()).toBe(prompt);
				return editor;
			};
			let markWorktreeSetupLockAcquired = () => {};
			const worktreeSetupLockAcquired = new Promise<void>((done) => {
				markWorktreeSetupLockAcquired = done;
			});
			const worktreeSetupReleased = new Promise<void>((done) => {
				releaseWorktreeSetup = done;
			});
			heldWorktreeSetup = lockedFileSystem.withLock(
				{
					type: "directory",
					path: join(source.repositoryPath, ".git"),
					lockfileName: "kanban-task-worktree-setup.lock",
				},
				async () => {
					blockedStartupStartedAt = Date.now();
					markWorktreeSetupLockAcquired();
					await worktreeSetupReleased;
				},
			);
			await worktreeSetupLockAcquired;
			const observerPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
			await observerPage.addInitScript(() => {
				localStorage.setItem("kanban.onboarding.dialog.shown", "true");
				sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
				localStorage.setItem("kanban.cross-project-task-switcher-running-section-expanded.v1", "true");
			});
			await observerPage.goto(`${origin}/${sourceId}`);
			const runningSection = observerPage.getByTestId("cross-project-task-switcher-section-running");
			await runningSection.waitFor({ state: "visible" });

			const editorA = await openCreate(sourceId, "任务 A 的原始正文", "[TEST]独立任务 A");
			await editorA.getByRole("button", { name: "创建并启动", exact: true }).click();
			await editorA.waitFor({ state: "hidden" });
			const savedConfirmationObservedAt = Date.now();
			await runningSection.getByText("正在启动", { exact: true }).waitFor({ state: "visible", timeout: 6_000 });
			savedConfirmationToVisibleMs = Date.now() - savedConfirmationObservedAt;
			if (savedConfirmationToVisibleMs > 1_000)
				process.stderr.write(`启动展示软目标超出：${savedConfirmationToVisibleMs}ms\n`);
			expect(runningSection && (await runningSection.innerText())).toContain("0 运行中 · 1 正在启动");

			const cardsA = (await sourceClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards);
			expect(cardsA).toHaveLength(1);
			const cardA = cardsA[0];
			if (!cardA) throw new Error("任务 A 尚未保存");
			await observerPage.screenshot({ path: join(evidenceDirectory, "running-startup-before-agent-process.png") });
			const startingRow = runningSection.locator(`[data-cross-project-task-switcher-task-id="${cardA.id}"]`);
			const compactStartingRowHeight = await startingRow.evaluate(
				(element) => element.getBoundingClientRect().height,
			);
			await startingRow.hover();
			const floatingStartingCard = startingRow.locator("[data-cross-project-task-switcher-hover-floating-card]");
			await floatingStartingCard.waitFor({ state: "visible" });
			expect(await startingRow.evaluate((element) => element.getBoundingClientRect().height)).toBe(
				compactStartingRowHeight,
			);
			expect(await floatingStartingCard.getByText("正在启动", { exact: true }).count()).toBe(1);
			await observerPage.screenshot({
				path: join(evidenceDirectory, "running-startup-hover-preserves-row-height.png"),
			});
			await observerPage.mouse.move(1400, 900);
			await floatingStartingCard.waitFor({ state: "hidden" });

			const queryResult = buildAllProjectsTaskGroupQueryResult(
				await sourceClient.projects.getAllProjectsTaskGroupQuerySnapshot.query({ recentDays: 7 }),
				{ group: "running" },
			);
			expect(queryResult.groups[0]?.tasks.map((task) => task.taskId)).toContain(cardA.id);
			await observerPage.reload();
			await runningSection
				.locator(`[data-cross-project-task-switcher-task-id="${cardA.id}"]`)
				.waitFor({ state: "visible" });
			await new Promise<void>((done) =>
				setTimeout(done, Math.max(0, 60_000 - (Date.now() - blockedStartupStartedAt))),
			);
			expect(await runningSection.locator(`[data-cross-project-task-switcher-task-id="${cardA.id}"]`).count()).toBe(
				1,
			);
			blockedStartupDurationMs = Date.now() - blockedStartupStartedAt;
			releaseWorktreeSetup();
			await heldWorktreeSetup;

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
			expect(cardsB[0]?.terminalAgentModelOverrideSettings).toEqual({
				agentId: "codex",
				modelId: "isolated-non-runnable-codex-model",
			});
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
			await editorBatch.getByRole("button", { name: "Start 2 tasks", exact: true }).click();
			await editorBatch.waitFor({ state: "hidden" });
			expect(
				(await targetClient.workspace.getState.query()).board.columns.flatMap((column) => column.cards),
			).toHaveLength(4);
			await expect
				.poll(async () => runningSection.locator("[data-cross-project-task-switcher-task-id]").count())
				.toBe(3);
			await observerPage.screenshot({ path: join(evidenceDirectory, "running-cross-project-batch-startup.png") });

			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 30_000)).toBe(true);
			runtime = await startRuntime();
			await observerPage.goto(`${origin}/${sourceId}`);
			await runningSection
				.locator(`[data-cross-project-task-switcher-task-id="${cardA.id}"]`)
				.waitFor({ state: "visible" });
			await expect.poll(async () => runningSection.innerText(), { timeout: 15_000 }).toContain("启动等待恢复");
			await observerPage.screenshot({ path: join(evidenceDirectory, "running-startup-after-runtime-restart.png") });

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
			await page.setViewportSize({ width: 1440, height: 1000 });
			const liveEditor = await openCreate(
				sourceId,
				"仅运行隔离 PTY fixture，不调用真实模型",
				"[TEST]真实进程接管启动展示",
			);
			await liveEditor.getByRole("button", { name: "Agent：codex", exact: true }).click();
			await liveEditor.getByRole("button", { name: "Claude Code", exact: true }).click();
			await liveEditor.getByRole("button", { name: "创建并启动", exact: true }).click();
			await liveEditor.waitFor({ state: "hidden" });
			const liveCard = (await sourceClient.workspace.getState.query()).board.columns
				.flatMap((column) => column.cards)
				.find((card) => card.prompt === "仅运行隔离 PTY fixture，不调用真实模型");
			if (!liveCard) throw new Error("未找到隔离 PTY 任务");
			launchedFixtureTaskId = liveCard.id;
			fixtureTaskWorkspaceId = sourceId;
			await expect
				.poll(async () => (await sourceClient.workspace.getState.query()).sessions[liveCard.id]?.pid, {
					timeout: 20_000,
				})
				.toBeTypeOf("number");
			const liveRow = runningSection.locator(`[data-cross-project-task-switcher-task-id="${liveCard.id}"]`);
			await liveRow.waitFor({ state: "visible" });
			await expect.poll(async () => runningSection.innerText()).toContain("1 运行中");
			expect(
				await liveRow
					.locator(`[data-verification-anchor="task-editor-creation-agent-startup:${liveCard.id}"]`)
					.count(),
			).toBe(0);
			expect(await liveRow.count()).toBe(1);
			await observerPage.screenshot({
				path: join(evidenceDirectory, "running-live-process-replaces-startup-label.png"),
			});
			await sourceClient.runtime.stopTaskSession.mutate({ taskId: liveCard.id });
			launchedFixtureTaskId = undefined;

			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidenceDirectory, "browser-verification.json"),
				JSON.stringify(
					{
						sourceId,
						targetId,
						cardA: cardA.id,
						targetTaskCount: 4,
						droppedSubmissionResponse,
						pageErrors,
						savedConfirmationToVisibleMs,
						blockedStartupDurationMs,
					},
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
			releaseWorktreeSetup();
			await heldWorktreeSetup;
			if (launchedFixtureTaskId && fixtureTaskWorkspaceId)
				await client(fixtureTaskWorkspaceId).runtime.stopTaskSession.mutate({ taskId: launchedFixtureTaskId });
			await browser?.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExit(runtime, 30_000);
			browserFixture.writeRuntimeOutput();
		}
	},
	300_000,
);
