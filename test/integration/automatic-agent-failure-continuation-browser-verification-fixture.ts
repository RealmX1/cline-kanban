import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { RuntimeBoardData, RuntimeProjectSummary } from "../../src/core/api-contract";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "../../src/server/cross-project-task-switcher-entry-projection";
import {
	buildTaskActivityDetailFromBoardCardAndTaskSessionFacts,
	extractTaskSessionFactsByTaskIdForCrossProjectTaskViews,
} from "../../src/server/in-progress-task-detail-projection";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import type { Browser, BrowserType, Page } from "../../web-ui/node_modules/playwright-core";
import type { IsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { sigkillChildProcessAndWaitForExit } from "./runtime-integration-test-spawned-child-process-lifecycle";

export async function createAutomaticFailureContinuationBrowserVerificationFixture(input: {
	fixture: IsolatedGitTestWorkspaceFixture;
	manager: TerminalSessionManager;
	workspaceId: string;
	taskId: string;
	evidenceDirectory: string;
}) {
	const { fixture, manager, workspaceId, taskId } = input;
	const board: RuntimeBoardData = {
		columns: [
			{
				id: "in_progress",
				title: "进行中",
				cards: [
					{
						id: taskId,
						title: "容量不足自动恢复",
						prompt: "验证原任务续跑",
						baseRef: "main",
						startInPlanMode: true,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						agentId: "codex",
					},
				],
			},
		],
	};
	const hub = createRuntimeStateHub({
		workspaceRegistry: {
			resolveWorkspaceForStream: async () => ({
				status: "no_registered_project",
				projectId: null,
				workspacePath: null,
			}),
			buildWorkspaceStateSnapshot: async () => {
				throw new Error("全项目视图不应读取当前项目快照");
			},
			buildProjectsPayloadUsingCachedRuntimeProjectAvailability: async () => {
				const project: RuntimeProjectSummary = {
					id: workspaceId,
					name: "隔离容量恢复项目",
					path: fixture.ownedIntegrationProjectsDirectoryPath,
					availability: { status: "available" },
					taskCounts: { backlog: 0, in_progress: 1, review: 0, validation: 0, trash: 0 },
					inProgressTaskDetails: board.columns.flatMap((column) =>
						column.cards.map((card) =>
							buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(
								card,
								extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(manager.listSummaries()).get(card.id),
							),
						),
					),
					crossProjectTaskSwitcherEntries: collectCrossProjectTaskSwitcherEntriesFromBoard({
						board,
						sessionFactsByTaskId: extractTaskSessionFactsByTaskIdForCrossProjectTaskViews(
							manager.listSummaries(),
						),
						lastOpenedByUserAtByTaskId: new Map(),
						nowMs: Date.now(),
						activityHorizonMs: 86_400_000,
					}),
				};
				return { currentProjectId: null, projects: [project] };
			},
		},
	});
	hub.trackTerminalManager(workspaceId, manager);
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		hub.handleUpgrade(request, socket, head, {
			requestedWorkspaceId: null,
			initialWorkspaceMetadataProbeScope: null,
		});
	});
	await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
	const streamAddress = server.address();
	if (!streamAddress || typeof streamAddress === "string") throw new Error("状态流端口不可用");
	const portReservation = createServer();
	await new Promise<void>((accept) => portReservation.listen(0, "127.0.0.1", accept));
	const webAddress = portReservation.address();
	if (!webAddress || typeof webAddress === "string") throw new Error("浏览器端口不可用");
	await new Promise<void>((accept) => portReservation.close(() => accept()));
	const sourceCheckout = resolve(import.meta.dirname, "../..");
	const configurationPath = join(fixture.fixtureRootDirectoryPath, "capacity-recovery-vite.config.mts");
	await writeFile(
		configurationPath,
		`import base from ${JSON.stringify(join(sourceCheckout, "web-ui/vite.config.ts"))};
export default { ...base, cacheDir: ${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-cache"))}, server: { host: "127.0.0.1", port: ${webAddress.port}, strictPort: true }, optimizeDeps: { entries: [${JSON.stringify(join(sourceCheckout, "web-ui/index.html"))}] } };`,
	);
	const vite = spawn(
		process.execPath,
		[join(sourceCheckout, "web-ui/node_modules/vite/bin/vite.js"), "--config", configurationPath],
		{
			cwd: join(sourceCheckout, "web-ui"),
			env: fixture.createIsolatedChildProcessEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let viteOutput = "";
	vite.stdout.on("data", (chunk) => {
		viteOutput += String(chunk);
	});
	vite.stderr.on("data", (chunk) => {
		viteOutput += String(chunk);
	});
	let browser: Browser | undefined;
	const pages: Page[] = [];
	const errors: string[] = [];
	const dispose = async () => {
		await browser?.close();
		await sigkillChildProcessAndWaitForExit(vite);
		await hub.close();
		await new Promise<void>((accept) => server.close(() => accept()));
	};
	try {
		await expect
			.poll(
				async () =>
					fetch(`http://127.0.0.1:${webAddress.port}`)
						.then((response) => response.ok)
						.catch(() => false),
				{ timeout: 40_000 },
			)
			.toBe(true);
		const requireWeb = createRequire(join(sourceCheckout, "web-ui/package.json"));
		const { chromium } = requireWeb("playwright-core") as { chromium: BrowserType };
		browser = await chromium.launch({ headless: true });
		for (const width of [1280, 390]) {
			const page = await browser.newPage({ viewport: { width, height: 1100 } });
			pages.push(page);
			page.on("pageerror", (error) => {
				errors.push(error.message);
			});
			await page.route("**/api/**", (route) => route.abort());
			await page.route("**/isolated-capacity-recovery?*", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
				}),
			);
			await page.goto(
				`http://127.0.0.1:${webAddress.port}/isolated-capacity-recovery?stream=${encodeURIComponent(`ws://127.0.0.1:${streamAddress.port}`)}`,
			);
			await page.addScriptTag({
				type: "module",
				content:
					"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
			});
			await page.addScriptTag({
				type: "module",
				url: "/tests/automatic-agent-failure-continuation-native-stream-browser-harness.tsx",
			});
		}
	} catch (error) {
		await dispose();
		throw new Error(`隔离浏览器启动失败：${String(error)}\n${viteOutput}`);
	}
	return {
		dispose,
		async assertPhase(phase: string, waitingNotice = "容量不足") {
			for (const page of pages) {
				await expect
					.poll(() => page.locator("main").getAttribute("data-native-capacity-browser-phase"), { timeout: 15_000 })
					.toBe(phase);
				if (["waiting_backoff", "waiting_machine_evidence", "sending", "reconciling_acceptance"].includes(phase)) {
					expect(
						await page
							.locator(
								'[data-cross-project-task-switcher-section="running"][data-cross-project-task-switcher-task-id]',
							)
							.count(),
					).toBe(0);
					expect(
						await page.locator('[data-cross-project-task-switcher-section="waiting_automatic_recovery"]').count(),
					).toBe(2);
					await expect
						.poll(() => page.locator("[data-automatic-agent-failure-continuation]").textContent())
						.toContain(waitingNotice);
				} else if (phase === "executing") {
					expect(
						await page.locator('[data-cross-project-task-switcher-section="waiting_automatic_recovery"]').count(),
					).toBe(0);
					const expandRunning = page.locator(
						'[data-testid="cross-project-task-switcher-section-running"] button[aria-expanded="false"]',
					);
					if (await expandRunning.count()) await expandRunning.first().click();
					await expect
						.poll(() =>
							page
								.locator(
									'[data-cross-project-task-switcher-section="running"][data-cross-project-task-switcher-task-id]',
								)
								.count(),
						)
						.toBe(2);
					expect(await page.getByTestId("board-scope-all-projects-home-page-summary").textContent()).toContain(
						"1 live",
					);
				}
				await page.screenshot({
					path: join(input.evidenceDirectory, `capacity-${phase}-${page.viewportSize()?.width}.png`),
					fullPage: true,
				});
			}
			expect(errors).toEqual([]);
		},
	};
}
