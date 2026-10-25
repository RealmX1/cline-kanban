import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createTRPCProxyClient, httpLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import type { BrowserType } from "../../web-ui/node_modules/playwright-core";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	waitForChildProcessExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const packagedCliPath = process.env.KANBAN_MANAGED_DELIVERY_PACKAGED_CLI_PATH;
const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe(
	"统一主动投递的隔离打包实例",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 120_000,
		}),
	},
	() => {
		it.skipIf(!packagedCliPath)("CLI 即时注入、API 人工发送、等待队列、真实浏览器推流及重启记录", async () => {
			if (!packagedCliPath || !existsSync(packagedCliPath)) throw new Error("需要本任务的隔离构建 CLI。");
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const project = fixture.createNonBareRepository({ repositoryDirectoryName: "managed-delivery-project" });
			writeFileSync(join(project.repositoryPath, "README.md"), "隔离主动投递验证\n");
			project.commitAllRepositoryFilesAtDate({
				message: "初始化隔离验证仓库",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const evidenceDirectory =
				process.env.KANBAN_MANAGED_DELIVERY_EVIDENCE_DIRECTORY ?? fixture.fixtureRootDirectoryPath;
			mkdirSync(evidenceDirectory, { recursive: true });
			const reservation = createServer();
			await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
			const address = reservation.address();
			if (!address || typeof address === "string") throw new Error("未取得隔离端口。");
			const port = address.port;
			await new Promise<void>((done) => reservation.close(() => done()));
			expect(port).not.toBe(3484);
			const origin = `http://127.0.0.1:${port}`;
			const environment = fixture.createIsolatedChildProcessEnvironment();
			for (const key of Object.keys(environment))
				if (/^(KANBAN_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|CURSOR_|GEMINI_|GOOGLE_|KIMI_)/u.test(key))
					delete environment[key];
			Object.assign(environment, {
				PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
				KANBAN_RUNTIME_PORT: String(port),
			});
			const shutdownHook = resolve(import.meta.dirname, "shutdown-ipc-hook.cjs");
			const runCli = async (args: string[]) => {
				const child = children.register(
					spawn(process.execPath, ["--require", shutdownHook, packagedCliPath, ...args], {
						cwd: project.repositoryPath,
						env: environment,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					}),
				);
				let output = "";
				let errors = "";
				child.stdout?.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr?.on("data", (chunk) => {
					errors += String(chunk);
				});
				if (!(await waitForChildProcessExit(child, 45_000)) || child.exitCode !== 0)
					throw new Error(`隔离 CLI 失败：${errors}\n${output}`);
				return JSON.parse(output);
			};
			const startRuntime = async (name: string) => {
				const child = children.register(
					spawn(
						process.execPath,
						["--require", shutdownHook, packagedCliPath, "--port", String(port), "--no-open", "--no-passcode"],
						{ cwd: project.repositoryPath, env: environment, stdio: ["ignore", "pipe", "pipe", "ipc"] },
					),
				);
				let output = "";
				child.stdout?.on("data", (chunk) => {
					output += String(chunk);
				});
				child.stderr?.on("data", (chunk) => {
					output += String(chunk);
				});
				child.on("exit", () => writeFileSync(join(evidenceDirectory, `${name}.log`), output));
				await waitForRuntimeServerStartupBannerOrSigkillChild(child);
				return child;
			};
			const client = (workspaceId?: string) =>
				createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpLink({
							url: `${origin}/api/trpc`,
							headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {},
						}),
					],
				});
			let runtime = await startRuntime("managed-delivery-runtime-before-restart");
			const requireFromWeb = createRequire(resolve(import.meta.dirname, "../../web-ui/package.json"));
			const { chromium } = requireFromWeb("playwright-core") as { chromium: BrowserType };
			const browser = await chromium.launch({ headless: true });
			try {
				const created = await runCli([
					"task",
					"create",
					"--title",
					"统一投递隔离验证",
					"--prompt",
					"隔离验证",
					"--agent-id",
					"claude",
					"--worktree-mode",
					"inplace",
					"--project-path",
					project.repositoryPath,
				]);
				const taskId = created.task.id as string;
				const workspaceId = (await client().projects.list.query()).projects.find(
					(entry) => entry.path === project.repositoryPath,
				)?.id;
				if (!workspaceId) throw new Error("隔离项目未注册。");
				const scoped = client(workspaceId);
				const state = await scoped.workspace.getState.query();
				const backlog = state.board.columns.find((column) => column.id === "backlog");
				const card = backlog?.cards.find((candidate) => candidate.id === taskId);
				if (!backlog || !card) throw new Error("隔离任务缺失。");
				backlog.cards = backlog.cards.filter((candidate) => candidate.id !== taskId);
				state.board.columns.find((column) => column.id === "review")?.cards.push(card);
				state.sessions[taskId] = {
					taskId,
					agentId: "claude",
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					workspacePath: project.repositoryPath,
					pid: null,
					startedAt: 1,
					updatedAt: 1,
					lastOutputAt: null,
					reviewReason: "hook",
					exitCode: 0,
					lastHookAt: null,
					latestHookActivity: null,
				};
				await scoped.workspace.saveState.mutate({
					board: state.board,
					sessions: state.sessions,
					expectedRevision: state.revision,
				});
				// 不启动真实模型；不可投递也必须在统一界面诚实保留失败，不能把受理当作送达。
				const request = {
					taskId,
					targetTaskConversationSessionId: taskId,
					text: "API 人工发送的完整正文",
					deliveryRequestId: "human-api-request",
					deliveryOrigin: { messageType: "human_message" as const, sourceLabel: "隔离 API 输入" },
				};
				expect((await scoped.runtime.sendTaskChatMessage.mutate(request)).ok).toBe(false);
				const injectionArgs = [
					"task",
					"message",
					"--task-id",
					taskId,
					"--prompt",
					"CLI 即时注入的完整正文",
					"--source",
					"managed-delivery-integration",
					"--idempotency-key",
					"integration-injection-key",
					"--project-path",
					project.repositoryPath,
				];
				await runCli(injectionArgs);
				await runCli(injectionArgs);
				await scoped.runtime.mutateTaskPromptDeliveryQueue.mutate({
					mutation: {
						kind: "enqueue_prompt_for_delivery_after_current_turn",
						taskId,
						queueEntryId: "waiting-entry",
						text: "等待空闲后再发的正文",
					},
				});
				const entries =
					(await scoped.runtime.getTaskPromptDeliveryQueue.query({})).queue?.entriesByTaskId[taskId] ?? [];
				expect(entries.filter((entry) => entry.text === "CLI 即时注入的完整正文")).toHaveLength(1);
				expect(entries.find((entry) => entry.queueEntryId === "human-api-request")).toMatchObject({
					deliveryState: "settled_failed",
					managedDelivery: { messageType: "human_message", deliveryStrategy: "immediate" },
				});
				expect(entries.find((entry) => entry.queueEntryId === "waiting-entry")?.deliveryState).toBe("queued");
				const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
				const pageErrors: string[] = [];
				page.on("pageerror", (error) => pageErrors.push(error.message));
				await page.goto(`${origin}/${workspaceId}?task=${taskId}`);
				const onboarding = page.getByRole("dialog").filter({ hasText: "Get started" });
				// 首次引导可在页面加载后才出现，交互前持续处理，避免一次 isVisible 探测漏掉模态。
				await page.addLocatorHandler(onboarding, async () => {
					await onboarding.getByRole("button", { name: "Close", exact: true }).click();
				});
				await page.getByRole("tab", { name: /^Queue/ }).click();
				await expect
					.poll(() => page.locator("[data-queued-prompt-entry-id]").count(), { timeout: 15000 })
					.toBeGreaterThanOrEqual(3);
				await expect
					.poll(() => page.locator('[data-queued-prompt-entry-id="human-api-request"]').textContent(), {
						timeout: 15000,
					})
					.toContain("人工发送");
				await page.screenshot({
					path: join(evidenceDirectory, "managed-delivery-real-runtime-desktop.png"),
					fullPage: true,
				});
				// 页面保持打开，由实际 runtime 推流更新新消息。
				await scoped.runtime.sendTaskChatMessage.mutate({
					...request,
					deliveryRequestId: "streamed-human-request",
					text: "浏览器打开后通过真实推流出现",
				});
				await expect
					.poll(() => page.locator('[data-queued-prompt-entry-id="streamed-human-request"]').textContent(), {
						timeout: 15000,
					})
					.toContain("浏览器打开后通过真实推流出现");
				await page.setViewportSize({ width: 390, height: 1000 });
				await page.screenshot({
					path: join(evidenceDirectory, "managed-delivery-real-runtime-mobile.png"),
					fullPage: true,
				});
				expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				runtime.kill("SIGINT");
				if (!(await waitForChildProcessExit(runtime, 15000))) throw new Error("隔离实例未退出。");
				runtime = await startRuntime("managed-delivery-runtime-after-restart");
				const restored =
					(await scoped.runtime.getTaskPromptDeliveryQueue.query({})).queue?.entriesByTaskId[taskId] ?? [];
				expect(
					restored.find((entry) => entry.queueEntryId === "human-api-request")?.managedDelivery?.deliveryStrategy,
				).toBe("immediate");
				expect(restored.filter((entry) => entry.text === "CLI 即时注入的完整正文")).toHaveLength(1);
				expect(pageErrors).toEqual([]);
				writeFileSync(
					join(evidenceDirectory, "managed-delivery-runtime-verification.json"),
					JSON.stringify(
						{ workspaceId, taskId, beforeRestart: entries, afterRestart: restored, pageErrors },
						null,
						2,
					),
				);
			} catch (error) {
				// 隔离实例失败时持久保存页面现场，避免关闭进程后丢失可自动诊断的证据。
				const failedPage = browser
					.contexts()
					.flatMap((context) => context.pages())
					.at(-1);
				if (failedPage) {
					await failedPage.screenshot({
						path: join(evidenceDirectory, "failed-runtime-page.png"),
						fullPage: true,
					});
					writeFileSync(join(evidenceDirectory, "failed-runtime-page.html"), await failedPage.content());
					writeFileSync(join(evidenceDirectory, "failed-runtime-page-url.txt"), failedPage.url());
				}
				throw error;
			} finally {
				await browser.close();
				runtime.kill("SIGINT");
			}
		});
	},
);
