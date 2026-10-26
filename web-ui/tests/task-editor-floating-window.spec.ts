import { expect, type Page, test } from "@playwright/test";

async function openEditorHarness(page: Page) {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { readText: async () => document.body.dataset.controlledClipboardText ?? "" },
		});
	});
	await page.routeWebSocket("**/*", () => {});
	let preferences = {
		newTaskAutoReviewEnabled: null,
		newTaskAutoReviewMode: null,
		taskCreateDialogPrimaryStartAction: null,
		taskCreateTerminalAgentModelSelectionsByProjectAndAgentKey: {},
		workspaceOpenTargetPreferredApplicationId: null,
		projectNumericSlotGroupAssignmentsBySlotNumber: {},
		mostRecentlyUsedTaskCreateBaseRefByProjectId: {},
		taskPromptPseudoHtmlBlockRecentlyUsedCustomNames: [],
		taskEditorSettingPresentationBySettingKey: {} as Record<string, string>,
	};
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const names = decodeURIComponent(url.pathname.split("/api/trpc/")[1] ?? "").split(",");
		const payload = route.request().postDataJSON() ?? JSON.parse(url.searchParams.get("input") ?? "{}");
		const results = names.map((name, index) => {
			let value: unknown = null;
			if (name === "runtime.getConfig" || name === "runtime.saveConfig") {
				const patch = payload[index]?.userInterfacePreferencesSharedAcrossBrowserOrigins;
				if (patch)
					preferences = {
						...preferences,
						...patch,
						taskEditorSettingPresentationBySettingKey: {
							...preferences.taskEditorSettingPresentationBySettingKey,
							...patch.taskEditorSettingPresentationBySettingKey,
						},
					};
				value = { userInterfacePreferencesSharedAcrossBrowserOrigins: preferences };
			} else if (name === "workUnit.resolveKanbanBoardCardIdentityByBareTaskId")
				value = {
					kanbanBoardCardIdentityCandidates: [
						{
							kanbanBoardCard: {
								workUnitType: "kanban_board_card",
								workspaceId: "clipboard-project",
								taskId: payload[index]?.bareTaskId,
								taskIncarnationCreatedAtEpochMs: 1,
							},
							workspaceRepositoryPath: "/repo/clipboard-project",
							currentTitle: `剪贴板任务 ${payload[index]?.bareTaskId}`,
							permanentlyRemovedFromBoardAt: null,
						},
					],
				};
			else if (name === "workUnit.saveRelationModelingEditorDraft") value = { saved: true };
			else if (name === "support.analyzeTaskProjectAssignment")
				value = {
					operationId: payload[index]?.operationId,
					currentWorkspaceId: "isolated-task-editor-project",
					inputFingerprint: "controlled",
					suggestedWorkspaceId: null,
					suggestedProjectName: null,
					rationale: "当前项目合适",
					confidence: "high",
					stablePromptPrefixSha256: "controlled",
				};
			return { result: { data: value } };
		});
		await route.fulfill({ json: results });
	});
	await page.route("**/isolated-task-editor-floating-window", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-task-editor-floating-window");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/task-editor-floating-window-browser-harness.tsx" });
	await expect(page.getByRole("dialog", { name: "创建任务" })).toBeVisible();
}

test("桌面浮窗可拖动，背景可操作，折叠隐藏保留值且快捷键归属正确", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openEditorHarness(page);
	const dialog = page.getByRole("dialog", { name: "创建任务" });
	await expect(dialog).toHaveAttribute("aria-modal", "false");
	await expect(dialog.locator("textarea").first()).toBeFocused();
	const focusableControls = dialog.locator(
		'button:visible:not(:disabled), input:visible:not(:disabled), textarea:visible:not(:disabled), select:visible:not(:disabled), [tabindex="0"]:visible',
	);
	await focusableControls.last().focus();
	await page.keyboard.press("Tab");
	await expect(focusableControls.first()).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(focusableControls.last()).toBeFocused();
	const before = await dialog.boundingBox();
	expect(before?.width).toBeGreaterThan(1000);
	const header = page.getByRole("heading", { name: "创建任务" });
	const box = await header.boundingBox();
	if (!box) throw new Error("标题栏未出现");
	await page.mouse.move(box.x + 30, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(box.x + 110, box.y + 50);
	await page.mouse.up();
	const after = await dialog.boundingBox();
	expect(after?.x).toBeGreaterThan(before?.x ?? 0);
	await page.getByRole("button", { name: "操作背景 0" }).click();
	await expect(page.getByRole("button", { name: "操作背景 1" })).toBeVisible();
	await page.getByLabel("背景输入").fill("背景仍可输入");
	await page.getByLabel("背景输入").press("Control+Enter");
	await expect(dialog).toBeVisible();
	await page.getByLabel("背景输入").press("Escape");
	await expect(dialog).toBeVisible();
	await expect(page.getByLabel("背景输入")).toBeFocused();
	await page.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Task name" })).toBeHidden();
	await page.getByRole("button", { name: "展开任务编辑器", exact: true }).click();
	await page.getByRole("button", { name: "收起Plan Mode", exact: true }).click();
	await expect(page.getByRole("button", { name: "Plan Mode：开启" })).toBeVisible();
	await page.getByRole("button", { name: "Plan Mode：开启" }).click();
	await expect(page.getByRole("checkbox", { name: "Start in plan mode", exact: true })).toBeChecked();
	await page.getByRole("button", { name: "隐藏Plan Mode", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "Start in plan mode", exact: true })).toBeHidden();
	await page.getByRole("button", { name: /管理隐藏设置/ }).click();
	await page.getByRole("button", { name: "显示Plan Mode", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "Start in plan mode", exact: true })).toBeChecked();
	await page.setViewportSize({ width: 820, height: 700 });
	const resized = await dialog.boundingBox();
	expect(resized!.x).toBeGreaterThanOrEqual(8);
	expect(resized!.x + resized!.width).toBeLessThanOrEqual(820);
	expect(resized!.y).toBeLessThanOrEqual(636);
	await page.screenshot({ path: test.info().outputPath("desktop-task-editor.png") });
});

test("手机浮窗保留背景入口并避免横向溢出", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openEditorHarness(page);
	const bounds = await page.getByRole("dialog", { name: "创建任务" }).boundingBox();
	expect(bounds?.width).toBeLessThan(390);
	await page.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
	await page.getByRole("button", { name: "操作背景 0" }).click();
	await page.getByRole("button", { name: "展开任务编辑器", exact: true }).click();
	await page.screenshot({ path: test.info().outputPath("mobile-task-editor.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("从背景切回时解析剪贴板，临时揭示隐藏的关系组并保留正在编辑的对端", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await openEditorHarness(page);
	await page.getByRole("button", { name: "隐藏关系建模", exact: true }).click();
	await page.getByLabel("背景输入").focus();
	await page.evaluate(() => {
		document.body.dataset.controlledClipboardText = "ee150";
	});
	await page.getByRole("dialog", { name: "创建任务" }).locator("textarea").first().focus();
	await expect(page.getByText("剪贴板任务 ee150", { exact: true })).toBeVisible();
	await page.getByLabel("背景输入").focus();
	await page.evaluate(() => {
		document.body.dataset.controlledClipboardText = "ff160";
	});
	await page.getByRole("dialog", { name: "创建任务" }).locator("textarea").first().focus();
	await expect(page.getByText("剪贴板任务 ee150", { exact: true })).toBeVisible();
	await expect(page.getByText("剪贴板任务 ff160", { exact: true })).toHaveCount(0);
});
