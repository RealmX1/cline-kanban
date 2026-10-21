import { expect, type Page, test } from "@playwright/test";
import type { RuntimeTaskCardActionUpdateFieldValuesRequest } from "../src/runtime/types";
import type { TaskCommentEntry } from "../src/types";

async function openWorkbench(page: Page, width: number, height: number) {
	await page.setViewportSize({ width, height });
	await page.route("**/api/**", (route) => route.abort());
	let terminalConnections = 0;
	await page.routeWebSocket("**/*", (socket) => {
		const url = new URL(socket.url());
		if (url.pathname === "/api/terminal/io") terminalConnections++;
		if (url.pathname === "/api/terminal/control")
			socket.send(JSON.stringify({ type: "restore", cols: 60, rows: 24, snapshot: "隔离工作台终端\r\n> " }));
	});
	await page.route("**/isolated-desktop-task-workbench", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-desktop-task-workbench");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/desktop-focus-view-task-workbench-browser-harness.tsx" });
	await expect(page.locator(".xterm-screen")).toBeVisible();
	return () => terminalConnections;
}

for (const [width, height] of [
	[1080, 1920],
	[1440, 2560],
	[769, 1024],
	[1920, 1080],
]) {
	test(`${width}×${height} 自动布局、模块交换和终端连续性`, async ({ page }) => {
		const connections = await openWorkbench(page, width!, height!);
		const initialConnections = connections();
		const arrangement = height! > width! ? "agent_above_workbench_below" : "agent_left_workbench_right";
		await expect(page.locator("[data-focus-view-panel-arrangement]")).toHaveAttribute(
			"data-focus-view-panel-arrangement",
			arrangement,
		);
		const terminal = await page.locator(".kb-terminal-container").boundingBox();
		const workbench = await page.getByRole("region", { name: "任务工作台", exact: true }).boundingBox();
		expect(terminal).not.toBeNull();
		expect(workbench).not.toBeNull();
		if (height! > width!) {
			expect(workbench!.y).toBeGreaterThan(terminal!.y + terminal!.height - 2);
			expect(terminal!.width).toBeGreaterThan(width! * 0.7);
		} else expect(workbench!.x).toBeGreaterThan(terminal!.x);
		await page.screenshot({ path: test.info().outputPath(`task-workbench-${width}x${height}.png`) });
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("prompt_tools");
		await expect(page.getByLabel("工作台格位 2", { exact: true })).toHaveValue("task_sessions");
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("cross_task_relations");
		await page.getByLabel("工作台格位 1", { exact: true }).selectOption("exploration_map");
		await page.getByLabel("任务专注视图布局").selectOption("agent_above_workbench_below");
		await page.setViewportSize({ width: 1920, height: 1080 });
		await expect(page.locator("[data-focus-view-panel-arrangement]")).toHaveAttribute(
			"data-focus-view-panel-arrangement",
			"agent_above_workbench_below",
		);
		expect(connections()).toBe(initialConnections);
		expect(
			await page.evaluate(() =>
				(window as unknown as { readWorkbenchTerminalCount: () => number }).readWorkbenchTerminalCount(),
			),
		).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
		await page.getByRole("button", { name: "重置布局", exact: true }).click();
		await expect(page.getByLabel("工作台格位 1", { exact: true })).toHaveValue("task_sessions");
		await expect(page.getByLabel("任务专注视图布局")).toHaveValue("automatic");
	});
}

test("会话对话框关闭、换格与 Changes 返回后保留草稿", async ({ page }) => {
	await openWorkbench(page, 1080, 1920);
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await page.getByLabel("首条消息", { exact: true }).fill("跨格位保留的会话草稿");
	await page.keyboard.press("Escape");
	await page.getByLabel("工作台格位 1", { exact: true }).selectOption("cross_task_relations");
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByRole("button", { name: "Changes", exact: true }).click();
	await page.getByLabel("工作台格位 1", { exact: true }).selectOption("task_sessions");
	await page.getByRole("button", { name: "新建会话", exact: true }).click();
	await expect(page.getByLabel("首条消息", { exact: true })).toHaveValue("跨格位保留的会话草稿");
	await page.getByRole("button", { name: "Create session", exact: true }).click();
	await expect(page.getByText("隔离环境：创建失败后保留草稿", { exact: true })).toBeVisible();
	await expect(page.getByLabel("首条消息", { exact: true })).toHaveValue("跨格位保留的会话草稿");
	await page.screenshot({ path: test.info().outputPath("portrait-session-creation.png") });
});

test("拖动比例和手动布局在刷新后恢复", async ({ page }) => {
	await openWorkbench(page, 1080, 1920);
	const handle = await page
		.getByRole("separator", { name: "Resize agent and diff panels", exact: true })
		.boundingBox();
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y);
	await page.mouse.down();
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 100);
	await page.mouse.up();
	const ratio = await page.evaluate(() =>
		localStorage.getItem("kanban.focus-view-stacked-agent-panel-height-ratio.v1"),
	);
	expect(Number(ratio)).toBeGreaterThan(0.6);
	await page.getByRole("separator", { name: "调整任务工作台格位大小" }).focus();
	await page.keyboard.press("ArrowRight");
	await page.getByLabel("工作台格位 2", { exact: true }).selectOption("exploration_map");
	await page.getByLabel("任务专注视图布局").selectOption("agent_above_workbench_below");
	await openWorkbench(page, 1920, 1080);
	await expect(page.getByLabel("任务专注视图布局")).toHaveValue("agent_above_workbench_below");
	await expect(page.getByLabel("工作台格位 2", { exact: true })).toHaveValue("exploration_map");
	expect(
		await page.evaluate(() => localStorage.getItem("kanban.focus-view-stacked-agent-panel-height-ratio.v1")),
	).toBe(ratio);
	expect(
		Number(await page.evaluate(() => localStorage.getItem("kanban.task-workbench-side-by-side-slot-width-ratio.v1"))),
	).toBeCloseTo(0.55);
});

