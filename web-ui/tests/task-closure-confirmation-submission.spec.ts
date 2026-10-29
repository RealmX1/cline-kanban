import { expect, type Page, test } from "@playwright/test";

async function fillAndSubmitClosureForm(page: Page) {
	await page.getByRole("button", { name: "打开结案表单", exact: true }).click();
	await page.getByLabel("结案结果", { exact: true }).selectOption("delivery_accepted");
	await page.getByLabel("原因或判断依据", { exact: true }).fill("已验证本次交付");
	await page.getByLabel("额外保全路径", { exact: true }).fill("reports/accepted.md");
	await page.getByLabel("任务评论", { exact: true }).fill("保留这段结案评论");
	await page.getByRole("button", { name: "归档并结案", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function expectPreservedClosureDraft(page: Page) {
	await expect(page.getByLabel("结案结果", { exact: true })).toHaveValue("delivery_accepted");
	await expect(page.getByLabel("原因或判断依据", { exact: true })).toHaveValue("已验证本次交付");
	await expect(page.getByLabel("额外保全路径", { exact: true })).toHaveValue("reports/accepted.md");
	await expect(page.getByLabel("任务评论", { exact: true })).toHaveValue("保留这段结案评论");
}

for (const entry of ["current-project", "other-project"] as const) {
	for (const sourceColumn of ["review", "in_progress"] as const) {
		for (const outcome of ["成功", "失败"] as const) {
			test(`${entry} ${sourceColumn} 确认结案等待期间不恢复表单，${outcome}后正确收口`, async ({ page }) => {
				const pageErrors: string[] = [];
				page.on("pageerror", (error) => pageErrors.push(error.message));
				let releaseResponse!: () => void;
				const responseBarrier = new Promise<void>((resolve) => {
					releaseResponse = resolve;
				});
				const closureRequests: Record<string, unknown>[] = [];
				await page.routeWebSocket("**/*", () => {});
				await page.route("**/api/**", async (route) => {
					// 截获全部 API，隔离用例绝不透传到真实运行实例。
					const procedures = new URL(route.request().url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
					const responses = await Promise.all(
						procedures.map(async (procedure, index) => {
							if (procedure === "deployment.getPostDeployVerificationState")
								return { result: { data: { activeDeploymentId: null, deploymentGroups: [] } } };
							const taskCard = {
								id: "closure-confirmation-fixture",
								title: "隔离结案确认回归任务",
								prompt: "隔离回归",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							};
							const taskCardSnapshot = {
								taskCard,
								boardColumnIdContainingTaskCard: sourceColumn,
								taskSessionSummaryLiveInRuntimeProcessMemory: null,
								taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
							};
							if (procedure === "taskCardAction.readTaskCardWithBoardColumn")
								return {
									result: {
										data: { taskCardLookupOutcome: "task_card_found_on_workspace_board", taskCardSnapshot },
									},
								};
							expect(procedure).toBe("taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree");
							expect(route.request().headers()["x-kanban-workspace-id"]).toBe(
								`isolated-${entry === "current-project" ? "current" : "other"}-project`,
							);
							const request = route.request().postDataJSON()[String(index)];
							closureRequests.push(request);
							await responseBarrier;
							return outcome === "失败"
								? {
										error: {
											message: "隔离回归：结案请求失败",
											code: -32603,
											data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
										},
									}
								: {
										result: {
											data: {
												boardColumnIdOfTaskCardBeforeAction: sourceColumn,
												taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
												taskAgentSessionStopWasRequested: true,
												taskWorktreeDeletionResult: {
													taskWorktreeWasRemoved: true,
													taskWorktreeDeletionErrorMessage: null,
												},
												taskCardSnapshotAfterAction: {
													...taskCardSnapshot,
													boardColumnIdContainingTaskCard: "trash",
												},
											},
										},
									};
						}),
					);
					await route.fulfill({ json: responses });
				});
				try {
					await page.goto(
						`/tests/task-closure-confirmation-submission.html?entry=${entry}&sourceColumn=${sourceColumn}`,
					);
					await fillAndSubmitClosureForm(page);
					await page.getByRole("alertdialog").getByRole("button", { name: "结案任务", exact: true }).click();
					await expect.poll(() => closureRequests.length).toBe(1);
					await expect(page.getByRole("alertdialog")).toHaveCount(0);
					await expect(page.getByRole("dialog")).toHaveCount(0);
					expect(closureRequests[0]).toMatchObject({
						taskId: "closure-confirmation-fixture",
						taskCommentToAppendWhenMovingIntoDone: {
							commentText: "保留这段结案评论",
							closure: {
								details: { outcome: "delivery_accepted", reason: "已验证本次交付" },
								selectedArtifactRelativePaths: ["reports/accepted.md"],
							},
						},
					});
					releaseResponse();
					if (outcome === "成功") {
						await expect(page.getByRole("button", { name: "打开结案表单", exact: true })).toBeEnabled();
						await page.getByRole("button", { name: "打开结案表单", exact: true }).click();
						await expect(page.getByLabel("任务评论", { exact: true })).toHaveValue("");
						await expect(page.getByLabel("结案结果", { exact: true })).toHaveValue("");
					} else {
						await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("隔离回归：结案请求失败");
						await expectPreservedClosureDraft(page);
						await expect(page.getByRole("button", { name: "归档并结案", exact: true })).toBeEnabled();
					}
					expect(closureRequests).toHaveLength(1);
					expect(pageErrors).toEqual([]);
				} finally {
					releaseResponse();
				}
			});
		}
	}
}
