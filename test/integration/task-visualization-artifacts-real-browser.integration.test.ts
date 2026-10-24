import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageTaskVisualizationPublication } from "../../src/task-visualization-artifacts/stage-task-visualization-publication";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType, Page, Route } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_TASK_VISUALIZATION_PACKAGED_CLI_PATH;
const browserEvidenceDirectory = process.env.KANBAN_TASK_VISUALIZATION_BROWSER_EVIDENCE_DIRECTORY;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());
const cliExitDeadline = {
	waitedForDescription: "可视化 CLI 完整返回发布回执",
	softDeadlineMsExpectedOnUncontendedHost: 8_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
};
const testTimeoutMs = computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
	runtimeColdStartCount: 2,
	testBodyTimeoutBudgetMs: 170_000,
	cliChildProcessSpawns: { cliChildProcessSpawnCount: 5, cliChildProcessExitTwoTierDeadline: cliExitDeadline },
});

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("未取得隔离测试端口。");
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	return address.port;
}

async function dismissOnboarding(page: Page): Promise<void> {
	const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
	try {
		await onboarding.waitFor({ state: "visible", timeout: 3000 });
		await onboarding.getByRole("button", { name: "Close", exact: true }).click();
	} catch {
		/* 已关闭欢迎页时无需操作。 */
	}
}

describe("可视化发布拒绝的真实运行时接线", { timeout: testTimeoutMs }, () => {
	it.skipIf(!packagedCliPath)(
		"缺失任务、Done 与包归属错误通过真实 API 明确拒绝，CLI 返回失败",
		async (testContext) => {
			if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI 路径。");
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const repository = fixture.createNonBareRepository({
				repositoryDirectoryName: "visualization-rejection-project",
			});
			await writeFile(join(repository.repositoryPath, "README.md"), "隔离发布拒绝测试\n");
			repository.commitAllRepositoryFilesAtDate({
				message: "初始化隔离发布拒绝仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const port = await availablePort();
			const packagedCliArguments = ["--require", resolve("test/integration/shutdown-ipc-hook.cjs"), packagedCliPath];
			const environment = fixture.createIsolatedChildProcessEnvironment({
				KANBAN_RUNTIME_HOST: "127.0.0.1",
				KANBAN_RUNTIME_PORT: String(port),
				KANBAN_CLI_TRPC_TIMEOUT_MS: "3000",
				KANBAN_CLI_HARD_TIMEOUT_MS: "15000",
			});
			const runtime = children.register(
				spawn(process.execPath, [...packagedCliArguments, "--no-open"], {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				}),
			);
			await waitForRuntimeServerStartupBannerOrSigkillChild(runtime);
			const runCli = async (arguments_: string[], expectedExitCode: number) => {
				const child = children.register(
					spawn(
						process.execPath,
						[...packagedCliArguments, ...arguments_, "--project-path", repository.repositoryPath],
						{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
					),
				);
				let output = "";
				let stderr = "";
				child.stdout?.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr?.on("data", (chunk) => {
					stderr += String(chunk);
				});
				const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
				await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, cliExitDeadline, {
					describeChildProcessOutputForFailureMessage: () => `${output}\n${stderr}`,
				});
				await closed;
				expect(child.exitCode, `${output}\n${stderr}`).toBe(expectedExitCode);
				return JSON.parse(output) as {
					ok: boolean;
					status?: string;
					task?: { id: string };
					publicationRequestId?: string;
					pendingPublicationDirectoryPath?: string;
				};
			};
			const task = (await runCli(["task", "create", "--title", "隔离发布任务", "--prompt", "验证发布拒绝"], 0)).task;
			if (!task) throw new Error("未创建隔离测试任务。");
			const sourceHtmlFilePath = join(fixture.fixtureRootDirectoryPath, "chart.html");
			await writeFile(sourceHtmlFilePath, "<h1>拒绝证据保留</h1>");
			const publishArguments = [
				"task",
				"visualization",
				"publish",
				"--source-html-file",
				sourceHtmlFilePath,
				"--title",
				"图表",
			];
			const missing = await runCli([...publishArguments, "--task-id", "missing-task"], 1);
			expect(missing).toMatchObject({ ok: false, status: "runtime_acceptance_rejected" });
			if (!missing.pendingPublicationDirectoryPath) throw new Error("缺少拒绝包路径。");
			expect(
				JSON.parse(
					await readFile(
						join(missing.pendingPublicationDirectoryPath, "runtime-acceptance-rejection.json"),
						"utf8",
					),
				),
			).toMatchObject({ failureCode: "NOT_FOUND" });
			const unscopedClient = createTRPCProxyClient<RuntimeAppRouter>({
				links: [httpLink({ url: `http://127.0.0.1:${port}/api/trpc` })],
			});
			const project = (await unscopedClient.projects.list.query()).projects.find(
				(entry) => entry.path === repository.repositoryPath,
			);
			if (!project) throw new Error("隔离项目未注册。");
			const client = createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `http://127.0.0.1:${port}/api/trpc`,
						headers: { "x-kanban-workspace-id": project.id },
					}),
				],
			});
			const runtimeHomeDirectoryPath = join(fixture.isolatedHomeDirectoryPath, ".cline", "kanban");
			for (const ownershipMismatch of ["task", "repository"] as const) {
				const pending = await stageTaskVisualizationPublication({
					runtimeHomeDirectoryPath,
					workspaceId: project.id,
					workspaceRepositoryPath:
						ownershipMismatch === "repository" ? "/wrong-project" : repository.repositoryPath,
					taskId: task.id,
					title: "归属拒绝图表",
					sourceHtmlFilePath,
				});
				await expect(
					client.taskVisualizationArtifacts.publish.mutate({
						taskId: ownershipMismatch === "task" ? "wrong-task" : task.id,
						publicationRequestId: pending.publicationRequestId,
					}),
				).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
				expect(
					JSON.parse(
						await readFile(
							join(pending.pendingPublicationDirectoryPath, "runtime-acceptance-rejection.json"),
							"utf8",
						),
					),
				).toMatchObject({ failureCode: "BAD_REQUEST" });
			}
			await runCli(["task", "done", "--task-id", task.id], 0);
			const done = await runCli([...publishArguments, "--task-id", task.id], 1);
			expect(done).toMatchObject({ ok: false, status: "runtime_acceptance_rejected" });
			if (!done.pendingPublicationDirectoryPath) throw new Error("缺少 Done 拒绝包路径。");
			expect(
				JSON.parse(
					await readFile(join(done.pendingPublicationDirectoryPath, "runtime-acceptance-rejection.json"), "utf8"),
				),
			).toMatchObject({ failureCode: "FORBIDDEN" });
			await expect(
				readFile(join(done.pendingPublicationDirectoryPath, "accepted-artifact.json")),
			).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readFile(join(done.pendingPublicationDirectoryPath, "files", "chart.html"), "utf8")).toContain(
				"拒绝证据保留",
			);
		},
	);
});

