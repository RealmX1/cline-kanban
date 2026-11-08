import { expect, type Locator, type Page, test } from "@playwright/test";

async function expectCheckedSwitchThumbOnRight(checkedSwitch: Locator) {
	await expect
		.poll(async () => {
			const trackBounds = await checkedSwitch.boundingBox();
			const thumbBounds = await checkedSwitch.locator("span").boundingBox();
			return trackBounds && thumbBounds ? Math.round(thumbBounds.x - trackBounds.x) : null;
		})
		.toBe(18);
}

async function mountEditorHarness(page: Page) {
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/task-editor-floating-window-browser-harness.tsx" });
	await expect(page.getByRole("dialog", { name: /创建任务|编辑 Backlog 任务/ })).toBeVisible();
}

for (const mode of ["create", "edit"] as const) {
	test(`任务简介在 ${mode} 窗口独立编辑并保留正文与后台交互`, async ({ page }) => {
		await openEditorHarness(page, { mode });
		const prompt = page.getByRole("textbox", { name: "任务正文", exact: true });
		const original = await prompt.inputValue();
		const description = page.getByRole("textbox", { name: "任务简介", exact: true });
		await description.fill("描述观测问题、当前范围和修正后的方案");
		await expect(prompt).toHaveValue(original);
		await page.getByRole("button", { name: "操作背景 0" }).click({ force: true });
		await expect(description).toHaveValue("描述观测问题、当前范围和修正后的方案");
	});
}

async function openEditorHarness(
	page: Page,
	options: {
		failAutomaticAnalysisPreferenceSaves?: boolean;
		mode?: "create" | "edit";
		failFirstModelCatalogRead?: boolean;
	} = {},
) {
	const observations = {
		analysisRequestCount: 0,
		savedAutomaticAnalysisChoices: [] as boolean[],
		savedCustomBlockNameLists: [] as string[][],
		lastSavedRelationDrafts: [] as unknown[],
		modelCatalogReadCount: 0,
		remainingModelCatalogFailures: options.failFirstModelCatalogRead ? 1 : 0,
		sideSessionCreationRequests: [] as Array<Record<string, unknown>>,
	};
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { readText: async () => document.body.dataset.controlledClipboardText ?? "" },
		});
	});
	await page.routeWebSocket("**/*", () => {});
	let preferences = {
		taskProjectAssignmentAutomaticAnalysisEnabled: null as boolean | null,
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
				if (Array.isArray(patch?.taskPromptPseudoHtmlBlockRecentlyUsedCustomNames)) {
					observations.savedCustomBlockNameLists.push([...patch.taskPromptPseudoHtmlBlockRecentlyUsedCustomNames]);
				}
				if (typeof patch?.taskProjectAssignmentAutomaticAnalysisEnabled === "boolean") {
					if (options.failAutomaticAnalysisPreferenceSaves)
						return {
							error: {
								message: "隔离测试模拟保存失败",
								code: -32603,
								data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
							},
						};
					observations.savedAutomaticAnalysisChoices.push(patch.taskProjectAssignmentAutomaticAnalysisEnabled);
				}
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
			} else if (name === "runtime.getTerminalAgentModelSelectionOptions") {
				observations.modelCatalogReadCount++;
				const failThisModelCatalogRead = observations.remainingModelCatalogFailures > 0;
				if (failThisModelCatalogRead) observations.remainingModelCatalogFailures--;
				value = failThisModelCatalogRead
					? {
							agentId: "codex",
							defaultModelId: null,
							defaultLabel: "默认",
							options: [],
							warning: "目录读取暂时失败",
						}
					: {
							agentId: "codex",
							defaultModelId: null,
							defaultLabel: "默认",
							options: [
								{
									modelId: "fixture-model",
									label: "默认模型",
									supportedReasoningEfforts: [{ effort: "high" }, { effort: "max" }, { effort: "ultra" }],
									defaultReasoningEffort: "high",
									modelSelectionGroup: "latest_tracking_alias",
								},
								{
									modelId: "limited-model",
									label: "受限模型",
									supportedReasoningEfforts: [{ effort: "low" }],
									modelSelectionGroup: "latest_tracking_alias",
								},
							],
						};
			} else if (name === "runtime.getCodexConfigurationSyncState") {
				value = {
					revision: 1,
					changes: [],
					sourceObservations: [],
					observationProblem: null,
					defaultCodexConfigurationProfileId: "fixture-profile",
					profiles: [
						{
							profileId: "fixture-profile",
							name: "默认配置",
							sourceIdentity: "source",
							version: 1,
							fields: [
								{
									fieldKey: JSON.stringify(["config.toml", "model"]),
									fieldLabel: "model",
									value: "fixture-model",
									valueSummary: "fixture-model",
									version: 1,
									exceptionGroup: "model",
								},
								{
									fieldKey: JSON.stringify(["config.toml", "model_reasoning_effort"]),
									fieldLabel: "effort",
									value: "high",
									valueSummary: "high",
									version: 1,
									exceptionGroup: "reasoning_effort",
								},
							],
						},
					],
				};
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
			else if (name === "workUnit.getRelationModelingPreview")
				value = {
					rootWorkUnitKey: "draft-root",
					workUnits: [],
					relations: [],
					truncated: false,
					projectedThroughGlobalCommittedEventSequence: 0,
				};
			else if (name === "workUnit.saveRelationModelingEditorDraft") {
				observations.lastSavedRelationDrafts = payload[index]?.draft?.referenceRelationDrafts ?? [];
				value = { saved: true };
			} else if (name === "runtime.lookupTaskConversationSessionCreation") value = null;
			else if (name === "runtime.createTaskConversationSession") {
				observations.sideSessionCreationRequests.push(payload[index]);
				return {
					error: {
						message: "模拟创建失败，输入保持",
						code: -32603,
						data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
					},
				};
			} else if (name === "workspace.allocateTaskIdForNewWebUiTaskCard")
				value = { allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry: "abcde" };
			else if (name === "support.analyzeTaskProjectAssignment") {
				observations.analysisRequestCount++;
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
			}
			return { result: { data: value } };
		});
		await route.fulfill({ json: url.searchParams.get("batch") === "1" ? results : results[0] });
	});
	await page.route("**/isolated-task-editor-floating-window*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-task-editor-floating-window?mode=${options.mode ?? "create"}`);
	await mountEditorHarness(page);
	return observations;
}

