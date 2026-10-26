import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import type { Page } from "../../web-ui/node_modules/playwright-core";

/** 复用现有隔离 HOME、runtime、CLI 与 Chromium 宿主，不触碰在线实例。 */
export async function runTaskShelvingRealBrowserCheck(input: {
	page: Page;
	webUiOrigin: string;
	workspaceId: string;
	otherWorkspaceId: string;
	focusTaskId: string;
	backlogTaskId: string;
	additionalFocusNavigationTaskId: string;
	otherTaskId: string;
	evidenceOutputDirectory: string;
	readBoard: (workspaceId: string) => Promise<RuntimeBoardData>;
	runCli: (workspaceId: string, arguments_: string[]) => Promise<unknown>;
	queryAllProjectsShelved: () => Promise<unknown>;
	restartRuntime: () => Promise<void>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}): Promise<void> {
	const { page, workspaceId, otherWorkspaceId, focusTaskId, backlogTaskId, otherTaskId, observeUntil } = input;
	const checks: string[] = [];
	const readTask = async (taskId: string, targetWorkspaceId = workspaceId) => {
		const board = await input.readBoard(targetWorkspaceId);
		const column = board.columns.find((candidate) => candidate.cards.some((card) => card.id === taskId));
		return { card: column?.cards.find((card) => card.id === taskId), stage: column?.id };
	};
	const card = (taskId: string) => page.locator(`[data-task-id="${taskId}"]`);
	await card(focusTaskId).hover();
	await card(focusTaskId).getByRole("button", { name: "搁置任务", exact: true }).click();
	await observeUntil(
		async () => (await readTask(focusTaskId)).card?.taskShelvingState?.isShelved === true,
		"按钮搁置持久化",
	);
	expect((await readTask(focusTaskId)).stage).toBe("review");
	await card(focusTaskId).waitFor({ state: "detached" });
	expect(await page.locator('[data-column-id="shelved"]').getAttribute("data-kanban-board-column-collapsed")).toBe(
		"true",
	);
	await page.getByRole("button", { name: "Expand Shelved column", exact: true }).click();
	await card(focusTaskId).waitFor();
	expect(await card(focusTaskId).count()).toBe(1);
	expect(await card(focusTaskId).textContent()).toContain("Review");
	expect(await card(focusTaskId).getByRole("button", { name: "Move task to validation", exact: true }).count()).toBe(
		0,
	);
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "shelved-single-project.png") });
	checks.push("搁置保留真实 Stage；单项目默认折叠；展开后仅有一个真实卡片");

	await card(focusTaskId).focus();
	await page.keyboard.press("Space");
	for (let index = 0; index < 3; index += 1) await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Space");
	await observeUntil(
		async () => (await readTask(focusTaskId)).card?.taskShelvingState?.isShelved === false,
		"拖回原 Stage 取消搁置",
	);
	expect((await readTask(focusTaskId)).stage).toBe("review");
	await card(focusTaskId).focus();
	await page.keyboard.press("Space");
	for (let index = 0; index < 3; index += 1) await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Space");
	await observeUntil(
		async () => (await readTask(focusTaskId)).card?.taskShelvingState?.isShelved === true,
		"拖入 Shelved",
	);
	checks.push("真实键盘拖放往返 Shelved，原 Stage 不变");

	await input.runCli(workspaceId, ["task", "shelve", "--task-id", backlogTaskId]);
	await input.runCli(otherWorkspaceId, ["task", "shelve", "--task-id", otherTaskId]);
	const repeated = await input.runCli(otherWorkspaceId, ["task", "shelve", "--task-id", otherTaskId]);
	expect(repeated).toMatchObject({
		ok: true,
		boardWasSaved: false,
		task: { column: "review", taskShelvingState: { isShelved: true } },
	});
	await input.runCli(workspaceId, ["task", "shelve", "--task-id", input.additionalFocusNavigationTaskId]);
	expect((await readTask(backlogTaskId)).stage).toBe("backlog");
	const allProjectsShelved = await input.queryAllProjectsShelved();
	expect(allProjectsShelved).toMatchObject({
		ok: true,
		groups: [
			{
				group: "shelved",
				tasks: expect.arrayContaining([
					expect.objectContaining({ taskId: otherTaskId, workspaceId: otherWorkspaceId }),
				]),
			},
		],
	});
	checks.push("真实 CLI 搁置、幂等、解除搁置及全项目分组查询，Backlog 保留原 Stage");

	await page.getByTestId("toggle-board-scope-all-projects-button").click();
	const shelved = page.getByTestId("cross-project-task-switcher-section-shelved");
	await shelved.getByRole("button", { name: "Expand Shelved", exact: true }).waitFor();
	expect(await shelved.locator("[data-cross-project-task-switcher-task-id]").count()).toBe(0);
	await shelved.getByRole("button", { name: "Expand Shelved", exact: true }).click();
	for (const taskId of [focusTaskId, otherTaskId]) {
		await shelved.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).waitFor();
		expect(await page.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).count()).toBe(1);
		expect(await shelved.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).textContent()).toContain(
			"Review",
		);
	}
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "shelved-all-projects.png") });
	checks.push("All projects 与切换面板互斥归属，跨项目任务各展示一次");
	await page.goto(`${input.webUiOrigin}/${workspaceId}?task=${focusTaskId}`);
	await page.getByTestId("cross-project-recently-active-task-switcher-panel").waitFor();
	await shelved.locator(`[data-cross-project-task-switcher-task-id="${focusTaskId}"]`).waitFor();
	await page.evaluate(() => {
		localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "single_project_scope");
		sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "single_project_scope");
	});
	await page.goto(`${input.webUiOrigin}/${workspaceId}?task=${focusTaskId}`);
	const shelfStage = page.locator('[data-stage-section-id="shelved"]');
	await shelfStage.waitFor();
	expect(await shelfStage.locator("button").first().getAttribute("aria-expanded")).toBe("true");
	expect(await card(focusTaskId).count()).toBe(1);
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "shelved-focus-view.png") });
	await page.keyboard.press("Alt+ArrowDown");
	await observeUntil(
		async () => page.url().includes(`task=${input.additionalFocusNavigationTaskId}`),
		"Shelved 跨原 Stage 键盘导航",
	);
	await page.keyboard.press("Alt+ArrowUp");
	await observeUntil(async () => page.url().includes(`task=${focusTaskId}`), "Shelved 键盘导航返回");
	await page.keyboard.press("Meta+k");
	const searchInput = page.getByRole("textbox", { name: "Search tasks", exact: true });
	await searchInput.fill(backlogTaskId);
	const backlogTitle = (await readTask(backlogTaskId)).card?.title;
	if (!backlogTitle) throw new Error("缺少搜索任务标题");
	await page.getByRole("dialog").getByText(backlogTitle, { exact: true }).waitFor();
	await searchInput.press("Enter");
	await observeUntil(async () => page.url().includes(`task=${backlogTaskId}`), "搜索搁置 Backlog 后聚焦 Shelved");
	expect((await readTask(backlogTaskId)).card?.taskShelvingState?.isShelved).toBe(true);
	await input.runCli(workspaceId, ["task", "unshelve", "--task-id", backlogTaskId]);
	expect((await readTask(backlogTaskId)).stage).toBe("backlog");
	await page.goto(`${input.webUiOrigin}/${workspaceId}?task=${focusTaskId}`);
	await shelfStage.waitFor();
	checks.push("搜索搁置 Backlog 可以定位并展开 Shelved，不解除搁置；CLI 解除后保留 Backlog");
	await page.setViewportSize({ width: 1600, height: 450 });
	await page.locator(".kb-detail-task-list-scroll").evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.getByRole("button", { name: "Collapse Shelved", exact: true }).click();
	expect(await shelfStage.locator("button").first().getAttribute("aria-expanded")).toBe("false");
	await page.getByRole("button", { name: "Expand Shelved", exact: true }).click();
	expect(await shelfStage.locator("button").first().getAttribute("aria-expanded")).toBe("true");
	await page.setViewportSize({ width: 1600, height: 1000 });
	checks.push("Focus View 按 Shelved 定位展开，键盘按展示组导航，固定头与行内头共享折叠状态");

	await input.restartRuntime();
	await page.reload();
	await shelfStage.waitFor();
	expect((await readTask(focusTaskId)).card?.taskShelvingState?.isShelved).toBe(true);
	expect((await readTask(otherTaskId, otherWorkspaceId)).card?.taskShelvingState?.isShelved).toBe(true);
	expect(await shelfStage.locator("button").first().getAttribute("aria-expanded")).toBe("true");
	await input.runCli(workspaceId, ["task", "unshelve", "--task-id", focusTaskId]);
	await observeUntil(
		async () => (await readTask(focusTaskId)).card?.taskShelvingState?.isShelved === false,
		"重启后取消搁置",
	);
	expect((await readTask(focusTaskId)).stage).toBe("review");
	checks.push("runtime 重启与页面刷新恢复持久状态及展开偏好，解除搁置恢复原 Stage");
	writeFileSync(
		join(input.evidenceOutputDirectory, "task-shelving-browser-verification.json"),
		JSON.stringify({ checks }, null, 2),
	);
}
