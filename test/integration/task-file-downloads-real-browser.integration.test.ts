import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

interface TaskFileDownloadBrowserGlobal {
	mountTaskFileDownloadsBrowserHarness(workspaceId: string, taskId: string, createdAt: number): void;
}

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(process.env.KANBAN_RUN_TASK_FILE_DOWNLOAD_BROWSER_CHECK !== "1")(
	"桌面浏览器从隔离远端运行时下载完整原文件和主会话计划，并经过登录与路径边界",
	async (context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const checkout = resolve(import.meta.dirname, "../..");
		const project = fixture.createNonBareRepository({ repositoryDirectoryName: "task-file-download-project" });
		writeFileSync(join(project.repositoryPath, "tracked.txt"), "已跟踪原文件\n");
		project.commitAllRepositoryFilesAtDate({
			message: "初始化下载测试",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const reservePort = async () => {
			const server = createServer();
			await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("无法分配端口");
			await new Promise<void>((closed) => server.close(() => closed()));
			return address.port;
		};
		const runtimePort = await reservePort();
		const webPort = await reservePort();
		const runtimeOrigin = `http://0.0.0.0:${runtimePort}`;
		const webOrigin = `http://127.0.0.1:${webPort}`;
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GOOGLE_|GEMINI_|KIMI_)/u.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-home"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite"),
			NODE_ENV: "development",
			KANBAN_RUNTIME_PORT: String(runtimePort),
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
				{
					pollIntervalMs: 100,
					describeLastObservedStateForFailureMessage: () =>
						JSON.stringify(logs).replace(
							/Remote access passcode: [A-Za-z0-9]+/gu,
							"Remote access passcode: [redacted]",
						),
				},
			);
		const { chromium } = createRequire(join(checkout, "web-ui/package.json"))("playwright-core") as {
			chromium: BrowserType;
		};
		let browser: Awaited<ReturnType<BrowserType["launch"]>> | null = null;
		try {
			start(
				"runtime",
				[
					"--import",
					createRequire(join(checkout, "package.json")).resolve("tsx"),
					join(checkout, "src/cli.ts"),
					"--host",
					"0.0.0.0",
					"--port",
					String(runtimePort),
					"--no-open",
				],
				project.repositoryPath,
			);
			await observe("隔离远端运行时启动", () =>
				fetch(`${runtimeOrigin}/api/passcode/status`)
					.then((response) => response.ok)
					.catch(() => false),
			);
			expect((await fetch(`${runtimeOrigin}/api/task-file-download`)).status).toBe(401);
			expect(
				(
					await fetch(`${runtimeOrigin}/api/task-file-download`, {
						headers: { Origin: "http://untrusted.example" },
					})
				).status,
			).toBe(403);
			const untrustedHostStatus = await new Promise<number>((resolveStatus, reject) => {
				const request = requestHttp(
					`${runtimeOrigin}/api/task-file-download`,
					{ headers: { Host: "untrusted.example" } },
					(response) => {
						response.resume();
						resolveStatus(response.statusCode ?? 0);
					},
				);
				request.on("error", reject);
				request.end();
			});
			expect(untrustedHostStatus).toBe(403);
			const passcode = /Remote access passcode: ([A-Za-z0-9]+)/u.exec(logs.runtime ?? "")?.[1];
			if (!passcode) throw new Error("隔离实例未提供登录口令");
			const login = await fetch(`${runtimeOrigin}/api/passcode/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ passcode }),
			});
			const cookie = login.headers.get("set-cookie")?.split(";")[0];
			if (!cookie) throw new Error("隔离登录未返回会话");
			const client = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${runtimeOrigin}/api/trpc`,
							headers: { cookie, ...(workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}) },
						}),
					],
				});
			const workspaceId = (await client().projects.list.query()).projects.find(
				(entry) => entry.path === project.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("未找到隔离项目");
			const { taskId } = await client(workspaceId).workspace.addBacklogTask.mutate({
				title: "下载测试任务",
				prompt: "只读下载",
			});
			const state = await client(workspaceId).workspace.getState.query();
			const card = state.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === taskId);
			if (!card) throw new Error("缺少测试任务");
			card.worktreeMode = "inplace";
			const transcriptPath = join(fixture.fixtureRootDirectoryPath, "task-main-session.jsonl");
			writeFileSync(
				transcriptPath,
				`${[
					{ type: "session_meta", payload: { id: "native-main", source: "cli" } },
					{
						type: "response_item",
						payload: {
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: "<proposed_plan># 主会话完整计划\n\n验证原文件下载。</proposed_plan>",
								},
							],
						},
					},
				]
					.map((record) => JSON.stringify(record))
					.join("\n")}\n`,
			);
			const summary: RuntimeTaskSessionSummary = {
				taskId,
				agentId: "codex",
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
				workspacePath: project.repositoryPath,
				pid: null,
				startedAt: 1,
				updatedAt: 2,
				lastOutputAt: 2,
				reviewReason: null,
				exitCode: 0,
				lastHookAt: null,
				latestHookActivity: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "native-main",
					transcriptPath,
					observedAt: 1,
				},
			};
			state.sessions[taskId] = summary;
			await client(workspaceId).workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const files = new Map<string, Buffer>([
				["tracked.txt", Buffer.from("已跟踪原文件\n")],
				["中文 文件.txt", Buffer.from("中文原文件\r\n")],
				[".hidden", Buffer.from("隐藏文件")],
				["empty.bin", Buffer.alloc(0)],
				["binary.bin", Buffer.from([0, 255, 1, 128])],
				["large.bin", Buffer.alloc(3 * 1024 * 1024, 81)],
			]);
			for (const [name, contents] of files) writeFileSync(join(project.repositoryPath, name), contents);
			mkdirSync(join(project.repositoryPath, "目录"));
			writeFileSync(join(project.repositoryPath, "目录/子文件.txt"), "子目录文件");
			const outsidePath = join(fixture.fixtureRootDirectoryPath, "outside-secret.txt");
			writeFileSync(outsidePath, "不可下载");
			symlinkSync(outsidePath, join(project.repositoryPath, "outside-link"));
			const downloadUrl = (path: string, incarnation = card.createdAt) =>
				`${runtimeOrigin}/api/task-file-download?${new URLSearchParams({ workspaceId, taskId, expectedTaskIncarnationCreatedAtEpochMs: String(incarnation), source: "task_file", path })}`;
			for (const [path, status] of [
				["../outside-secret.txt", 403],
				["outside-link", 403],
				["missing.txt", 404],
				["目录", 403],
			] as const)
				expect((await fetch(downloadUrl(path), { headers: { cookie } })).status).toBe(status);
			expect((await fetch(downloadUrl("tracked.txt", -1), { headers: { cookie } })).status).toBe(409);
			const config = join(fixture.fixtureRootDirectoryPath, "task-file-download-vite.config.mts");
			writeFileSync(
				config,
				`import base from ${JSON.stringify(join(checkout, "web-ui/vite.config.ts"))};\nexport default {...base,optimizeDeps:{entries:["index.html"],include:["react","react-dom/client","react/jsx-runtime"]},cacheDir:${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-cache"))},server:{...base.server,host:"127.0.0.1",port:${webPort},strictPort:true,proxy:{"/api":{target:${JSON.stringify(runtimeOrigin)},changeOrigin:true,headers:{origin:${JSON.stringify(runtimeOrigin)}}}}}};`,
			);
			start(
				"vite",
				[join(checkout, "web-ui/node_modules/vite/bin/vite.js"), "--config", config],
				join(checkout, "web-ui"),
			);
			await observe("隔离 Vite 启动", () =>
				fetch(webOrigin)
					.then((response) => response.ok)
					.catch(() => false),
			);
			browser = await chromium.launch({ headless: true });
			const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
			page.setDefaultTimeout(20000);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page
				.context()
				.addCookies([{ name: "kanban_session", value: cookie.slice("kanban_session=".length), url: webOrigin }]);
			await page.route("**/isolated-task-file-downloads", (route) =>
				route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
			);
			await page.goto(`${webOrigin}/isolated-task-file-downloads`);
			await page.addScriptTag({
				type: "module",
				content:
					"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
			});
			await page.addScriptTag({ type: "module", url: "/tests/task-file-downloads-browser-harness.tsx" });
			await page.waitForFunction(
				() =>
					typeof (globalThis as unknown as TaskFileDownloadBrowserGlobal).mountTaskFileDownloadsBrowserHarness ===
					"function",
			);
			await page.evaluate(
				({ workspaceId, taskId, createdAt }) =>
					(globalThis as unknown as TaskFileDownloadBrowserGlobal).mountTaskFileDownloadsBrowserHarness(
						workspaceId,
						taskId,
						createdAt,
					),
				{ workspaceId, taskId, createdAt: card.createdAt },
			);
			const fileBrowser = page.getByRole("region", { name: "任务文件", exact: true });
			for (const [name, contents] of files) {
				const received = page.waitForEvent("download");
				await fileBrowser.getByRole("button", { name: `下载文件 ${name}`, exact: true }).click();
				const download = await received;
				// Chromium 的保存策略移除隐藏文件名开头的点；正文仍逐字节核验。
				expect(download.suggestedFilename()).toBe(name.startsWith(".") ? name.slice(1) : name);
				const savedPath = await download.path();
				if (!savedPath) throw new Error("浏览器没有保存下载");
				expect(readFileSync(savedPath)).toEqual(contents);
			}
			const changedFileDownload = page.waitForEvent("download");
			await page
				.locator('[data-task-workbench-module="task_sessions"]')
				.getByRole("button", { name: "下载文件 tracked.txt", exact: true })
				.click();
			const changedFile = await changedFileDownload;
			const changedFilePath = await changedFile.path();
			if (!changedFilePath) throw new Error("改动文件列表没有触发下载");
			expect(readFileSync(changedFilePath)).toEqual(files.get("tracked.txt"));
			await page.getByRole("button", { name: "进入目录 目录", exact: true }).click();
			await page.getByRole("button", { name: "下载文件 子文件.txt", exact: true }).waitFor();
			await page.getByRole("button", { name: "返回上级目录", exact: true }).click();
			await page.getByRole("button", { name: "刷新任务文件", exact: true }).click();
			const receivedPlan = page.waitForEvent("download");
			await page.getByRole("button", { name: "下载主会话 Plan", exact: true }).click();
			const plan = await receivedPlan;
			expect(plan.suggestedFilename()).toBe(`${taskId}-main-session-plan.md`);
			const planPath = await plan.path();
			if (!planPath) throw new Error("浏览器没有保存计划");
			expect(readFileSync(planPath, "utf8")).toBe("# 主会话完整计划\n\n验证原文件下载。");
			const evidenceDirectory = process.env.KANBAN_TASK_FILE_DOWNLOAD_BROWSER_EVIDENCE_DIRECTORY;
			if (evidenceDirectory) {
				mkdirSync(evidenceDirectory, { recursive: true });
				await fileBrowser.getByRole("button", { name: "下载文件 tracked.txt", exact: true }).waitFor();
				await page.screenshot({ path: join(evidenceDirectory, "desktop-task-file-downloads.png") });
			}
			expect(errors).toEqual([]);
			await page.close();
		} finally {
			await browser?.close();
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
		}
	},
	180000,
);
