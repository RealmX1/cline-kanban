import { expect, type Page, test } from "@playwright/test";
import { runtimeTaskCardActionApplyTaskStickerEntryMutationRequestSchema } from "../../src/core/api-contract";
import { applyTaskStickerEntryMutationToTaskCard } from "../../src/core/task-sticker-entry-mutation";
import { createTaskStickerBrowserFixtureCard } from "./task-card-stickers-browser-fixture";

async function openStickerCards(page: Page, bottom = false, startsWithoutStickers = false) {
	const cards = new Map(
		["main-task", "focus-task", "pin-task", "preview-task"].map((id) => [
			id,
			createTaskStickerBrowserFixtureCard(id),
		]),
	);
	const mutations: unknown[] = [];
	if (startsWithoutStickers) cards.get("main-task")!.taskStickerEntries = [];
	const pageErrors: string[] = [];
	let failNextMutation = false;
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(
			request.method() === "GET" ? (url.searchParams.get("input") ?? "{}") : (request.postData() ?? "{}"),
		) as Record<string, Record<string, unknown>>;
		const results = procedures.map((procedure, index) => {
			const input = inputs[index] ?? {};
			const card = cards.get(String(input.taskId));
			const snapshot = () => ({
				taskCard: card,
				boardColumnIdContainingTaskCard: "review",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			});
			let data: unknown = null;
			if (procedure === "workUnit.getDirectlyRelatedTaskPreviewPage")
				data = {
					subjectTask: input.task,
					entries: [],
					totalTaskCount: 0,
					mutedOnlyTaskCount: 0,
					standaloneSessionCount: 0,
					neighborhoodRevision: "sticker-fixture",
					nextCursor: null,
				};
			if (procedure === "taskCardAction.readTaskCardWithBoardColumn")
				data = { taskCardLookupOutcome: "task_card_found_on_workspace_board", taskCardSnapshot: snapshot() };
			if (procedure === "taskCardAction.applyTaskStickerEntryMutation" && card) {
				mutations.push(input);
				if (failNextMutation) {
					failNextMutation = false;
					return {
						error: {
							message: "隔离保存故障，草稿保留",
							code: -32603,
							data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
						},
					};
				}
				const parsed = runtimeTaskCardActionApplyTaskStickerEntryMutationRequestSchema.parse(input);
				const updated = applyTaskStickerEntryMutationToTaskCard(card, parsed.mutation, Date.now());
				Object.assign(card, updated);
				data = { boardWasSaved: updated !== card, taskCardSnapshotAfterAction: snapshot() };
			}
			return { result: { data } };
		});
		await route.fulfill({ json: results });
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-task-card-stickers*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	const mount = async () => {
		const query = new URLSearchParams();
		if (bottom) query.set("bottom", "");
		if (startsWithoutStickers) query.set("empty", "");
		await page.goto(`/isolated-task-card-stickers?${query}`);
		await page.addScriptTag({
			type: "module",
			content:
				"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
		});
		await page.addScriptTag({ type: "module", url: "/tests/task-card-stickers-browser-harness.tsx" });
		await expect(page.locator("[data-sticker-host='board'] .kb-board-card-shell")).toBeVisible();
		if (!startsWithoutStickers)
			await expect(page.locator("[data-sticker-host='board'] [data-task-sticker-stub]")).toBeVisible();
	};
	await mount();
	return {
		cards,
		mutations,
		pageErrors,
		mount,
		failNextSave: () => {
			failNextMutation = true;
		},
	};
}

test("无便签卡片可从动作区添加首张便签，默认展开且不增加卡片高度", async ({ page }) => {
	await openStickerCards(page, false, true);
	const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
	const before = await card.boundingBox();
	await expect(card.locator("[data-task-sticker-stub]")).toHaveCount(0);
	await card.hover();
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(0);
	await card.getByRole("button", { name: "添加便签", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "便签正文" })).toBeFocused();
	await page.getByRole("textbox", { name: "便签正文" }).fill("首张便签\n默认展开");
	await page.getByRole("button", { name: "保存便签", exact: true }).click();
	await expect(card.getByRole("button", { name: "便签 1", exact: true })).toBeVisible();
	await expect(page.locator("[data-task-sticker-overlay]").getByText("首张便签", { exact: false })).toBeVisible();
	expect(await card.boundingBox()).toEqual(before);
});

