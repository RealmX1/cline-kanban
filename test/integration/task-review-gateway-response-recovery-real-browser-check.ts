import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { Locator, Page } from "../../web-ui/node_modules/playwright-core";

export async function runTaskReviewGatewayResponseRecoveryRealBrowserCheck(input: {
	page: Page;
	webUiOrigin: string;
	workspaceId: string;
	otherWorkspaceId: string;
	focusTaskId: string;
	evidenceOutputDirectory: string;
	createAndStartTask: (workspaceId: string, title: string) => Promise<string>;
	readTaskColumn: (workspaceId: string, taskId: string) => Promise<string | undefined>;
	taskCardActionToolbar: (source: Locator) => Promise<Locator>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
}) {
	const { page, observeUntil } = input;
	const checks: string[] = [];
	for (const surface of ["board", "focus", "cross_project"] as const) {
		const workspaceId = surface === "cross_project" ? input.otherWorkspaceId : input.workspaceId;
		const taskId = await input.createAndStartTask(workspaceId, `Review 故障恢复 ${surface}`);
		await page.evaluate(
			(scope) => {
				sessionStorage.setItem("kanban.selected-board-or-single-project-scope.v1", scope);
				localStorage.setItem("kanban.selected-board-or-single-project-scope.v1", scope);
			},
			surface === "cross_project" ? "board_scope_all_projects" : "single_project_scope",
		);
		await page.goto(
			`${input.webUiOrigin}/${input.workspaceId}${surface === "board" ? "" : `?task=${input.focusTaskId}`}`,
		);
		if (surface === "cross_project") {
			const runningToggle = page
				.getByTestId("cross-project-task-switcher-section-running")
				.locator("button[aria-expanded]");
			if ((await runningToggle.getAttribute("aria-expanded")) === "false") await runningToggle.click();
		}
		const source =
			surface === "cross_project"
				? page.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`).first()
				: page.locator(`[data-task-id="${taskId}"]`).filter({ visible: true }).first();
		await source.waitFor();
		await source.hover();
		const toolbarOwner =
			surface === "cross_project"
				? source.locator("[data-cross-project-task-switcher-hover-floating-card]")
				: source;
		await toolbarOwner.waitFor();
		await toolbarOwner.hover();
		const toolbar = await input.taskCardActionToolbar(toolbarOwner);
		let mutationCount = 0;
		let queryCount = 0;
		const onRequest = (request: { url: () => string }) => {
			if (
				request.url().includes("readTaskCardWithBoardColumn") &&
				decodeURIComponent(request.url()).includes(taskId)
			)
				queryCount++;
		};
		page.on("request", onRequest);
		const routePattern = "**/api/trpc/taskCardAction.moveTaskCardIntoReviewByHandingTurnToUser*";
		await page.route(routePattern, async (route) => {
			mutationCount++;
			if (surface !== "focus") {
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
			}
			if (surface === "cross_project") await route.abort("connectionreset");
			else
				await route.fulfill({
					status: 502,
					contentType: surface === "board" ? "text/html" : "text/plain",
					body: "Bad Gateway",
				});
		});
		try {
			await toolbar.getByRole("button", { name: "Move task to review", exact: true }).click();
			if (surface === "focus") {
				await page.getByText(/移入 Review 的结果未知/u).waitFor();
				expect(await input.readTaskColumn(workspaceId, taskId)).toBe("in_progress");
				await source.hover();
				const recoveredToolbar = await input.taskCardActionToolbar(source);
				expect(
					await recoveredToolbar.getByRole("button", { name: "Move task to review", exact: true }).isEnabled(),
				).toBe(true);
				expect(queryCount).toBe(3);
			} else {
				await observeUntil(
					async () => (await input.readTaskColumn(workspaceId, taskId)) === "review",
					"响应丢失后权威列为 Review",
				);
				await observeUntil(async () => queryCount > 0, "浏览器执行权威卡片回查");
				if (surface === "board")
					await page.locator(`[data-column-id="review"] [data-task-id="${taskId}"]`).waitFor();
				if (surface === "cross_project")
					await page
						.getByTestId("cross-project-task-switcher-section-running")
						.locator(`[data-cross-project-task-switcher-task-id="${taskId}"]`)
						.waitFor({ state: "detached" });
			}
			expect(mutationCount).toBe(1);
			expect(await page.getByText(/Unexpected token|not valid JSON/u).count()).toBe(0);
			await page.screenshot({
				path: join(input.evidenceOutputDirectory, `review-response-recovery-${surface}.png`),
			});
			checks.push(
				`${surface}：移列只发一次，状态回查 ${queryCount} 次，${surface === "focus" ? "明确未知并恢复按钮" : "采用已达 Review 的状态"}`,
			);
		} finally {
			page.off("request", onRequest);
			await page.unroute(routePattern);
		}
	}
	writeFileSync(
		join(input.evidenceOutputDirectory, "review-response-recovery-browser-results.json"),
		JSON.stringify({ checks }, null, 2),
	);
}