for (const mode of ["create", "edit"] as const) {
	test(`${mode} 共用推理强度选择，默认模型可独立设置并显示不兼容错误`, async ({ page }) => {
		await page.setViewportSize({ width: 1100, height: 1000 });
		await openEditorHarness(page, { mode });
		await page.getByRole("button", { name: /模型与参数：/ }).click();
		const effort = page.getByLabel("推理强度", { exact: true });
		await expect(effort).toHaveValue("");
		await expect(effort.locator("option").first()).toHaveText("沿用 Codex 配置（high）");
		await effort.selectOption("ultra");
		await page.getByRole("button", { name: "收起模型与参数", exact: true }).click();
		await expect(page.getByRole("button", { name: /模型与参数：.*推理：ultra/ })).toBeVisible();
		await page.getByRole("button", { name: /模型与参数：/ }).click();
		await expect(effort).toHaveValue("ultra");
		await page.getByRole("button", { name: "受限模型", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("不支持推理强度 ultra");
		await expect(
			page.getByRole("button", { name: mode === "create" ? "创建任务" : "保存更改", exact: true }),
		).toBeDisabled();
		await effort.selectOption("low");
		await expect(page.getByRole("alert")).toHaveCount(0);
		await effort.selectOption("");
		await expect(effort).toHaveValue("");
		await page.screenshot({ path: test.info().outputPath(`codex-effort-${mode}.png`) });
	});
}

test("目录读取失败后自动重验，手机上可选 max 和 ultra", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const observations = await openEditorHarness(page, { failFirstModelCatalogRead: true });
	await page.getByRole("button", { name: /模型与参数：/ }).click();
	await expect(page.getByRole("status").filter({ hasText: "暂时无法核验此模型" })).toBeVisible();
	await expect.poll(() => observations.modelCatalogReadCount).toBeGreaterThan(1);
	const effort = page.getByLabel("推理强度", { exact: true });
	await effort.selectOption("max");
	await effort.selectOption("ultra");
	await expect(effort).toHaveValue("ultra");
	observations.remainingModelCatalogFailures = 1;
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await expect(page.getByRole("status").filter({ hasText: "暂时无法核验此模型" })).toBeVisible();
	await expect(effort).toHaveValue("ultra");
	await expect(page.getByRole("status").filter({ hasText: "暂时无法核验此模型" })).toHaveCount(0);
	await expect(effort).toHaveValue("ultra");
	await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
	await effort.scrollIntoViewIfNeeded();
	await page.screenshot({ path: test.info().outputPath("codex-effort-mobile.png") });
});

test("自动归属开关默认关闭，手动分析可用，键盘切换后刷新恢复全局偏好", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const observations = await openEditorHarness(page);
	await page.getByRole("button", { name: "项目归属分析", exact: true }).click();
	const automaticAnalysisSwitch = page.getByRole("switch", { name: "自动分析项目归属" });
	await expect(automaticAnalysisSwitch).not.toBeChecked();
	await page.getByRole("button", { name: "创建任务", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute("data-task-editor-submission-count", "1");
	expect(observations.analysisRequestCount).toBe(0);
	await page.getByRole("button", { name: "分析项目归属", exact: true }).click();
	await expect.poll(() => observations.analysisRequestCount).toBe(1);
	await expect(page.getByRole("button", { name: "分析项目归属", exact: true })).toBeEnabled();
	await automaticAnalysisSwitch.focus();
	await page.keyboard.press("Space");
	await expect(automaticAnalysisSwitch).toBeChecked();
	await page.getByRole("button", { name: "创建任务", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute("data-task-editor-submission-count", "2");
	expect(observations.analysisRequestCount).toBe(2);
	await automaticAnalysisSwitch.focus();
	await page.keyboard.press("Enter");
	await expect(automaticAnalysisSwitch).not.toBeChecked();
	await page.keyboard.press("Space");
	await expect.poll(() => observations.savedAutomaticAnalysisChoices).toEqual([true, false, true]);
	await page.reload();
	await mountEditorHarness(page);
	await expect(page.getByRole("switch", { name: "自动分析项目归属" })).toBeChecked();
	await expectCheckedSwitchThumbOnRight(page.getByRole("switch", { name: "自动分析项目归属" }));
	await page.screenshot({ path: test.info().outputPath("desktop-automatic-project-assignment-analysis.png") });
});

test("自动分析偏好保存失败明确提示并保留当前选择", async ({ page }) => {
	await openEditorHarness(page, { failAutomaticAnalysisPreferenceSaves: true });
	await page.getByRole("button", { name: "项目归属分析", exact: true }).click();
	const automaticAnalysisSwitch = page.getByRole("switch", { name: "自动分析项目归属" });
	await automaticAnalysisSwitch.click();
	await expect(page.getByText(/“自动分析项目归属”偏好尚未保存到运行时/)).toBeVisible();
	await expect(automaticAnalysisSwitch).toBeChecked();
});

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
	expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(false);
	await focusableControls.first().focus();
	await page.keyboard.press("Shift+Tab");
	await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(false);
	await expect(page.locator(":focus")).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(focusableControls.first()).toBeFocused();
	const before = await dialog.boundingBox();
	expect(before?.width).toBeGreaterThan(700);
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
	await expect(page.getByRole("textbox", { name: "任务名称（可选）" })).toBeHidden();
	await page.getByRole("button", { name: "展开任务编辑器", exact: true }).click();
	await expect(page.getByRole("button", { name: "Plan Mode：开启" })).toBeVisible();
	await page.getByRole("button", { name: "Plan Mode：开启" }).click();
	await page.getByRole("button", { name: "收起Plan Mode", exact: true }).click();
	await expect(page.getByRole("button", { name: "Plan Mode：开启" })).toBeVisible();
	await page.getByRole("button", { name: "Plan Mode：开启" }).click();
	await expect(page.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true })).toBeChecked();
	await page.getByRole("button", { name: "隐藏Plan Mode", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true })).toBeHidden();
	await page.getByRole("button", { name: /管理隐藏设置/ }).click();
	await page.getByRole("button", { name: "显示Plan Mode", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true })).toBeChecked();
	await page.setViewportSize({ width: 820, height: 700 });
	await expect
		.poll(async () => {
			const resized = await dialog.boundingBox();
			return Boolean(resized && resized.x >= 8 && resized.x + resized.width <= 820 && resized.y <= 636);
		})
		.toBe(true);
	await page.screenshot({ path: test.info().outputPath("desktop-task-editor.png") });
});