test("手机任务卡保留评论入口，读取失败不提供覆盖评论的保存入口", async ({ page }) => {
	await openWorkbench(page, 390, 812);
	await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
	const button = page.getByRole("button", { name: "任务评论", exact: true });
	const box = await button.boundingBox();
	expect(box!.width).toBeGreaterThanOrEqual(44);
	expect(box!.height).toBeGreaterThanOrEqual(44);
	await button.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByRole("button", { name: "重新读取", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add comment", exact: true })).toHaveCount(0);
});

async function openCommentsWithIsolatedRuntime(page: Page, failFirstSave = false) {
	await openWorkbench(page, 390, 812);
	const savedComments: TaskCommentEntry[] = [];
	const writes: unknown[] = [];
	await page.route("**/api/trpc/taskCardAction.*", async (route) => {
		const snapshot = () => ({
			taskCard: { id: "workbench-test-task", title: "隔离评论验证", taskCommentEntries: [...savedComments] },
			boardColumnIdContainingTaskCard: "in_progress",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		});
		if (route.request().url().includes("readTaskCardWithBoardColumn")) {
			await route.fulfill({
				json: [
					{
						result: {
							data: {
								taskCardLookupOutcome: "task_card_found_on_workspace_board",
								taskCardSnapshot: snapshot(),
							},
						},
					},
				],
			});
		} else if (route.request().url().includes("updateTaskCardFieldValues")) {
			const input = (
				route.request().postDataJSON() as Record<string, RuntimeTaskCardActionUpdateFieldValuesRequest>
			)["0"]!;
			writes.push(input);
			if (failFirstSave && writes.length === 1) {
				await route.fulfill({
					status: 500,
					json: [
						{
							error: {
								message: "隔离环境：评论保存失败",
								code: -32603,
								data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
							},
						},
					],
				});
				return;
			}
			if (input.taskCardFieldUpdate.taskCardFieldUpdateInputKind !== "three_state_task_card_field_value_patch")
				throw new Error("评论保存必须使用字段 patch。");
			savedComments.splice(
				0,
				savedComments.length,
				...(input.taskCardFieldUpdate.taskCardFieldValuePatch.taskCommentEntries ?? []),
			);
			await route.fulfill({ json: [{ result: { data: { taskCardSnapshotAfterAction: snapshot() } } }] });
		} else await route.abort();
	});
	await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
	await page.getByRole("button", { name: "任务评论", exact: true }).click();
	await expect(page.getByPlaceholder("Write a task comment...")).toBeVisible();
	return { writes, savedComments };
}

for (const closeMethod of ["关闭按钮", "Escape", "遮罩"] as const) {
	test(`评论对话框通过${closeMethod}关闭不会提交新评论草稿`, async ({ page }) => {
		const { writes, savedComments } = await openCommentsWithIsolatedRuntime(page);
		await page.getByPlaceholder("Write a task comment...").fill("尚未确认的新评论");
		if (closeMethod === "关闭按钮") await page.getByRole("button", { name: "Close", exact: true }).click();
		else if (closeMethod === "Escape") await page.keyboard.press("Escape");
		else await page.mouse.click(1, 1);
		await expect(page.getByRole("dialog")).toBeHidden();
		await page.getByRole("button", { name: "任务评论", exact: true }).click();
		await expect(page.getByPlaceholder("Write a task comment...")).toBeVisible();
		expect(writes).toHaveLength(0);
		expect(savedComments).toHaveLength(0);
	});
}

test("评论对话框新评论只显式提交，失败可重试且既有评论仍在失焦时保存", async ({ page }) => {
	const { writes, savedComments } = await openCommentsWithIsolatedRuntime(page, true);
	const newComment = page.getByPlaceholder("Write a task comment...");
	await newComment.fill("明确提交的新评论");
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "Add comment", exact: true })).toBeFocused();
	expect(writes).toHaveLength(0);
	await expect(newComment).toHaveValue("明确提交的新评论");
	await page.getByRole("button", { name: "Add comment", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("隔离环境：评论保存失败");
	await expect(page.getByPlaceholder("Edit task comment...")).toHaveValue("明确提交的新评论");
	expect(savedComments).toHaveLength(0);
	await page.getByRole("button", { name: "重试保存", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect.poll(() => writes.length).toBe(2);
	await expect(newComment).toBeEnabled();
	expect(savedComments).toEqual([expect.objectContaining({ commentText: "明确提交的新评论" })]);
	await page.getByPlaceholder("Edit task comment...").fill("修改已有评论");
	await newComment.click();
	await expect.poll(() => savedComments[0]?.commentText).toBe("修改已有评论");
	expect(writes).toHaveLength(3);
});
