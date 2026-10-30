import { expect, test } from "@playwright/test";

for (const touch of [false, true]) {
	test.describe(touch ? "触屏重启" : "桌面重启", () => {
		test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 900 } });
		for (const compact of [false, true]) {
			test(`${compact ? "紧凑头部" : "完整工具栏"}保留快捷操作，参数只发一次且下次不复用`, async ({ page }) => {
				const requests: Record<string, unknown>[] = [];
				const pageErrors: string[] = [];
				page.on("pageerror", (error) => pageErrors.push(error.message));
				await page.route("**/api/**", async (route) => {
					if (!route.request().url().includes("runtime.refreshTaskTerminal")) return await route.abort();
					const input = route.request().postDataJSON() as Record<string, Record<string, unknown>>;
					requests.push(input["0"]!);
					await route.fulfill({ json: [{ result: { data: { ok: true, summary: null, mode: "resume" } } }] });
				});
				await page.routeWebSocket("**/*", () => {});
				await page.route("**/isolated-restart-arguments*", (route) =>
					route.fulfill({
						contentType: "text/html",
						body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
					}),
				);
				await page.goto(`/isolated-restart-arguments${compact ? "?compact" : ""}`);
				await page.addScriptTag({
					type: "module",
					content:
						"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
				});
				await page.addScriptTag({
					type: "module",
					url: "/tests/agent-session-restart-arguments-browser-harness.tsx",
				});
				const quickRestart = page.getByRole("button", { name: "Restart agent session", exact: true });
				const openAdditionalMenu = async () => {
					if (touch) await page.getByRole("button", { name: "展开快捷重启附加操作", exact: true }).tap();
					else await quickRestart.hover();
					await expect(page.getByRole("menuitem")).toHaveCount(1);
					await expect(page.getByRole("menu")).toHaveAttribute("data-side", "bottom");
				};
				await openAdditionalMenu();
				await page.getByRole("menuitem", { name: "带参数重启…", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await expect(dialog).toContainText("带参数重启 Codex");
				await page.getByRole("textbox", { name: "额外启动参数", exact: true }).fill('--cd "未闭合');
				await page.getByRole("button", { name: "重启会话", exact: true }).click();
				await expect(page.getByRole("alert")).toContainText("双引号未闭合");
				expect(requests).toHaveLength(0);
				await page.getByRole("button", { name: "取消", exact: true }).click();
				expect(requests).toHaveLength(0);
				await openAdditionalMenu();
				await page.getByRole("menuitem", { name: "带参数重启…", exact: true }).click();
				await expect(page.getByRole("textbox", { name: "额外启动参数", exact: true })).toHaveValue("");
				await page.getByRole("textbox", { name: "额外启动参数", exact: true }).fill('--cd "/explicit path" ""');
				await dialog.evaluate((element) =>
					Promise.all(element.getAnimations().map((animation) => animation.finished)),
				);
				await page.screenshot({
					path: test
						.info()
						.outputPath(
							`restart-arguments-${touch ? "touch" : "desktop"}-${compact ? "compact" : "toolbar"}.png`,
						),
				});
				await page.getByRole("textbox", { name: "额外启动参数", exact: true }).press("Meta+Enter");
				await expect(dialog).toHaveCount(0);
				expect(requests).toHaveLength(1);
				expect(requests[0]!.additionalAgentStartupArgumentsForThisRestart).toEqual(["--cd", "/explicit path", ""]);
				await quickRestart.click();
				await expect.poll(() => requests.length).toBe(2);
				expect(requests[1]).not.toHaveProperty("additionalAgentStartupArgumentsForThisRestart");
				await page.getByRole("button", { name: "切换活跃回合", exact: true }).click();
				await openAdditionalMenu();
				await page.getByRole("menuitem", { name: "带参数重启…", exact: true }).click();
				await expect(dialog).toContainText("当前回合仍在运行");
				await expect(page.getByRole("alertdialog")).toHaveCount(0);
				await page.getByRole("button", { name: "取消", exact: true }).click();
				await quickRestart.focus();
				await page.keyboard.press("ArrowDown");
				await expect(page.getByRole("menuitem", { name: "带参数重启…", exact: true })).toBeFocused();
				await page.keyboard.press("Escape");
				await expect(page.getByRole("menu")).toHaveCount(0);
				expect(pageErrors).toEqual([]);
			});
		}
	});
}