test("手机浮窗保留背景入口并避免横向溢出", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openEditorHarness(page);
	const bounds = await page.getByRole("dialog", { name: "创建任务" }).boundingBox();
	expect(bounds?.width).toBeLessThan(390);
	await page.getByRole("button", { name: "项目归属分析", exact: true }).click();
	const automaticAnalysisSwitch = page.getByRole("switch", { name: "自动分析项目归属" });
	await automaticAnalysisSwitch.scrollIntoViewIfNeeded();
	await expect(automaticAnalysisSwitch).not.toBeChecked();
	await automaticAnalysisSwitch.click();
	await expect(automaticAnalysisSwitch).toBeChecked();
	await expectCheckedSwitchThumbOnRight(automaticAnalysisSwitch);
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
	await expect(page.getByRole("button", { name: /关联 .*剪贴板任务 ee150/ })).toBeVisible();
	await expect(page.getByRole("list", { name: "待保存关联任务" }).locator("li")).toHaveCount(0);
	await page.getByRole("button", { name: /关联 .*剪贴板任务 ee150/ }).click();
	await expect(page.getByRole("list", { name: "待保存关联任务" }).locator("li")).toHaveCount(1);
	await page.getByRole("button", { name: "详情", exact: true }).click();
	await page.getByLabel("背景输入").focus();
	await page.evaluate(() => {
		document.body.dataset.controlledClipboardText = "ff160";
	});
	await page.getByRole("dialog", { name: "创建任务" }).locator("textarea").first().focus();
	await expect(page.getByRole("list", { name: "待保存关联任务" })).toContainText("ee150");
	await expect(page.getByRole("button", { name: /关联 .*剪贴板任务 ff160/ })).toHaveCount(0);
});

