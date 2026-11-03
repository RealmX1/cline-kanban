import { expect, test } from "@playwright/test";

for (const compact of [false, true]) {
	for (const mobile of [false, true]) {
		test.describe(`${mobile ? "手机" : "桌面"} ${compact ? "紧凑头部" : "完整工具栏"}重启进度`, () => {
			test.use({ viewport: { width: mobile ? 390 : 1280, height: 900 }, hasTouch: mobile });
			for (const failsFirstAttempt of [false, true]) {
				test(`${failsFirstAttempt ? "失败后可重试" : "成功后清理状态"}，长等待不重复提交`, async ({ page }) => {
					let requestCount = 0;
					let releaseResponse: (() => void) | undefined;
					const responseReady = new Promise<void>((resolve) => {
						releaseResponse = resolve;
					});
					const pageErrors: string[] = [];
					page.on("pageerror", (error) => pageErrors.push(error.message));
					await page.route("**/api/**", async (route) => {
						if (!route.request().url().includes("runtime.refreshTaskTerminal")) return await route.abort();
						requestCount += 1;
						const shouldFail = failsFirstAttempt && requestCount === 1;
						await responseReady;
						await route.fulfill({
							json: [
								{
									result: {
										data: shouldFail
											? { ok: false, error: "隔离模拟：会话宿主通信失败" }
											: { ok: true, summary: null, mode: "resume" },
									},
								},
							],
						});
					});
					await page.routeWebSocket("**/*", () => {});
					await page.route("**/isolated-restart-progress*", (route) =>
						route.fulfill({
							contentType: "text/html",
							body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
						}),
					);
					await page.goto(`/isolated-restart-progress${compact ? "?compact" : ""}`);
					await page.addScriptTag({
						type: "module",
						content:
							"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
					});
					await page.addScriptTag({
						type: "module",
						url: "/tests/agent-session-restart-arguments-browser-harness.tsx",
					});
					await page.clock.install();
					const restart = page.getByRole("button", { name: "Restart agent session", exact: true });
					await restart.click();
					await expect(page.getByRole("status")).toHaveText("正在重启会话，等待运行时响应…");
					await expect(restart).toBeDisabled();
					await page.clock.fastForward(16_000);
					await expect(page.getByRole("status")).toContainText("已等待 16 秒");
					await restart.evaluate((button: HTMLButtonElement) => button.click());
					expect(requestCount).toBe(1);
					await page.screenshot({ path: test.info().outputPath("restart-response-wait.png") });
					releaseResponse?.();
					await expect(page.getByRole("status")).toHaveCount(0);
					await expect(restart).toBeEnabled();
					if (failsFirstAttempt) {
						await expect(page.getByRole("alert")).toContainText("隔离模拟：会话宿主通信失败");
						await restart.click();
						await expect.poll(() => requestCount).toBe(2);
						await expect(page.getByRole("alert")).toHaveCount(0);
						await expect(restart).toBeEnabled();
					}
					expect(pageErrors).toEqual([]);
				});
			}
		});
	}
}
