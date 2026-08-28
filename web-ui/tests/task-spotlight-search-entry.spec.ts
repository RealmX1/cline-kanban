import { expect, test } from "@playwright/test";

const SPOTLIGHT_TRIGGER_TEST_ID = "open-task-spotlight-search-button";
const SPOTLIGHT_DIALOG_SELECTOR = "[data-task-spotlight-search-dialog]";
// LocalStorageKey.OnboardingDialogShown。全新浏览器 profile 一定会弹「Get started」首启弹层，
// 它是更上层的 modal，会把 Escape 吃掉——不预置这个标记，下面的关闭断言测的就不是 Spotlight。
const ONBOARDING_DIALOG_SHOWN_STORAGE_KEY = "kanban.onboarding.dialog.shown";

test.beforeEach(async ({ page }) => {
	await page.addInitScript((storageKey: string) => {
		window.localStorage.setItem(storageKey, "true");
	}, ONBOARDING_DIALOG_SHOWN_STORAGE_KEY);
});

test.describe("desktop task spotlight search entry", () => {
	test("top bar trigger opens the same dialog as the keyboard shortcut", async ({ page }) => {
		await page.goto("/");

		const trigger = page.getByTestId(SPOTLIGHT_TRIGGER_TEST_ID);
		await expect(trigger).toBeVisible();
		// 假搜索框形态：占位文字 + 常驻键帽徽标，两者合起来才是这次要补的可发现性。
		await expect(trigger).toContainText("Search tasks");

		const dialog = page.locator(SPOTLIGHT_DIALOG_SELECTOR);
		await trigger.click();
		await expect(dialog).toBeVisible();
		await expect(page.getByPlaceholder("Search tasks")).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		// 按钮与热键必须接同一个 controller——否则两条入口会各自持有一份状态。
		await page.keyboard.press("ControlOrMeta+k");
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});
});

test.describe("desktop task spotlight browse, sort, filter and row fields", () => {
	// 这一组全部走真实浏览器 + 真实 runtime：排序/过滤/字段开关三件事各自的 jsdom 单测证明的是纯逻辑，
	// 「持久化偏好在重开页面后还在」「stage chips 确实搬进了 Filters 浮层」这类只有真跑才算数。
	const SORT_ORDER_STORAGE_KEY = "kanban.task-spotlight-search-result-sort-order.v1";
	const ROW_FIELD_VISIBILITY_STORAGE_KEY = "kanban.task-spotlight-search-result-row-field-visibility.v1";

	async function openSpotlight(page: import("@playwright/test").Page) {
		await page.goto("/");
		await expect(page.locator('[data-column-id="backlog"]').first()).toBeAttached();
		await page.getByTestId(SPOTLIGHT_TRIGGER_TEST_ID).click();
		const dialog = page.locator(SPOTLIGHT_DIALOG_SELECTOR);
		await expect(dialog).toBeVisible();
		return dialog;
	}

	test("empty query browses every task without preselecting a row", async ({ page }) => {
		const dialog = await openSpotlight(page);

		// 空查询不再是「Type to search…」的静止空态，而是一份按排序档排好的全量列表。
		await expect(dialog).not.toContainText("Type to search tasks");
		const rows = dialog.locator("button", { hasText: /./ });
		await expect(rows.first()).toBeVisible();

		// ⌘K 之后直接回车是既有肌肉记忆；浏览态若预选第 0 行，那个手势会变成「随手打开某个任务」。
		await expect(dialog.locator(".bg-surface-3")).toHaveCount(0);
		await page.keyboard.press("ArrowDown");
		await expect(dialog.locator(".bg-surface-3").first()).toBeVisible();
	});

	test("the sort order survives a reload", async ({ page }) => {
		const dialog = await openSpotlight(page);
		await dialog.getByRole("group", { name: "Sort results" }).getByText("Created", { exact: true }).click();
		expect(await page.evaluate((key: string) => window.localStorage.getItem(key), SORT_ORDER_STORAGE_KEY)).toBe(
			"task_created_at_desc",
		);

		const reopenedDialog = await openSpotlight(page);
		await expect(
			reopenedDialog.getByRole("group", { name: "Sort results" }).getByText("Created", { exact: true }),
		).toHaveClass(/bg-surface-4/);
	});

	test("stage chips now live inside the Filters popover and narrow the results", async ({ page }) => {
		const dialog = await openSpotlight(page);

		// 收进浮层是这次的有意改动：五个维度平铺在窄屏上必然折行，挤掉本就紧张的结果列表高度。
		await expect(dialog.getByRole("button", { name: "Backlog", exact: true })).toHaveCount(0);

		await dialog.getByRole("button", { name: "Filter tasks" }).click();
		const filterPanel = page.locator("[data-task-filter-controls-panel]");
		await expect(filterPanel).toBeVisible();
		await expect(filterPanel).toContainText("Stage");
		await expect(filterPanel).toContainText("Last modified");

		await filterPanel.getByRole("button", { name: "Backlog", exact: true }).click();
		// 启用一个维度后触发按钮上出现角标，用户随时看得见「我正在被过滤」。
		await expect(dialog.getByRole("button", { name: "Filter tasks" })).toContainText("1");
	});

	test("switching a row field off removes it from every row and persists", async ({ page }) => {
		const dialog = await openSpotlight(page);
		await dialog.getByTestId("task-spotlight-search-result-row-field-visibility-menu-trigger").click();

		const stageNameItem = page.getByRole("menuitemcheckbox", { name: "Stage name" });
		await expect(stageNameItem).toBeVisible();
		await stageNameItem.click();
		await page.keyboard.press("Escape");

		const storedVisibility = await page.evaluate(
			(key: string) => window.localStorage.getItem(key),
			ROW_FIELD_VISIBILITY_STORAGE_KEY,
		);
		expect(storedVisibility).toContain('"stage_label_badge":false');
	});

	test("a full task id stays on top under a non-relevance sort order", async ({ page }) => {
		const dialog = await openSpotlight(page);
		await dialog.getByRole("group", { name: "Sort results" }).getByText("Created", { exact: true }).click();

		// 从看板上拿一个真实 task id，避免依赖固定的种子数据。
		const firstTaskId = await page.evaluate(() => {
			const cardElement = document.querySelector("[data-task-id]");
			return cardElement?.getAttribute("data-task-id") ?? null;
		});
		test.skip(!firstTaskId, "No task on the board to look up by id.");

		await page.getByPlaceholder("Search tasks").fill(firstTaskId as string);
		// 排序层刻意叠在 ID 置顶层之下：换档不该让「粘贴 id + 回车直达」失效。
		await expect(
			dialog
				.locator("button")
				.filter({ hasText: firstTaskId as string })
				.first(),
		).toBeVisible();
	});
});

