import { expect, test } from "@playwright/test";

for (const width of [1440, 360]) {
	test(`${width}px 同名项目按路径区分、搜索并保留选中结果`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/*", () => {});
		await page.route("**/isolated-project-path-disambiguation", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto("/isolated-project-path-disambiguation");
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({ type: "module", url: "/tests/task-project-path-disambiguation-browser-harness.tsx" });
		const field = page.getByTestId("task-creation-target-project-field");
		await expect(field).toContainText("/Users/bominzhang/Documents/GitHub/cline-kanban");
		await field.getByRole("button").click();
		await expect(page.getByRole("button", { name: /515ad/ })).toBeVisible();
		await page.getByPlaceholder("Search projects...").fill("515ad");
		await expect(page.getByRole("button", { name: /Documents/ })).toHaveCount(1);
		await page.getByRole("button", { name: /515ad/ }).click();
		await expect(field.getByRole("button")).toContainText("/Users/bominzhang/.cline/worktrees/515ad/cline-kanban");
		const bounds = await field.evaluate((element) => ({
			left: element.getBoundingClientRect().left,
			right: element.getBoundingClientRect().right,
		}));
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(width);
		expect(errors).toEqual([]);
	});
}
