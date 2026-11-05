import { expect, type Page, test } from "@playwright/test";

const pageErrorsByPage = new WeakMap<Page, string[]>();
test.afterEach(({ page }) => expect(pageErrorsByPage.get(page) ?? []).toEqual([]));

async function openHarness(page: Page) {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	pageErrorsByPage.set(page, pageErrors);
	const writes: { workspaceId?: string; procedure: string; input: Record<string, unknown> }[] = [];
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = decodeURIComponent(url.pathname.split("/api/trpc/")[1] ?? "").split(",");
		const payload = route.request().postDataJSON() ?? JSON.parse(url.searchParams.get("input") ?? "{}");
		const workspaceId = route.request().headers()["x-kanban-workspace-id"];
		const response = procedures.map((procedure, index) => {
			const input = payload[index] ?? {};
			let data: unknown = null;
			if (procedure === "runtime.getConfig" || procedure === "runtime.saveConfig")
				data = {
					selectedAgentId: "codex",
					agents: [],
					userInterfacePreferencesSharedAcrossBrowserOrigins: {
						taskProjectAssignmentAutomaticAnalysisEnabled: false,
						taskEditorSettingPresentationBySettingKey: {},
						taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
						mostRecentlyUsedTaskCreateBaseRefByProjectId: {},
					},
				};
			else if (procedure === "workUnit.getRelationModelingPreview")
				data = {
					rootWorkUnitKey: "fixture",
					workUnits: [],
					relations: [],
					truncated: false,
					projectedThroughGlobalCommittedEventSequence: 0,
				};
			else if (procedure === "workUnit.saveRelationModelingEditorDraft") data = { saved: true };
			else if (procedure === "workspace.allocateTaskIdForNewWebUiTaskCard")
				data = { allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry: "abcde" };
			else if (procedure === "workspace.getState")
				data = { git: { defaultBranch: "main", branches: ["main"], currentBranch: "main" } };
			else if (procedure === "taskCardAction.updateTaskCardFieldValues") {
				writes.push({ workspaceId, procedure, input });
				const patch = input.taskCardFieldUpdate?.taskCardFieldValuePatch ?? {};
				data = {
					taskCardSnapshotAfterAction: {
						taskCard: {
							id: input.taskId,
							title: "project-a的任务",
							prompt: patch.prompt ?? "project-a的原始需求",
							baseRef: "main",
							startInPlanMode: true,
							createdAt: 100,
							updatedAt: 101,
						},
						boardColumnIdContainingTaskCard: "backlog",
						workspaceId,
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				};
			} else if (procedure === "exploratory.saveFinding") {
				writes.push({ workspaceId, procedure, input });
				data = { saved: true };
			}
			return { result: { data } };
		});
		await route.fulfill({ json: response });
	});
	await page.route("**/isolated-floating-forms", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-floating-forms");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/non-modal-floating-form-windows-browser-harness.tsx" });
	return writes;
}

for (const width of [1440, 320]) {
	test(`${width}px 收成紧凑标题条，反复展开保留节点、附件、选区与滚动，背景继续操作`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await openHarness(page);
		await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "填写表单", exact: true });
		const input = dialog.getByRole("textbox", { name: "草稿 project-a" });
		await input.fill("保留光标、附件与滚动位置");
		await input.evaluate((element) =>
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })),
		);
		await expect(dialog).toBeVisible();
		await dialog
			.getByLabel("附件 project-a")
			.setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("附件内容") });
		await input.focus();
		await input.evaluate((element: HTMLTextAreaElement) => {
			element.setSelectionRange(2, 5);
			element.closest("[role=dialog]")!.querySelector(".overflow-y-auto")!.scrollTop = 300;
		});
		const expandedWidth = (await dialog.boundingBox())!.width;
		for (let round = 0; round < 2; round++) {
			await dialog.getByRole("button", { name: "收起填写窗口" }).click();
			expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(320);
			if (width === 1440) expect((await dialog.boundingBox())!.width).toBeLessThan(expandedWidth);
			await expect(input).toBeHidden();
			await dialog.getByRole("button", { name: "展开填写窗口" }).press("Control+Enter");
			await page.getByLabel("背景可编辑输入").fill("背景输入仍可编辑");
			await page.getByLabel("背景可编辑输入").press("Escape");
			await expect(dialog).toBeVisible();
			await dialog.getByRole("button", { name: "展开填写窗口" }).click();
			await expect(input).toHaveValue("保留光标、附件与滚动位置");
			expect(
				await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]),
			).toEqual([2, 5]);
			expect(await dialog.locator(".overflow-y-auto").evaluate((element) => element.scrollTop)).toBe(300);
			await expect(dialog.getByText("附件：evidence.txt")).toHaveCount(1);
			await expect(dialog.getByLabel("保存次数 project-a")).toHaveText("0");
		}
		await page.screenshot({ path: test.info().outputPath(`form-${width}.png`) });
	});
}

