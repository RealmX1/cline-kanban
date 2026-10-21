import { expect, test } from "@playwright/test";

test("创建与已有任务的 AI 关系建议只在点击时查询，选择后才暂存；手机没有横向溢出", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const modelRequests: Record<string, unknown>[] = [];
	let selectedResponse: "candidate" | "empty" | "unavailable" | "failure" = "candidate";
	await page.route("**/api/trpc/**", async (route) => {
		const url = new URL(route.request().url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
		const responses = procedures.map((procedure, index) => {
			if (procedure === "workUnit.suggestReferenceRelationsForTaskModeling") {
				modelRequests.push(inputs[String(index)]);
				if (selectedResponse === "failure")
					return {
						error: {
							message: "模型服务暂不可用",
							code: -32603,
							data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
						},
					};
				return {
					result: {
						data: {
							availability: selectedResponse === "unavailable" ? "unavailable" : "available",
							unavailableReason: selectedResponse === "unavailable" ? "缺少当前完整要求" : null,
							contextAsOf: 1,
							contextCompleteness: [],
							candidates:
								selectedResponse === "candidate"
									? [
											{
												candidateId: "candidate",
												rationale: "已有任务承担同一范围的工作",
												evidencePointers: ["src/example.ts:1"],
												relationDraft: {
													draftId: "candidate",
													replacesRelationId: null,
													expectedAssertedRelationStateVersion: null,
													counterpartWorkUnit: {
														workUnitType: "kanban_board_card",
														workspaceId: "isolated-project",
														taskId: "related-task",
														taskIncarnationCreatedAtEpochMs: 1,
													},
													relationKind: "reference_is_generally_related_with",
													currentTaskIsStatementSubject: true,
													relationAssertionRationaleOneSentence: "已有任务承担同一范围的工作",
													relationAssertionEvidencePointers: ["src/example.ts:1"],
													assertedRelationKindSpecificAttributes: {},
												},
											},
										]
									: [],
						},
					},
				};
			}
			if (procedure === "workUnit.readRelationModelingEditorDraft") return { result: { data: null } };
			if (procedure === "workUnit.getRelationModelingPreview")
				return {
					result: {
						data: {
							rootWorkUnitKey: "draft",
							workUnits: [],
							relations: [],
							truncated: false,
							projectedThroughGlobalCommittedEventSequence: 0,
						},
					},
				};
			return { result: { data: { saved: true } } };
		});
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(url.searchParams.has("batch") ? responses : responses[0]),
		});
	});
	await page.route("**/isolated-task-relation-suggestions", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto("/isolated-task-relation-suggestions");
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({
		type: "module",
		url: "/tests/task-indexing-support-relation-suggestions-browser-harness.tsx",
	});
	const requestButton = page.getByRole("button", { name: "获取关系建议", exact: true });
	await expect(requestButton).toBeEnabled();
	expect(modelRequests).toHaveLength(0);
	await requestButton.click();
	await expect(page.getByText("已有任务承担同一范围的工作", { exact: true })).toBeVisible();
	expect(modelRequests[0]).toMatchObject({ workUnit: null, draftTaskPrompt: "完整需求：修复同一问题" });
	await expect(page.getByText("创建中的任务，草稿 0 条")).toBeVisible();
	await page.getByRole("button", { name: "加入草稿", exact: true }).click();
	await expect(page.getByText("创建中的任务，草稿 1 条")).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("relation-suggestions-create-desktop.png") });
	await page.getByRole("button", { name: "切换任务模式" }).click();
	selectedResponse = "empty";
	await requestButton.click();
	await expect(page.getByText("本次未找到相关任务。")).toBeVisible();
	expect(modelRequests[1]).toMatchObject({
		workUnit: { bareTaskId: "current-task", workspaceId: "isolated-project" },
	});
	selectedResponse = "unavailable";
	await requestButton.click();
	await expect(page.getByText("缺少当前完整要求")).toBeVisible();
	selectedResponse = "failure";
	await requestButton.click();
	await expect(page.getByRole("alert")).toContainText("模型服务暂不可用");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: test.info().outputPath("relation-suggestions-mobile-error.png") });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	expect(pageErrors).toEqual([]);
});