for (const mode of ["create", "edit"] as const) {
	test(`${mode}：中文 Insert block 支持输入法确认、鼠标插入和最近使用恢复`, async ({ page }) => {
		const observations = await openEditorHarness(page, { mode });
		const prompt = page.getByRole("textbox", { name: "任务正文", exact: true });
		const selectedText = "需要保留的正文";
		await prompt.fill(selectedText);
		await prompt.press("ControlOrMeta+A");
		await page.getByRole("button", { name: "Insert block", exact: true }).click();
		const blockNameInput = page.getByPlaceholder("Block name...", { exact: true });
		await blockNameInput.focus();
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Input.imeSetComposition", { text: "问题", selectionStart: 2, selectionEnd: 2 });
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			windowsVirtualKeyCode: 13,
			key: "Enter",
			code: "Enter",
		});
		await cdp.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			windowsVirtualKeyCode: 13,
			key: "Enter",
			code: "Enter",
		});
		await expect(blockNameInput).toBeFocused();
		await expect(prompt).toHaveValue(selectedText);
		await cdp.send("Input.insertText", { text: "问题" });
		await expect(page.getByRole("button", { name: "Insert <问题> block", exact: true })).toBeVisible();
		await blockNameInput.press("Enter");
		await expect(blockNameInput).toHaveCount(0);
		await expect(prompt).toHaveValue(`<问题>\n${selectedText}\n</问题>`);
		await expect(prompt).toBeFocused();
		expect(
			await prompt.evaluate((textarea: HTMLTextAreaElement) => [textarea.selectionStart, textarea.selectionEnd]),
		).toEqual(["<问题>\n".length, "<问题>\n".length + selectedText.length]);

		await prompt.fill("");
		await page.getByRole("button", { name: "Insert block", exact: true }).click();
		await blockNameInput.fill("预期 结果");
		await page.getByRole("button", { name: "Insert <预期_结果> block", exact: true }).click();
		await expect(prompt).toHaveValue("<预期_结果>\n\n</预期_结果>");
		await expect(prompt).toBeFocused();
		expect(
			await prompt.evaluate((textarea: HTMLTextAreaElement) => [textarea.selectionStart, textarea.selectionEnd]),
		).toEqual(["<预期_结果>\n".length, "<预期_结果>\n".length]);
		await expect.poll(() => observations.savedCustomBlockNameLists.at(-1)).toEqual(["预期_结果", "问题"]);

		await page.reload();
		await mountEditorHarness(page);
		await page.getByRole("button", { name: "Insert block", exact: true }).click();
		await expect(page.getByRole("button", { name: "<问题>", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "<预期_结果>", exact: true })).toBeVisible();
	});

	for (const width of [1440, 320] as const) {
		test(`${mode}：${width}px 仅正文即可提交，设置摘要和底栏保持在边界内`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await openEditorHarness(page, { mode });
			const dialog = page.getByRole("dialog", {
				name: mode === "create" ? "创建任务" : "编辑 Backlog 任务",
				exact: true,
			});
			await expect(dialog.getByRole("textbox", { name: "任务名称（可选）" })).toHaveValue("");
			await expect(dialog.getByRole("button", { name: "Agent：codex", exact: true })).toBeVisible();
			await expect(dialog.getByRole("button", { name: "基础分支：main", exact: true })).toBeVisible();
			await expect(dialog.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true })).toBeHidden();
			await dialog.getByRole("textbox", { name: "任务正文", exact: true }).fill("只填写正文的创建或编辑要求");
			const submit = dialog.getByRole("button", { name: mode === "create" ? "创建任务" : "保存更改", exact: true });
			await expect(submit).toBeVisible();
			await submit.click();
			await expect(page.locator("body")).toHaveAttribute("data-task-editor-submission-count", "1");
			await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
			for (const locator of [dialog.getByRole("textbox", { name: "任务正文", exact: true }), submit]) {
				const bounds = await locator.boundingBox();
				expect(bounds).not.toBeNull();
				expect(bounds!.x).toBeGreaterThanOrEqual(0);
				expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
			}
			await page.screenshot({ path: test.info().outputPath(`${mode}-${width}-prompt-first.png`) });
		});
	}
}

