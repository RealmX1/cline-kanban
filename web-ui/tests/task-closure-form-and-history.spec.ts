import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
	test(`结案表单在 ${width}px 的双宿主保留部分成果并展示归档`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await page.route("**/api/**", async (route) => {
			const url = new URL(route.request().url());
			const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
			const responses = procedures.map((procedure) =>
				procedure === "taskCardAction.readTaskClosureHistory"
					? { result: { data: { records: [], operations: [] } } }
					: {
							error: {
								message: "隔离测试未调用真实运行时",
								code: -32603,
								data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
							},
						},
			);
			await route.fulfill({ contentType: "application/json", body: JSON.stringify(responses) });
		});
		await page.goto("/tests/task-closure-form-and-history.html");
		for (const host of ["主看板宿主", "Focus View 宿主"]) {
			await page.getByRole("region", { name: host }).hover();
			await page
				.getByRole("region", { name: host })
				.getByRole("button", { name: "结案任务", exact: true })
				.first()
				.click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.getByLabel("结案结果", { exact: true }).selectOption("plan_retired");
			await page.getByRole("button", { name: "归档并结案" }).click();
			await expect(page.getByRole("alert")).toContainText("原因");
			await page.getByLabel("原因或判断依据", { exact: true }).fill("剩余实现采用后继方案");
			await page.getByRole("button", { name: "添加已接受成果" }).click();
			await page.getByLabel("已接受成果 1", { exact: true }).fill("独立反例报告");
			await page.getByLabel("成果验收证据 1", { exact: true }).fill("用户已接受报告");
			await page.getByLabel("额外保全路径", { exact: true }).fill("reports/accepted.md");
			await page.getByRole("button", { name: "归档并结案" }).click();
			await expect(page.getByRole("dialog")).not.toBeVisible();
			const submitted = JSON.parse((await page.getByLabel("提交的结案结果").textContent()) ?? "{}");
			expect(submitted.details.outcome).toBe("plan_retired");
			expect(submitted.details.acceptedDeliverables[0].description).toBe("独立反例报告");
			expect(submitted.selectedArtifactRelativePaths).toEqual(["reports/accepted.md"]);
		}
		await page.getByRole("button", { name: "查看结案历史：方案退役" }).first().click();
		await expect(page.getByRole("dialog")).toContainText("归档已经实际还原验证");
		await expect(page.getByRole("dialog")).toContainText("独立反例报告");
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});
}

test("PDV 面板未水合项目也显式选择结构化结果，取消不会发出结案", async ({ page }) => {
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const responses = procedures.map(() => ({
			result: {
				data: {
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: {
						taskCard: {
							id: "abc12",
							title: "其他项目的待结案任务",
							prompt: "保持项目归属",
							baseRef: "main",
							startInPlanMode: false,
							createdAt: 1,
							updatedAt: 1,
						},
						boardColumnIdContainingTaskCard: "validation",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				},
			},
		}));
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(responses) });
	});
	await page.goto("/tests/task-closure-form-and-history.html");
	await page.getByRole("button", { name: "PDV 面板结案其他项目" }).click();
	await expect(page.getByRole("dialog")).toContainText("其他项目的待结案任务");
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByLabel("提交的结案结果")).toHaveText("null");
	await page.getByRole("button", { name: "PDV 面板结案其他项目" }).click();
	await page.getByLabel("结案结果", { exact: true }).selectOption("delivery_accepted");
	await page.getByRole("button", { name: "归档并结案" }).click();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	const submitted = JSON.parse((await page.getByLabel("提交的结案结果").textContent()) ?? "{}");
	expect(submitted.details.outcome).toBe("delivery_accepted");
	expect(submitted.expectedTaskUpdatedAtEpochMs).toBe(1);
});