describe("持久 HTML 可视化的真实打包 CLI 与浏览器", { timeout: testTimeoutMs }, () => {
	it.skipIf(!packagedCliPath)("远端页面自动预览、资源与控制面隔离、离线发布恢复及手机查看", async (testContext) => {
		if (!packagedCliPath) throw new Error("缺少隔离构建的 CLI 路径。");
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "visualization-browser-project" });
		await writeFile(join(repository.repositoryPath, "README.md"), "隔离可视化验收\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "初始化隔离验收仓库",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const port = await availablePort();
		const origin = `http://127.0.0.1:${port}`;
		const environment = fixture.createIsolatedChildProcessEnvironment({
			KANBAN_RUNTIME_HOST: "127.0.0.1",
			KANBAN_RUNTIME_PORT: String(port),
			KANBAN_CLI_TRPC_TIMEOUT_MS: "3000",
			KANBAN_CLI_HARD_TIMEOUT_MS: "15000",
		});
		const startRuntime = async () => {
			const child = children.register(
				spawn(
					process.execPath,
					[
						packagedCliPath,
						"--port",
						String(port),
						"--no-open",
						"--additional-trusted-browser-origin",
						`http://localhost:${port}`,
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe"] },
				),
			);
			await waitForRuntimeServerStartupBannerOrSigkillChild(child);
			return child;
		};
		const runCli = async (args: string[]) => {
			const child = children.register(
				spawn(process.execPath, [packagedCliPath, ...args, "--project-path", repository.repositoryPath], {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
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
			const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, cliExitDeadline, {
				describeChildProcessOutputForFailureMessage: () => `${output}\n${stderr}`,
			});
			await closed;
			expect(child.exitCode, stderr).toBe(0);
			return JSON.parse(output) as {
				status?: string;
				task?: { id: string };
				viewerRelativeUrl?: string;
				artifact?: { visualizationArtifactId: string };
			};
		};
		let runtime = await startRuntime();
		let browser: Browser | null = null;
		try {
			const created = await runCli([
				"task",
				"create",
				"--title",
				"远端可视化验收",
				"--prompt",
				"隔离 HTML 发布测试",
				"--start-in-plan-mode",
				"true",
			]);
			const taskId = created.task?.id;
			if (!taskId) throw new Error("未创建隔离任务。");
			const createClient = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${origin}/api/trpc`,
							headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
						}),
					],
				});
			const workspaceId = (await createClient().projects.list.query()).projects.find(
				(project) => project.path === repository.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("隔离项目未注册。");
			const client = createClient(workspaceId);
			const requireFromWeb = createRequire(resolve("web-ui/package.json"));
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			browser = await chromium.launch({ headless: true });
			const firstPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
			const secondPage = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
			const pageErrors: string[] = [];
			const browserDeclarations = new Map<Page, { taskId: string | null; isForeground: boolean }>();
			for (const page of [firstPage, secondPage]) {
				page.setDefaultTimeout(20_000);
				page.on("pageerror", (error) => pageErrors.push(error.message));
				page.on("websocket", (socket) =>
					socket.on("framesent", ({ payload }) => {
						try {
							const message = JSON.parse(String(payload));
							if (message.type === "declare_task_visualization_browser_context")
								browserDeclarations.set(page, message);
						} catch {
							/* 其他 WebSocket 帧与本断言无关。 */
						}
					}),
				);
				await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
				await dismissOnboarding(page);
				await page.getByRole("combobox", { name: "工作台格位 2", exact: true }).waitFor();
			}
			await secondPage.bringToFront();
			await secondPage.keyboard.press("Shift");
			await vi.waitFor(
				() => expect(browserDeclarations.get(secondPage)).toMatchObject({ taskId, isForeground: true }),
				{ timeout: 20_000 },
			);
			const sourceDirectory = join(fixture.fixtureRootDirectoryPath, "HTML 中文 空格");
			await mkdir(join(sourceDirectory, "resources"), { recursive: true });
			const sourceHtmlFile = join(sourceDirectory, "chart.html");
			await writeFile(join(sourceDirectory, "resources/chart.js"), "document.body.dataset.scriptLoaded = 'true';");
			await writeFile(join(sourceDirectory, "resources/sample.json"), JSON.stringify({ label: "相邻数据已加载" }));
			await writeFile(
				sourceHtmlFile,
				'<!doctype html><meta charset="utf-8"><h1>交互图表第一版</h1><script src="resources/chart.js"></script><script>fetch("resources/sample.json").then(r=>r.json()).then(v=>{document.body.dataset.jsonLoaded=v.label});try{parent.document.body.dataset.unsafe="yes"}catch{document.body.dataset.parentIsolated="true"}fetch("/api/passcode/status").then(()=>document.body.dataset.controlRead="allowed",()=>document.body.dataset.controlRead="blocked");</script>',
			);
			const publicationArguments = [
				"task",
				"visualization",
				"publish",
				"--task-id",
				taskId,
				"--source-html-file",
				sourceHtmlFile,
				"--title",
				"交互图表",
				"--resource-mapping",
				`resources=${join(sourceDirectory, "resources")}`,
			];
			const contentEntryPattern = "**/api/task-visualization-content/**/chart.html";
			let releaseInitialEntryResponse = () => {};
			let initialEntryHasBeenRequested = false;
			const initialEntryResponseMayContinue = new Promise<void>((resolveContinue) => {
				releaseInitialEntryResponse = resolveContinue;
			});
			const delayInitialEntryResponse = async (route: Route) => {
				initialEntryHasBeenRequested = true;
				await initialEntryResponseMayContinue;
				await route.continue();
			};
			await secondPage.route(contentEntryPattern, delayInitialEntryResponse);
			const frameLocator = secondPage.frameLocator('iframe[title="交互图表"]');
			try {
				const published = await runCli(publicationArguments);
				expect(published.status).toBe("published");
				await vi.waitFor(() => expect(initialEntryHasBeenRequested).toBe(true), { timeout: 20_000 });
				const pending = (await client.taskVisualizationArtifacts.list.query({ taskId })).latestPreviewRequest;
				expect(pending?.acceptedByBrowserPageId).toBeDefined();
				expect(pending?.displayedAtMs).toBeNull();
				const entrySource = await secondPage.locator('iframe[title="交互图表"]').getAttribute("src");
				if (!entrySource) throw new Error("慢加载入口没有 iframe 来源。");
				const payload = JSON.parse(
					Buffer.from(new URL(entrySource, origin).pathname.split("/")[3].split(".")[0], "base64url").toString(
						"utf8",
					),
				) as {
					artifact: { workspaceId: string; taskId: string; visualizationArtifactId: string; revisionId: string };
					contentLoadConfirmationId: string;
				};
				const untrustedSourceProof = {
					type: "kanban_visualization_content_loaded",
					...payload.artifact,
					contentLoadConfirmationId: payload.contentLoadConfirmationId,
				};
				await secondPage.evaluate(
					`window.dispatchEvent(new MessageEvent("message", { source: window, origin: "null", data: ${JSON.stringify(untrustedSourceProof)} }))`,
				);
				// 此反向观察必须跨过原 5 秒改派边界，再让另一页面主动交互。
				await firstPage.waitForTimeout(5_500);
				await firstPage.bringToFront();
				await firstPage.keyboard.press("Shift");
				await vi.waitFor(
					() => expect(browserDeclarations.get(firstPage)).toMatchObject({ taskId, isForeground: true }),
					{ timeout: 20_000 },
				);
				await firstPage.waitForTimeout(300);
				expect(await firstPage.locator('iframe[title="交互图表"]').count()).toBe(0);
				expect(await secondPage.locator('iframe[title="交互图表"]').count()).toBe(1);
				expect(
					(await client.taskVisualizationArtifacts.list.query({ taskId })).latestPreviewRequest?.displayedAtMs,
				).toBeNull();
				await secondPage.bringToFront();
				await secondPage.keyboard.press("Shift");
			} finally {
				releaseInitialEntryResponse();
			}
			await frameLocator.getByRole("heading", { name: "交互图表第一版" }).waitFor();
			await secondPage.unroute(contentEntryPattern, delayInitialEntryResponse);
			await vi.waitFor(
				async () =>
					expect(
						(await client.taskVisualizationArtifacts.list.query({ taskId })).latestPreviewRequest?.displayedAtMs,
					).toEqual(expect.any(Number)),
				{ timeout: 20_000 },
			);
			expect(await firstPage.locator('iframe[title="交互图表"]').count()).toBe(0);
			const frame = secondPage.frames().find((entry) => entry.url().includes("/api/task-visualization-content/"));
			if (!frame) throw new Error("未找到隔离可视化 frame。");
			await vi.waitFor(
				async () =>
					expect(await frame.evaluate("({...document.body.dataset})")).toMatchObject({
						scriptLoaded: "true",
						jsonLoaded: "相邻数据已加载",
						parentIsolated: "true",
						controlRead: "blocked",
					}),
				{ timeout: 20_000 },
			);
			const immutableContentUrl = frame.url();
			expect((await fetch(immutableContentUrl)).headers.get("content-security-policy")).toContain(
				"sandbox allow-scripts",
			);
			expect((await fetch(`${origin}/api/passcode/status`, { headers: { Origin: "null" } })).status).toBe(403);
			if (browserEvidenceDirectory) {
				await mkdir(browserEvidenceDirectory, { recursive: true });
				await secondPage.screenshot({ path: join(browserEvidenceDirectory, "desktop-automatic-preview.png") });
			}
			// 新请求返回 404；旧 frame 和旧证明即使迟到也不能把新请求写成 displayed。
			await firstPage.close();
			await secondPage.bringToFront();
			await secondPage.keyboard.press("Shift");
			await secondPage.evaluate(`void Object.defineProperty(window, "taskVisualizationPreviousFrameForDeliveryRegression", {
				value: document.querySelector('iframe[title="交互图表"]')?.contentWindow, configurable: true,
			})`);
			const previousCapabilityPayload = JSON.parse(
				Buffer.from(new URL(immutableContentUrl).pathname.split("/")[3].split(".")[0], "base64url").toString(
					"utf8",
				),
			) as {
				artifact: { workspaceId: string; taskId: string; visualizationArtifactId: string; revisionId: string };
				contentLoadConfirmationId: string;
			};
			const returnUnavailableEntry = async (route: Route) =>
				route.fulfill({
					status: 404,
					contentType: "text/plain; charset=utf-8",
					headers: { "Content-Security-Policy": "sandbox; default-src 'none'" },
					body: "模拟内容读取失败",
				});
			await secondPage.route(contentEntryPattern, returnUnavailableEntry);
			const unavailableEntryResponse = secondPage.waitForResponse(
				(response) => response.url().includes("/api/task-visualization-content/") && response.status() === 404,
			);
			const unavailablePreview = await client.taskVisualizationArtifacts.requestPreview.mutate({
				taskId,
				visualizationArtifactId: previousCapabilityPayload.artifact.visualizationArtifactId,
			});
			await unavailableEntryResponse;
			const oldProof = {
				type: "kanban_visualization_content_loaded",
				...previousCapabilityPayload.artifact,
				contentLoadConfirmationId: previousCapabilityPayload.contentLoadConfirmationId,
			};
			await secondPage.evaluate(`(() => {
				const data = ${JSON.stringify(oldProof)};
				const previousFrame = Object.getOwnPropertyDescriptor(window, "taskVisualizationPreviousFrameForDeliveryRegression")?.value;
				window.dispatchEvent(new MessageEvent("message", { source: previousFrame, origin: "null", data }));
				window.dispatchEvent(new MessageEvent("message", { source: document.querySelector('iframe[title="交互图表"]')?.contentWindow, origin: "null", data }));
			})()`);
			await secondPage.waitForTimeout(200);
			const unavailableBeforeTimeout = (await client.taskVisualizationArtifacts.list.query({ taskId }))
				.latestPreviewRequest;
			expect(unavailableBeforeTimeout?.previewRequestId).toBe(unavailablePreview.previewRequestId);
			expect(unavailableBeforeTimeout?.displayedAtMs).toBeNull();
			await vi.waitFor(
				async () => {
					const failure = (await client.taskVisualizationArtifacts.list.query({ taskId })).latestPreviewRequest;
					expect(failure?.failedAtMs).toEqual(expect.any(Number));
					expect(failure?.displayedAtMs).toBeNull();
					expect(failure?.deliveryAttemptCount).toBeLessThanOrEqual(3);
					expect(failure?.deliveryFailureReason).toContain("30 秒");
				},
				{ timeout: 45_000 },
			);
			expect(await secondPage.locator('iframe[title="交互图表"]').count()).toBe(0);
			await secondPage.unroute(contentEntryPattern, returnUnavailableEntry);
			await secondPage
				.getByRole("combobox", { name: "选择可视化", exact: true })
				.selectOption(previousCapabilityPayload.artifact.visualizationArtifactId);
			await frameLocator.getByRole("heading", { name: "交互图表第一版" }).waitFor();
			await writeFile(sourceHtmlFile, "<!doctype html><meta charset=utf-8><h1>交互图表第二版</h1>");
			await runCli(publicationArguments);
			await secondPage.getByRole("button", { name: "加载最新版本", exact: true }).waitFor();
			expect(frame.url()).toBe(immutableContentUrl);
			await secondPage.getByRole("button", { name: "加载最新版本", exact: true }).click();
			await frameLocator.getByRole("heading", { name: "交互图表第二版" }).waitFor();
			const popupPromise = secondPage.waitForEvent("popup");
			await secondPage.getByRole("link", { name: "新标签", exact: true }).click();
			const popup = await popupPromise;
			await popup
				.frameLocator('iframe[title="交互图表"]')
				.getByRole("heading", { name: "交互图表第二版" })
				.waitFor();
			expect(new URL(popup.url()).origin).toBe(origin);
			await popup.close();
			runtime.kill("SIGINT");
			await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, runtime, cliExitDeadline);
			const offlineHtml = join(fixture.fixtureRootDirectoryPath, "offline.html");
			await writeFile(offlineHtml, "<h1>离线固化</h1>");
			const pending = await runCli([
				"task",
				"visualization",
				"publish",
				"--task-id",
				taskId,
				"--source-html-file",
				offlineHtml,
				"--title",
				"离线图表",
			]);
			expect(pending.status).toBe("awaiting_runtime_acceptance");
			await rm(sourceDirectory, { recursive: true });
			await rm(offlineHtml);
			runtime = await startRuntime();
			await vi.waitFor(
				async () =>
					expect((await client.taskVisualizationArtifacts.list.query({ taskId })).artifacts).toHaveLength(2),
				{ timeout: 20_000 },
			);
			expect((await fetch(immutableContentUrl)).status).toBe(200);
			const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
			phone.on("pageerror", (error) => pageErrors.push(error.message));
			phone.on("websocket", (socket) =>
				socket.on("framesent", ({ payload }) => {
					try {
						const message = JSON.parse(String(payload));
						if (message.type === "declare_task_visualization_browser_context")
							browserDeclarations.set(phone, message);
					} catch {
						/* 只观察声明消息。 */
					}
				}),
			);
			await phone.goto(`${origin}/${workspaceId}?task=${taskId}`);
			await dismissOnboarding(phone);
			await phone.bringToFront();
			await vi.waitFor(() => expect(browserDeclarations.get(phone)).toMatchObject({ taskId, isForeground: true }), {
				timeout: 20_000,
			});
			const artifact = (await client.taskVisualizationArtifacts.list.query({ taskId })).artifacts.find(
				(entry) => entry.title === "交互图表",
			);
			if (!artifact) throw new Error("已发布图表不存在。");
			await client.taskVisualizationArtifacts.requestPreview.mutate({
				taskId,
				visualizationArtifactId: artifact.visualizationArtifactId,
			});
			await phone
				.frameLocator('iframe[title="交互图表"]')
				.getByRole("heading", { name: "交互图表第二版" })
				.waitFor();
			expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
			if (browserEvidenceDirectory)
				await phone.screenshot({ path: join(browserEvidenceDirectory, "mobile-automatic-preview.png") });
			const visualizationPlatformScriptPath = process.env.KANBAN_TASK_VISUALIZATION_PLATFORM_SCRIPT_PATH;
			if (visualizationPlatformScriptPath) {
				const runVisualizationPlatform = async (args: string[], input = "") => {
					const child = children.register(
						spawn(process.execPath, [visualizationPlatformScriptPath, ...args], {
							cwd: repository.repositoryPath,
							env: fixture.createIsolatedChildProcessEnvironment({
								KANBAN_RUNTIME_HOST: "127.0.0.1",
								KANBAN_RUNTIME_PORT: String(port),
								KANBAN_TASK_ID: taskId,
								KANBAN_PROJECT_PATH: repository.repositoryPath,
								AI_VIZ_RUNTIME_DIR_OVERRIDE: join(fixture.fixtureRootDirectoryPath, "isolated-skill-runtime"),
								AI_VIZ_ENABLE_KANBAN_PUBLICATION_IN_ISOLATED_RUNTIME: "1",
								KANBAN_VISUALIZATION_PUBLISH_COMMAND_JSON: JSON.stringify([process.execPath, packagedCliPath]),
							}),
							stdio: ["pipe", "pipe", "pipe"],
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
					child.stdin?.end(input);
					const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
					await waitForChildProcessExitWithinLoadSensitiveTwoTierDeadline(testContext, child, cliExitDeadline, {
						describeChildProcessOutputForFailureMessage: () => `${output}\n${stderr}`,
					});
					await closed;
					expect(child.exitCode, stderr).toBe(0);
					return output;
				};
				const createdPage = (await runVisualizationPlatform(["--new", "--title", "Skill 自动发布"]))
					.trim()
					.split("\n")
					.at(-1);
				if (!createdPage) throw new Error("未创建隔离 skill 页面。");
				const output = await runVisualizationPlatform(
					["--append", createdPage, "--type", "mermaid", "--title", "远端图解"],
					"flowchart TD\n A[任务生成] --> B[当前浏览器预览]\n",
				);
				expect(output).toContain("KANBAN_PUBLICATION_STATUS: published");
				await phone.frameLocator('iframe[title*="Skill 自动发布"]').locator("svg").first().waitFor();
				if (browserEvidenceDirectory)
					await phone.screenshot({ path: join(browserEvidenceDirectory, "mobile-skill-mermaid-preview.png") });
			}
			expect(pageErrors).toEqual([]);
		} finally {
			await browser?.close();
		}
	});
});
