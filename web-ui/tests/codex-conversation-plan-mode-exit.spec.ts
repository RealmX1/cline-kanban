import { expect, test } from "@playwright/test";

for (const mobile of [false, true]) {
	for (const focus of [false, true]) {
		test(`${mobile ? "手机" : "桌面"}${focus ? " Focus View" : "完整工具栏"}可退出计划模式，等待中不重复提交`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: mobile ? 390 : 1280, height: 900 });
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			let requestCount = 0;
			let requestBody = "";
			let releaseResponse: () => void = () => {};
			const responseReady = new Promise<void>((resolve) => {
				releaseResponse = resolve;
			});
			await page.route("**/api/**", async (route) => {
				if (!route.request().url().includes("runtime.exitCodexTaskConversationSessionPlanMode"))
					return await route.abort();
				requestCount += 1;
				requestBody = route.request().postData() ?? "";
				expect(route.request().headers()["x-kanban-workspace-id"]).toBe("isolated-workspace");
				await responseReady;
				await route.fulfill({ json: [{ result: { data: { status: "exited" } } }] });
			});
			await page.routeWebSocket("**/*", () => {});
			await page.route("**/isolated-codex-plan-mode-exit*", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
				}),
			);
			await page.goto(`/isolated-codex-plan-mode-exit${focus ? "?focus" : ""}`);
			await page.addScriptTag({
				type: "module",
				content:
					"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
			});
			await page.addScriptTag({
				type: "module",
				url: "/tests/codex-conversation-plan-mode-exit-browser-harness.tsx",
			});
			await page.getByRole("button", { name: "终端工具与更多信息", exact: true }).click();
			const exit = page.getByRole("button", { name: "退出计划模式", exact: true });
			await expect(exit).toBeVisible();
			await exit.click();
			const pending = page.getByRole("button", { name: "正在退出计划模式…", exact: true });
			await expect(pending).toBeDisabled();
			await pending.evaluate((button: HTMLButtonElement) => button.click());
			await expect.poll(() => requestCount).toBe(1);
			expect(requestBody).toContain("isolated-collaborator");
			expect(requestBody).toContain("isolated-native-session");
			await page.screenshot({ path: test.info().outputPath("exiting-plan-mode.png") });
			releaseResponse();
			await expect(page.getByText("已退出计划模式", { exact: true })).toBeVisible();
			await expect(exit).toBeEnabled();
			expect(pageErrors).toEqual([]);
		});
	}
}
