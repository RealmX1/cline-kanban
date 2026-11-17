import { expect, type Page, test } from "@playwright/test";

async function openHarness(page: Page) {
	const errors: string[] = [];
	const observedWorkspaceHeaders: string[] = [];
	page.on("pageerror", (error) => {
		errors.push(error.message);
		throw error;
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = decodeURIComponent(url.pathname.split("/").at(-1) ?? "").split(",");
		const workspaceHeader = route.request().headers()["x-kanban-workspace-id"];
		const workspaceId = workspaceHeader ?? url.searchParams.get("workspace") ?? "project-a";
		observedWorkspaceHeaders.push(workspaceHeader ?? `missing:${workspaceId}`);
		const inputs = JSON.parse(url.searchParams.get("input") ?? route.request().postData() ?? "{}");
		const isBatchedRequest = url.searchParams.get("batch") === "1";
		const results = procedures.map((procedure, index) => {
			const input = isBatchedRequest ? (inputs[index] ?? {}) : inputs;
			let data: unknown = null;
			if (procedure === "workUnit.resolveKanbanBoardCardIdentityByBareTaskId")
				data = { kanbanBoardCardIdentityCandidates: [] };
			else if (procedure === "taskCardAction.readTaskCardWithBoardColumn") {
				const taskId = input.taskId;
				expect(taskId).toEqual(expect.any(String));
				const card = {
					id: taskId,
					title:
						taskId === "same1"
							? workspaceId === "project-a"
								? "甲项目详情"
								: "乙项目详情"
							: workspaceId === "project-a"
								? "甲项目草稿"
								: "乙项目草稿",
					prompt: workspaceId === "project-a" ? "甲项目原始正文" : "乙项目原始正文",
					baseRef: "main",
					startInPlanMode: true,
					createdAt: taskId === "same1" ? 100 : taskId === "edit1" ? 200 : 300,
					updatedAt: 100,
				};
				data = {
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: {
						workspaceId,
						taskCard: card,
						boardColumnIdContainingTaskCard: taskId === "same1" ? "review" : "backlog",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				};
			} else if (procedure === "runtime.getConfig" || procedure === "runtime.saveConfig")
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
			else if (procedure === "workspace.getState")
				data = { git: { defaultBranch: "main", branches: ["main"], currentBranch: "main" } };
			return { result: { data } };
		});
		await route.fulfill({ json: isBatchedRequest ? results : results[0] });
	});
	await page.route("**/isolated-task-visits", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-task-visits");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/visited-task-navigation-browser-harness.tsx" });
	return { errors, observedWorkspaceHeaders };
}

async function hotkey(page: Page, direction: "back" | "forward") {
	const mac = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
	return mac
		? direction === "back"
			? "Control+-"
			: "Control+Shift+-"
		: direction === "back"
			? "Alt+ArrowLeft"
			: "Alt+ArrowRight";
}

for (const width of [1440, 320]) {
	test(`${width}px 顶栏列表支持跨项目同号、键盘选择和前后导航`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		const { errors, observedWorkspaceHeaders } = await openHarness(page);
		await page.getByRole("button", { name: "打开甲项目详情", exact: true }).click();
		await page.getByRole("button", { name: "打开乙项目详情", exact: true }).click();
		await expect(page.getByLabel("当前详情")).toHaveText("project-b:same1");
		await expect(page.getByLabel("历史游标")).toHaveText("1");
		expect(observedWorkspaceHeaders).toContain("project-a");
		expect(observedWorkspaceHeaders).toContain("project-b");
		const controls = page.locator('[data-verification-anchor="visited-task-navigation"]');
		const bounds = await controls.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
		await page.getByRole("button", { name: "后退到已访问任务" }).click();
		await expect(page.getByLabel("当前详情")).toHaveText("project-a:same1");
		await page.getByRole("button", { name: "前进到已访问任务" }).click();
		await expect(page.getByLabel("当前详情")).toHaveText("project-b:same1");
		await page.getByRole("button", { name: "最近访问任务", exact: true }).click();
		const items = page.getByRole("menuitem");
		await expect(items).toHaveCount(2);
		await expect(items.nth(0)).toContainText("项目乙");
		await expect(items.nth(1)).toContainText("项目甲");
		const menuBounds = await page.getByRole("menu", { name: "最近访问任务" }).boundingBox();
		expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
		expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width);
		await page.screenshot({ path: test.info().outputPath(`task-history-${width}.png`) });
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("当前详情")).toHaveText("project-a:same1");
		await expect(page.getByLabel("历史游标")).toHaveText("2");
		expect(errors).toEqual([]);
	});
}