test("悬停保持输入焦点和卡片布局，跨入浮层不关闭，折叠后重新 hover 与刷新仍收起", async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 850 });
	const fixture = await openStickerCards(page);
	const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
	const adjacent = page.locator("[data-sticker-adjacent-element]");
	const before = [await card.boundingBox(), await adjacent.boundingBox()];
	await page.getByRole("textbox", { name: "当前输入" }).focus();
	await card.hover();
	const overlay = page.locator("[data-task-sticker-overlay]");
	await expect(overlay).toBeVisible();
	await expect(overlay).toHaveAttribute("data-side", "bottom");
	await expect(page.getByRole("textbox", { name: "当前输入" })).toBeFocused();
	await overlay.hover();
	await page.waitForTimeout(250);
	await expect(overlay).toBeVisible();
	await overlay.getByRole("button", { name: "收起便签", exact: true }).first().click();
	await expect(overlay.getByText("第一张完整正文", { exact: false })).toHaveCount(0);
	await page.mouse.move(0, 0);
	await expect(overlay).toHaveCount(0);
	await card.hover();
	await expect(overlay.getByRole("button", { name: "展开便签" })).toHaveCount(1);
	await expect(card).toHaveJSProperty("offsetHeight", before[0]!.height);
	expect(await card.boundingBox()).toEqual(before[0]);
	expect(await adjacent.boundingBox()).toEqual(before[1]);
	await fixture.mount();
	await card.hover();
	await expect(overlay.getByRole("button", { name: "展开便签" })).toHaveCount(1);
	await page.getByRole("button", { name: "切换任务 Stage" }).click();
	await card.hover();
	await expect(overlay.getByRole("button", { name: "展开便签" })).toHaveCount(1);
	await page.screenshot({ path: test.info().outputPath("stickers-desktop.png") });
	expect(fixture.pageErrors).toEqual([]);
});

test("鼠标显式打开便签后移出卡片和浮层仍延迟关闭", async ({ page }) => {
	await openStickerCards(page);
	await page.locator("[data-sticker-host='board'] [data-task-sticker-stub]").click();
	const overlay = page.locator("[data-task-sticker-overlay]");
	await expect(overlay).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(overlay).toHaveCount(0);
});

for (const finishEditing of ["保存便签", "取消编辑"]) {
	test(`指针添加便签后${finishEditing}，移出卡片和浮层仍延迟关闭`, async ({ page }) => {
		await openStickerCards(page, false, true);
		const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
		await card.hover();
		await card.getByRole("button", { name: "添加便签", exact: true }).click();
		const overlay = page.locator("[data-task-sticker-overlay]");
		await overlay.getByRole("textbox", { name: "便签正文" }).fill("结束编辑后的便签");
		await page.mouse.move(0, 0);
		await page.waitForTimeout(250);
		await expect(overlay).toBeVisible();
		await overlay.getByRole("button", { name: finishEditing, exact: true }).evaluate((element) => element.click());
		await expect(overlay).toHaveCount(0);
	});
}

