import { expect, type Page, test } from "@playwright/test";

const panelSelector = '[data-testid="cross-project-recently-active-task-switcher-panel"]';
const focusedCardSelector = '[data-cross-project-focused-task-scroll-anchor="project-a:warm-current"]';
let pageErrors: string[];

test.beforeEach(async ({ page }) => {
	pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	// 所有请求均截获，隔离页面绝不经 Vite 代理访问真实 runtime。
	await page.route("**/api/**", async (route) => {
		expect(route.request().method()).toBe("GET");
		const procedures = new URL(route.request().url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		await route.fulfill({
			json: procedures.map((procedure) => ({
				result: {
					data:
						procedure === "taskCardAction.readTaskCardWithBoardColumn"
							? { taskCardLookupOutcome: "task_card_not_found_on_workspace_board" }
							: { tasks: [] },
				},
			})),
		});
	});
	await page.routeWebSocket("**/*", () => {});
});
test.afterEach(() => expect(pageErrors).toEqual([]));

async function openScenario(page: Page, scenario: string) {
	await page.route("**/isolated-cache-warm-validation-focus?*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-cache-warm-validation-focus?scenario=${scenario}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/cache-warm-validation-focus-browser-harness.tsx" });
	await expect(page.getByLabel("当前焦点")).toHaveText("project-a:warm-current");
	await page.locator(focusedCardSelector).hover();
	await expect(
		page.locator(focusedCardSelector).getByRole("button", { name: "Move task to validation", exact: true }),
	).toBeVisible();
}

async function interceptValidationMove(page: Page, outcome: "success" | "failure" = "success") {
	let resolveRequestStarted = () => {};
	let releaseResponse = () => {};
	const requestStarted = new Promise<void>((resolve) => {
		resolveRequestStarted = resolve;
	});
	const responseReleased = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	await page.route(
		"**/api/trpc/taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects?*",
		async (route) => {
			expect(route.request().method()).toBe("POST");
			expect(route.request().headers()["x-kanban-workspace-id"]).toBe("project-a");
			expect(route.request().postDataJSON()["0"]).toMatchObject({
				taskId: "warm-current",
				targetBoardColumnId: "validation",
			});
			resolveRequestStarted();
			await responseReleased;
			await route.fulfill(
				outcome === "failure"
					? {
							status: 500,
							json: [
								{
									error: {
										message: "隔离测试移列失败",
										code: -32603,
										data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
									},
								},
							],
						}
					: {
							json: [
								{
									result: {
										data: {
											boardColumnIdOfTaskCardBeforeAction: "review",
											taskCardPlacementWasChangedByThisAction: true,
											taskCardSnapshotAfterAction: {
												taskCard: { id: "warm-current" },
												boardColumnIdContainingTaskCard: "validation",
												taskSessionSummaryLiveInRuntimeProcessMemory: null,
												taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
											},
										},
									},
								},
							],
						},
			);
		},
	);
	return { requestStarted, releaseResponse };
}

for (const [scenario, expected] of [
	["same-project", "project-a:warm-next"],
	["cross-project", "project-b:warm-current"],
	["next-in-progress", "project-a:warm-next"],
	["last", "project-a:warm-previous"],
	["single", "project-a:warm-current"],
]) {
	test(`实际卡片按钮按 Cache warm 接续：${scenario}`, async ({ page }) => {
		await openScenario(page, scenario);
		const move = await interceptValidationMove(page);
		await page
			.locator(focusedCardSelector)
			.getByRole("button", { name: "Move task to validation", exact: true })
			.click();
		await move.requestStarted;
		await expect(page.getByLabel("当前焦点")).toHaveText("project-a:warm-current");
		// 模拟真实广播先到：原任务退出 Cache warm 后仍须使用操作前捕获的邻项。
		await page.evaluate(() => window.dispatchEvent(new Event("isolated-validation-move-broadcast")));
		move.releaseResponse();
		await expect(page.getByLabel("当前焦点")).toHaveText(expected);
	});
}

test("Sticky 副本使用同一套接续逻辑", async ({ page }) => {
	await openScenario(page, "same-project");
	const move = await interceptValidationMove(page);
	await page.locator(panelSelector).evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	const sticky = page.locator("[data-cross-project-focused-task-sticky-edge]");
	await expect(sticky).toHaveCount(1);
	await sticky.hover();
	await sticky.getByRole("button", { name: "Move task to validation", exact: true }).click();
	await move.requestStarted;
	move.releaseResponse();
	await expect(page.getByLabel("当前焦点")).toHaveText("project-a:warm-next");
});

test("移列失败不跳转", async ({ page }) => {
	await openScenario(page, "same-project");
	const move = await interceptValidationMove(page, "failure");
	await page
		.locator(focusedCardSelector)
		.getByRole("button", { name: "Move task to validation", exact: true })
		.click();
	await move.requestStarted;
	const response = page.waitForResponse((value) => value.request().method() === "POST");
	move.releaseResponse();
	await response;
	await expect(page.getByLabel("当前焦点")).toHaveText("project-a:warm-current");
});

test("等待服务端时手动切走，成功响应不抢焦点", async ({ page }) => {
	await openScenario(page, "same-project");
	const move = await interceptValidationMove(page);
	await page
		.locator(focusedCardSelector)
		.getByRole("button", { name: "Move task to validation", exact: true })
		.click();
	await move.requestStarted;
	await page.getByRole("button", { name: "手动切走", exact: true }).click();
	const response = page.waitForResponse((value) => value.request().method() === "POST");
	move.releaseResponse();
	await response;
	await expect(page.getByLabel("当前焦点")).toHaveText("project-a:recent-0");
});
