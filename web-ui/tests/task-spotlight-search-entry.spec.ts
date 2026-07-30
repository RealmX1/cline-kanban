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
