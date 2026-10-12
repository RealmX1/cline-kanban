import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { recordAgentRaisedPendingUserDecision } from "../../src/state/agent-raised-pending-user-decision-store";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { chromium } from "../../web-ui/node_modules/playwright";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

// 本用例需要本机 Chrome；CI 的普通 npm test 不要求安装浏览器。
const childProcessRegistry = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => childProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe("问答草稿的打包态浏览器重启验证", { timeout: 120_000 }, () => {
	it.skipIf(process.env.KANBAN_RUN_BROWSER_DEPENDENT_RUNTIME_RESTART_TESTS !== "1")(
		"本地写入与清理失败后的旧备份不回滚已确认草稿，刷新及浏览器和运行时重启均可恢复",
		async () => {
			const isolatedGitWorkspace = createIsolatedGitTestWorkspaceFixture();
			let browser = await chromium.launch({ channel: "chrome" });
			const taskId = "draft-restart-task";
			const decisionId = `${taskId}:question-a`;
			let workspaceId = "";
			let runtimeProcess: ChildProcess | null = null;
			const originalHome = process.env.HOME;
			const originalUserProfile = process.env.USERPROFILE;
			try {
				const repository = isolatedGitWorkspace.createNonBareRepository({
					repositoryDirectoryName: "answer-draft-restart-project",
				});
				// 只在建夹具阶段改 HOME；所有运行时子进程均使用 fixture 提供的隔离环境。
				process.env.HOME = isolatedGitWorkspace.isolatedHomeDirectoryPath;
				process.env.USERPROFILE = isolatedGitWorkspace.isolatedHomeDirectoryPath;
				try {
					workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
					await mutateWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => {
						const createdTask = addTaskToColumn(
							state.board,
							"review",
							{ taskId, prompt: "问答草稿重启检查", baseRef: "main", agentId: "claude" },
							() => taskId,
						);
						return { board: createdTask.board, value: null };
					});
					await recordAgentRaisedPendingUserDecision(workspaceId, {
						decisionId,
						taskId,
						workspaceId,
						agentId: "claude",
						sessionTransport: "pty_terminal",
						decisionKind: "ordinary_user_question",
						questionMarkdown: "草稿重启检查：选择方案",
						allowsFreeformAnswer: true,
						options: [
							{ optionId: "option-a", label: "方案 A" },
							{ optionId: "option-b", label: "方案 B" },
						],
						orderedQuestions: [
							{
								decisionQuestionId: "question-a",
								questionMarkdown: "草稿重启检查：选择方案",
								headerMarkdown: null,
								selectionMode: "single",
								options: [
									{ optionId: "option-a", label: "方案 A" },
									{ optionId: "option-b", label: "方案 B" },
								],
								allowsFreeformAnswer: true,
							},
							{
								decisionQuestionId: "question-b",
								questionMarkdown: "草稿重启检查：选择附加项",
								headerMarkdown: null,
								selectionMode: "multiple",
								options: [
									{ optionId: "option-c", label: "附加 C" },
									{ optionId: "option-d", label: "附加 D" },
								],
								allowsFreeformAnswer: true,
							},
						],
						askedAt: Date.now(),
						graceDeadlineAt: null,
						originRuntimeSessionIncarnationId: null,
						originTurnSequence: 0,
						sourceHarnessSignal: "browser-test:AskUserQuestion",
					});
				} finally {
					if (originalHome === undefined) delete process.env.HOME;
					else process.env.HOME = originalHome;
					if (originalUserProfile === undefined) delete process.env.USERPROFILE;
					else process.env.USERPROFILE = originalUserProfile;
				}

				const startIsolatedRuntime = async () => {
					runtimeProcess = childProcessRegistry.register(
						spawn(process.execPath, [resolve(process.cwd(), "dist/cli.js"), "--port", "auto", "--no-open"], {
							cwd: repository.repositoryPath,
							env: isolatedGitWorkspace.createIsolatedChildProcessEnvironment({
								DO_NOT_TRACK: "1",
								KANBAN_RUNTIME_PORT: undefined,
							}),
							stdio: ["ignore", "pipe", "pipe"],
						}),
					);
					return new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(runtimeProcess)).runtimeUrl)
						.origin;
				};
				const openQuestionPanel = async (runtimeOrigin: string) => {
					const browserContext = await browser.newContext();
					await browserContext.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
					const page = await browserContext.newPage();
					await page.goto(`${runtimeOrigin}/${workspaceId}`);
					await page.locator(`[data-task-id="${taskId}"]`).first().click();
					await page.getByRole("region", { name: "Agent 等待你的回答" }).waitFor({ state: "visible" });
					return { browserContext, page };
				};

				const firstRuntimeOrigin = await startIsolatedRuntime();
				const firstBrowser = await openQuestionPanel(firstRuntimeOrigin);
				let persistedBrowserStorageState = await firstBrowser.browserContext.storageState();
				const browserAnswerDraftBackupStorageKey = "kanban.agent-raised-pending-user-decision-answer-drafts.v1";
				const rejectBrowserAnswerDraftBackupWrites = (rejectedStorageKey: string) => {
					const originalStorageSetItem = Storage.prototype.setItem;
					Storage.prototype.setItem = function (key, value) {
						if (key === rejectedStorageKey) throw new DOMException("模拟备份写入失败", "QuotaExceededError");
						originalStorageSetItem.call(this, key, value);
					};
				};
				try {
					await firstBrowser.page.getByRole("radio", { name: "方案 B" }).check();
					await firstBrowser.page.getByRole("checkbox", { name: "附加 C" }).check();
					await firstBrowser.page.getByRole("checkbox", { name: "附加 D" }).check();
					await firstBrowser.page
						.getByPlaceholder("其他回答或补充说明", { exact: true })
						.fill("  Notes\n重启后保持原文  ");
					await firstBrowser.page
						.getByRole("status")
						.filter({ hasText: /^已保存$/ })
						.waitFor({ state: "visible" });
					// 先留下备份 A，再让 B 的本地写入与成功回执的清理都失败。
					await firstBrowser.page.getByPlaceholder("其他回答或补充说明", { exact: true }).fill("旧备份 A");
					const oldBrowserAnswerDraftBackupContents = await firstBrowser.page.evaluate(
						(storageKey) => localStorage.getItem(storageKey),
						browserAnswerDraftBackupStorageKey,
					);
					expect(oldBrowserAnswerDraftBackupContents).toContain("旧备份 A");
					await firstBrowser.page
						.getByRole("status")
						.filter({ hasText: /^已保存$/ })
						.waitFor({ state: "visible" });
					await firstBrowser.page.evaluate(
						({ storageKey, backupContents }) => localStorage.setItem(storageKey, backupContents ?? "{}"),
						{
							storageKey: browserAnswerDraftBackupStorageKey,
							backupContents: oldBrowserAnswerDraftBackupContents,
						},
					);
					await firstBrowser.page.evaluate(
						rejectBrowserAnswerDraftBackupWrites,
						browserAnswerDraftBackupStorageKey,
					);
					await firstBrowser.page
						.getByPlaceholder("其他回答或补充说明", { exact: true })
						.fill("  Notes\n重启后保持原文  ");
					await firstBrowser.page
						.getByRole("status")
						.filter({ hasText: /^已保存$/ })
						.waitFor({ state: "visible" });
					await firstBrowser.browserContext.addInitScript(
						rejectBrowserAnswerDraftBackupWrites,
						browserAnswerDraftBackupStorageKey,
					);
					await firstBrowser.page.reload();
					await firstBrowser.page.locator(`[data-task-id="${taskId}"]`).first().click();
					await firstBrowser.page
						.getByRole("region", { name: "Agent 等待你的回答" })
						.waitFor({ state: "visible" });
					expect(
						await firstBrowser.page.getByPlaceholder("其他回答或补充说明", { exact: true }).inputValue(),
					).toBe("  Notes\n重启后保持原文  ");
					expect(
						await firstBrowser.page.evaluate(
							(storageKey) => localStorage.getItem(storageKey),
							browserAnswerDraftBackupStorageKey,
						),
					).toContain("旧备份 A");
					persistedBrowserStorageState = await firstBrowser.browserContext.storageState();
				} finally {
					await firstBrowser.browserContext.close();
				}
				await browser.close();
				browser = await chromium.launch({ channel: "chrome" });
				const restartedBrowserContext = await browser.newContext({ storageState: persistedBrowserStorageState });
				try {
					await restartedBrowserContext.addInitScript(
						rejectBrowserAnswerDraftBackupWrites,
						browserAnswerDraftBackupStorageKey,
					);
					const restartedBrowserPage = await restartedBrowserContext.newPage();
					await restartedBrowserPage.goto(`${firstRuntimeOrigin}/${workspaceId}`);
					await restartedBrowserPage.locator(`[data-task-id="${taskId}"]`).first().click();
					await restartedBrowserPage
						.getByRole("region", { name: "Agent 等待你的回答" })
						.waitFor({ state: "visible" });
					expect(
						await restartedBrowserPage.getByPlaceholder("其他回答或补充说明", { exact: true }).inputValue(),
					).toBe("  Notes\n重启后保持原文  ");
					expect(
						await restartedBrowserPage.evaluate(
							(storageKey) => localStorage.getItem(storageKey),
							browserAnswerDraftBackupStorageKey,
						),
					).toContain("旧备份 A");
				} finally {
					await restartedBrowserContext.close();
				}
				expect(runtimeProcess).not.toBeNull();
				if (runtimeProcess) expect(await sigkillChildProcessAndWaitForExit(runtimeProcess)).toBe(true);
				// 暂占原端口，保证第二次 auto 启动确实换端口，排除同源浏览器缓存的影响。
				const originalRuntimePortReservation = createServer();
				let secondRuntimeOrigin: string;
				try {
					await new Promise<void>((resolveListening, rejectListening) => {
						originalRuntimePortReservation.once("error", rejectListening);
						originalRuntimePortReservation.listen(
							Number(new URL(firstRuntimeOrigin).port),
							new URL(firstRuntimeOrigin).hostname,
							resolveListening,
						);
					});
					secondRuntimeOrigin = await startIsolatedRuntime();
				} finally {
					await new Promise<void>((resolveClosed) => originalRuntimePortReservation.close(() => resolveClosed()));
				}
				expect(secondRuntimeOrigin).not.toBe(firstRuntimeOrigin);
				const restoredBrowser = await openQuestionPanel(secondRuntimeOrigin);
				try {
					expect(await restoredBrowser.page.getByRole("radio", { name: "方案 B" }).isChecked()).toBe(true);
					expect(await restoredBrowser.page.getByRole("checkbox", { name: "附加 C" }).isChecked()).toBe(true);
					expect(await restoredBrowser.page.getByRole("checkbox", { name: "附加 D" }).isChecked()).toBe(true);
					expect(
						await restoredBrowser.page.getByPlaceholder("其他回答或补充说明", { exact: true }).inputValue(),
					).toBe("  Notes\n重启后保持原文  ");
					const runtimeClient = createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({
								url: `${secondRuntimeOrigin}/api/trpc`,
								headers: { "x-kanban-workspace-id": workspaceId },
							}),
						],
					});
					const pendingDecision = (
						await runtimeClient.runtime.listAgentRaisedPendingUserDecisions.query({ taskId })
					).decisions[0];
					expect(pendingDecision?.recordedAnswerQuestionAnswers).toBeNull();
					expect(pendingDecision?.answerDeliveryState).toBe("not_answered");
				} finally {
					await restoredBrowser.browserContext.close();
				}
			} finally {
				try {
					await browser.close();
				} finally {
					try {
						await childProcessRegistry.sigkillEveryStillRunningChildProcessAndWaitForExit();
					} finally {
						isolatedGitWorkspace.cleanup();
					}
				}
			}
		},
	);
});
