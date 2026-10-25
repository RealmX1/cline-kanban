import { expect, test } from "@playwright/test";

for (const width of [1280, 390]) {
	test(`${width}px：后台等待三种宿主均保持运行，纯等待不重置活动，真实结果才更新`, async ({ page }) => {
		await page.setViewportSize({ width, height: 1200 });
		await page.clock.install({ time: new Date("2026-10-24T12:00:00.000Z") });
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/*", () => {});
		await page.route("**/isolated-codex-background-wait", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto("/isolated-codex-background-wait");
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({ type: "module", url: "/tests/codex-background-terminal-wait-browser-harness.tsx" });
		await page.getByRole("button", { name: "展开任务卡", exact: true }).click();
		for (const hostName of ["board", "focus", "all-projects"]) {
			const host = page.locator(`[data-background-wait-host="${hostName}"]`);
			await expect(host.locator("[data-last-conversation-progress-pill]")).toHaveText("10m");
			await expect(host.locator("[data-agent-response-generation-stopped-pill]")).toHaveCount(0);
		}
		await expect(page.locator('[data-cross-project-task-switcher-section="running"]')).toHaveCount(1);
		await page.clock.fastForward(10 * 60_000);
		await page.getByRole("button", { name: "仅推进等待时间", exact: true }).click();
		for (const hostName of ["board", "focus", "all-projects"])
			await expect(
				page.locator(`[data-background-wait-host="${hostName}"] [data-last-conversation-progress-pill]`),
			).toHaveText("20m");
		await page.getByRole("button", { name: "收到真实工具结果", exact: true }).click();
		for (const hostName of ["board", "focus", "all-projects"]) {
			const host = page.locator(`[data-background-wait-host="${hostName}"]`);
			await expect(host.locator("[data-last-conversation-progress-pill]")).toHaveText("now");
			await expect(host.locator("[data-agent-response-generation-stopped-pill]")).toHaveCount(0);
		}
		expect(pageErrors).toEqual([]);
		await page.screenshot({ path: test.info().outputPath(`background-wait-${width}.png`), fullPage: true });
	});
}
