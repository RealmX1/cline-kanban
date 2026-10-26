import { join } from "node:path";
import { expect, test } from "@playwright/test";

for (const width of [390, 1280])
	test(`API 主备设置在 ${width}px 下保存、取消并重新读取`, async ({ page }) => {
		await page.setViewportSize({ width, height: 850 });
		let saved = { preferredModelProviderId: "minimax", fallbackModelProviderId: "deepseek" as string | null };
		let writes = 0;
		await page.route("**/api/trpc/**", async (route) => {
			const url = new URL(route.request().url());
			const names = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
			const input = route.request().postDataJSON() ?? JSON.parse(url.searchParams.get("input") ?? "{}");
			const replies = names.map((name, index) => {
				if (name === "support.setTaskAssistanceModelProviderRoutingSettings") {
					saved = input[index];
					writes++;
				}
				return { result: { data: saved } };
			});
			await route.fulfill({ json: url.searchParams.has("batch") ? replies : replies[0] });
		});
		await page.route("**/isolated-task-assistance-settings", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto("/isolated-task-assistance-settings");
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({
			type: "module",
			url: "/tests/task-assistance-model-provider-routing-settings-browser-harness.tsx",
		});
		const primary = page.getByRole("combobox", { name: "任务分析首选 provider" });
		const fallback = page.getByRole("combobox", { name: "任务分析备用 provider" });
		await expect(primary).toHaveValue("minimax");
		await expect(fallback).toHaveValue("deepseek");
		await primary.selectOption("deepseek");
		await fallback.selectOption("");
		expect(writes).toBe(0);
		await page.getByRole("button", { name: "取消修改" }).click();
		await page.getByRole("button", { name: "打开分析设置" }).click();
		await expect(primary).toHaveValue("minimax");
		await expect(fallback).toHaveValue("deepseek");
		await primary.selectOption("deepseek");
		await fallback.selectOption("");
		await page.getByRole("button", { name: "保存设置" }).click();
		await expect.poll(() => writes).toBe(1);
		await page.getByRole("button", { name: "打开分析设置" }).click();
		await expect(primary).toHaveValue("deepseek");
		await expect(fallback).toHaveValue("");
		await expect(page.getByText("模型：configured-model · 凭据已配置")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		const directory = process.env.KANBAN_TASK_ASSISTANCE_BROWSER_EVIDENCE_DIRECTORY;
		if (directory)
			await page.screenshot({ path: join(directory, `api-routing-settings-${width}px.png`), fullPage: true });
	});
