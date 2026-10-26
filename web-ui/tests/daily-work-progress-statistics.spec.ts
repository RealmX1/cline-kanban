import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { RuntimeDailyWorkProgressSummary } from "../src/runtime/types";

function fixture(): RuntimeDailyWorkProgressSummary {
	return {
		revision: 1,
		dateKey: "2026-10-23",
		timeZone: "UTC",
		workspaceId: null,
		projects: [
			{ workspaceId: "project-a", projectName: "cline-kanban" },
			{ workspaceId: "project-b", projectName: "另一项目" },
		],
		metrics: ["entered_validation", "entered_done", "human_prompt"].map((metric, index) => ({
			metric: metric as RuntimeDailyWorkProgressSummary["metrics"][number]["metric"],
			value: [3, 2, 24][index] ?? 0,
			nextMilestoneValue: [5, 3, 25][index] ?? 1,
			historicalDailyRecord: 4,
			sevenDayAverage: 1.8,
			historyStartDate: "2026-10-01",
		})),
		achievements: [],
		celebrationEligibleAchievementIds: [],
		recentAccomplishments: [
			{
				workspaceId: "project-a",
				taskId: "abc12",
				taskTitle: "完成今日进展与里程碑庆祝组件",
				metric: "entered_done",
				occurredAtEpochMs: Date.now(),
			},
		],
		coverage: { status: "complete", warnings: [] },
	};
}
async function openHarness(page: Page) {
	await page.route("**/isolated-daily-work-progress-statistics", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-daily-work-progress-statistics");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/daily-work-progress-statistics-browser-harness.tsx" });
	await expect(page.getByRole("button", { name: "今日进展，全部项目" })).toBeVisible();
}
async function screenshot(page: Page, name: string) {
	const directory = process.env.KANBAN_WORK_PROGRESS_BROWSER_ARTIFACT_DIRECTORY;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await page.screenshot({ path: join(directory, name), fullPage: true });
}
for (const viewport of [
	{ name: "桌面", width: 1280, height: 800 },
	{ name: "手机", width: 375, height: 812 },
]) {
	test(`${viewport.name}：覆盖展开不挤压工作区、庆祝计时、手动保持及焦点连续`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let summary = fixture();
		const claimed = new Set<string>();
		await page.route("**/api/trpc/**", async (route) => {
			const url = new URL(route.request().url());
			const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
			const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
			const responses = procedures.map((procedure, index) => {
				const input = inputs[String(index)] ?? {};
				let data: unknown = {};
				if (procedure === "dailyWorkProgressStatistics.getSummary")
					data = { ...summary, workspaceId: input.workspaceId };
				if (procedure === "dailyWorkProgressStatistics.claimCelebrations") {
					const achievements = summary.achievements.filter(
						(achievement) =>
							input.achievementIds.includes(achievement.achievementId) &&
							!claimed.has(achievement.achievementId),
					);
					for (const achievement of achievements) claimed.add(achievement.achievementId);
					data = { achievements };
				}
				return { result: { data } };
			});
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify(url.searchParams.has("batch") ? responses : responses[0]),
			});
		});
		await openHarness(page);
		const trigger = page.getByRole("button", { name: "今日进展，全部项目" });
		const region = page.getByRole("region", { name: "今日进展详情" });
		await expect(region).toHaveCount(0);
		const input = page.getByRole("textbox", { name: "正在编辑的任务指令" });
		await input.fill("保留这段正在输入的指令");
		await input.focus();
		const workspaceBeforeExpansion = await page.getByRole("main").boundingBox();
		const inputBeforeExpansion = await input.boundingBox();
		summary = {
			...summary,
			revision: 2,
			metrics: summary.metrics.map((metric) =>
				metric.metric === "entered_done" ? { ...metric, value: 5, nextMilestoneValue: 10 } : metric,
			),
			achievements: [
				{
					achievementId: "daily-done-record",
					metric: "entered_done",
					kind: "personal_daily_record",
					value: 5,
					threshold: null,
					comparisonValue: 4,
				},
			],
			celebrationEligibleAchievementIds: ["daily-done-record"],
		};
		await page.evaluate(() => window.dispatchEvent(new CustomEvent("daily-work-progress-browser-test-update")));
		await expect(region).toBeVisible();
		await expect(region).toContainText("刷新单日纪录");
		await expect(input).toBeFocused();
		await expect(input).toHaveValue("保留这段正在输入的指令");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		const navigation = await page.locator("nav").boundingBox();
		const expanded = await region.boundingBox();
		expect(Math.abs((expanded?.y ?? 0) - ((navigation?.y ?? 0) + (navigation?.height ?? 0)))).toBeLessThan(2);
		expect(await page.getByRole("main").boundingBox()).toEqual(workspaceBeforeExpansion);
		expect(await input.boundingBox()).toEqual(inputBeforeExpansion);
		expect(expanded?.y).toBeLessThan((inputBeforeExpansion?.y ?? 0) + (inputBeforeExpansion?.height ?? 0));
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await screenshot(
			page,
			viewport.name === "桌面" ? "desktop-expanded-celebration.png" : "mobile-expanded-celebration.png",
		);
		await page.clock.fastForward(8_100);
		await expect(region).toHaveCount(0);
		await trigger.click();
		await page.clock.fastForward(20_000);
		await expect(region).toBeVisible();
		await page.setViewportSize({ ...viewport, height: 240 });
		const compactWorkspace = await page.getByRole("main").boundingBox();
		const compactOverlay = await region.boundingBox();
		expect(compactOverlay?.height).toBeLessThanOrEqual(compactWorkspace?.height ?? 0);
		expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
		await page.setViewportSize(viewport);
		await region.getByRole("button", { name: "收起今日进展" }).click();
		await expect(region).toHaveCount(0);
		await page.evaluate(() =>
			window.dispatchEvent(new CustomEvent("daily-work-progress-browser-test-update", { detail: { quiet: true } })),
		);
		await expect(region).toHaveCount(0);
		await trigger.click();
		await region.getByRole("combobox", { name: "今日进展统计范围" }).selectOption("project-a");
		await expect(page.getByRole("button", { name: "今日进展，cline-kanban" })).toBeVisible();
		await region.getByRole("button", { name: /完成今日进展与里程碑庆祝组件/ }).click();
		await expect.poll(() => page.evaluate(() => document.body.dataset.openedTask)).toBe("project-a:abc12");
		expect(errors).toEqual([]);
	});
}

