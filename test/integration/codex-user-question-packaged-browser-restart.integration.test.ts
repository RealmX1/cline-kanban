import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it } from "vitest";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
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

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe("Codex 问答的打包态浏览器与运行时重启", { timeout: 120_000 }, () => {
	it.skipIf(process.env.KANBAN_RUN_CODEX_QUESTION_BROWSER_TESTS !== "1")(
		"缺失账本时恢复未答问题，真实答案回填历史，重启不复活已答问题",
		async () => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			const browser = await chromium.launch({ channel: "chrome" });
			let runtimeProcess: ChildProcess | null = null;
			const previousHome = process.env.HOME;
			const previousUserProfile = process.env.USERPROFILE;
			try {
				const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "codex-question-browser" });
				const codexHome = join(fixture.isolatedHomeDirectoryPath, ".codex");
				const sessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
				const taskId = "codex-question-browser-task";
				const directory = join(codexHome, "sessions", "2026", "10", "17");
				await mkdir(directory, { recursive: true });
				const transcriptPath = join(directory, `rollout-${sessionId}.jsonl`);
				const toolInput = {
					questions: [
						{
							id: "recovery",
							question: "恢复原对话采用什么动作？",
							options: [{ label: "保留打开和聚焦" }, { label: "鼠标停留恢复" }],
						},
					],
				};
				const call = (id: string, time: number) =>
					JSON.stringify({
						type: "response_item",
						timestamp: new Date(time).toISOString(),
						payload: {
							type: "function_call",
							name: "request_user_input",
							call_id: id,
							arguments: JSON.stringify(toolInput),
						},
					});
				const result = (id: string, output: string) =>
					JSON.stringify({
						type: "response_item",
						timestamp: new Date(6000).toISOString(),
						payload: { type: "function_call_output", call_id: id, output },
					});
				const prefix = `${JSON.stringify({ type: "session_meta", timestamp: new Date(1000).toISOString(), payload: { id: sessionId, timestamp: new Date(1000).toISOString(), history_mode: "paginated", history_base: null } })}\n${call("old", 2000)}\n${result("old", "aborted")}\n`;
				await writeFile(transcriptPath, prefix);
				let workspaceId: string;
				process.env.HOME = fixture.isolatedHomeDirectoryPath;
				process.env.USERPROFILE = fixture.isolatedHomeDirectoryPath;
				try {
					workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
					await mutateWorkspaceState(
						repository.repositoryPath,
						TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
						(state) => ({
							board: addTaskToColumn(
								state.board,
								"review",
								{
									taskId,
									prompt: "Codex 问答隔离验证",
									baseRef: "main",
									agentId: "codex",
									worktreeMode: "inplace",
								},
								() => taskId,
							).board,
							value: null,
						}),
					);
					await writeFile(
						join(getWorkspaceDirectoryPath(workspaceId), "sessions.json"),
						JSON.stringify({
							[taskId]: {
								taskId,
								state: "awaiting_review",
								turnOwner: "user",
								liveness: "exited",
								userTurnKind: "question",
								agentId: "codex",
								workspacePath: repository.repositoryPath,
								pid: null,
								startedAt: 3000,
								updatedAt: 3000,
								lastOutputAt: 2000,
								lastHookAt: null,
								latestHookActivity: null,
								reviewReason: "hook",
								exitCode: 0,
								runtimeSessionIncarnationId: "restored-incarnation",
								agentNativeConversationSessionIdentity: {
									sourceAgentId: "codex",
									nativeSessionId: sessionId,
									transcriptPath,
									observedAt: 3000,
								},
							},
						}),
					);
				} finally {
					if (previousHome === undefined) delete process.env.HOME;
					else process.env.HOME = previousHome;
					if (previousUserProfile === undefined) delete process.env.USERPROFILE;
					else process.env.USERPROFILE = previousUserProfile;
				}
				const start = async () => {
					runtimeProcess = children.register(
						spawn(process.execPath, [resolve("dist/cli.js"), "--port", "auto", "--no-open"], {
							cwd: repository.repositoryPath,
							stdio: ["ignore", "pipe", "pipe"],
							env: fixture.createIsolatedChildProcessEnvironment({
								CODEX_HOME: codexHome,
								PATH: "/usr/bin:/bin",
								DO_NOT_TRACK: "1",
								KANBAN_RUNTIME_PORT: undefined,
							}),
						}),
					);
					return new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(runtimeProcess)).runtimeUrl)
						.origin;
				};
				const client = (origin: string) =>
					createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } }),
						],
					});
				const origin = await start();
				const firstPending = await client(origin).runtime.listAgentRaisedPendingUserDecisions.query({ taskId });
				expect(firstPending.decisions).toHaveLength(1);
				expect(firstPending.decisions[0]?.nativeToolCallOutcome).toBe("interrupted_without_answer");
				const context = await browser.newContext();
				await context.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
				const page = await context.newPage();
				await page.goto(`${origin}/${workspaceId}`);
				await page.locator(`[data-task-id="${taskId}"]`).first().click();
				const panel = page.getByRole("region", { name: "Agent 等待你的回答" });
				await panel.waitFor({ state: "visible" });
				expect(await panel.getByRole("radio", { name: "保留打开和聚焦" }).isVisible()).toBe(true);
				expect(await panel.getByRole("button", { name: "提交回答", exact: true }).isEnabled()).toBe(true);
				await page.reload();
				await panel.waitFor({ state: "visible" });
				expect(
					(await client(origin).runtime.listAgentRaisedPendingUserDecisions.query({ taskId })).decisions[0]
						?.decisionId,
				).toBe(firstPending.decisions[0]?.decisionId);
				await context.close();
				if (runtimeProcess) expect(await sigkillChildProcessAndWaitForExit(runtimeProcess)).toBe(true);
				await writeFile(
					transcriptPath,
					`${prefix}${call("new", 4000)}\n${result("new", JSON.stringify({ answers: { recovery: { answers: ["保留打开和聚焦"] } } }))}\n`,
				);
				const restartedOrigin = await start();
				expect(
					(await client(restartedOrigin).runtime.listAgentRaisedPendingUserDecisions.query({ taskId })).decisions,
				).toHaveLength(0);
				const history = await client(restartedOrigin).runtime.listAgentRaisedUserDecisionHistoryForTask.query({
					taskId,
				});
				expect(history.historyEntries).toHaveLength(2);
				expect(history.historyEntries.map((entry) => entry.resolution)).toEqual([
					"answered_in_agent_terminal",
					"superseded_by_later_question_without_answer",
				]);
				const historyContext = await browser.newContext();
				await historyContext.addInitScript(() => localStorage.setItem("kanban.onboarding.dialog.shown", "true"));
				const historyPage = await historyContext.newPage();
				await historyPage.goto(`${restartedOrigin}/${workspaceId}`);
				await historyPage.locator(`[data-task-id="${taskId}"]`).first().click();
				await historyPage.getByRole("button", { name: "展开问答记录" }).click();
				await historyPage.getByText("在终端作答", { exact: true }).waitFor();
				expect(await historyPage.getByText("未作答，被新问题取代", { exact: true }).isVisible()).toBe(true);
				expect(await historyPage.getByRole("region", { name: "Agent 等待你的回答" }).count()).toBe(0);
				await historyContext.close();
			} finally {
				if (runtimeProcess) await sigkillChildProcessAndWaitForExit(runtimeProcess);
				await browser.close();
				fixture.cleanup();
			}
		},
	);
});