for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
	test(`${platform} xterm 聚焦时导航按键不发给 agent，长按不重复跳转，IME 与模态确认让行`, async ({ page }) => {
		await page.addInitScript((value) => Object.defineProperty(navigator, "platform", { value }), platform);
		const { errors } = await openHarness(page);
		await page.getByRole("button", { name: "打开甲项目详情", exact: true }).click();
		await page.getByRole("button", { name: "打开乙项目详情", exact: true }).click();
		await expect(page.getByLabel("历史游标")).toHaveText("1");
		const terminal = page.locator(".xterm-helper-textarea");
		await terminal.focus();
		await terminal.press(await hotkey(page, "back"));
		await expect(page.getByLabel("当前详情")).toHaveText("project-a:same1");
		await expect(page.getByLabel("发给 agent 的输入")).toHaveText('""');
		await terminal.press(await hotkey(page, "forward"));
		await expect(page.getByLabel("当前详情")).toHaveText("project-b:same1");
		await terminal.evaluate((element) => {
			const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
			for (const flags of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }])
				element.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: mac ? "-" : "ArrowLeft",
						code: mac ? "Minus" : "ArrowLeft",
						ctrlKey: mac,
						altKey: !mac,
						bubbles: true,
						cancelable: true,
						...flags,
					}),
				);
		});
		await expect(page.getByLabel("历史游标")).toHaveText("1");
		await page.getByRole("button", { name: "打开模态确认" }).click();
		await page.keyboard.press(await hotkey(page, "back"));
		await expect(page.getByRole("dialog", { name: "模态确认" })).toBeVisible();
		await expect(page.getByLabel("历史游标")).toHaveText("1");
		await page.getByRole("button", { name: "关闭模态确认" }).click();
		await page.getByRole("button", { name: "刷新元数据 0" }).click();
		await expect(page.getByLabel("历史游标")).toHaveText("1");
		expect(errors).toEqual([]);
	});
}

for (const width of [1440, 320]) {
	test(`${width}px Backlog 输入中的历史导航收起其他编辑窗并复用原草稿、字段节点和位置`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		const { errors } = await openHarness(page);
		await page.getByRole("button", { name: "打开甲项目详情", exact: true }).click();
		await page.getByRole("button", { name: "打开甲项目草稿", exact: true }).click();
		const firstDialog = page
			.locator("[data-non-modal-floating-form-window]")
			.filter({ hasText: "project-a / edit1" });
		const firstPrompt = firstDialog.getByRole("textbox", { name: "任务正文", exact: true });
		await firstPrompt.fill("保留甲项目草稿和选区");
		const headerBounds = await firstDialog.locator(".cursor-grab").boundingBox();
		await page.mouse.move(headerBounds!.x + 20, headerBounds!.y + 12);
		await page.mouse.down();
		await page.mouse.move(headerBounds!.x + (width > 320 ? 70 : 20), headerBounds!.y + 44);
		await page.mouse.up();
		await firstPrompt.evaluate((element: HTMLTextAreaElement) => {
			element.dataset.originalHistoryNode = "true";
			element.setSelectionRange(2, 5);
		});
		const originalBounds = await firstDialog.boundingBox();
		await firstPrompt.press(await hotkey(page, "back"));
		await expect(page.getByLabel("历史游标")).toHaveText("0");
		await expect(firstDialog).toHaveAttribute("data-collapsed", "true");
		await page.getByRole("button", { name: "前进到已访问任务" }).click();
		await expect(firstPrompt).toBeVisible();
		await expect(firstPrompt).toHaveValue("保留甲项目草稿和选区");
		await expect(firstPrompt).toHaveAttribute("data-original-history-node", "true");
		expect(
			await firstPrompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]),
		).toEqual([2, 5]);
		const restoredBounds = await firstDialog.boundingBox();
		expect(restoredBounds!.x).toBe(originalBounds!.x);
		expect(restoredBounds!.y).toBe(originalBounds!.y);
		await page.getByRole("button", { name: "收起任务编辑器" }).click();
		await page.getByRole("button", { name: "打开乙项目草稿", exact: true }).click();
		const secondDialog = page
			.locator("[data-non-modal-floating-form-window]")
			.filter({ hasText: "project-b / edit2" });
		const secondPrompt = secondDialog.getByRole("textbox", { name: "任务正文", exact: true });
		await secondPrompt.fill("保留乙项目草稿");
		await secondPrompt.press(await hotkey(page, "back"));
		await expect(firstPrompt).toBeVisible();
		await expect(firstPrompt).toHaveValue("保留甲项目草稿和选区");
		await expect(secondDialog).toHaveAttribute("data-collapsed", "true");
		await firstPrompt.press(await hotkey(page, "forward"));
		await expect(secondPrompt).toBeVisible();
		await expect(secondPrompt).toHaveValue("保留乙项目草稿");
		await expect(firstDialog).toHaveAttribute("data-collapsed", "true");
		expect(errors).toEqual([]);
	});
}
