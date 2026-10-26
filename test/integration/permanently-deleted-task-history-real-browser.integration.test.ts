import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(process.env.KANBAN_RUN_ISOLATED_DELETED_TASK_HISTORY_BROWSER_CHECK !== "1")(
	"永久删除后经真实 runtime 与 Expanded Task Cards 查询、跨项目复制且保持只读",
	async (context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const checkout = resolve(import.meta.dirname, "../..");
		const evidence =
			process.env.KANBAN_DELETED_TASK_HISTORY_BROWSER_EVIDENCE_DIRECTORY ??
			join(fixture.fixtureRootDirectoryPath, "deleted-task-history-browser-evidence");
		mkdirSync(evidence, { recursive: true });
		const requireFromWeb = createRequire(join(checkout, "web-ui/package.json"));
		const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
		const reservePort = async () => {
			const server = createServer();
			await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("无法分配隔离端口");
			await new Promise<void>((closed) => server.close(() => closed()));
			return address.port;
		};
		const runtimePort = await reservePort();
		const webPort = await reservePort();
		expect([runtimePort, webPort]).not.toContain(3484);
		const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
		const webOrigin = `http://127.0.0.1:${webPort}`;
		const alpha = fixture.createNonBareRepository({ repositoryDirectoryName: "history-alpha" });
		const beta = fixture.createNonBareRepository({ repositoryDirectoryName: "history-beta" });
		for (const project of [alpha, beta]) {
			writeFileSync(join(project.repositoryPath, "initial.txt"), "隔离测试\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化隔离仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
		}
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GOOGLE_|GEMINI_|KIMI_)/.test(key))
				delete environment[key];
		const stubExecutables = join(fixture.fixtureRootDirectoryPath, "isolated-agent-stub-executables");
		mkdirSync(stubExecutables);
		writeFileSync(
			join(stubExecutables, "claude"),
			"#!/usr/bin/env node\nif(process.argv.includes('--version') || process.argv.includes('--help')) { process.stdout.write('2.1.288 (Claude Code)'); process.exit(0); }\nprocess.stdout.write('隔离测试 agent\\n> ');process.stdin.resume();setInterval(()=>{},1000);\n",
			{ mode: 0o755 },
		);
		Object.assign(environment, {
			PATH: `${stubExecutables}:${dirname(process.execPath)}:/usr/bin:/bin`,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-databases"),
			KANBAN_RUNTIME_PORT: String(runtimePort),
			NODE_ENV: "development",
		});
		const logs: Record<string, string> = {};
		const start = (role: string, arguments_: string[], cwd: string) => {
			const child = children.register(
				spawn(
					process.execPath,
					["--require", join(checkout, "test/integration/shutdown-ipc-hook.cjs"), ...arguments_],
					{ cwd, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
			logs[role] = "";
			child.stdout?.on("data", (chunk) => {
				logs[role] += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				logs[role] += String(chunk);
			});
			return child;
		};
		const observe = (description: string, condition: () => Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				context,
				{
					waitedForDescription: description,
					softDeadlineMsExpectedOnUncontendedHost: 15000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 60000,
				},
				condition,
				{ pollIntervalMs: 100, describeLastObservedStateForFailureMessage: () => JSON.stringify(logs) },
			);
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${runtimeOrigin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		let browser: Awaited<ReturnType<BrowserType["launch"]>> | null = null;
		let readOnlyLedger: Database.Database | null = null;
		try {
			start(
				"runtime",
				[
					"--import",
					createRequire(join(checkout, "package.json")).resolve("tsx"),
					join(checkout, "src/cli.ts"),
					"--port",
					String(runtimePort),
					"--no-open",
					"--no-passcode",
				],
				alpha.repositoryPath,
			);
			await observe("隔离 runtime 启动", async () =>
				fetch(`${runtimeOrigin}/api/trpc/projects.list`)
					.then((response) => response.ok)
					.catch(() => false),
			);
			await client().projects.add.mutate({ path: beta.repositoryPath });
			const { projects } = await client().projects.list.query();
			const alphaId = projects.find((project) => project.path === alpha.repositoryPath)?.id;
			const betaId = projects.find((project) => project.path === beta.repositoryPath)?.id;
			if (!alphaId || !betaId) throw new Error("隔离项目未注册");
			const createdPrompt = "创建时需求：只读检索历史";
			const finalPrompt = `  删除前完整需求\r\n\n${"中文与 Unicode 😀 保留空白\n".repeat(150)}  `;
			const deletedId = (
				await client(alphaId).workspace.addBacklogTask.mutate({ title: "历史目标 Alpha", prompt: createdPrompt })
			).taskId;
			const otherDeletedId = (
				await client(betaId).workspace.addBacklogTask.mutate({ title: "历史目标 Beta", prompt: "跨项目已删除需求" })
			).taskId;
			const focusId = (
				await client(alphaId).workspace.addBacklogTask.mutate({
					title: "保持当前任务",
					prompt: "历史查询时保留该任务",
				})
			).taskId;
			const state = await client(alphaId).workspace.getState.query();
			const backlog = state.board.columns.find((column) => column.id === "backlog");
			const deleted = backlog?.cards.find((card) => card.id === deletedId);
			const focus = backlog?.cards.find((card) => card.id === focusId);
			if (!backlog || !deleted || !focus) throw new Error("缺少隔离任务");
			deleted.prompt = finalPrompt;
			backlog.cards = backlog.cards.filter((card) => card.id !== focusId);
			state.board.columns.find((column) => column.id === "review")?.cards.push(focus);
			await client(alphaId).workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const stickerIdentity = {
				taskId: deletedId,
				expectedTaskIncarnationCreatedAtEpochMs: deleted.createdAt,
			};
			const retainedStickerText = "删除前便签首行\n真实账本保留的完整便签正文";
			for (const taskStickerEntryId of ["retained-sticker", "removed-sticker"])
				await client(alphaId).taskCardAction.applyTaskStickerEntryMutation.mutate({
					...stickerIdentity,
					mutation: { operation: "create", taskStickerEntryId, stickerText: "最初便签" },
				});
			await client(alphaId).taskCardAction.applyTaskStickerEntryMutation.mutate({
				...stickerIdentity,
				mutation: {
					operation: "update_text",
					taskStickerEntryId: "retained-sticker",
					expectedStickerText: "最初便签",
					stickerText: retainedStickerText,
				},
			});
			await client(alphaId).taskCardAction.applyTaskStickerEntryMutation.mutate({
				...stickerIdentity,
				mutation: { operation: "set_collapsed", taskStickerEntryId: "retained-sticker", isCollapsed: true },
			});
			await client(alphaId).taskCardAction.applyTaskStickerEntryMutation.mutate({
				...stickerIdentity,
				mutation: { operation: "delete", taskStickerEntryId: "removed-sticker", expectedStickerText: "最初便签" },
			});
			for (const [workspaceId, taskId] of [
				[alphaId, deletedId],
				[betaId, otherDeletedId],
			])
				await client(workspaceId).taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate({
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: [taskId],
					},
				});
			const versions = await client().workUnit.getPermanentlyDeletedTaskPromptVersions.query({
				kanbanBoardCard: {
					workUnitType: "kanban_board_card",
					workspaceId: alphaId,
					taskId: deletedId,
					taskIncarnationCreatedAtEpochMs: deleted.createdAt,
				},
			});
			expect(versions.beforePermanentRemoval.text).toBe(finalPrompt);
			expect(versions.atCreation.text).toBe(createdPrompt);
			const retainedHistoryPage = await client().workUnit.listPermanentlyDeletedTaskCards.query({
				workspaceId: alphaId,
				query: deletedId,
				cursor: null,
			});
			expect(retainedHistoryPage.entries).toMatchObject([
				{
					kanbanBoardCard: {
						workspaceId: alphaId,
						taskId: deletedId,
						taskIncarnationCreatedAtEpochMs: deleted.createdAt,
					},
					taskStickerEntries: [
						{ taskStickerEntryId: "retained-sticker", stickerText: retainedStickerText, isCollapsed: true },
					],
				},
			]);
			const configurationPath = join(fixture.fixtureRootDirectoryPath, "deleted-task-history-vite.config.mts");
			writeFileSync(
				configurationPath,
				`import base from ${JSON.stringify(join(checkout, "web-ui/vite.config.ts"))};\nexport default {...base, optimizeDeps:{entries:["index.html"],include:["react","react-dom/client","react/jsx-runtime","@xyflow/react","@dagrejs/dagre"]}, cacheDir:${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-dependency-cache"))}, server:{...base.server,host:"127.0.0.1",port:${webPort},strictPort:true,proxy:{"/api":{target:${JSON.stringify(runtimeOrigin)},changeOrigin:true,ws:true,headers:{origin:${JSON.stringify(runtimeOrigin)}}}}}};`,
			);
			start(
				"vite",
				[join(checkout, "web-ui/node_modules/vite/bin/vite.js"), "--config", configurationPath],
				join(checkout, "web-ui"),
			);
			await observe("隔离 Vite 启动", async () =>
				fetch(webOrigin)
					.then((response) => response.ok)
					.catch(() => false),
			);
			browser = await chromium.launch({ headless: true });
			const browserContext = await browser.newContext({
				viewport: { width: 1440, height: 1000 },
				permissions: ["clipboard-read", "clipboard-write"],
			});
			const page = await browserContext.newPage();
			page.setDefaultTimeout(20000);
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			const requests: string[] = [];
			page.on("request", (request) => requests.push(request.url()));
			await page.goto(`${webOrigin}/${alphaId}`);
			await page
				.getByRole("dialog")
				.filter({ hasText: "Get started" })
				.getByRole("button", { name: "Close", exact: true })
				.click();
			await page.getByRole("button", { name: "查看已删除 Task", exact: true }).click();
			const history = page.getByRole("dialog", { name: "已删除 Task", exact: true });
			await history.getByText("历史目标 Alpha", { exact: true }).waitFor();
			expect(await history.getByLabel("已删除 Task 的项目范围").inputValue()).toBe(alphaId);
			expect(await history.getByText("历史目标 Beta", { exact: true }).count()).toBe(0);
			const beforeQueryState = await client(alphaId).workspace.getState.query();
			readOnlyLedger = new Database(
				join(
					fixture.isolatedHomeDirectoryPath,
					".cline/kanban/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger.sqlite",
				),
				{ readonly: true },
			);
			const countCommittedEvents = () => {
				if (!readOnlyLedger) throw new Error("只读账本连接未打开");
				return readOnlyLedger
					.prepare(
						"SELECT count(*) AS count FROM inter_work_unit_relation_ledger_events WHERE event_commit_status = 'committed'",
					)
					.get() as { count: number };
			};
			const eventCountBeforeQueries = countCommittedEvents();
			await history.getByRole("button", { name: "便签 1", exact: true }).click();
			const stickerOverlay = page.locator("[data-task-sticker-overlay]");
			await stickerOverlay.getByText("删除前便签首行", { exact: true }).waitFor();
			expect(await stickerOverlay.getByRole("button", { name: "编辑便签" }).count()).toBe(0);
			expect(await stickerOverlay.getByRole("button", { name: "删除便签" }).count()).toBe(0);
			expect(await stickerOverlay.getByRole("button", { name: "添加便签" }).count()).toBe(0);
			await stickerOverlay.getByRole("button", { name: "展开便签", exact: true }).click();
			await stickerOverlay.getByText(retainedStickerText, { exact: true }).waitFor();
			await page.screenshot({ animations: "disabled", path: join(evidence, "deleted-task-sticker-desktop.png") });
			await stickerOverlay.getByRole("button", { name: "关闭便签", exact: true }).click();
			await history.getByLabel("已删除 Task 的项目范围").selectOption("");
			await history.getByText("历史目标 Beta", { exact: true }).waitFor();
			await history.getByRole("textbox", { name: "搜索已删除 Task" }).fill(deletedId);
			await history.getByText("历史目标 Beta", { exact: true }).waitFor({ state: "hidden" });
			await history.getByRole("button", { name: "查看完整 Prompt", exact: true }).click();
			const viewer = page.getByRole("dialog", { name: "历史 Prompt", exact: true });
			await viewer.getByText("创建时与删除前 Prompt 存在差异，请按版本查看和复制。", { exact: true }).waitFor();
			await viewer.getByRole("button", { name: "复制完整 Prompt", exact: true }).click();
			expect(
				await page.evaluate(() =>
					(
						globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
					).navigator.clipboard.readText(),
				),
			).toBe(finalPrompt);
			await viewer.getByRole("button", { name: "创建时 Prompt", exact: true }).click();
			await viewer.getByRole("button", { name: "复制完整 Prompt", exact: true }).click();
			expect(
				await page.evaluate(() =>
					(
						globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
					).navigator.clipboard.readText(),
				),
			).toBe(createdPrompt);
			await page.screenshot({ animations: "disabled", path: join(evidence, "deleted-task-prompt-desktop.png") });
			await viewer.getByRole("button", { name: "返回列表", exact: true }).click();
			await page.keyboard.press("Escape");
			const afterQueryState = await client(alphaId).workspace.getState.query();
			expect(afterQueryState.board).toEqual(beforeQueryState.board);
			expect(afterQueryState.sessions).toEqual(beforeQueryState.sessions);
			try {
				expect(countCommittedEvents()).toEqual(eventCountBeforeQueries);
			} finally {
				readOnlyLedger.close();
				readOnlyLedger = null;
			}
			// 直达焦点视图只改变阅读位置，查询弹窗不启动被删除任务。
			await page.goto(`${webOrigin}/${alphaId}?task=${focusId}`);
			await page.getByRole("button", { name: "已删除 Task", exact: true }).click();
			await history.getByText("历史目标 Alpha", { exact: true }).waitFor();
			await page.screenshot({
				animations: "disabled",
				path: join(evidence, "deleted-task-focus-sidebar-entry.png"),
			});
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Back to board", exact: true }).click();
			await page.getByRole("button", { name: "Show all projects", exact: true }).click();
			await page.goto(`${webOrigin}/${alphaId}?task=${focusId}`);
			await page.getByRole("button", { name: "已删除 Task", exact: true }).click();
			await history.getByText("历史目标 Beta", { exact: true }).waitFor();
			expect(await history.getByLabel("已删除 Task 的项目范围").inputValue()).toBe("");
			await page.screenshot({
				animations: "disabled",
				path: join(evidence, "deleted-task-all-projects-focus-entry.png"),
			});
			await page.keyboard.press("Escape");
			await page.setViewportSize({ width: 390, height: 844 });
			await page.getByRole("button", { name: "展开上方导航与工具", exact: true }).click();
			await page.getByRole("button", { name: "查看已删除 Task", exact: true }).click();
			await history.getByText("历史目标 Alpha", { exact: true }).waitFor();
			expect(
				await page.evaluate(() => {
					const viewport = globalThis as unknown as {
						document: { documentElement: { scrollWidth: number } };
						innerWidth: number;
					};
					return viewport.document.documentElement.scrollWidth <= viewport.innerWidth;
				}),
			).toBe(true);
			await page.screenshot({ animations: "disabled", path: join(evidence, "deleted-task-history-mobile.png") });
			await history.getByRole("button", { name: "便签 1", exact: true }).click();
			await stickerOverlay.getByRole("button", { name: "展开便签", exact: true }).click();
			await stickerOverlay.getByText(retainedStickerText, { exact: true }).waitFor();
			await page.screenshot({ animations: "disabled", path: join(evidence, "deleted-task-sticker-mobile.png") });
			expect(requests.some((url) => url.includes(":3484/"))).toBe(false);
			expect(requests.some((url) => url.includes("taskCardAction."))).toBe(false);
			expect(pageErrors).toEqual([]);
			writeFileSync(
				join(evidence, "verification-results.json"),
				JSON.stringify(
					{
						runtimePort,
						webPort,
						deletedId,
						otherDeletedId,
						checks: [
							"真实永久删除后可查询",
							"删除前账本便签进入历史 API 与卡片，只读展开不写服务端",
							"已删除便签不复活",
							"跨项目范围",
							"完整 Prompt 逐字复制",
							"创建时与删除前版本",
							"看板、sessions 与账本事件数不变",
							"单项目、All projects Focus View 与手机入口",
							"无任务变更请求",
						],
						pageErrors,
					},
					null,
					2,
				),
			);
		} finally {
			readOnlyLedger?.close();
			const page = browser?.contexts()[0]?.pages()[0];
			if (page) {
				await page
					.screenshot({ animations: "disabled", path: join(evidence, "last-browser-state.png") })
					.catch(() => {});
				writeFileSync(join(evidence, "last-browser-state.html"), await page.content().catch(() => ""));
			}
			await browser?.close();
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
			for (const [role, output] of Object.entries(logs)) writeFileSync(join(evidence, `${role}.log`), output);
			fixture.cleanup();
		}
	},
	180000,
);