test("未采纳的剪贴板候选不阻塞正文创建", async ({ page }) => {
	await openEditorHarness(page);
	await page.getByLabel("背景输入").focus();
	await page.evaluate(() => {
		document.body.dataset.controlledClipboardText = "ee150";
	});
	await page.getByRole("textbox", { name: "任务正文", exact: true }).focus();
	await expect(page.getByRole("button", { name: /关联 .*剪贴板任务 ee150/ })).toBeVisible();
	await expect(page.getByRole("list", { name: "待保存关联任务" }).locator("li")).toHaveCount(0);
	await page.getByRole("button", { name: "创建任务", exact: true }).click();
	await expect(page.locator("body")).toHaveAttribute("data-task-editor-submission-count", "1");
});

test("六种关系不填详情均进入列表，方向修改与收起后刷新恢复", async ({ page }) => {
	const observations = await openEditorHarness(page);
	await page.getByLabel("背景输入").focus();
	await page.evaluate(() => {
		document.body.dataset.controlledClipboardText = "ee150";
	});
	await page.getByRole("textbox", { name: "任务正文", exact: true }).focus();
	await page.getByRole("button", { name: /关联 .*剪贴板任务 ee150/ }).click();
	const pendingRelations = page.getByRole("list", { name: "待保存关联任务" });
	await expect(pendingRelations.locator("li")).toHaveCount(1);
	const kind = pendingRelations.getByRole("combobox", { name: "待保存关系类型" });
	await expect(kind).toHaveValue("reference_is_generally_related_with");
	for (const relationKind of [
		"reference_concerns_behavior_or_state_of",
		"reference_verifies_claims_of",
		"reference_reuses_produced_outputs_of",
		"reference_requirement_originates_from",
		"reference_is_cross_repository_counterpart_with",
		"reference_is_generally_related_with",
	]) {
		await kind.selectOption(relationKind);
		await expect
			.poll(() => observations.lastSavedRelationDrafts)
			.toEqual([
				expect.objectContaining({
					relationKind,
					relationAssertionRationaleOneSentence: "",
					relationAssertionEvidencePointers: [],
					assertedRelationKindSpecificAttributes: {},
				}),
			]);
	}
	await kind.selectOption("reference_concerns_behavior_or_state_of");
	await pendingRelations.getByRole("button", { name: "详情", exact: true }).click();
	await page.getByRole("combobox", { name: "陈述方向", exact: true }).selectOption("other");
	await page.getByRole("button", { name: "收起详情", exact: true }).first().click();
	await expect
		.poll(() => observations.lastSavedRelationDrafts)
		.toEqual([expect.objectContaining({ currentTaskIsStatementSubject: false })]);
	await page.reload();
	await mountEditorHarness(page);
	await expect(pendingRelations.locator("li")).toHaveCount(1);
	await pendingRelations.getByRole("button", { name: "详情", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "陈述方向", exact: true })).toHaveValue("other");
});