test("打包实例：真实 App、HTTP 统计与顶栏展开入口贯通", async ({ page }) => {
	const origin = process.env.KANBAN_WORK_PROGRESS_PACKAGED_RUNTIME_ORIGIN;
	test.skip(!origin, "仅在提供 HOME 隔离的打包实例地址时运行");
	if (!origin) return;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin);
	// 隔离 HOME 是新用户配置，先完成应用自带的首次使用引导。
	const onboarding = page.getByRole("dialog", { name: "Get started" });
	await expect(onboarding).toBeVisible();
	await onboarding.getByRole("button", { name: "Close", exact: true }).click();
	const trigger = page.getByRole("button", { name: "今日进展，全部项目" });
	await expect(trigger).toBeVisible();
	await trigger.click();
	const region = page.getByRole("region", { name: "今日进展详情" });
	await expect(region).toBeVisible();
	await expect(region.getByText("进入 Validation", { exact: true })).toBeVisible();
	await expect(region.getByText("进入 Done", { exact: true })).toBeVisible();
	await expect(region.getByText("人工 prompt", { exact: true })).toBeVisible();
	await expect(region).not.toContainText("暂时无法读取");
	await screenshot(page, "packaged-real-app-expanded.png");
	await region.getByRole("button", { name: "收起今日进展" }).click();
	await expect(region).toHaveCount(0);
	expect(errors).toEqual([]);
});
