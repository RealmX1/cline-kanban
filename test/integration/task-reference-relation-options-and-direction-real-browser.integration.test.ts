import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_TASK_RELATION_OPTIONS_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(async () => {
	await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
	vi.unstubAllEnvs();
});

it.skipIf(!packagedCliPath)(
	"打包浏览器：创建、Backlog、Focus 与快捷添加的方向落账、跨 project 资格、手机与重试",
	async () => {
		if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const evidenceDirectory =
			process.env.KANBAN_TASK_RELATION_OPTIONS_BROWSER_EVIDENCE_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "browser-evidence");
		mkdirSync(evidenceDirectory, { recursive: true });
		const source = fixture.createNonBareRepository({
			repositoryDirectoryName: "relation-options-source",
			initialBranchName: "main",
		});
		const target = fixture.createNonBareRepository({
			repositoryDirectoryName: "relation-options-target",
			initialBranchName: "main",
		});
		for (const repository of [source, target]) {
			writeFileSync(join(repository.repositoryPath, "initial.txt"), "隔离关系方向验收\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化隔离项目",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const initial = await loadWorkspaceState(repository.repositoryPath);
			const card = (id: string, title: string, createdAt: number) => ({
				id,
				title,
				prompt: title,
				createdAt,
				updatedAt: createdAt,
				baseRef: "main",
				startInPlanMode: false,
			});
			await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					...initial.board,
					columns: initial.board.columns.map((column) => ({
						...column,
						cards:
							column.id === "backlog"
								? repository === source
									? [card("edit1", "待编辑任务", 1), card("same1", "同项目对端", 2)]
									: [card("other", "跨项目对端", 3)]
								: column.id === "in_progress" && repository === source
									? [card("focus", "焦点任务", 4)]
									: [],
					})),
				},
				sessions: {},
			});
		}
		const portAllocator = createServer();
		await new Promise<void>((done) => portAllocator.listen(0, "127.0.0.1", done));
		const address = portAllocator.address();
		if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
		const port = address.port;
		await new Promise<void>((done) => portAllocator.close(() => done()));
		expect(port).not.toBe(3484);
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
				delete environment[key];
		const binaryDirectory = join(fixture.isolatedHomeDirectoryPath, "isolated-agent-binaries");
		mkdirSync(binaryDirectory, { recursive: true });
		writeFileSync(
			join(binaryDirectory, "claude"),
			`#!${process.execPath}\nif(process.argv.includes('--help'))process.stdout.write('--settings --session-id --model');else process.stdout.write('2.1.0 (Claude Code)\\n');\n`,
			{ mode: 0o700 },
		);
		Object.assign(environment, {
			PATH: `${binaryDirectory}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-config"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"),
			KANBAN_RUNTIME_PORT: String(port),
		});
		const sourcePath = resolve(import.meta.dirname, "../..");
		let runtimeOutput = "";
		const runtime = children.register(
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
		runtime.stdout?.on("data", (chunk) => {
			runtimeOutput += String(chunk);
		});
		runtime.stderr?.on("data", (chunk) => {
			runtimeOutput += String(chunk);
		});
		let browser: Browser | undefined;
		try {
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
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
			const sourceId = (await client().projects.add.mutate({ path: source.repositoryPath })).project?.id;
			const targetId = (await client().projects.add.mutate({ path: target.repositoryPath })).project?.id;
			if (!sourceId || !targetId) throw new Error("项目注册失败");
			const sourceClient = client(sourceId);
			await sourceClient.runtime.saveConfig.mutate({ selectedAgentId: "claude" });
			await client(targetId).runtime.saveConfig.mutate({ selectedAgentId: "claude" });
			const { chromium } = createRequire(join(sourcePath, "web-ui/package.json"))("playwright-core") as {
				chromium: BrowserType;
			};
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
			page.setDefaultTimeout(15_000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
			const neighborhood = (taskId: string) =>
				sourceClient.workUnit.getRelationNeighborhoodSummary.query({
					workUnit: {
						workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
						bareTaskId: taskId,
						workspaceId: sourceId,
					},
				});
			const editor = () => page.getByRole("region", { name: "任务关系建模", exact: true });
			const taskDialog = () =>
				page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "关闭任务编辑器", exact: true }) });
			const selectCounterpart = async (taskId: string, workspaceId: string) => {
				const search = page.getByPlaceholder("Search tasks in all projects (title, prompt or task id)");
				await search.fill(taskId);
				await page
					.locator(`[data-counterpart-candidate-kanban-board-card="${workspaceId}:${taskId}"]`)
					.first()
					.click();
			};
			const addPending = async (taskId: string, workspaceId: string) => {
				await editor().getByRole("button", { name: "添加关系", exact: true }).click();
				await selectCounterpart(taskId, workspaceId);
				await editor().getByRole("list", { name: "待保存关联任务" }).locator("li").last().waitFor();
				return editor().getByRole("combobox", { name: "待保存关系及方向", exact: true }).last();
			};
			await page.goto(`${origin}/${sourceId}`);
			await page.getByRole("button", { name: "Create task", exact: true }).first().click();
			await taskDialog().getByRole("textbox", { name: "任务名称（可选）", exact: true }).fill("创建方向验收");
			await taskDialog().getByRole("textbox", { name: "任务正文", exact: true }).fill("创建带方向的任务关系");
			const creatingSelection = await addPending("same1", sourceId);
			expect(
				await creatingSelection
					.locator('option[value="reference_is_cross_repository_counterpart_with"]')
					.isDisabled(),
			).toBe(true);
			await creatingSelection.selectOption("reference_fixes_defects_in_produced_outputs_of:inverse");
			expect(await editor().locator("[data-relation-statement-preview]").first().innerText()).toContain(
				"本 Task：创建方向验收",
			);
			expect(await creatingSelection.locator("option:checked").innerText()).toBe("← 交付物由其修复");
			let heldSubmissionResponse = false;
			await page.route("**/api/trpc/*", async (route) => {
				if (!heldSubmissionResponse && route.request().url().includes("taskEditorCreation.submit")) {
					heldSubmissionResponse = true;
					await route.fetch();
					await route.abort("failed");
				} else await route.continue();
			});
			await taskDialog().getByRole("button", { name: "创建任务", exact: true }).click();
			await vi.waitFor(
				async () =>
					expect(
						(await sourceClient.workspace.getState.query()).board.columns
							.flatMap((column) => column.cards)
							.filter((card) => card.title === "创建方向验收"),
					).toHaveLength(1),
				{ timeout: 20_000 },
			);
			const createdCards = (await sourceClient.workspace.getState.query()).board.columns
				.flatMap((column) => column.cards)
				.filter((card) => card.title === "创建方向验收");
			expect(createdCards).toHaveLength(1);
			const created = createdCards[0];
			if (!created) throw new Error("创建任务尚未落盘");
			await vi.waitFor(
				async () =>
					expect((await neighborhood(created.id)).assertedRelations).toContainEqual(
						expect.objectContaining({
							relationKind: "reference_fixes_defects_in_produced_outputs_of",
							relationStatementSubjectWorkUnitRef: expect.objectContaining({ taskId: "same1" }),
							relationStatementAnchorWorkUnitRef: expect.objectContaining({ taskId: created.id }),
						}),
					),
				{ timeout: 20_000 },
			);
			// 刷新后继续读取同一张卡与已落账关系，覆盖响应丢失后的持久恢复。
			await page.reload();
			expect(
				(await sourceClient.workspace.getState.query()).board.columns
					.flatMap((column) => column.cards)
					.filter((card) => card.title === "创建方向验收"),
			).toHaveLength(1);
			await page.getByText("待编辑任务", { exact: true }).first().click();
			const editingSelection = await addPending("other", targetId);
			await editingSelection.selectOption("reference_diagnoses_agent_execution_trajectory_of");
			await taskDialog().getByRole("button", { name: "保存更改", exact: true }).click();
			await taskDialog().waitFor({ state: "hidden" });
			expect((await neighborhood("edit1")).assertedRelations).toContainEqual(
				expect.objectContaining({
					relationKind: "reference_diagnoses_agent_execution_trajectory_of",
					relationStatementSubjectWorkUnitRef: expect.objectContaining({ taskId: "edit1" }),
					relationStatementAnchorWorkUnitRef: expect.objectContaining({ taskId: "other" }),
				}),
			);
			await page.goto(`${origin}/${sourceId}?task=focus`);
			await page
				.getByRole("combobox", { name: /^工作台格位/ })
				.first()
				.selectOption("cross_task_relations");
			const relations = page.getByRole("region", { name: "Relations", exact: true });
			const toggle = relations.getByRole("button", { name: /^(展开|收起)关系内容$/ });
			if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
			const openRelationsAction = async (label: string) => {
				const action = page.getByRole("button", { name: label, exact: true });
				if (!(await action.isVisible()))
					await relations.getByRole("button", { name: "更多关系操作", exact: true }).click();
				await action.click();
				if (await page.getByRole("dialog", { name: "更多关系操作", exact: true }).isVisible())
					await relations.getByRole("button", { name: "更多关系操作", exact: true }).click();
			};
			await openRelationsAction("Add relation");
			await selectCounterpart("other", targetId);
			const quickAdd = page.getByRole("dialog", { name: "添加关系", exact: true });
			await quickAdd
				.getByRole("combobox", { name: "关系及方向", exact: true })
				.selectOption("reference_fixes_defects_in_produced_outputs_of:inverse");
			await quickAdd.getByRole("combobox", { name: "关系及方向", exact: true }).press("Control+Enter");
			await quickAdd.waitFor({ state: "hidden" });
			expect((await neighborhood("focus")).assertedRelations).toContainEqual(
				expect.objectContaining({
					relationKind: "reference_fixes_defects_in_produced_outputs_of",
					relationStatementSubjectWorkUnitRef: expect.objectContaining({ taskId: "other" }),
					relationStatementAnchorWorkUnitRef: expect.objectContaining({ taskId: "focus" }),
				}),
			);
			await openRelationsAction("关系图与建模");
			const focusSelection = await addPending("other", targetId);
			await vi.waitFor(async () =>
				expect(
					await focusSelection
						.locator('option[value="reference_is_cross_repository_counterpart_with"]')
						.isDisabled(),
				).toBe(false),
			);
			await focusSelection.selectOption("reference_is_cross_repository_counterpart_with");
			await client(targetId).taskCardAction.transferNeverStartedBacklogTaskToProject.mutate({
				operationId: randomUUID(),
				taskId: "other",
				taskIncarnationCreatedAtEpochMs: 3,
				targetWorkspaceId: sourceId,
				targetBaseRef: "main",
			});
			await editor().getByRole("button", { name: "刷新关系", exact: true }).click();
			await vi.waitFor(async () =>
				expect(await editor().getByRole("button", { name: "保存关系变更", exact: true }).isDisabled()).toBe(true),
			);
			expect(await focusSelection.inputValue()).toBe("reference_is_cross_repository_counterpart_with");
			expect(await editor().getByRole("alert").first().innerText()).toContain("仅限不同 project");
			await sourceClient.taskCardAction.transferNeverStartedBacklogTaskToProject.mutate({
				operationId: randomUUID(),
				taskId: "other",
				taskIncarnationCreatedAtEpochMs: 3,
				targetWorkspaceId: targetId,
				targetBaseRef: "main",
			});
			await editor().getByRole("button", { name: "刷新关系", exact: true }).click();
			await editor().getByRole("button", { name: "保存关系变更", exact: true }).click();
			await vi.waitFor(async () => expect((await neighborhood("focus")).assertedRelations).toHaveLength(2));
			await vi.waitFor(async () =>
				expect(await editor().locator("li").filter({ hasText: "已保存" }).count()).toBe(2),
			);
			await relations.getByRole("button", { name: "展开关系图", exact: true }).click();
			await page.screenshot({ path: join(evidenceDirectory, "focus-relations-desktop.png") });
			await page.setViewportSize({ width: 390, height: 844 });
			await editor().getByRole("button", { name: "列表", exact: true }).click();
			await editor().scrollIntoViewIfNeeded();
			expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
			await page.screenshot({ path: join(evidenceDirectory, "focus-relations-mobile.png") });
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidenceDirectory, "browser-checks.json"),
				JSON.stringify(
					{
						checked: [
							"创建反向修复及响应丢失不重复建卡",
							"同 project 禁用跨 project 对应",
							"Backlog 正向 Trajectory 诊断",
							"快捷添加反向修复及键盘保存",
							"Focus 无向跨 project 保存",
							"对端迁入同 project 后保留失效选择并阻止提交，迁出后恢复资格",
							"手机固定阅读顺序与无横向溢出",
						],
						createdTaskId: created.id,
					},
					null,
					2,
				),
			);
		} catch (failure) {
			const failedPage = browser?.contexts()[0]?.pages()[0];
			if (failedPage) {
				await failedPage.screenshot({ path: join(evidenceDirectory, "failed-browser-state.png"), fullPage: true });
				writeFileSync(join(evidenceDirectory, "failed-browser-state.html"), await failedPage.content());
			}
			throw failure;
		} finally {
			if (browser) await browser.close();
			writeFileSync(join(evidenceDirectory, "isolated-runtime.log"), runtimeOutput);
		}
	},
	180_000,
);
