import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard } from "../../src/core/api-contract";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeAppRouter } from "../../src/trpc/app-router";
import { chromium } from "../../web-ui/node_modules/playwright";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import {
	computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts,
	createSpawnedChildProcessRegistrySigkilledAfterEachTest,
	sigkillChildProcessAndWaitForExit,
	waitForRuntimeServerStartupBannerOrSigkillChild,
} from "./runtime-integration-test-spawned-child-process-lifecycle";

const children = createSpawnedChildProcessRegistrySigkilledAfterEachTest();
afterEach(() => children.sigkillEveryStillRunningChildProcessAndWaitForExit());

describe(
	"多便签的打包态双浏览器与运行时重启",
	{
		timeout: computeIntegrationTestTimeoutMsCoveringRuntimeColdStarts({
			runtimeColdStartCount: 2,
			testBodyTimeoutBudgetMs: 45_000,
		}),
	},
	() => {
		it.skipIf(process.env.KANBAN_RUN_TASK_STICKER_PACKAGED_BROWSER_RESTART_TEST !== "1")(
			"跨浏览器同步便签，进程重启恢复折叠与正文，删除不影响其他条目",
			async () => {
				const fixture = createIsolatedGitTestWorkspaceFixture();
				const repository = fixture.createNonBareRepository({
					repositoryDirectoryName: "task-sticker-packaged-restart",
				});
				const originalHome = process.env.HOME;
				let workspaceId: string;
				const card: RuntimeBoardCard = {
					id: "sticker-restart-task",
					title: "便签打包态重启检查",
					prompt: "不启动 Agent",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 2,
					taskDescriptionLastUpdatedAt: 1,
				};
				process.env.HOME = fixture.isolatedHomeDirectoryPath;
				try {
					workspaceId = (await loadWorkspaceContext(repository.repositoryPath)).workspaceId;
					await saveWorkspaceState(repository.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
						board: { columns: [{ id: "review", title: "Review", cards: [card] }] },
						sessions: {},
					});
				} finally {
					if (originalHome === undefined) delete process.env.HOME;
					else process.env.HOME = originalHome;
				}
				const startRuntime = async () => {
					const child = children.register(
						spawn(process.execPath, [resolve("dist/cli.js"), "--port", "auto", "--no-open"], {
							cwd: repository.repositoryPath,
							env: fixture.createIsolatedChildProcessEnvironment({
								DO_NOT_TRACK: "1",
								KANBAN_RUNTIME_PORT: undefined,
								CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"),
								CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-database"),
							}),
							stdio: ["ignore", "pipe", "pipe"],
						}),
					);
					const origin = new URL((await waitForRuntimeServerStartupBannerOrSigkillChild(child)).runtimeUrl).origin;
					const client = createTRPCProxyClient<RuntimeAppRouter>({
						links: [
							httpBatchLink({ url: `${origin}/api/trpc`, headers: { "x-kanban-workspace-id": workspaceId } }),
						],
					});
					return { child, origin, client };
				};
				const browser = await chromium.launch();
				try {
					const firstRuntime = await startRuntime();
					const firstContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
					const secondContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
					await Promise.all(
						[firstContext, secondContext].map((context) =>
							context.addInitScript(() => {
								localStorage.setItem("kanban.onboarding.dialog.shown", "true");
							}),
						),
					);
					const firstPage = await firstContext.newPage();
					const secondPage = await secondContext.newPage();
					await Promise.all([
						firstPage.goto(`${firstRuntime.origin}/${workspaceId}`),
						secondPage.goto(`${firstRuntime.origin}/${workspaceId}`),
					]);
					const identity = { taskId: card.id, expectedTaskIncarnationCreatedAtEpochMs: card.createdAt };
					await Promise.all(
						["first", "second"].map((taskStickerEntryId) =>
							firstRuntime.client.taskCardAction.applyTaskStickerEntryMutation.mutate({
								...identity,
								mutation: {
									operation: "create",
									taskStickerEntryId,
									stickerText: `便签 ${taskStickerEntryId}\n完整正文`,
								},
							}),
						),
					);
					const firstCard = firstPage.locator(`[data-task-id="${card.id}"]`);
					await firstCard.getByRole("button", { name: "便签 2", exact: true }).waitFor();
					await firstCard.hover();
					await firstPage
						.locator("[data-task-sticker-overlay]")
						.getByRole("button", { name: "收起便签", exact: true })
						.first()
						.click();
					await vi.waitFor(async () => {
						const result = await firstRuntime.client.taskCardAction.readTaskCardWithBoardColumn.query(identity);
						expect(
							result.taskCardLookupOutcome === "task_card_found_on_workspace_board" &&
								result.taskCardSnapshot.taskCard.taskStickerEntries?.[0]?.isCollapsed,
						).toBe(true);
					});
					await secondPage.locator(`[data-task-id="${card.id}"]`).hover();
					await secondPage
						.locator("[data-task-sticker-overlay]")
						.getByRole("button", { name: "展开便签", exact: true })
						.waitFor();
					await firstContext.close();
					await secondContext.close();
					await sigkillChildProcessAndWaitForExit(firstRuntime.child);
					const restarted = await startRuntime();
					const loaded = await restarted.client.taskCardAction.readTaskCardWithBoardColumn.query(identity);
					expect(loaded.taskCardLookupOutcome).toBe("task_card_found_on_workspace_board");
					if (loaded.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
						throw new Error("重启后任务丢失");
					expect(loaded.taskCardSnapshot.taskCard.taskStickerEntries).toHaveLength(2);
					expect(loaded.taskCardSnapshot.taskCard.taskStickerEntries?.[0]?.isCollapsed).toBe(true);
					expect(loaded.taskCardSnapshot.taskCard.updatedAt).toBe(2);
					expect(loaded.taskCardSnapshot.taskCard.taskDescriptionLastUpdatedAt).toBe(1);
					const restartedContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
					await restartedContext.addInitScript(() =>
						localStorage.setItem("kanban.onboarding.dialog.shown", "true"),
					);
					const restartedPage = await restartedContext.newPage();
					await restartedPage.goto(`${restarted.origin}/${workspaceId}`);
					await restartedPage.locator(`[data-task-id="${card.id}"]`).hover();
					await restartedPage
						.locator("[data-task-sticker-overlay]")
						.getByRole("button", { name: "展开便签", exact: true })
						.waitFor();
					await restarted.client.taskCardAction.applyTaskStickerEntryMutation.mutate({
						...identity,
						mutation: {
							operation: "delete",
							taskStickerEntryId: "first",
							expectedStickerText: "便签 first\n完整正文",
						},
					});
					await restartedPage.getByRole("button", { name: "便签 1", exact: true }).waitFor();
					const evidenceDirectory = process.env.KANBAN_TASK_STICKER_PACKAGED_BROWSER_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						await restartedPage.screenshot({
							path: join(evidenceDirectory, "task-stickers-packaged-runtime-after-restart.png"),
						});
					}
					await restartedContext.close();
				} catch (error) {
					const evidenceDirectory = process.env.KANBAN_TASK_STICKER_PACKAGED_BROWSER_EVIDENCE_DIRECTORY;
					if (evidenceDirectory) {
						await mkdir(evidenceDirectory, { recursive: true });
						for (const [contextIndex, context] of browser.contexts().entries()) {
							for (const [pageIndex, page] of context.pages().entries()) {
								await page.screenshot({
									path: join(evidenceDirectory, `task-stickers-failure-${contextIndex}-${pageIndex}.png`),
								});
								console.error(
									"打包态浏览器诊断：",
									page.url(),
									(await page.locator("body").innerText()).slice(0, 5000),
								);
							}
						}
					}
					throw error;
				} finally {
					await browser.close();
				}
			},
		);
	},
);