for (const viewport of [
	{ width: 1440, height: 1000 },
	{ width: 390, height: 844 },
]) {
	test(`共享创建工作台 ${viewport.width}：Task、Peer 与 By the way 保留独立草稿和固定目标`, async ({ page }) => {
		await page.setViewportSize(viewport);
		const observations = await openEditorHarness(page);
		await page.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "新建 Peer 会话", exact: true });
		await expect(dialog).toHaveAttribute("aria-modal", "false");
		await dialog.locator("textarea").fill("Peer 的独立正文");
		await dialog.getByLabel("会话名称（可选）", { exact: true }).fill("Peer 主题");
		await dialog.getByRole("button", { name: "Plan Mode：关闭", exact: true }).click();
		await dialog.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true }).check();
		await dialog.getByLabel("创建类型", { exact: true }).selectOption("by_the_way");
		dialog = page.getByRole("dialog", { name: "新建 By the way 会话", exact: true });
		await expect(dialog.locator("textarea")).toHaveValue("");
		await expect(dialog.getByRole("checkbox", { name: "以 Plan Mode 启动", exact: true })).not.toBeChecked();
		await dialog.locator("textarea").fill("By the way 正文");
		await dialog.getByLabel("创建类型", { exact: true }).selectOption("task_collaborator");
		dialog = page.getByRole("dialog", { name: "新建 Peer 会话", exact: true });
		await expect(dialog.locator("textarea")).toHaveValue("Peer 的独立正文");
		await expect(dialog.getByLabel("会话名称（可选）", { exact: true })).toHaveValue("Peer 主题");
		await dialog.getByRole("button", { name: "收起会话创建", exact: true }).click();
		await page.getByRole("button", { name: "操作背景 0", exact: true }).click();
		await dialog.getByRole("button", { name: "展开会话创建", exact: true }).click();
		await dialog.getByRole("button", { name: "创建会话", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("模拟创建失败");
		await expect(dialog.locator("textarea")).toHaveValue("Peer 的独立正文");
		expect(observations.sideSessionCreationRequests[0]).toMatchObject({
			taskId: "abcde",
			expectedTaskIncarnationCreatedAtEpochMs: 1,
			initialMessage: "Peer 的独立正文",
			startInPlanMode: true,
			conversationSessionName: "Peer 主题",
		});
		await page.screenshot({ path: test.info().outputPath(`shared-workbench-${viewport.width}.png`) });
		await page.reload();
		await mountEditorHarness(page);
		await page.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		dialog = page.getByRole("dialog", { name: "新建 Peer 会话", exact: true });
		await expect(dialog.locator("textarea")).toHaveValue("Peer 的独立正文");
	});
}
