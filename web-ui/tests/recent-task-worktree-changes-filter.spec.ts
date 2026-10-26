import { expect, type Page, test } from "@playwright/test";
import {
	createRecentTaskWorktreeMetadataTestFixture,
	createRecentTaskWorktreeUnavailableGitProbeMetadataTestFixture,
} from "./recent-task-worktree-changes-filter-fixtures";

async function openIsolatedWorktreeFilterHarness(page: Page, view: "board" | "focus") {
	const dirtyEntryKeys = new Set(["project-a:dirty"]);
	const aheadEntryKeys = new Set(["project-a:ahead", "project-a:missing"]);
	const unavailableProbeEntryKeys = new Set<string>();
	const metadataRequests: Array<Array<{ workspaceId: string; taskId: string }>> = [];
	const pageErrors: string[] = [];
	let failsMetadataRequest = false;
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.clock.install();
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/api/**", async (route) => {
		// 所有 API 均在此拦截，不访问 Vite 代理后的真实 runtime，也不允许写请求。
		expect(route.request().method()).toBe("GET");
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(url.searchParams.get("input") ?? "{}") as Record<
			string,
			{ tasks?: Array<{ workspaceId: string; taskId: string }> }
		>;
		if (failsMetadataRequest) {
			await route.fulfill({ status: 503, body: "隔离测试的暂时失败" });
			return;
		}
		const responses = procedures.map((procedure, index) => {
			if (procedure !== "projects.readTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries") {
				return { result: { data: { taskCardLookupOutcome: "task_card_not_found_on_workspace_board" } } };
			}
			const tasks = inputs[String(index)]?.tasks ?? [];
			metadataRequests.push(tasks);
			return {
				result: {
					data: {
						tasks: tasks.map(({ workspaceId, taskId }) => ({
							workspaceId,
							taskId,
							availability: "available",
							taskWorkspaceMetadata: unavailableProbeEntryKeys.has(`${workspaceId}:${taskId}`)
								? createRecentTaskWorktreeUnavailableGitProbeMetadataTestFixture(taskId)
								: createRecentTaskWorktreeMetadataTestFixture(taskId, {
										exists: taskId !== "missing",
										changedFiles:
											taskId === "unknown" ? null : dirtyEntryKeys.has(`${workspaceId}:${taskId}`) ? 1 : 0,
										commitsAheadOfBaseRef:
											taskId === "unknown" ? null : aheadEntryKeys.has(`${workspaceId}:${taskId}`) ? 2 : 0,
									}),
						})),
					},
				},
			};
		});
		await route.fulfill({ json: responses });
	});
	await page.route("**/isolated-recent-worktree-filter?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-recent-worktree-filter?view=${view}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/recent-task-worktree-changes-filter-browser-harness.tsx" });
	const recent = page.getByTestId("cross-project-task-switcher-section-remaining");
	const filter = recent.getByRole("button", { name: "未提交改动 / 独有提交", exact: true });
	await expect(filter).toBeVisible();
	await expect.poll(() => metadataRequests.length).toBeGreaterThan(0);
	return {
		recent,
		filter,
		dirtyEntryKeys,
		aheadEntryKeys,
		unavailableProbeEntryKeys,
		metadataRequests,
		pageErrors,
		setFailsMetadataRequest: (fails: boolean) => {
			failsMetadataRequest = fails;
		},
	};
}

