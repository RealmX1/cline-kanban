import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import { compress, decompress } from "zstd-stream";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createSpawnedChildProcessRegistrySigkilledAfterEachTest } from "./runtime-integration-test-spawned-child-process-lifecycle";

interface NativeTranscriptReaderBrowserGlobal {
	nativeTranscriptReaderBrowserHarness: {
		mount(workspaceId: string, summary: RuntimeTaskSessionSummary): void;
		disconnectTerminal(): void;
		readTerminalScreen(): string;
	};
	document: {
		querySelector(selector: string): { textContent: string | null } | null;
		documentElement: { scrollWidth: number };
	};
	innerWidth: number;
}

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(process.env.KANBAN_RUN_NATIVE_TRANSCRIPT_DOCUMENT_BROWSER_CHECK !== "1")(
	"桌面和手机经隔离 runtime 读取普通与压缩历史，格式转换保留分页、阅读位置且不启动 Agent",
	async (context) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const checkout = resolve(import.meta.dirname, "../..");
		const project = fixture.createNonBareRepository({ repositoryDirectoryName: "native-transcript-reader" });
		writeFileSync(join(project.repositoryPath, "initial.txt"), "隔离转录阅读测试\n");
		project.commitAllRepositoryFilesAtDate({
			message: "初始化隔离测试",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
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
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const key of Object.keys(environment))
			if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GOOGLE_|GEMINI_|KIMI_)/.test(key))
				delete environment[key];
		Object.assign(environment, {
			PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
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
					"--port",
					String(runtimePort),
					"--no-open",
					"--no-passcode",
				],
				project.repositoryPath,
			);
			await observe("隔离 runtime 启动", () =>
				fetch(`${runtimeOrigin}/api/trpc/projects.list`)
					.then((response) => response.ok)
					.catch(() => false),
			);
			const workspaceId = (await client().projects.list.query()).projects.find(
				(entry) => entry.path === project.repositoryPath,
			)?.id;
			if (!workspaceId) throw new Error("缺少隔离项目");
			const { taskId } = await client(workspaceId).workspace.addBacklogTask.mutate({
				title: "转录阅读测试",
				prompt: "全屏和未连接的终端仍能阅读转录",
			});
			const state = await client(workspaceId).workspace.getState.query();
			const message = (text: string) => ({
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
			});
			const summaries: RuntimeTaskSessionSummary[] = [];
			for (const sessionId of [taskId, `${taskId}-side`]) {
				const transcriptPath = join(fixture.fixtureRootDirectoryPath, `${sessionId}.jsonl`);
				writeFileSync(
					transcriptPath,
					`${[
						{ type: "session_meta", payload: { id: sessionId, source: "cli" } },
						...Array.from({ length: 140 }, (_, index) =>
							message(`终端画面之外的历史 ${sessionId} ${index}\n\n${"这段内容来自已持久化转录。".repeat(8)}`),
						),
						{
							type: "response_item",
							payload: {
								type: "function_call",
								name: "exec_command",
								call_id: "tool",
								arguments: "工具完整正文",
							},
						},
						{
							type: "response_item",
							payload: { type: "reasoning", summary: [{ type: "summary_text", text: "已有可读推理" }] },
						},
					]
						.map((record) => JSON.stringify(record))
						.join("\n")}\n`,
				);
				if (sessionId !== taskId) {
					writeFileSync(`${transcriptPath}.zst`, await compress(readFileSync(transcriptPath)));
					unlinkSync(transcriptPath);
				}
				const summary: RuntimeTaskSessionSummary = {
					taskId: sessionId,
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
						nativeSessionId: sessionId,
						transcriptPath,
						observedAt: 1,
					},
					...(sessionId === taskId
						? {}
						: {
								taskConversationSessionMetadata: {
									workspaceTaskId: taskId,
									taskConversationSessionRole: "task_collaborator",
									taskConversationSessionContextSource: "started_from_scratch",
									parentTaskConversationSessionId: null,
									mainSessionOriginTurnNumber: null,
									mainSessionOriginUserMessagePreview: null,
									latestUserMessagePreview: null,
								},
							}),
				};
				state.sessions[sessionId] = summary;
				summaries.push(summary);
			}
			await client(workspaceId).workspace.saveState.mutate({
				board: state.board,
				sessions: state.sessions,
				expectedRevision: state.revision,
			});
			const configurationPath = join(fixture.fixtureRootDirectoryPath, "native-transcript-reader-vite.config.mts");
			writeFileSync(
				configurationPath,
				`import base from ${JSON.stringify(join(checkout, "web-ui/vite.config.ts"))};\nexport default {...base,optimizeDeps:{entries:["index.html"],include:["react","react-dom/client","react/jsx-runtime"]},cacheDir:${JSON.stringify(join(fixture.fixtureRootDirectoryPath, "isolated-vite-dependency-cache"))},server:{...base.server,host:"127.0.0.1",port:${webPort},strictPort:true,proxy:{"/api":{target:${JSON.stringify(runtimeOrigin)},changeOrigin:true,ws:true,headers:{origin:${JSON.stringify(runtimeOrigin)}}}}}};`,
			);
			start(
				"vite",
				[join(checkout, "web-ui/node_modules/vite/bin/vite.js"), "--config", configurationPath],
				join(checkout, "web-ui"),
			);
			await observe("隔离 Vite 启动", () =>
				fetch(webOrigin)
					.then((response) => response.ok)
					.catch(() => false),
			);
			browser = await chromium.launch({ headless: true });
			for (const [index, viewport] of [
				{ width: 1440, height: 1000 },
				{ width: 390, height: 844 },
			].entries()) {
				const summary = summaries[index];
				if (!summary?.agentNativeConversationSessionIdentity?.transcriptPath)
					throw new Error("缺少测试会话转录绑定");
				const page = await browser.newPage({ viewport });
				page.setDefaultTimeout(20000);
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.route("**/isolated-native-transcript-reader", (route) =>
					route.fulfill({
						contentType: "text/html",
						body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
					}),
				);
				await page.goto(`${webOrigin}/isolated-native-transcript-reader`);
				await page.addScriptTag({
					type: "module",
					content:
						"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
				});
				await page.addScriptTag({
					type: "module",
					url: "/tests/task-conversation-transcript-document-reader-browser-harness.tsx",
				});
				await page.evaluate(
					({ workspaceId, summary }) =>
						(
							globalThis as unknown as NativeTranscriptReaderBrowserGlobal
						).nativeTranscriptReaderBrowserHarness.mount(workspaceId, summary),
					{ workspaceId, summary },
				);
				await page.waitForFunction(() =>
					(globalThis as unknown as NativeTranscriptReaderBrowserGlobal).nativeTranscriptReaderBrowserHarness
						.readTerminalScreen()
						.includes("全屏终端当前画面"),
				);
				expect(
					await page.evaluate(() =>
						(
							globalThis as unknown as NativeTranscriptReaderBrowserGlobal
						).nativeTranscriptReaderBrowserHarness.readTerminalScreen(),
					),
				).not.toContain("终端画面之外的历史");
				await page.getByRole("button", { name: "以文档阅读会话记录", exact: true }).click();
				const reader = page.getByRole("region", { name: "会话转录文档" });
				await reader.locator('[data-history-message-role="assistant"]').first().waitFor();
				expect(await reader.textContent()).toContain(`终端画面之外的历史 ${summary.taskId}`);
				expect(
					await reader.getByRole("button", { name: "exec_command", exact: true }).getAttribute("aria-expanded"),
				).toBe("false");
				await reader.getByRole("button", { name: "exec_command", exact: true }).click();
				expect(await reader.textContent()).toContain("工具完整正文");
				const nativePath = summary.agentNativeConversationSessionIdentity.transcriptPath;
				if (index === 0) {
					writeFileSync(`${nativePath}.zst`, await compress(readFileSync(nativePath)));
					unlinkSync(nativePath);
				}
				const beforeConversionScrollTop = await reader
					.locator("[data-transcript-document-scroll-container]")
					.evaluate((element) => element.scrollTop);
				writeFileSync(`${nativePath}.replacement`, await decompress(readFileSync(`${nativePath}.zst`)));
				renameSync(`${nativePath}.replacement`, nativePath);
				unlinkSync(`${nativePath}.zst`);
				expect(
					await reader
						.locator("[data-transcript-document-scroll-container]")
						.evaluate((element) => element.scrollTop),
				).toBe(beforeConversionScrollTop);
				appendFileSync(nativePath, `${JSON.stringify(message("追加后刷新才出现"))}\n`);
				const scroller = reader.locator("[data-transcript-document-scroll-container]");
				await scroller.evaluate((element) => {
					element.scrollTop = 200;
					element.dispatchEvent(new Event("scroll"));
				});
				await reader.getByRole("button", { name: "加载更早记录", exact: true }).click();
				await page.waitForFunction(() =>
					(globalThis as unknown as NativeTranscriptReaderBrowserGlobal).document
						.querySelector("[data-task-conversation-transcript-document-reader]")
						?.textContent?.includes("已加载 142 条"),
				);
				expect(await reader.textContent()).toContain(`终端画面之外的历史 ${summary.taskId} 0`);
				expect(await reader.textContent()).not.toContain("追加后刷新才出现");
				await scroller.evaluate((element) => {
					element.scrollTop = 350;
					element.dispatchEvent(new Event("scroll"));
				});
				await page.getByRole("button", { name: "返回实时终端", exact: true }).click();
				await page.getByRole("button", { name: "以文档阅读会话记录", exact: true }).click();
				expect(await scroller.evaluate((element) => element.scrollTop)).toBe(350);
				await page.evaluate(() =>
					(
						globalThis as unknown as NativeTranscriptReaderBrowserGlobal
					).nativeTranscriptReaderBrowserHarness.disconnectTerminal(),
				);
				await reader.getByRole("button", { name: "刷新到最新", exact: true }).click();
				await page.waitForFunction(() =>
					(globalThis as unknown as NativeTranscriptReaderBrowserGlobal).document
						.querySelector("[data-task-conversation-transcript-document-reader]")
						?.textContent?.includes("追加后刷新才出现"),
				);
				const bottomGap = await scroller.evaluate(
					(element) => element.scrollHeight - element.scrollTop - element.clientHeight,
				);
				expect(bottomGap).toBeLessThanOrEqual(2);
				if (viewport.width < 768) {
					const previousScrollTop = await scroller.evaluate((element) => element.scrollTop);
					await page.getByRole("button", { name: "向上滚动，长按加速", exact: true }).click();
					expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(previousScrollTop);
					await reader.getByRole("button", { name: "返回最新", exact: true }).click();
				}
				await reader.getByRole("combobox", { name: "阅读内容可见度" }).selectOption("conversation_only");
				expect(await reader.locator('[data-history-message-role="tool"]:visible').count()).toBe(0);
				await reader.getByRole("combobox", { name: "阅读内容可见度" }).selectOption("all_records");
				await reader.getByRole("searchbox", { name: "搜索已加载记录" }).fill("追加后刷新");
				expect(await reader.locator("[data-history-message-role]:visible").count()).toBe(1);
				expect(
					await page.evaluate(
						() =>
							(globalThis as unknown as NativeTranscriptReaderBrowserGlobal).document.documentElement
								.scrollWidth > (globalThis as unknown as NativeTranscriptReaderBrowserGlobal).innerWidth,
					),
				).toBe(false);
				if (process.env.KANBAN_NATIVE_TRANSCRIPT_DOCUMENT_BROWSER_EVIDENCE_DIRECTORY) {
					const evidenceDirectory = process.env.KANBAN_NATIVE_TRANSCRIPT_DOCUMENT_BROWSER_EVIDENCE_DIRECTORY;
					mkdirSync(evidenceDirectory, { recursive: true });
					await reader.getByRole("searchbox", { name: "搜索已加载记录" }).fill("");
					await scroller.evaluate((element) => {
						element.scrollTop = element.scrollHeight;
					});
					await page.screenshot({ path: join(evidenceDirectory, `${viewport.width}-transcript-reader.png`) });
				}
				expect(errors).toEqual([]);
				await page.close();
			}
		} finally {
			await browser?.close();
			await children.sigkillEveryStillRunningChildProcessAndWaitForExit();
		}
	},
	180000,
);
