import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import type { Page } from "../../web-ui/node_modules/playwright-core";

export async function runTaskSessionConnectionRetryGroupingRealBrowserCheck(input: {
	page: Page;
	webUiOrigin: string;
	workspaceId: string;
	taskId: string;
	evidenceOutputDirectory: string;
	readSession: () => Promise<RuntimeTaskSessionSummary | undefined>;
	activateErrorOutput: () => void;
	stopErrorOutput: () => Promise<void>;
	recordTrustedRecovery: () => Promise<void>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}) {
	const { page, observeUntil, taskId } = input;
	const checks: string[] = [];
	await observeUntil(async () => (await input.readSession())?.liveness === "live", "普通 Python 错误不进入网络重试");
	await page.goto(`${input.webUiOrigin}/${input.workspaceId}`);
	await page.evaluate(() => {
		localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
		sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", "board_scope_all_projects");
	});
	await page.reload();
	const running = () => page.getByTestId("cross-project-task-switcher-section-running");
	const row = () => running().locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`);
	const expandRunningInStackedPresentation = async () => {
		await running().waitFor();
		const toggle = running().locator('button[aria-expanded="false"]').first();
		if (await toggle.count()) await toggle.click();
	};
	await expandRunningInStackedPresentation();
	await row().waitFor();
	expect(await row().getByText("重连中", { exact: true }).count()).toBe(0);
	checks.push("真实 PTY 的 Python 错误名不触发网络重试");
	input.activateErrorOutput();
	await observeUntil(async () => (await input.readSession())?.liveness === "retrying", "真实输出反应进入 retrying");
	await row().getByText("重连中", { exact: true }).waitFor();
	expect(
		await page
			.getByTestId("cross-project-task-switcher-section-remaining")
			.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`)
			.count(),
	).toBe(0);
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "retrying-all-projects-home.png") });
	checks.push("runtime 广播使重连任务留在首页 Running，Recent 无副本");
	await row()
		.getByRole("button", { name: /^打开任务：/ })
		.click();
	await observeUntil(async () => page.url().includes(`?task=${taskId}`), "进入真实 Focus View");
	await expandRunningInStackedPresentation();
	await row().getByText("重连中", { exact: true }).waitFor();
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "retrying-focus-view.png") });
	checks.push("Focus View 复用同一分组与重连说明");
	await page.goto(`${input.webUiOrigin}/${input.workspaceId}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await expandRunningInStackedPresentation();
	await row().getByText("重连中", { exact: true }).scrollIntoViewIfNeeded();
	const bounds = await row().boundingBox();
	const labelBounds = await row().getByText("重连中", { exact: true }).boundingBox();
	expect(bounds).not.toBeNull();
	expect(labelBounds).not.toBeNull();
	expect((labelBounds?.x ?? 0) + (labelBounds?.width ?? 0)).toBeLessThanOrEqual(
		(bounds?.x ?? 0) + (bounds?.width ?? 0),
	);
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "retrying-mobile-home.png") });
	checks.push("手机宽度下重连说明保留在行内");
	await input.stopErrorOutput();
	await input.recordTrustedRecovery();
	await observeUntil(async () => {
		const summary = await input.readSession();
		return summary?.liveness === "live" && summary.connectionRetry == null;
	}, "可信 hook 清理真实重试状态");
	await observeUntil(
		async () => (await row().count()) === 1 && (await row().getByText("重连中", { exact: true }).count()) === 0,
		"恢复后保留 Running 行并移除重连说明",
	);
	checks.push("可信恢复经服务端广播清理重试，任务继续留在 Running");
	writeFileSync(
		join(input.evidenceOutputDirectory, "connection-retry-browser-results.json"),
		JSON.stringify({ checks }, null, 2),
	);
}
