import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type {
	RuntimeTaskRetainedCommittedLineChangeHistory,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import type { Page } from "../../web-ui/node_modules/playwright-core";
import type { IsolatedGitTestRepository } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

export async function runTaskRetainedCommittedLineChangeRealBrowserCheck(input: {
	page: Page;
	repository: IsolatedGitTestRepository;
	workspaceId: string;
	taskId: string;
	webUiOrigin: string;
	evidenceOutputDirectory: string;
	ensureWorktree: () => Promise<RuntimeWorktreeEnsureResponse>;
	readHistory: () => Promise<RuntimeTaskRetainedCommittedLineChangeHistory>;
	restartRuntime: () => Promise<void>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}) {
	const { page, repository, workspaceId, taskId, webUiOrigin, evidenceOutputDirectory, observeUntil } = input;
	const ensured = await input.ensureWorktree();
	if (!ensured.path) throw new Error("隔离 worktree 不存在");
	const worktreePath = ensured.path;
	const commit = (text: string, message: string) => {
		writeFileSync(join(worktreePath, "committed-lines.txt"), text);
		repository.runGit(["add", "committed-lines.txt"], { workingDirectoryPath: worktreePath });
		repository.runGit(["commit", "-m", message], { workingDirectoryPath: worktreePath });
	};
	commit("a\nb\nc\nd\n", "浏览器：新增四行");
	commit("a\nc\nd\n", "浏览器：删除一行");
	await observeUntil(async () => (await input.readHistory()).summary.additions === 4, "真实探针捕获提交统计");
	const card = page.locator(`[data-task-id="${taskId}"]`).first();
	const indicator = card.locator("[data-task-retained-committed-line-change-indicator]").getByRole("button");
	await observeUntil(async () => (await indicator.textContent()) === "已提交 +4 −1", "主看板常驻累计");
	await indicator.hover();
	const details = page.getByRole("dialog", { name: "任务已提交增删行明细" });
	await details.getByText("浏览器：删除一行", { exact: true }).waitFor();
	expect(await details.innerText()).toContain("2 次提交");
	await page.screenshot({ path: join(evidenceOutputDirectory, "committed-lines-board-hover.png") });
	await page.keyboard.press("Escape");
	await indicator.focus();
	await indicator.press("ArrowDown");
	expect(await details.evaluate((element) => element === element.ownerDocument.activeElement)).toBe(true);
	await page.keyboard.press("Escape");
	await observeUntil(
		async () => indicator.evaluate((element) => element === element.ownerDocument.activeElement),
		"键盘关闭明细后恢复触发按钮焦点",
	);
	writeFileSync(join(worktreePath, "committed-lines.txt"), "dirty\n".repeat(30));
	await observeUntil(async () => /1 file/.test(await card.innerText()), "dirty 编辑实时更新");
	expect(await indicator.textContent()).toBe("已提交 +4 −1");
	await page.goto(`${webUiOrigin}/${workspaceId}?task=${taskId}`);
	const focusIndicators = page.locator("[data-task-retained-committed-line-change-indicator]");
	await observeUntil(
		async () => (await focusIndicators.allTextContents()).filter((text) => text === "已提交 +4 −1").length >= 2,
		"Focus 卡片与顶栏累计一致",
	);
	await input.restartRuntime();
	await page.reload();
	await observeUntil(async () => (await input.readHistory()).summary.additions === 4, "新 runtime 读取持久统计");
	await observeUntil(
		async () => (await focusIndicators.allTextContents()).includes("已提交 +4 −1"),
		"重启后 WebSocket 恢复累计",
	);
	await page.evaluate(() =>
		sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects"),
	);
	await page.goto(`${webUiOrigin}/${workspaceId}`);
	const crossProjectRow = page.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).first();
	await crossProjectRow.waitFor();
	const crossProjectCounter = crossProjectRow.getByRole("button", { name: "已提交 +4 −1", exact: true });
	await crossProjectCounter.waitFor();
	await crossProjectCounter.click();
	await page
		.getByRole("dialog", { name: "任务已提交增删行明细" })
		.getByText("浏览器：删除一行", { exact: true })
		.waitFor();
	expect(page.url()).not.toContain("?task=");
	await page.screenshot({ path: join(evidenceOutputDirectory, "committed-lines-cross-project.png") });
	const browser = page.context().browser();
	if (!browser) throw new Error("没有隔离 Chromium");
	const mobileContext = await browser.newContext({
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
		storageState: await page.context().storageState(),
	});
	try {
		const mobilePage = await mobileContext.newPage();
		await mobilePage.goto(`${webUiOrigin}/${workspaceId}?task=${taskId}`);
		await mobilePage.getByRole("button", { name: "展开任务卡", exact: true }).tap();
		const mobileCounter = mobilePage.getByRole("button", { name: "已提交 +4 −1", exact: true }).first();
		await mobileCounter.tap();
		const mobileDetails = mobilePage.getByRole("dialog", { name: "任务已提交增删行明细" });
		await mobileDetails.getByText("浏览器：删除一行", { exact: true }).waitFor();
		const bounds = await mobileDetails.boundingBox();
		expect(bounds?.x).toBeGreaterThanOrEqual(0);
		expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(391);
		await mobilePage.screenshot({ path: join(evidenceOutputDirectory, "committed-lines-mobile-tap.png") });
	} finally {
		await mobileContext.close();
	}
	writeFileSync(
		join(evidenceOutputDirectory, "committed-lines-browser-results.json"),
		JSON.stringify(
			{
				checks: [
					"主看板累计",
					"悬浮逐提交明细",
					"dirty 独立更新",
					"Focus 与顶栏",
					"跨 runtime 重启",
					"跨项目点击不导航",
					"手机触屏与边界",
					"键盘聚焦与浮层滚动",
				],
				history: await input.readHistory(),
			},
			null,
			2,
		),
	);
}