test("窗口跨项目独立存续，重复打开恢复原草稿，焦点置前且关闭只影响对应实例", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openHarness(page);
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	await page.getByLabel("草稿 project-a").fill("A 的独立草稿");
	await page.getByRole("button", { name: "收起填写窗口" }).click();
	await page.getByRole("button", { name: "切换背景项目" }).click();
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	await page.getByLabel("草稿 project-b").fill("B 的独立草稿");
	await page.getByRole("button", { name: "收起填写窗口" }).click();
	await page.getByRole("button", { name: "切换背景项目" }).click();
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	await expect(page.getByLabel("草稿 project-a")).toHaveValue("A 的独立草稿");
	await expect(page.getByLabel("草稿 project-a")).toBeFocused();
	await expect(page.locator("[data-non-modal-floating-form-window]")).toHaveCount(2);
	await page
		.getByRole("dialog", { name: "填写表单" })
		.filter({ has: page.getByLabel("草稿 project-a") })
		.getByRole("button", { name: "关闭填写窗口" })
		.click();
	await expect(page.locator("[data-non-modal-floating-form-window]")).toHaveCount(1);
	await page.getByRole("button", { name: "展开填写窗口" }).click();
	await expect(page.getByLabel("草稿 project-b")).toHaveValue("B 的独立草稿");
});

test("边缘拖动、视口缩小与旋转后标题和底栏仍在可见范围", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openHarness(page);
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "填写表单" });
	const header = await dialog.getByRole("heading", { name: "填写表单" }).boundingBox();
	await page.mouse.move(header!.x + 10, header!.y + 8);
	await page.mouse.down();
	await page.mouse.move(1435, 995);
	await page.mouse.up();
	for (const viewport of [
		{ width: 320, height: 500 },
		{ width: 700, height: 320 },
	]) {
		await page.setViewportSize(viewport);
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		await expect
			.poll(async () => {
				const bounds = await dialog.boundingBox();
				return (
					!!bounds &&
					bounds.x >= 7 &&
					bounds.y >= 7 &&
					bounds.x + bounds.width <= viewport.width - 7 &&
					bounds.y + bounds.height <= viewport.height - 7
				);
			})
			.toBe(true);
		await expect(dialog.getByRole("button", { name: "保存表单", exact: true })).toBeVisible();
	}
});

test("嵌套选择器和模态确认保留事件边界，焦点所在表单才响应快捷键", async ({ page }) => {
	await openHarness(page);
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "填写表单" });
	await dialog.getByRole("combobox", { name: "嵌套选项" }).click();
	await page.getByRole("option", { name: "第二项" }).focus();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("listbox")).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "确认操作", exact: true }).click();
	const confirmation = page.getByRole("dialog", { name: "确认操作" });
	await expect(confirmation).toBeVisible();
	const confirmationCloseButton = confirmation.getByRole("button", { name: "Close", exact: true });
	await expect(confirmationCloseButton).toBeFocused();
	await confirmation.evaluate(async (element) => {
		await Promise.all(element.getAnimations().map((animation) => animation.finished));
	});
	await confirmationCloseButton.press("Escape");
	await expect(confirmation).toHaveCount(0);
	await expect(dialog).toBeVisible();
	await dialog.getByLabel("草稿 project-a").press("Control+Enter");
	await expect(dialog.getByLabel("保存次数 project-a")).toHaveText("1");
	await page.getByLabel("背景可编辑输入").press("Control+Enter");
	await expect(dialog.getByLabel("保存次数 project-a")).toHaveText("1");
});