test.describe("mobile task spotlight search entry", () => {
	test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

	test("trigger is tappable and the dialog goes fullscreen with a working close button", async ({ page }) => {
		await page.goto("/");

		const trigger = page.getByTestId(SPOTLIGHT_TRIGGER_TEST_ID);
		await expect(trigger).toBeVisible();
		// 顶栏右区的项目相关按钮挂载后左区才定宽，几何断言必须量稳态：等看板列渲染出来即代表项目数据到位。
		await expect(page.locator('[data-column-id="backlog"]').first()).toBeAttached();
		await expect(page.getByTestId("workspace-path")).toBeAttached();
		const triggerBox = await trigger.boundingBox();
		if (!triggerBox) {
			throw new Error("Expected the task spotlight search trigger to be laid out.");
		}
		expect(triggerBox.width).toBeGreaterThanOrEqual(44);
		expect(triggerBox.height).toBeGreaterThanOrEqual(44);

		// 顶栏左区是 overflow-hidden：入口只要越过它的右边界就会被裁掉，而 toBeVisible() 与
		// boundingBox 都照样通过（实测踩过——按钮 44px 里只剩 14px 露在外面）。必须显式钉住不被裁剪。
		const navigationLeftZoneBox = await page.locator("nav.kb-top-bar > div").first().boundingBox();
		if (!navigationLeftZoneBox) {
			throw new Error("Expected the top bar left zone to be laid out.");
		}
		expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(
			navigationLeftZoneBox.x + navigationLeftZoneBox.width + 1,
		);

		// 新增入口不得把顶栏撑到横向溢出——左区刻意可收缩就是为了这个。
		const documentOverflowsHorizontally = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
		);
		expect(documentOverflowsHorizontally).toBe(false);

		await trigger.tap();
		const dialog = page.locator(SPOTLIGHT_DIALOG_SELECTOR);
		await expect(dialog).toBeVisible();

		const dialogBox = await dialog.boundingBox();
		const viewport = page.viewportSize();
		if (!dialogBox || !viewport) {
			throw new Error("Expected both the dialog box and the viewport size.");
		}
		expect(dialogBox.width).toBe(viewport.width);
		expect(dialogBox.height).toBeGreaterThanOrEqual(viewport.height - 1);

		// 全屏后没有 overlay 可点、mobile 也没有 Esc——关闭按钮是唯一出路。
		await page.getByLabel("Close search").tap();
		await expect(dialog).toHaveCount(0);
	});
});