test("触屏点按打开便签后抬手仍保留浮层，允许等待后开始编辑", async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	try {
		await openStickerCards(page);
		await page.locator("[data-sticker-host='board'] [data-task-sticker-stub]").tap();
		const overlay = page.locator("[data-task-sticker-overlay]");
		await page.waitForTimeout(350);
		await expect(overlay).toBeVisible();
		await overlay.getByRole("button", { name: "编辑便签", exact: true }).first().tap();
		await overlay.getByRole("textbox", { name: "便签正文" }).fill("触屏等待后保存");
		await overlay.getByRole("button", { name: "保存便签", exact: true }).tap();
		await page.waitForTimeout(350);
		await expect(overlay.getByText("触屏等待后保存", { exact: true })).toBeVisible();
		await page.getByRole("textbox", { name: "当前输入" }).tap();
		await expect(overlay).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("新增、编辑、删除独立工作，保存故障保留草稿并幂等重试，不跳转或拖拽", async ({ page }) => {
	const fixture = await openStickerCards(page);
	const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
	await card.hover();
	const overlay = page.locator("[data-task-sticker-overlay]");
	await overlay.getByRole("button", { name: "添加便签", exact: true }).click();
	await page.getByRole("textbox", { name: "便签正文" }).fill("新便签\n重试后保存");
	fixture.failNextSave();
	await overlay.getByRole("button", { name: "保存便签", exact: true }).click();
	await expect(overlay.getByRole("alert")).toContainText("隔离保存故障");
	await page.mouse.move(0, 0);
	await expect(overlay).toBeVisible();
	await expect(page.getByRole("textbox", { name: "便签正文" })).toHaveValue("新便签\n重试后保存");
	await overlay.getByRole("button", { name: "重试", exact: true }).click();
	await expect(card.getByRole("button", { name: "便签 3", exact: true })).toBeVisible();
	expect(fixture.mutations[0]).toEqual(fixture.mutations[1]);
	await overlay.getByRole("button", { name: "编辑便签", exact: true }).last().click();
	await page.getByRole("textbox", { name: "便签正文" }).fill("修改后的新便签");
	await overlay.getByRole("button", { name: "保存便签", exact: true }).click();
	await expect(overlay.getByText("修改后的新便签", { exact: true })).toBeVisible();
	await overlay.getByRole("button", { name: "删除便签", exact: true }).last().click();
	await expect(card.getByRole("button", { name: "便签 2", exact: true })).toBeVisible();
	await expect(overlay.getByText("第一张首行", { exact: false })).toBeVisible();
	await expect(page.getByLabel("卡片跳转次数")).toHaveText("0");
	await expect(page.getByLabel("拖拽次数")).toHaveText("0");
	expect(fixture.pageErrors).toEqual([]);
});

for (const draftKind of ["新增", "编辑"]) {
	test(`${draftKind}草稿存在时折叠失败只重试折叠，保留未经确认的正文`, async ({ page }) => {
		const fixture = await openStickerCards(page);
		await page.locator("[data-sticker-host='board'] .kb-board-card-shell").hover();
		const overlay = page.locator("[data-task-sticker-overlay]");
		if (draftKind === "新增") await overlay.getByRole("button", { name: "添加便签", exact: true }).click();
		else await overlay.getByRole("button", { name: "编辑便签", exact: true }).last().click();
		const draft = overlay.getByRole("textbox", { name: "便签正文" });
		await draft.fill("未经确认的草稿正文");
		fixture.failNextSave();
		await overlay.getByRole("button", { name: "收起便签", exact: true }).first().click();
		await expect(overlay.getByRole("alert")).toContainText("隔离保存故障");
		await overlay.getByRole("button", { name: "重试", exact: true }).click();
		await expect(overlay.getByRole("alert")).toHaveCount(0);
		await expect.poll(() => fixture.mutations).toHaveLength(2);
		for (const mutation of fixture.mutations)
			expect(mutation).toMatchObject({
				mutation: { operation: "set_collapsed", taskStickerEntryId: "first", isCollapsed: true },
			});
		await expect(overlay.getByRole("button", { name: "展开便签", exact: true })).toHaveCount(1);
		await expect(draft).toHaveValue("未经确认的草稿正文");
		expect(fixture.cards.get("main-task")!.taskStickerEntries).toHaveLength(2);
		expect(fixture.pageErrors).toEqual([]);
	});

	test(`${draftKind}正文保存失败后可以修改草稿并重试当前正文`, async ({ page }) => {
		const fixture = await openStickerCards(page);
		await page.locator("[data-sticker-host='board'] .kb-board-card-shell").hover();
		const overlay = page.locator("[data-task-sticker-overlay]");
		if (draftKind === "新增") await overlay.getByRole("button", { name: "添加便签", exact: true }).click();
		else await overlay.getByRole("button", { name: "编辑便签", exact: true }).last().click();
		const draft = overlay.getByRole("textbox", { name: "便签正文" });
		await draft.fill("首次保存的草稿正文");
		fixture.failNextSave();
		await overlay.getByRole("button", { name: "保存便签", exact: true }).click();
		await expect(overlay.getByRole("alert")).toContainText("隔离保存故障");
		await draft.fill("保存失败后手动修改的草稿正文");
		await overlay.getByRole("button", { name: "重试", exact: true }).click();
		await expect(draft).toHaveCount(0);
		expect(fixture.mutations).toHaveLength(2);
		expect(fixture.mutations[1]).toMatchObject({
			mutation: {
				operation: draftKind === "新增" ? "create" : "update_text",
				stickerText: "保存失败后手动修改的草稿正文",
			},
		});
		await expect(overlay.getByText("保存失败后手动修改的草稿正文", { exact: true })).toBeVisible();
		expect(fixture.pageErrors).toEqual([]);
	});
}

test("底部翻到上方，长正文内部滚动并避开裁切", async ({ page }) => {
	await page.setViewportSize({ width: 800, height: 600 });
	const fixture = await openStickerCards(page, true);
	fixture.cards.get("main-task")!.taskStickerEntries![0]!.stickerText = Array.from(
		{ length: 80 },
		(_, index) => `长正文 ${index}`,
	).join("\n");
	await page.locator("[data-sticker-host='board'] .kb-board-card-shell").hover();
	const overlay = page.locator("[data-task-sticker-overlay]");
	await expect(overlay).toHaveAttribute("data-side", "top");
	await expect
		.poll(() =>
			overlay.evaluate((element) => {
				const scroll = element.querySelector<HTMLElement>(".overflow-y-auto");
				return Boolean(scroll && scroll.scrollHeight > scroll.clientHeight);
			}),
		)
		.toBe(true);
	await expect
		.poll(async () => {
			const bounds = (await overlay.boundingBox())!;
			return bounds.y >= 0 && bounds.y + bounds.height <= 600;
		})
		.toBe(true);
	await page.screenshot({ path: test.info().outputPath("stickers-top-collision.png") });
});

for (const presentation of [
	{ name: "桌面", viewport: { width: 1200, height: 850 }, bottom: false },
	{ name: "底部卡片", viewport: { width: 800, height: 600 }, bottom: true },
	{ name: "手机", viewport: { width: 390, height: 844 }, bottom: false },
]) {
	for (const editorAction of ["添加便签", "编辑便签", "从卡片键盘添加便签"]) {
		test(`${presentation.name}长便签${editorAction}仅滚动浮层，正文与保存取消均可见`, async ({ page }) => {
			await page.setViewportSize(presentation.viewport);
			const fixture = await openStickerCards(page, presentation.bottom);
			fixture.cards.get("main-task")!.taskStickerEntries![0]!.stickerText = Array.from(
				{ length: 70 },
				(_, index) => `长正文第 ${index + 1} 行`,
			).join("\n");
			await page.evaluate(() => {
				document.body.style.minHeight = "1800px";
				document.querySelector<HTMLElement>("main")!.style.paddingTop = "220px";
				window.scrollTo(0, 200);
			});
			const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
			const adjacent = page.locator("[data-sticker-adjacent-element]");
			const before = {
				card: await card.boundingBox(),
				adjacent: await adjacent.boundingBox(),
				pageScroll: await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })),
				cardHostScroll: await card.locator("..").evaluate((element) => element.scrollTop),
			};
			await page
				.getByRole("textbox", { name: "当前输入" })
				.evaluate((element) => element.focus({ preventScroll: true }));
			await card.hover();
			const overlay = page.locator("[data-task-sticker-overlay]");
			await expect(overlay.getByText("长正文第 70 行", { exact: false })).toHaveCount(1);
			await expect(page.getByRole("textbox", { name: "当前输入" })).toBeFocused();
			await expect(overlay.locator(".overflow-y-auto")).toHaveJSProperty("scrollTop", 0);
			if (editorAction === "从卡片键盘添加便签") {
				await overlay.getByRole("button", { name: "关闭便签", exact: true }).click();
				await expect(overlay).toHaveCount(0);
				await card
					.getByRole("button", { name: "添加便签", exact: true })
					.evaluate((element) => element.focus({ preventScroll: true }));
				await page.keyboard.press("Enter");
			} else {
				await overlay.getByRole("button", { name: editorAction, exact: true }).first().click();
			}
			const editor = overlay.getByRole("textbox", { name: "便签正文" });
			await expect(editor).toBeFocused();
			const scrollViewport = overlay.locator(".overflow-y-auto");
			const viewportBounds = (await scrollViewport.boundingBox())!;
			for (const control of [
				editor,
				overlay.getByRole("button", { name: "保存便签", exact: true }),
				overlay.getByRole("button", { name: "取消编辑", exact: true }),
			]) {
				const bounds = (await control.boundingBox())!;
				// 浏览器滚动范围以整数像素取整，允许不足一像素的布局舍入。
				expect(bounds.y).toBeGreaterThanOrEqual(viewportBounds.y - 1);
				expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewportBounds.y + viewportBounds.height + 1);
				await expect(control).toBeInViewport({ ratio: 0.99 });
			}
			expect(await scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
			expect(await card.boundingBox()).toEqual(before.card);
			expect(await adjacent.boundingBox()).toEqual(before.adjacent);
			expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(before.pageScroll);
			expect(await card.locator("..").evaluate((element) => element.scrollTop)).toBe(before.cardHostScroll);
			await page.screenshot({ path: test.info().outputPath("long-sticker-editor-visible.png") });
			expect(fixture.pageErrors).toEqual([]);
		});
	}
}

