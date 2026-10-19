import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { Browser, BrowserType, Page } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	hasChildProcessExited,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

// 真实 Codex 会请求模型，须显式启用；凭据只复制到隔离 HOME，证据不包含凭据或系统提示词。
const runsRealCodexBrowserCheck = process.env.KANBAN_RUN_MOBILE_CODEX_BACKGROUND_STARTUP_BROWSER_CHECK === "1";
const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit(), 30000);

interface NativeTranscriptRecord {
	timestamp?: string;
	type?: string;
	payload?: {
		id?: string;
		role?: string;
		content?: Array<{ text?: string }>;
		collaboration_mode?: { mode?: string };
	};
}

it.skipIf(!runsRealCodexBrowserCheck)(
	"手机创建并后台发起 Codex，无终端连接也能完整投递一次 Plan Mode 首条提示词",
	async (testContext) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const sourceCheckout = resolve(import.meta.dirname, "../..");
		const evidenceDirectory = process.env.KANBAN_MOBILE_CODEX_STARTUP_EVIDENCE_OUTPUT_DIRECTORY;
		const authenticationFile = process.env.KANBAN_MOBILE_CODEX_STARTUP_AUTHENTICATION_FILE_PATH;
		const codexBinary = process.env.KANBAN_MOBILE_CODEX_STARTUP_BINARY_PATH;
		const modelId = process.env.KANBAN_MOBILE_CODEX_STARTUP_MODEL_ID;
		const usesPackagedRuntime = process.env.KANBAN_MOBILE_CODEX_STARTUP_USE_PACKAGED_RUNTIME === "1";
		let browser: Browser | null = null;
		let lastPage: Page | null = null;
		const ownedProcesses: Array<{ child: ChildProcess; role: string; output: string }> = [];
		const results: Array<Record<string, unknown>> = [];
		try {
			if (!evidenceDirectory || !authenticationFile || !codexBinary || !modelId) {
				throw new Error("真实验证需要显式指定持久证据目录、Codex 凭据文件、可执行文件与模型。");
			}
			mkdirSync(evidenceDirectory, { recursive: true });
			const projects = ["mobile-startup-alpha", "mobile-startup-beta"].map((repositoryDirectoryName) => {
				const repository = fixture.createNonBareRepository({ repositoryDirectoryName });
				writeFileSync(join(repository.repositoryPath, "initial.txt"), "初始化隔离验证项目\n");
				repository.commitAllRepositoryFilesAtDate({
					message: "初始化手机后台启动验证",
					authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
				});
				return repository;
			});
			const isolatedCodexHome = join(fixture.fixtureRootDirectoryPath, "isolated-codex-home");
			const executableDirectory = join(fixture.fixtureRootDirectoryPath, "isolated-agent-executables");
			mkdirSync(isolatedCodexHome);
			mkdirSync(executableDirectory);
			copyFileSync(authenticationFile, join(isolatedCodexHome, "auth.json"));
			const modelsCache = join(dirname(authenticationFile), "models_cache.json");
			if (existsSync(modelsCache)) copyFileSync(modelsCache, join(isolatedCodexHome, "models_cache.json"));
			writeFileSync(
				join(isolatedCodexHome, "config.toml"),
				`model = ${JSON.stringify(modelId)}\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n`,
			);
			symlinkSync(codexBinary, join(executableDirectory, "codex"));
			async function reservePort() {
				const server = createServer();
				await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("隔离端口分配失败");
				await new Promise<void>((accept) => server.close(() => accept()));
				expect([3484, 3485]).not.toContain(address.port);
				return address.port;
			}
			const runtimePort = await reservePort();
			const webPort = usesPackagedRuntime ? runtimePort : await reservePort();
			const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
			const webOrigin = `http://127.0.0.1:${webPort}`;
			const environment = fixture.createIsolatedChildProcessEnvironment();
			for (const key of Object.keys(environment)) {
				if (/^(KANBAN_|CLINE_KANBAN_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/.test(key)) delete environment[key];
			}
			Object.assign(environment, {
				NODE_ENV: "development",
				CODEX_HOME: isolatedCodexHome,
				PATH: `${executableDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
				KANBAN_RUNTIME_PORT: String(runtimePort),
			});
			const requireFromSource = createRequire(join(sourceCheckout, "package.json"));
			const requireFromWeb = createRequire(join(sourceCheckout, "web-ui/package.json"));
			function startOwnedProcess(role: string, arguments_: string[], cwd: string) {
				const child = childProcesses.register(
					spawn(process.execPath, arguments_, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] }),
				);
				const record = { child, role, output: "" };
				ownedProcesses.push(record);
				child.stdout?.on("data", (chunk) => {
					record.output += String(chunk);
				});
				child.stderr?.on("data", (chunk) => {
					record.output += String(chunk);
				});
				return child;
			}
			const shutdownHook = join(sourceCheckout, "test/integration/shutdown-ipc-hook.cjs");
			const runtimeProcess = startOwnedProcess(
				"isolated-runtime",
				[
					"--require",
					shutdownHook,
					...(usesPackagedRuntime
						? [join(sourceCheckout, "dist/cli.js")]
						: ["--import", requireFromSource.resolve("tsx"), join(sourceCheckout, "src/cli.ts")]),
					"--host",
					"127.0.0.1",
					"--port",
					String(runtimePort),
					"--no-open",
				],
				projects[0].repositoryPath,
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
			const waitUntil = (description: string, condition: () => boolean | Promise<boolean>, hardDeadlineMs = 60000) =>
				waitForConditionWithinLoadSensitiveTwoTierDeadline(
					testContext,
					{
						waitedForDescription: description,
						softDeadlineMsExpectedOnUncontendedHost: 15000,
						hardDeadlineMsOnlyExplainedByRealHangOrRegression: hardDeadlineMs,
					},
					condition,
					{ pollIntervalMs: 250 },
				);
			await waitUntil("隔离运行时启动", () => {
				if (hasChildProcessExited(runtimeProcess)) throw new Error(ownedProcesses[0].output);
				return fetch(`${runtimeOrigin}/api/trpc/projects.list`)
					.then((r) => r.ok)
					.catch(() => false);
			});
			await client().projects.add.mutate({ path: projects[1].repositoryPath });
			const registeredProjects = (await client().projects.list.query()).projects;
			const workspaceIds = projects.map(
				(p) => registeredProjects.find((entry) => entry.path === p.repositoryPath)?.id,
			);
			const [alphaId, betaId] = workspaceIds;
			if (!alphaId || !betaId) throw new Error("隔离项目未注册");
			await client(alphaId).runtime.saveConfig.mutate({ selectedAgentId: "codex" });
			if (!usesPackagedRuntime) {
				const viteConfiguration = join(fixture.fixtureRootDirectoryPath, "mobile-startup-vite.config.mts");
				writeFileSync(
					viteConfiguration,
					`import base from ${JSON.stringify(join(sourceCheckout, "web-ui/vite.config.ts"))};
export default { ...base, optimizeDeps: { entries: [${JSON.stringify(join(sourceCheckout, "web-ui/index.html"))}], include: ["react", "react-dom/client", "react/jsx-runtime", "@xyflow/react", "@dagrejs/dagre"] }, cacheDir: ${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-cache"))}, server: { ...base.server, host: "127.0.0.1", port: ${webPort}, strictPort: true, proxy: { "/api": { target: ${JSON.stringify(runtimeOrigin)}, changeOrigin: true, ws: true, headers: { origin: ${JSON.stringify(runtimeOrigin)} } } } } };`,
				);
				startOwnedProcess(
					"isolated-vite",
					[
						"--require",
						shutdownHook,
						join(sourceCheckout, "web-ui/node_modules/vite/bin/vite.js"),
						"--config",
						viteConfiguration,
					],
					join(sourceCheckout, "web-ui"),
				);
				await waitUntil("隔离浏览器页面启动", () =>
					fetch(webOrigin)
						.then((r) => r.ok)
						.catch(() => false),
				);
			}
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			browser = await chromium.launch({ headless: true });
			for (const scenario of [
				{
					name: "all-projects-current-project",
					scope: "board_scope_all_projects",
					target: alphaId,
					project: "mobile-startup-alpha",
				},
				{
					name: "all-projects-other-project",
					scope: "board_scope_all_projects",
					target: betaId,
					project: "mobile-startup-beta",
				},
				{
					name: "single-project-control",
					scope: "single_project_scope",
					target: alphaId,
					project: "mobile-startup-alpha",
				},
			]) {
				const context = await browser.newContext({
					viewport: { width: 390, height: 844 },
					isMobile: true,
					hasTouch: true,
				});
				await context.addInitScript((scope) => {
					localStorage.setItem("kanban.onboarding.dialog.shown", "true");
					localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", scope);
					sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", scope);
				}, scenario.scope);
				const page = await context.newPage();
				lastPage = page;
				page.setDefaultTimeout(30000);
				const terminalConnections: string[] = [];
				const startRequests: string[] = [];
				page.on("websocket", (socket) => {
					if (/\/terminal\//.test(socket.url())) terminalConnections.push(socket.url());
				});
				page.on("request", (request) => {
					if (request.url().includes("startTaskCardAgentSessionMovingItIntoInProgress"))
						startRequests.push(request.postData() ?? "");
				});
				const projectConfigLoaded = page.waitForResponse(
					(response) =>
						response.url().includes("runtime.getConfig") &&
						response.request().headers()["x-kanban-workspace-id"] === alphaId &&
						response.ok(),
				);
				await page.goto(`${webOrigin}/${alphaId}`);
				await (await projectConfigLoaded).finished();
				await page.evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
				await page.getByRole("button", { name: "Create task", exact: true }).click();
				const dialog = page.getByRole("dialog").filter({ hasText: "New task" });
				if (scenario.scope === "board_scope_all_projects") {
					await dialog.getByTestId("task-creation-target-project-field").getByRole("button").click();
					await page
						.getByRole("button", { name: new RegExp(scenario.project) })
						.last()
						.click();
				}
				const marker = `MOBILE_CODEX_STARTUP_${scenario.name}_${Date.now()}`;
				const prompt = `仅回复 ${marker}。不要调用工具或访问文件。\n这是手机后台首发正文完整性检查😀。`;
				await dialog.getByPlaceholder("Describe the task...").fill(prompt);
				await dialog.getByRole("checkbox", { name: "Start in plan mode" }).setChecked(true);
				const clickedStartAt = Date.now();
				await dialog.getByRole("button", { name: "Start task", exact: true }).click();
				let taskId: string | undefined;
				await waitUntil("浏览器新卡启动", async () => {
					const state = await client(scenario.target).workspace.getState.query();
					taskId = state.board.columns
						.flatMap((column) => column.cards)
						.find((card) => card.prompt === prompt)?.id;
					return Boolean(taskId && state.sessions[taskId]?.pid);
				});
				let matchedTranscript: NativeTranscriptRecord[] = [];
				let firstPromptDeliveredAt: string | undefined;
				await waitUntil(
					"无需打开任务的原生首发与回复",
					() => {
						const sessionRoot = join(isolatedCodexHome, "sessions");
						if (!existsSync(sessionRoot)) return false;
						for (const path of readdirSync(sessionRoot, { recursive: true })
							.map(String)
							.filter((p) => p.endsWith(".jsonl"))) {
							const records = readFileSync(join(sessionRoot, path), "utf8")
								.split("\n")
								.filter(Boolean)
								.flatMap((line) => {
									try {
										return [JSON.parse(line) as NativeTranscriptRecord];
									} catch {
										return [];
									}
								});
							const messageText = (record: NativeTranscriptRecord) =>
								record.payload?.content?.map((part) => part.text ?? "").join("") ?? "";
							const prompts = records.filter(
								(record) =>
									record.type === "response_item" &&
									record.payload?.role === "user" &&
									messageText(record).includes(marker),
							);
							if (!prompts.length) continue;
							expect(prompts).toHaveLength(1);
							expect(messageText(prompts[0])).toBe(prompt);
							firstPromptDeliveredAt = prompts[0].timestamp;
							matchedTranscript = records;
							return records.some(
								(record) =>
									record.type === "response_item" &&
									record.payload?.role === "assistant" &&
									messageText(record).includes(marker),
							);
						}
						return false;
					},
					90000,
				);
				expect(
					matchedTranscript
						.filter((r) => r.type === "turn_context")
						.map((r) => r.payload?.collaboration_mode?.mode),
				).toEqual(["plan"]);
				expect(startRequests).toHaveLength(1);
				expect(startRequests[0]).toMatch(/"cols":\s*43/);
				expect(terminalConnections).toEqual([]);
				expect(new URL(page.url()).searchParams.has("task")).toBe(false);
				const diagnosticLog = readFileSync(
					join(
						fixture.isolatedHomeDirectoryPath,
						".cline/kanban/task-session-start-diagnostics/task-session-start-diagnostics.log",
					),
					"utf8",
				);
				expect(diagnosticLog).toMatch(
					new RegExp(`event=runtime_started[^\\n]*taskId=${taskId}[^\\n]*requestedTerminalColumns=43`),
				);
				results.push({
					scenario: scenario.name,
					taskId,
					nativeSessionId: matchedTranscript.find((record) => record.type === "session_meta")?.payload?.id,
					expectedPrompt: prompt,
					nativeMessageEvidence: matchedTranscript
						.filter(
							(record) =>
								record.type === "response_item" &&
								record.payload?.content?.some((part) => part.text?.includes(marker)),
						)
						.map((record) => ({
							timestamp: record.timestamp,
							role: record.payload?.role,
							content: record.payload?.content,
						})),
					firstPromptDeliveredAt,
					promptDeliveryElapsedMs: Date.parse(firstPromptDeliveredAt ?? "") - clickedStartAt,
					nativeUserMessageCount: 1,
					planMode: true,
					terminalConnectionCount: terminalConnections.length,
					startRequests,
				});
				writeFileSync(join(evidenceDirectory, "results.json"), JSON.stringify(results, null, 2));
				await context.close();
				lastPage = null;
			}
		} finally {
			if (evidenceDirectory) {
				mkdirSync(evidenceDirectory, { recursive: true });
				if (lastPage)
					await lastPage
						.screenshot({ path: join(evidenceDirectory, "failure-browser-state.png") })
						.catch(() => {});
				if (lastPage)
					await lastPage
						.content()
						.then((html) => writeFileSync(join(evidenceDirectory, "failure-browser-state.html"), html))
						.catch(() => {});
				for (const record of ownedProcesses)
					writeFileSync(join(evidenceDirectory, `${record.role}.log`), record.output);
			}
			try {
				await browser?.close();
			} finally {
				try {
					for (const { child } of ownedProcesses.reverse()) {
						if (!hasChildProcessExited(child) && child.connected) child.send({ type: "kanban.shutdown" });
						await waitForChildProcessExit(child, 15000);
					}
				} finally {
					try {
						await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
					} finally {
						fixture.cleanup();
					}
				}
			}
		}
	},
	// 覆盖两次冷启动、三组页面准备与建卡、各 90 秒原生首发等待，以及统一清理。
	720000,
);
