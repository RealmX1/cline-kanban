import { expect, test } from "@playwright/test";

for (const cardWidth of [180, 280, 420, 640]) {
	test(`${cardWidth}px 卡片：统计完整显示、零值隐藏且按组对齐`, async ({ page }) => {
		await page.setViewportSize({ width: cardWidth <= 280 ? 360 : 1400, height: 1100 });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/api/**", (route) => route.abort());
		await page.routeWebSocket("**/*", () => {});
		await page.route("**/isolated-git-metadata-alignment?*", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
			}),
		);
		await page.goto(`/isolated-git-metadata-alignment?cardWidth=${cardWidth}`);
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({
			type: "module",
			url: "/tests/task-card-git-metadata-group-alignment-browser-harness.tsx",
		});
		for (const hostName of ["standard", "compact", "expanded", "cross-project"]) {
			const host = page.locator(`[data-alignment-host="${hostName}"]`);
			for (const caseId of ["both", "dirty", "committed", "zero", "unavailable", "large"]) {
				const fixture = host.locator(`[data-alignment-case="${caseId}"]`);
				const group = fixture.locator("[data-task-card-line-change-statistics-group]");
				if (caseId === "zero") {
					await expect(group).toHaveCount(0);
					continue;
				}
				await expect(group).toBeVisible();
				const text = (await group.innerText()).replace(/\s+/g, " ");
				if (["both", "dirty"].includes(caseId)) expect(text).toContain("2 files");
				if (["both", "committed"].includes(caseId)) expect(text.replace(/\s+/g, " ")).toContain("已提交 +10 −10");
				if (caseId === "both") expect(text.indexOf("2 files")).toBeLessThan(text.indexOf("已提交"));
				if (caseId === "dirty") expect(text).not.toContain("已提交");
				if (caseId === "unavailable") expect(text).toContain("已提交 —");
				if (caseId === "large") {
					expect(text).toContain("123456789");
					expect(text).toContain("987654321");
				}
				const overflowing = await fixture.evaluate((element) => {
					const boundary = element.getBoundingClientRect();
					return Array.from(
						element.querySelectorAll(
							"[data-task-card-base-branch-relation-group], [data-task-card-line-change-statistics-group], [data-task-card-line-change-statistics-group] span, [data-task-card-line-change-statistics-group] button",
						),
					)
						.filter((child) => {
							const box = child.getBoundingClientRect();
							return box.left < boundary.left - 1 || box.right > boundary.right + 1;
						})
						.map((child) => child.textContent);
				});
				expect(overflowing, `${hostName}/${caseId} 超出卡片边界`).toEqual([]);
			}
			if (cardWidth === 640) {
				const starts = await host
					.locator(
						'[data-alignment-case="both"] [data-task-card-line-change-statistics-group], [data-alignment-case="dirty"] [data-task-card-line-change-statistics-group], [data-alignment-case="committed"] [data-task-card-line-change-statistics-group]',
					)
					.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().x));
				expect(
					Math.max(...starts) - Math.min(...starts),
					`${hostName} 统计组起点 ${starts.join(", ")}`,
				).toBeLessThan(1);
			}
			const committed = host.locator(
				'[data-alignment-case="committed"] [data-task-retained-committed-line-change-indicator] button',
			);
			await committed.click();
			await expect(page.getByRole("dialog", { name: "任务已提交增删行明细" })).toBeVisible();
			await page.keyboard.press("Escape");
			await page.mouse.move(0, 0);
			await expect(page.getByRole("dialog", { name: "任务已提交增删行明细" })).toHaveCount(0);
		}
		await page.getByRole("heading", { name: "标准卡片", exact: true }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await page.screenshot({ path: test.info().outputPath(`metadata-groups-${cardWidth}.png`), fullPage: true });
		expect(errors).toEqual([]);
	});
}
