import { expect, type Locator, type Page, test } from "@playwright/test";

async function openIsolatedQuickActionCard(
	page: Page,
	touch = false,
	clipboardApiAvailable = true,
	postDeployVerification = false,
) {
	await page.addInitScript((available) => {
		Object.defineProperty(navigator, "clipboard", {
			value: available
				? {
						writeText: async (text: string) => {
							document.body.dataset.copiedOriginalPrompt = text;
						},
					}
				: undefined,
		});
		document.addEventListener("copy", (event) => {
			document.body.dataset.copiedOriginalPrompt = event.clipboardData?.getData("text/plain") ?? "";
		});
	}, clipboardApiAvailable);
	await page.route("**/api/**", (route) => route.abort());
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-task-card-quick-actions*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	const query = new URLSearchParams();
	if (touch) query.set("touch", "");
	if (postDeployVerification) query.set("post-deploy-verification", "");
	await page.goto(`/isolated-task-card-quick-actions?${query}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/task-card-quick-actions-browser-harness.tsx" });
}

test("桌面悬停向上展开、直接完成、评论弹窗及原文复制", async ({ page }) => {
	await openIsolatedQuickActionCard(page);
	const card = page.locator("[data-task-id='quick-actions-card']");
	await card.hover();
	const done = card.getByRole("button", { name: "Move task to done", exact: true });
	await done.hover();
	const menu = page.getByRole("menu");
	await expect(menu).toHaveAttribute("data-side", "top");
	await page.screenshot({ path: test.info().outputPath("desktop-menu-expanded.png") });
	await page.getByRole("menuitem", { name: "添加评论并移入 Done…", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "任务评论" })).toBeFocused();
	await expect(page.getByRole("button", { name: "提交评论并移入 Done", exact: true })).toBeDisabled();
	await page.getByRole("textbox", { name: "任务评论" }).fill("浏览器验证\n通过");
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByLabel("已提交评论")).toHaveText("");
	await expect(page.getByLabel("直接移动次数")).toHaveText("0");
	await done.hover();
	await page.getByRole("menuitem", { name: "添加评论并移入 Done…", exact: true }).click();
	await page.getByRole("textbox", { name: "任务评论" }).fill("浏览器验证\n通过");
	await page.getByRole("button", { name: "提交评论并移入 Done", exact: true }).click();
	await expect(page.getByLabel("已提交评论")).toHaveText("浏览器验证\n通过");
	await done.hover();
	await page.getByRole("menuitem", { name: "添加评论并移入 Done…", exact: true }).hover();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(page.getByRole("menu")).toHaveCount(0);
	await card.hover();
	await done.click();
	await expect(page.getByLabel("直接移动次数")).toHaveText("1");
	await card.getByRole("button", { name: "View original prompt", exact: true }).hover();
	await expect(page.getByRole("menu")).toHaveAttribute("data-side", "top");
	await page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-copied-original-prompt",
		"原始 Prompt\n  保留缩进与标点 $() `code`\n",
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await card.getByRole("button", { name: "View original prompt", exact: true }).focus();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menu")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "View original prompt", exact: true })).toBeFocused();
	await page.screenshot({ path: test.info().outputPath("desktop-task-card-quick-actions.png") });
});

test.describe("触屏快捷操作", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	for (const width of [375, 390, 768])
		test(`${width}px 首次点按向下展开，评论入口与复制不误触主操作`, async ({ page }) => {
			await page.setViewportSize({ width, height: 844 });
			await openIsolatedQuickActionCard(page, true);
			const done = page.getByRole("button", { name: "Move task to done", exact: true });
			await done.tap();
			await expect(page.getByRole("menu")).toHaveAttribute("data-side", "bottom");
			await expect(page.getByLabel("直接移动次数")).toHaveText("0");
			await page.screenshot({ path: test.info().outputPath("mobile-menu-expanded.png") });
			for (const item of await page.getByRole("menuitem").all())
				expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
			await page.getByRole("menuitem", { name: "添加评论并移入 Done…", exact: true }).tap();
			await expect(page.getByRole("dialog")).toBeVisible();
			await page.getByRole("textbox", { name: "任务评论" }).fill("手机评论");
			await page.getByRole("button", { name: "提交评论并移入 Done", exact: true }).tap();
			await expect(page.getByLabel("已提交评论")).toHaveText("手机评论");
			await done.tap();
			await page.getByRole("menuitem", { name: "移入 Done", exact: true }).tap();
			await expect(page.getByLabel("直接移动次数")).toHaveText("1");
			await page.getByRole("button", { name: "View original prompt", exact: true }).tap();
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await expect(page.getByRole("menu")).toHaveAttribute("data-side", "bottom");
			await page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true }).tap();
			await expect(page.locator("body")).toHaveAttribute(
				"data-copied-original-prompt",
				"原始 Prompt\n  保留缩进与标点 $() `code`\n",
			);
			await expect(page.getByRole("dialog")).toHaveCount(0);
			await page.getByRole("button", { name: "View original prompt", exact: true }).tap();
			await page.getByRole("menuitem", { name: "查看原始 Prompt", exact: true }).tap();
			await expect(page.getByRole("dialog")).toContainText("原始 Prompt");
			await page.screenshot({ path: test.info().outputPath("mobile-task-card-quick-actions.png") });
		});
});

test("缺少 Clipboard API 时仍可通过点击同步复制原始 Prompt", async ({ page }) => {
	await openIsolatedQuickActionCard(page, false, false);
	await page.locator("[data-task-id='quick-actions-card']").hover();
	await page.getByRole("button", { name: "View original prompt", exact: true }).hover();
	await page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-copied-original-prompt",
		"原始 Prompt\n  保留缩进与标点 $() `code`\n",
	);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

async function expectQuickActionMenuReceivesPointerEvents(menu: Locator) {
	await expect(menu).toBeVisible();
	for (const target of [menu, ...(await menu.getByRole("menuitem").all())]) {
		await expect
			.poll(() =>
				target.evaluate((element) => {
					const rect = element.getBoundingClientRect();
					const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
					return {
						centerHitBelongsToMenu: hit !== null && element.contains(hit),
						hitText: hit?.textContent,
					};
				}),
			)
			.toMatchObject({ centerHitBelongsToMenu: true });
	}
}

test("PDV 默认保持最前时 Done 与 Prompt 菜单接收鼠标和键盘操作", async ({ page }) => {
	await openIsolatedQuickActionCard(page, false, true, true);
	const panel = page.locator(".kb-viewport-bottom-verification-floating-panel");
	await expect(panel.getByRole("button", { name: "关闭保持最前", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(panel).toHaveCSS("z-index", "70");
	await panel.locator(".kb-board-card-shell").hover();
	const done = panel.getByRole("button", { name: "Move task to done", exact: true });
	await done.hover();
	await expectQuickActionMenuReceivesPointerEvents(page.getByRole("menu"));
	await page.screenshot({ path: test.info().outputPath("pdv-pinned-done-menu-expanded.png") });
	await page.getByRole("menuitem", { name: "移入 Done", exact: true }).click();
	await expect(page.getByLabel("直接移动次数")).toHaveText("1");
	const prompt = panel.getByRole("button", { name: "View original prompt", exact: true });
	await prompt.hover();
	await expectQuickActionMenuReceivesPointerEvents(page.getByRole("menu"));
	await page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-copied-original-prompt",
		"原始 Prompt\n  保留缩进与标点 $() `code`\n",
	);
	await prompt.focus();
	await page.keyboard.press("ArrowDown");
	await expectQuickActionMenuReceivesPointerEvents(page.getByRole("menu"));
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menu")).toHaveCount(0);
});

test.describe("PDV 保持最前的触屏快捷菜单", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	test("Done 与 Prompt 菜单中心命中菜单，点按执行选中操作", async ({ page }) => {
		await openIsolatedQuickActionCard(page, true, true, true);
		const panel = page.locator(".kb-viewport-bottom-verification-floating-panel");
		await expect(panel).toHaveCSS("z-index", "70");
		await panel.getByRole("button", { name: "Move task to done", exact: true }).tap();
		await expectQuickActionMenuReceivesPointerEvents(page.getByRole("menu"));
		await page.getByRole("menuitem", { name: "移入 Done", exact: true }).tap();
		await expect(page.getByLabel("直接移动次数")).toHaveText("1");
		await panel.getByRole("button", { name: "View original prompt", exact: true }).tap();
		await expectQuickActionMenuReceivesPointerEvents(page.getByRole("menu"));
		await page.screenshot({ path: test.info().outputPath("pdv-pinned-touch-prompt-menu-expanded.png") });
		await page.getByRole("menuitem", { name: "复制原始 Prompt", exact: true }).tap();
		await expect(page.locator("body")).toHaveAttribute(
			"data-copied-original-prompt",
			"原始 Prompt\n  保留缩进与标点 $() `code`\n",
		);
	});
});

test("首个菜单项刚获焦点立即 Escape 仍关闭并回焦触发器", async ({ page }) => {
	await openIsolatedQuickActionCard(page);
	await page.locator("[data-task-id='quick-actions-card']").hover();
	await page.evaluate(() => {
		const pressEscapeOnFirstMenuItemFocus = (event: FocusEvent) => {
			if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "menuitem") return;
			document.removeEventListener("focusin", pressEscapeOnFirstMenuItemFocus);
			document.body.dataset.immediateEscapeTarget = event.target.textContent ?? "";
			document.body.dataset.immediateEscapeTargetWasFocused = String(document.activeElement === event.target);
			event.target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		};
		document.addEventListener("focusin", pressEscapeOnFirstMenuItemFocus);
	});
	const trigger = page.getByRole("button", { name: "View original prompt", exact: true });
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	await expect(page.locator("body")).toHaveAttribute("data-immediate-escape-target", "查看原始 Prompt");
	await expect(page.locator("body")).toHaveAttribute("data-immediate-escape-target-was-focused", "true");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(trigger).toBeFocused();
});