test("Focus、置顶板共用单一浮层，嵌套预览中编辑不会关闭外层", async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 850 });
	await openStickerCards(page);
	await page.locator("[data-sticker-host='focus'] .kb-board-card-shell").hover();
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(1);
	await page.locator("[data-sticker-host='pinboard'] .kb-board-card-shell").hover();
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(1);
	await page.mouse.move(0, 0);
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(0);
	await page.getByRole("button", { name: "打开嵌套预览" }).click();
	await page.locator("[data-sticker-preview-host] .kb-board-card-shell").hover();
	const overlay = page.locator("[data-task-sticker-overlay]");
	await overlay.getByRole("button", { name: "编辑便签", exact: true }).first().click();
	await page.getByRole("textbox", { name: "便签正文" }).fill("嵌套预览编辑");
	await overlay.getByRole("button", { name: "保存便签", exact: true }).click();
	await expect(page.locator("[data-sticker-preview-host]")).toBeVisible();
	await expect(overlay.getByText("嵌套预览编辑", { exact: true })).toBeVisible();
});

test("键盘操作便签时保留浮层，焦点移出后关闭", async ({ page }) => {
	await openStickerCards(page);
	const stub = page.locator("[data-sticker-host='board'] [data-task-sticker-stub]");
	await stub.focus();
	await page.keyboard.press("Enter");
	const overlay = page.locator("[data-task-sticker-overlay]");
	await expect(overlay.getByRole("button", { name: "添加便签", exact: true })).toBeFocused();
	await page.mouse.move(0, 0);
	await page.waitForTimeout(250);
	await page.keyboard.press("Tab");
	await expect(overlay.getByRole("button", { name: "关闭便签", exact: true })).toBeFocused();
	await expect(overlay).toBeVisible();
	await page.getByRole("textbox", { name: "当前输入" }).focus();
	await expect(overlay).toHaveCount(0);
});