for (const scenario of [
	{ name: "桌面看板", view: "board", width: 1440, height: 900 },
	{ name: "Focus View 左栏", view: "focus", width: 1280, height: 800 },
	{ name: "手机看板", view: "board", width: 390, height: 844 },
] as const) {
	test(`${scenario.name}：键盘切换组合筛选，隐藏任务变脏后自动出现，呈现面切换保留开关`, async ({ page }) => {
		await page.setViewportSize({ width: scenario.width, height: scenario.height });
		const harness = await openIsolatedWorktreeFilterHarness(page, scenario.view);
		const rows = harness.recent.locator("[data-cross-project-task-switcher-task-id]");
		await expect(rows).toHaveCount(6);
		await expect(harness.filter).toHaveAttribute("aria-pressed", "false");
		await harness.filter.focus();
		await page.keyboard.press("Space");
		await expect(harness.filter).toHaveAttribute("aria-pressed", "true");
		await expect(rows).toHaveCount(2);
		await expect(harness.recent.getByRole("status")).toContainText("1 个任务的工作树状态暂不可用");
		await expect(page.getByTestId("cross-project-task-switcher-section-pinned")).toContainText("测试任务 clean");
		await page.screenshot({ path: test.info().outputPath(`${scenario.view}-${scenario.width}-filter-active.png`) });
		harness.dirtyEntryKeys.add("project-b:dirty");
		await page.clock.fastForward(5_000);
		await expect(rows).toHaveCount(3);
		expect(harness.metadataRequests.at(-1)).toContainEqual({ workspaceId: "project-b", taskId: "dirty" });
		harness.dirtyEntryKeys.delete("project-a:dirty");
		await page.clock.fastForward(5_000);
		await expect(rows).toHaveCount(2);
		await page.getByRole("button", { name: "重新挂载呈现面", exact: true }).click();
		await expect(harness.filter).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "切换看板与 Focus View", exact: true }).click();
		await expect(harness.filter).toHaveAttribute("aria-pressed", "true");
		await expect(rows).toHaveCount(2);
		await harness.filter.click();
		await expect(rows).toHaveCount(6);
		expect(harness.pageErrors).toEqual([]);
		const filterGeometry = await harness.filter.boundingBox();
		expect(filterGeometry!.width).toBeGreaterThan(100);
		if (scenario.width < 500)
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(scenario.width);
	});
}

test("轮询失败保留已知命中并提示，恢复后自动采用最新结果", async ({ page }) => {
	const harness = await openIsolatedWorktreeFilterHarness(page, "focus");
	await harness.filter.click();
	await expect(harness.recent.locator("[data-cross-project-task-switcher-task-id]")).toHaveCount(2);
	harness.setFailsMetadataRequest(true);
	await page.clock.fastForward(5_000);
	await expect(harness.recent.getByRole("status")).toContainText("将自动重试");
	await expect(harness.recent.locator("[data-cross-project-task-switcher-task-id]")).toHaveCount(2);
	harness.setFailsMetadataRequest(false);
	harness.dirtyEntryKeys.add("project-b:dirty");
	await page.clock.fastForward(5_000);
	await expect(harness.recent.locator("[data-cross-project-task-switcher-task-id]")).toHaveCount(3);
	expect(harness.pageErrors).toEqual([]);
});

test("外层 available 的全未知探针失败保留 dirty 与 ahead 命中，后续成功轮询自动恢复并移除", async ({ page }) => {
	const harness = await openIsolatedWorktreeFilterHarness(page, "focus");
	const rows = harness.recent.locator("[data-cross-project-task-switcher-task-id]");
	await harness.filter.click();
	await expect(rows).toHaveCount(2);
	harness.unavailableProbeEntryKeys.add("project-a:dirty");
	harness.unavailableProbeEntryKeys.add("project-a:ahead");
	await page.clock.fastForward(5_000);
	await expect(harness.recent.getByRole("status")).toContainText("3 个任务的工作树状态暂不可用");
	await expect(harness.recent.getByRole("status")).toContainText("将自动重试");
	await expect(rows).toHaveCount(2);
	harness.unavailableProbeEntryKeys.clear();
	await page.clock.fastForward(5_000);
	await expect(harness.recent.getByRole("status")).toContainText("1 个任务的工作树状态暂不可用");
	await expect(rows).toHaveCount(2);
	harness.dirtyEntryKeys.delete("project-a:dirty");
	harness.aheadEntryKeys.delete("project-a:ahead");
	await page.clock.fastForward(5_000);
	await expect(rows).toHaveCount(0);
	expect(harness.pageErrors).toEqual([]);
});
