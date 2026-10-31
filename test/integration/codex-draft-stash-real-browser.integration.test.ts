import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
// 对应 LocalStorageKey.OnboardingDialogShown；根测试工程不加载浏览器存储模块。
const STARTUP_ONBOARDING_DIALOG_SHOWN_STORAGE_KEY = "kanban.onboarding.dialog.shown";
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

it.skipIf(process.env.KANBAN_RUN_CODEX_DRAFT_STASH_REAL_BROWSER_CHECK !== "1" || process.platform === "win32")(
	"真实打包浏览器的 Ctrl+S／Cmd+S 经过会话桥接保存 Prompts，回执丢失后只读恢复且不重复入库",
	async (test) => {
		const fixture = createIsolatedGitTestWorkspaceFixture({ fixtureRootDirectoryNamePrefix: "codex-stash-browser-" });
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "draft-stash-browser" });
		await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离初始文件\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离初始提交",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const checkoutPath = resolve(import.meta.dirname, "../..");
		const runtimeCliPath =
			process.env.KANBAN_CODEX_DRAFT_STASH_BROWSER_RUNTIME_CLI_PATH ?? join(checkoutPath, "dist/cli.js");
		const executableDirectoryPath = join(fixture.fixtureRootDirectoryPath, "isolated-agent-executables");
		await mkdir(executableDirectoryPath);
		await copyFile(
			join(checkoutPath, "test/integration/fixtures/codex-draft-stash-synthetic-tui.cjs"),
			join(executableDirectoryPath, "codex"),
		);
		await chmod(join(executableDirectoryPath, "codex"), 0o755);
		const evidencePath = join(fixture.fixtureRootDirectoryPath, "editor-observations.jsonl");
		const portReservation = createServer();
		await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
		const address = portReservation.address();
		if (!address || typeof address === "string") throw new Error("未分配隔离端口");
		await new Promise<void>((done) => portReservation.close(() => done()));
		const origin = `http://127.0.0.1:${address.port}`;
		const environment = fixture.createIsolatedChildProcessEnvironment();
		for (const name of Object.keys(environment))
			if (/^(KANBAN_|CLINE_KANBAN_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|RVF_)/u.test(name)) delete environment[name];
		Object.assign(environment, {
			PATH: `${executableDirectoryPath}:${dirname(process.execPath)}:/usr/bin:/bin`,
			KANBAN_RUNTIME_PORT: String(address.port),
			KANBAN_ISOLATED_DRAFT_EDITOR_EVIDENCE_PATH: evidencePath,
			CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
			CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
		});
		const requireFromWebUi = createRequire(join(checkoutPath, "web-ui/package.json"));
		const { chromium } = requireFromWebUi("playwright-core") as { chromium: BrowserType };
		const isolatedRuntimeHomePath = join(fixture.isolatedHomeDirectoryPath, ".cline/kanban");
		await mkdir(isolatedRuntimeHomePath, { recursive: true });
		await writeFile(
			join(isolatedRuntimeHomePath, "config.json"),
			JSON.stringify({ agentSessionPtyHostEnablementPreference: "disabled" }),
		);
		let runtimeLog = "";
		let lastObservedEditorEvents = "";
		let lastObservedBrowserState = "";
		const observedStashHttpResponses: string[] = [];
		const startRuntime = () =>
			children.register(
				spawn(
					process.execPath,
					[
						"--require",
						join(checkoutPath, "test/integration/shutdown-ipc-hook.cjs"),
						runtimeCliPath,
						"--port",
						String(address.port),
						"--no-open",
						"--no-passcode",
					],
					{ cwd: repository.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
				),
			);
		const runtime = startRuntime();
		runtime.stdout?.on("data", (chunk) => {
			runtimeLog += String(chunk);
		});
		runtime.stderr?.on("data", (chunk) => {
			runtimeLog += String(chunk);
		});
		const wait = (description: string, condition: () => Promise<boolean>) =>
			waitForConditionWithinLoadSensitiveTwoTierDeadline(
				test,
				{
					waitedForDescription: description,
					softDeadlineMsExpectedOnUncontendedHost: 10_000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 45_000,
				},
				condition,
				{
					describeLastObservedStateForFailureMessage: () =>
						`${runtimeLog.slice(-3500)}\n${lastObservedEditorEvents}\n${lastObservedBrowserState}\n${observedStashHttpResponses.join("\n")}`,
				},
			);
		await wait("隔离打包 runtime 启动", async () =>
			fetch(`${origin}/api/trpc/projects.list`)
				.then((response) => response.ok)
				.catch(() => false),
		);
		async function runCli(arguments_: string[]) {
			const child = children.register(
				spawn(process.execPath, [runtimeCliPath, ...arguments_, "--project-path", repository.repositoryPath], {
					cwd: repository.repositoryPath,
					env: environment,
					stdio: ["ignore", "pipe", "pipe"],
				}),
			);
			let output = "";
			let errorOutput = "";
			child.stdout?.on("data", (chunk) => {
				output += String(chunk);
			});
			child.stderr?.on("data", (chunk) => {
				errorOutput += String(chunk);
			});
			if (!(await waitForChildProcessExit(child, 45_000)) || child.exitCode !== 0)
				throw new Error(`隔离 CLI 失败：${errorOutput}\n${output}`);
			return JSON.parse(output) as { task: { id: string } };
		}
		const { task } = await runCli([
			"task",
			"create",
			"--title",
			"隔离 Codex 草稿暂存",
			"--prompt",
			"仅用于隔离验证",
			"--agent-id",
			"codex",
		]);
		const client = (workspaceId?: string) =>
			createTRPCProxyClient<RuntimeAppRouter>({
				links: [
					httpLink({
						url: `${origin}/api/trpc`,
						headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
					}),
				],
			});
		const { projects } = await client().projects.list.query();
		const workspaceId = projects.find((project) => project.path === repository.repositoryPath)?.id;
		if (!workspaceId) throw new Error("未找到隔离项目");
		try {
			const started = await client(workspaceId).runtime.startTaskSession.mutate({
				taskId: task.id,
				agentId: "codex",
				prompt: "",
				baseRef: "main",
				startInPlanMode: false,
				cols: 120,
				rows: 32,
			});
			if (!started.ok) throw new Error(`隔离会话未启动：${started.error}`);
			const browser = await chromium.launch({ headless: true });
			test.onTestFinished(() => browser.close());
			const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
			// 只在隔离浏览器预置引导已读，避免稍后打开的首启弹层截获终端快捷键。
			await context.addInitScript((key: string) => {
				localStorage.setItem(key, "true");
			}, STARTUP_ONBOARDING_DIALOG_SHOWN_STORAGE_KEY);
			const page = await context.newPage();
			page.setDefaultTimeout(15_000);
			page.on("response", async (response) => {
				if (!/stashTerminalInputBoxToPromptLibrary|getTerminalInputBoxStashOperationStatus/u.test(response.url()))
					return;
				observedStashHttpResponses.push(`${response.status()} ${await response.text().catch(String)}`);
			});
			await page.addInitScript(`document.addEventListener("keydown", (event) => {
				if (event.key.toLowerCase() !== "s") return;
				document.documentElement.dataset.isolatedStashKeyboardEvent = JSON.stringify({
					key: event.key,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					target: event.target instanceof Element ? event.target.outerHTML.slice(0, 500) : null,
				});
			}, true);`);
			await page.goto(`${origin}/${workspaceId}?task=${task.id}`);
			const terminalInputSelector = `[data-verification-anchor="task-detail:${task.id}"] .xterm-helper-textarea`;
			const terminalInput = page.locator(terminalInputSelector).first();
			await terminalInput.waitFor({ state: "attached" });
			await wait(
				"浏览器已处理 Codex 粘贴模式初始化",
				async () =>
					(
						await page.locator(`[data-verification-anchor="task-detail:${task.id}"] .xterm-rows`).textContent()
					)?.includes("Ask Codex to do anything") ?? false,
			);
			const drafts = ["  浏览器第一份草稿 😀\n保留尾部空白  \n\n", "  浏览器回执丢失草稿\nEnglish 中文  \n"];
			for (let index = 0; index < drafts.length; index++) {
				await terminalInput.focus();
				await page.evaluate(`(() => {
					const element = document.querySelector(${JSON.stringify(terminalInputSelector)});
					if (!element) throw new Error("未找到 Codex 终端输入元素");
					const clipboardData = new DataTransfer();
					clipboardData.setData("text/plain", ${JSON.stringify(drafts[index] ?? "")});
					element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
				})()`);
				await wait("浏览器输入已完整进入真实 PTY", async () => {
					lastObservedEditorEvents = await readFile(evidencePath, "utf8").catch(() => "");
					return lastObservedEditorEvents
						.split("\n")
						.filter(Boolean)
						.some((line) => {
							const event = JSON.parse(line) as { event: string; text: string };
							return event.event === "composer" && event.text === drafts[index];
						});
				});
				if (index === 1) {
					await page.route("**/api/trpc/*stashTerminalInputBoxToPromptLibrary*", async (route) => {
						await route.fetch();
						await route.abort("connectionreset");
					});
				}
				await terminalInput.press(index === 0 || process.platform !== "darwin" ? "Control+s" : "Meta+s");
				await wait("快捷键写入当前任务 Prompts", async () => {
					const result = await client(workspaceId).runtime.getWorkspacePromptLibrary.query({});
					lastObservedBrowserState = await page.evaluate(`JSON.stringify({
						keyboardEvent: document.documentElement.dataset.isolatedStashKeyboardEvent,
						activeElement: document.activeElement?.outerHTML.slice(0, 500),
						visibleText: document.body.innerText.slice(-2500),
					})`);
					return result.library?.taskScopedPromptsByTaskId[task.id]?.length === index + 1;
				});
				await wait(
					"浏览器收到清框或补证回执",
					async () =>
						!(await page.evaluate(
							({ workspaceId, taskId }) =>
								localStorage.getItem(`terminal-input-box-stash-operation:${workspaceId}:${taskId}`),
							{ workspaceId, taskId: task.id },
						)),
				);
				await page.getByRole("tab", { name: "Prompts", exact: true }).click();
				expect(await page.locator("[data-prompt-library-entry-id]").count()).toBe(index + 1);
			}
			const library = await client(workspaceId).runtime.getWorkspacePromptLibrary.query({});
			expect(library.library?.taskScopedPromptsByTaskId[task.id]?.map((entry) => entry.text)).toEqual(drafts);
			const events = (await readFile(evidencePath, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { event: string; code?: number; text?: string });
			expect(events.filter((event) => event.event === "editor_started")).toHaveLength(2);
			expect(
				events
					.filter((event) => event.event === "editor_finished")
					.every((event) => event.code === 0 && event.text === ""),
			).toBe(true);
			expect(events.filter((event) => event.event === "user_submission")).toEqual([]);
			await client(workspaceId).runtime.stopTaskSession.mutate({ taskId: task.id });
			await browser.close();
			const operationIds = await readdir(
				join(isolatedRuntimeHomePath, "workspaces", workspaceId, "codex-draft-stash-operations"),
			);
			expect(operationIds).toHaveLength(2);
			runtime.kill("SIGINT");
			expect(await waitForChildProcessExit(runtime, 15_000)).toBe(true);
			const restartedRuntime = startRuntime();
			restartedRuntime.stdout?.on("data", (chunk) => {
				runtimeLog += String(chunk);
			});
			restartedRuntime.stderr?.on("data", (chunk) => {
				runtimeLog += String(chunk);
			});
			await wait("同一隔离 HOME 的打包 runtime 已重启", async () =>
				fetch(`${origin}/api/trpc/projects.list`)
					.then((response) => response.ok)
					.catch(() => false),
			);
			for (const operationId of operationIds)
				expect(
					(
						await client(workspaceId).runtime.getTerminalInputBoxStashOperationStatus.query({
							taskId: task.id,
							operationId,
						})
					).outcome,
				).toBe("stashed_into_prompt_library");
			expect(
				(await client(workspaceId).runtime.getWorkspacePromptLibrary.query({})).library?.taskScopedPromptsByTaskId[
					task.id
				]?.map((entry) => entry.text),
			).toEqual(drafts);
			expect(await readFile(evidencePath, "utf8")).toBe(
				`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
			);
		} finally {
			await client(workspaceId)
				.runtime.stopTaskSession.mutate({ taskId: task.id })
				.catch(() => {});
		}
	},
	180_000,
);