test("真实任务编辑器在背景项目切换后保存原任务，另一任务草稿仍保留", async ({ page }) => {
	const writes = await openHarness(page);
	await page.getByRole("button", { name: "编辑任务", exact: true }).click();
	const editorA = page.getByRole("dialog", { name: "编辑 Backlog 任务" }).first();
	await editorA.getByRole("textbox", { name: "任务正文", exact: true }).fill("只写回project-a 的任务");
	await editorA.getByRole("button", { name: "收起任务编辑器" }).click();
	await page.getByRole("button", { name: "切换背景项目" }).click();
	await page.getByRole("button", { name: "编辑任务", exact: true }).click();
	const editorB = page.getByRole("dialog", { name: "编辑 Backlog 任务" }).last();
	await editorB.getByRole("textbox", { name: "任务正文", exact: true }).fill("project-b 尚未提交的草稿");
	await editorB.getByRole("button", { name: "收起任务编辑器" }).click();
	await editorA.getByRole("button", { name: "展开任务编辑器" }).click();
	await editorA.getByRole("button", { name: "保存更改", exact: true }).click();
	await expect
		.poll(() => writes.filter((write) => write.procedure === "taskCardAction.updateTaskCardFieldValues").length)
		.toBe(1);
	expect(writes.find((write) => write.procedure === "taskCardAction.updateTaskCardFieldValues")).toMatchObject({
		workspaceId: "project-a",
		input: { taskId: "a1b2c", expectedTaskIncarnationCreatedAtEpochMs: 100 },
	});
	await expect(page.getByRole("dialog", { name: "编辑 Backlog 任务" })).toHaveCount(1);
	await page.getByRole("button", { name: "展开任务编辑器" }).click();
	await expect(page.getByRole("textbox", { name: "任务正文", exact: true })).toHaveValue("project-b 尚未提交的草稿");
});

test("真实 Finding 表单在切换项目后继续保存到原会话", async ({ page }) => {
	const writes = await openHarness(page);
	await page.getByRole("button", { name: "保存 Finding", exact: true }).click();
	await page.getByRole("textbox", { name: "Title", exact: true }).fill("属于project-a 的发现");
	await page.getByRole("button", { name: "收起填写窗口" }).click();
	await page.getByRole("button", { name: "切换背景项目" }).click();
	await page.getByRole("button", { name: "展开填写窗口" }).click();
	await page.getByRole("button", { name: "Save finding", exact: true }).click();
	await expect.poll(() => writes.filter((write) => write.procedure === "exploratory.saveFinding").length).toBe(1);
	expect(writes.find((write) => write.procedure === "exploratory.saveFinding")).toMatchObject({
		workspaceId: "project-a",
		input: { findingTitle: "属于project-a 的发现" },
	});
});

test("展开背景视图后既有浮窗仍可聚焦，Esc 只关闭焦点所在窗口", async ({ page }) => {
	await openHarness(page);
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	await page.getByRole("button", { name: "收起填写窗口" }).click();
	await page.getByRole("button", { name: "展开背景视图", exact: true }).click();
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(1);
	await page.getByRole("button", { name: "展开填写窗口" }).click();
	await page.getByLabel("草稿 project-a").fill("背景展开后仍可填写");
	await expect(page.getByLabel("草稿 project-a")).toBeFocused();
	await page.getByLabel("草稿 project-a").press("Escape");
	await expect(page.locator("[data-non-modal-floating-form-window]")).toHaveCount(0);
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(1);
});

test("手机软键盘可视区域变化后正文与提交按钮仍在区域内", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openHarness(page);
	await page.getByRole("button", { name: "打开填写表单", exact: true }).click();
	await page.evaluate(() => {
		const viewport = window.visualViewport!;
		Object.defineProperty(viewport, "height", { configurable: true, get: () => 340 });
		Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 180 });
		viewport.dispatchEvent(new Event("resize"));
	});
	const dialog = page.getByRole("dialog", { name: "填写表单", exact: true });
	await expect
		.poll(async () => {
			const bounds = await dialog.boundingBox();
			return !!bounds && bounds.y >= 188 && bounds.y + bounds.height <= 512;
		})
		.toBe(true);
	await expect(dialog.getByRole("button", { name: "保存表单", exact: true })).toBeVisible();
});