test("键盘打开、Escape 关闭并归还焦点，便签按钮不触发键盘拖拽", async ({ page }) => {
	await openStickerCards(page);
	const stub = page.locator("[data-sticker-host='board'] [data-task-sticker-stub]");
	await stub.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator("[data-task-sticker-overlay]")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(0);
	await expect(stub).toBeFocused();
	await expect(page.getByLabel("拖拽次数")).toHaveText("0");
});

test("悬停便签时仍可打开关联任务预览，非模态浮层不阻挡其他卡片动作", async ({ page }) => {
	await openStickerCards(page);
	const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
	await card.hover();
	await expect(page.locator("[data-task-sticker-overlay]")).toBeVisible();
	await card.getByRole("button", { name: "查看关联任务", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "关联任务预览", exact: true })).toBeVisible();
	await expect(page.getByText("尚无直接关联任务。", { exact: true })).toBeVisible();
});

test("卡片仍可键盘拖拽，拖拽期间关闭便签浮层", async ({ page }) => {
	await openStickerCards(page);
	const card = page.locator("[data-sticker-host='board'] .kb-board-card-shell");
	await card.hover();
	await expect(page.locator("[data-task-sticker-overlay]")).toBeVisible();
	await card.focus();
	await page.keyboard.press("Space");
	await expect(page.locator("[data-task-sticker-overlay]")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.getByLabel("拖拽次数")).toHaveText("1");
});

test("触屏通过 stub 打开并编辑便签", async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	try {
		await openStickerCards(page);
		await page.locator("[data-sticker-host='board'] [data-task-sticker-stub]").tap();
		const overlay = page.locator("[data-task-sticker-overlay]");
		await overlay.getByRole("button", { name: "编辑便签", exact: true }).first().tap();
		await page.getByRole("textbox", { name: "便签正文" }).fill("手机保存");
		await overlay.getByRole("button", { name: "保存便签", exact: true }).tap();
		await expect(overlay.getByText("手机保存", { exact: true })).toBeVisible();
		const box = (await overlay.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		await page.screenshot({ path: test.info().outputPath("stickers-touch.png") });
	} finally {
		await context.close();
	}
});
