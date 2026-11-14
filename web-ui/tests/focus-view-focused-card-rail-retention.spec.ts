import { expect, test } from "@playwright/test";
import {
	openIsolatedFocusViewCompactGroupHeadersBrowserHarness,
	setFocusViewTaskListScrollFractionAndWaitForLayout,
} from "./focus-view-group-header-browser-test-helpers";

const focusedCardSelector = '[data-task-id="in_progress-0"]';
const focusedCopySelector = '[data-testid="stage-header-rail-focused-card"]';
const topRailSelector = '.kb-stage-header-rail[data-edge="top"]';

// 直接使用真实 ColumnContextPanel，取代手抄分类器与固定单行高度的合成页面。
test("焦点卡大幅跳过视口时切换上下副本，回到视口后恢复唯一真实卡", async ({ page }) => {
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "current");
	const focusedCard = page.locator(focusedCardSelector);
	await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 0);
	await expect(page.locator(`.kb-stage-header-rail[data-edge="bottom"] ${focusedCopySelector}`)).toHaveCount(1);
	await expect(focusedCard).toHaveCount(1);
	await expect(focusedCard).toHaveCSS("visibility", "hidden");
	await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 1);
	await expect(page.locator(`${topRailSelector} ${focusedCopySelector}`)).toHaveCount(1);
	await expect(focusedCard).toHaveCount(1);
	await expect(focusedCard).toHaveCSS("visibility", "hidden");
	const ids = await page
		.locator(`${topRailSelector} [data-focus-view-group-header-rail-entry]`)
		.evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-focus-view-group-header-rail-entry")));
	expect(ids.slice(0, 2)).toEqual(["backlog", "in_progress"]);
	await focusedCard.evaluate((card) => card.scrollIntoView({ block: "center", inline: "nearest" }));
	await expect(page.locator(focusedCopySelector)).toHaveCount(0);
	await expect(focusedCard).toHaveCSS("visibility", "visible");
});

test("在可见分组折叠焦点阶段，唯一真实卡继续留存", async ({ page }) => {
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "current");
	const focusedCard = page.locator(focusedCardSelector);
	await focusedCard.evaluate((card) => card.scrollIntoView({ block: "center", inline: "nearest" }));
	await expect(page.locator(focusedCopySelector)).toHaveCount(0);
	const section = page.locator('[data-stage-section-id="in_progress"]');
	await section.getByRole("button", { name: "收起 In Progress", exact: true }).click();
	await expect(section.getByRole("button", { name: "展开 In Progress", exact: true })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(focusedCard).toHaveCount(1);
	await expect(focusedCard).toHaveCSS("visibility", "visible");
	await expect(section.locator('[data-task-id="in_progress-1"]')).toHaveCount(0);
});

test("从顶轨道折叠已滚过的焦点阶段，副本与真实卡身份继续唯一", async ({ page }) => {
	await openIsolatedFocusViewCompactGroupHeadersBrowserHarness(page, "current");
	await setFocusViewTaskListScrollFractionAndWaitForLayout(page, 1);
	await page.locator(topRailSelector).getByRole("button", { name: "收起 In Progress", exact: true }).click();
	await expect(
		page.locator(topRailSelector).getByRole("button", { name: "展开 In Progress", exact: true }),
	).toHaveAttribute("aria-expanded", "false");
	await expect(page.locator(focusedCopySelector)).toHaveCount(1);
	await expect(page.locator(focusedCardSelector)).toHaveCount(1);
	await expect(page.locator(focusedCardSelector)).toHaveCSS("visibility", "hidden");
});
