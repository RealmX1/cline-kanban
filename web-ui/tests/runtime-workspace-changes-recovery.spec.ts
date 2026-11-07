import { expect, test } from "@playwright/test";

test("真实浏览器取消挂起读取、耗尽预算后等待恢复，并隔离旧任务结果", async ({ page }) => {
	test.setTimeout(90_000);
	let hanging = true;
	let queryCount = 0;
	let cancelledCount = 0;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("requestfailed", (request) => {
		if (request.url().includes("workspace.getChanges")) cancelledCount += 1;
	});
	await page.route("**/api/**", async (route) => {
		if (!route.request().url().includes("/workspace.getChanges?")) return await route.abort();
		queryCount += 1;
		expect(route.request().url()).not.toContain("batch=");
		if (hanging) return;
		const input = JSON.parse(new URL(route.request().url()).searchParams.get("input") ?? "{}");
		await route.fulfill({
			json: {
				result: {
					data: {
						repoRoot: "/isolated/project",
						generatedAt: Date.now(),
						files: [
							{
								path: `${input.taskId}.ts`,
								status: "modified",
								additions: 1,
								deletions: 0,
								oldText: "",
								newText: "已恢复",
							},
						],
					},
				},
			},
		});
	});
	await page.goto("/tests/runtime-workspace-changes-recovery-browser-harness.html");
	await expect.poll(() => queryCount).toBe(1);
	await page.getByRole("button", { name: "刷新读取" }).click({ clickCount: 3 });
	expect(queryCount).toBe(1);
	await expect(page.getByTestId("query-phase")).toHaveText("initial_error", { timeout: 60_000 });
	await expect.poll(() => queryCount, { timeout: 30_000 }).toBe(3);
	await expect.poll(() => cancelledCount, { timeout: 30_000 }).toBe(3);
	await expect(page.getByRole("alert")).toContainText("超时");
	hanging = false;
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await expect(page.getByTestId("query-phase")).toHaveText("ready");
	await expect(page.getByTestId("diff-paths")).toHaveText("first-task.ts");
	hanging = true;
	await page.getByRole("button", { name: "刷新读取" }).click();
	await expect.poll(() => queryCount).toBe(5);
	hanging = false;
	await page.getByRole("button", { name: "切换任务" }).click();
	await expect(page.getByTestId("diff-paths")).toHaveText("second-task.ts");
	await expect.poll(() => cancelledCount).toBe(4);
	expect(pageErrors).toEqual([]);
});
