import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import { createAgentRaisedPendingUserDecisionAnswerDelivery } from "../../src/server/agent-raised-pending-user-decision-answer-delivery";
import { recordAgentRaisedPendingUserDecision } from "../../src/state/agent-raised-pending-user-decision-store";
import { getWorkspaceDirectoryPath, loadWorkspaceContext, mutateWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { chromium } from "../../web-ui/node_modules/playwright";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const childProcesses = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe("待确认答案的打包态浏览器恢复", { timeout: 120_000 }, () => {
	it.skipIf(process.env.KANBAN_RUN_BROWSER_DEPENDENT_RUNTIME_RESTART_TESTS !== "1")(
		"默认折叠、手动核验和人工关闭，刷新及 runtime 重启后不复活且无额外发送",
		async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const browser = await chromium.launch({ channel: "chrome" });
			const taskId = "answer-confirmation-browser-task";
			const decisionId = `${taskId}:question-call`;
			let runtime: ChildProcess | null = null;
			try {
				const repository = fixture.createNonBareRepository({
					repositoryDirectoryName: "answer-confirmation-browser-project",
				});
				let workspaceId = "";
				let workspaceDirectory = "";
				const previousHome = process.env.HOME;
				const previousUserProfile = process.env.USERPROFILE;
				try {
					process.env.HOME = fixture.isolatedHomeDirectoryPath;
					process.env.USERPROFILE = fixture.isolatedHomeDirectoryPath;
					workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
					workspaceDirectory = getWorkspaceDirectoryPath(workspaceId);
					await mutateWorkspaceState(
						repository.repositoryPath,
						TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
						(state) => ({
							board: addTaskToColumn(
								state.board,
								"review",
								{ taskId, prompt: "答案确认重启检查", baseRef: "main", agentId: "claude" },
								() => taskId,
							).board,
							value: null,
						}),
					);
					await recordAgentRaisedPendingUserDecision(workspaceId, {
						decisionId,
						taskId,
						workspaceId,
						agentId: "claude",
						sessionTransport: "pty_terminal",
						decisionKind: "ordinary_user_question",
						questionMarkdown: "重启后不要重复询问",
						options: [],
						allowsFreeformAnswer: true,
						askedAt: Date.now(),
						graceDeadlineAt: null,
						originRuntimeSessionIncarnationId: null,
						originTurnSequence: 0,
						sourceHarnessSignal: "browser-test:AskUserQuestion",
					});
					await createAgentRaisedPendingUserDecisionAnswerDelivery({
						ensureTaskSessionReadyForDelivery: async () => true,
						deliverTaskSessionInput: async () => ({
							status: "delivery_failed",
							reason: "submit_confirmation_budget_exhausted",
						}),
					}).answerPendingUserDecision({
						workspaceId,
						decisionId,
						selectedOptionIds: [],
						freeformText: "已经在终端处理",
					});
				} finally {
					if (previousHome === undefined) delete process.env.HOME;
					else process.env.HOME = previousHome;
					if (previousUserProfile === undefined) delete process.env.USERPROFILE;
					else process.env.USERPROFILE = previousUserProfile;
				}
				const startRuntime = async () => {
					runtime = childProcesses.register(
						spawn(process.execPath, [resolve(process.cwd(), "dist/cli.js"), "--port", "auto", "--no-open"], {
							cwd: repository.repositoryPath,
							env: fixture.createIsolatedChildProcessEnvironment({
								DO_NOT_TRACK: "1",
								KANBAN_RUNTIME_PORT: undefined,
								CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
								CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
								KANBAN_INTER_WORK_UNIT_RELATION_LEDGER_STORAGE_ROOT: join(
									fixture.isolatedHomeDirectoryPath,
									"isolated-relation-ledger",
								),
							}),
							stdio: ["ignore", "pipe", "pipe"],
						}),
					);
					return new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(runtime)).runtimeUrl).origin;
				};
				let origin = await startRuntime();
				const initialClient = createTRPCProxyClient<RuntimeAppRouter>({
					links: [httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } })],
				});
				expect(
					(await initialClient.runtime.listAgentRaisedPendingUserDecisions.query({ taskId })).decisions[0],
				).toMatchObject({ answerDeliveryState: "delivery_unconfirmed" });
				const context = await browser.newContext();
				await context.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
				const page = await context.newPage();
				let answerSubmissionRequestCount = 0;
				page.on("request", (request) => {
					if (request.url().includes("runtime.answerAgentRaisedPendingUserDecision"))
						answerSubmissionRequestCount++;
				});
				const openTask = async () => {
					await page.goto(`${origin}/${workspaceId}`);
					await page
						.locator(`[data-task-id="${taskId}"]`)
						.first()
						.getByText("答案确认重启检查", { exact: true })
						.click();
				};
				await openTask();
				const panel = page.getByRole("region", { name: "Agent 等待你的回答" });
				await panel
					.getByText("答案已保存，送达待确认", { exact: true })
					.waitFor({ timeout: 10_000 })
					.catch(async (error) => {
						throw new Error(
							`${String(error)}\n页面内容：${(await page.locator("body").innerText()).slice(-6000)}`,
						);
					});
				expect(await panel.getByText("补充说明：已经在终端处理").count()).toBe(0);
				await panel.getByRole("button", { name: "展开问题", exact: true }).click();
				await panel.getByRole("button", { name: "重新核验送达", exact: true }).click();
				await page.getByText("暂未取得送达证据，已保留答案与核验进度。", { exact: true }).waitFor();
				expect(await panel.getByRole("button", { name: "重试投递", exact: true }).count()).toBe(0);
				await panel.getByRole("button", { name: "我已在终端确认处理", exact: true }).click();
				await panel.waitFor({ state: "hidden" });
				await openTask();
				const client = () =>
					createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } }),
						],
					});
				expect(
					(await client().runtime.listAgentRaisedPendingUserDecisions.query({ taskId })).decisions,
				).toHaveLength(0);
				await page.reload();
				await page
					.locator(`[data-task-id="${taskId}"]`)
					.first()
					.getByText("答案确认重启检查", { exact: true })
					.click();
				expect(await panel.count()).toBe(0);
				if (runtime) await sigkillChildProcessAndWaitForExit(runtime);
				origin = await startRuntime();
				await openTask();
				expect(
					(await client().runtime.listAgentRaisedPendingUserDecisions.query({ taskId })).decisions,
				).toHaveLength(0);
				const history = await client().runtime.listAgentRaisedUserDecisionHistoryForTask.query({ taskId });
				expect(history.historyEntries[0]).toMatchObject({
					resolution: "user_confirmed_answer_handled",
					answerDeliveryState: "delivery_unconfirmed",
				});
				expect(await panel.count()).toBe(0);
				expect(answerSubmissionRequestCount).toBe(0);
				expect(
					await readFile(join(workspaceDirectory, "task-message-injections.json"), "utf8").catch(() => "[]"),
				).toBe("[]");
				const persisted = JSON.parse(
					await readFile(join(workspaceDirectory, "agent-raised-pending-user-decisions.json"), "utf8"),
				);
				expect(persisted[0].answerDeliveryAttempts).toHaveLength(1);
				expect(persisted[0].answerHandledConfirmation.source).toBe("kanban_panel_terminal_confirmation");
			} finally {
				await browser.close();
				await childProcesses.sigkillEveryStillRunningChildProcessAndWaitForExit();
				fixture.cleanup();
			}
		},
	);
});
