import { expect, type Page, test } from "@playwright/test";

const harnessPath = "/tests/form-primary-action-submit-keyboard-shortcut.html";

async function installIsolatedRuntimeResponses(page: Page) {
	// 拦住全部 API；关系事件只写进本用例的请求记录，不连接真实 HOME 的只追加账本。
	await page.route("**/api/**", async (route) => {
		const procedures = new URL(route.request().url()).pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const responses = procedures.map((procedure) => {
			let data: unknown = {};
			if (procedure === "projects.listDirectoryContents")
				data = {
					ok: true,
					rootPath: "/isolated",
					currentPath: "/isolated",
					parentPath: null,
					entries: [{ name: "project-a", path: "/isolated/project-a", isGitRepository: true }],
				};
			else if (procedure === "projects.add") data = { ok: true, project: { id: "isolated-added-project" } };
			else if (procedure === "projects.getAllProjectsTaskSearchIndex")
				data = {
					projects: [
						{
							projectId: "isolated-counterpart-workspace",
							projectName: "隔离项目",
							tasks: [
								{
									taskId: "other-task",
									title: "隔离关联任务",
									prompt: "快捷键测试",
									columnId: "in_progress",
									createdAt: 1,
									updatedAt: 2,
									agentId: null,
									mostRecentlyLaunchedAgentSessionAgentId: null,
									agentConversationProgressObservedAt: null,
								},
							],
						},
					],
				};
			else if (
				procedure === "workUnit.readRelationModelingEditorDraft" ||
				procedure === "workUnit.getRelationModelingPreview"
			)
				data = null;
			else if (procedure === "workUnit.resolveKanbanBoardCardIdentityByBareTaskId")
				data = {
					kanbanBoardCardIdentityCandidates: [
						{
							kanbanBoardCard: {
								workUnitType: "kanban_board_card",
								workspaceId: "isolated-counterpart-workspace",
								taskId: "other-task",
								taskIncarnationCreatedAtEpochMs: 1,
							},
							permanentlyRemovedFromBoardAt: null,
						},
					],
				};
			else if (procedure === "workUnit.assertReferenceRelationDirectlyAsWebUiUser")
				data = {
					relationAssertionWriteOutcome: "asserted_relation_applied_and_effective",
					relationStatementReadFromSubjectPerspective: "隔离关系已保存",
				};
			return { result: { data } };
		});
		await route.fulfill({ contentType: "application/json", body: JSON.stringify(responses) });
	});
}

test.beforeEach(async ({ page }) => installIsolatedRuntimeResponses(page));

for (const modifier of ["Meta", "Control"]) {
	test(`${modifier}+Enter 提交宿主，普通 Enter 换行，Shift/Alt 不提交`, async ({ page }) => {
		await page.goto(harnessPath);
		const input = page.getByRole("textbox", { name: "宿主表单正文", exact: true });
		await input.fill("第一行");
		await input.press("End");
		await input.press("Enter");
		await expect(input).toHaveValue("第一行\n");
		await input.press(`${modifier}+Shift+Enter`);
		await input.press(`${modifier}+Alt+Enter`);
		await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
		await input.press(`${modifier}+Enter`);
		await expect(page.getByLabel("宿主提交次数")).toHaveText("1");
		await expect(page.getByLabel("Diff 动作次数")).toHaveText("0");
	});
}

test("长按、禁用态及嵌套编辑器不会重复提交或穿透外层", async ({ page }) => {
	await page.goto(harnessPath);
	await page.getByRole("textbox", { name: "子表单正文", exact: true }).focus();
	await page.keyboard.down("Control");
	await page.keyboard.down("Enter");
	await page.keyboard.down("Enter");
	await page.keyboard.up("Enter");
	await page.keyboard.up("Control");
	await expect(page.getByLabel("子表单提交次数")).toHaveText("1");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await page.getByLabel("禁用提交").check();
	await page.getByRole("textbox", { name: "子表单正文", exact: true }).press("Meta+Enter");
	await page.getByRole("textbox", { name: "宿主表单正文", exact: true }).press("Control+Enter");
	await expect(page.getByLabel("子表单提交次数")).toHaveText("1");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await expect(page.getByLabel("Diff 动作次数")).toHaveText("0");
});

test("真实 IME 组字期间保留文本且不提交", async ({ page }) => {
	await page.goto(harnessPath);
	await page.getByRole("textbox", { name: "宿主表单正文", exact: true }).focus();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
	await cdp.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		windowsVirtualKeyCode: 13,
		key: "Enter",
		code: "Enter",
		modifiers: 2,
	});
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" });
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await expect(page.getByLabel("Diff 动作次数")).toHaveText("0");
	await cdp.send("Input.insertText", { text: "中文" });
	await page.getByRole("textbox", { name: "宿主表单正文", exact: true }).press("Control+Enter");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("1");
});

test("Portal 选择器不提交宿主，关闭表单后 Diff 快捷键继续可用", async ({ page }) => {
	await page.goto(harnessPath);
	await page.getByRole("button", { name: "打开 Portal 选择器" }).click();
	await page.getByLabel("Portal 选择器输入").press("Control+Enter");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await expect(page.getByLabel("Diff 动作次数")).toHaveText("0");
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByLabel("Diff 快捷键目标").focus();
	await page.keyboard.press("Control+Enter");
	await expect(page.getByLabel("Diff 动作次数")).toHaveText("1");
});

test("目录补全的 Enter 选择候选，组合键提交添加项目", async ({ page }) => {
	await page.goto(`${harnessPath}?view=projects`);
	const input = page.getByRole("combobox", { name: "Server path input" });
	await input.fill("project");
	await expect(page.getByRole("option")).toBeVisible();
	await input.press("ArrowDown");
	await input.press("Enter");
	await expect(input).toHaveValue("project-a/");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await input.fill("proj");
	await expect(page.getByRole("option")).toBeVisible();
	await input.press("ArrowDown");
	const request = page.waitForRequest((entry) => entry.url().includes("projects.add"));
	await input.press("Meta+Enter");
	expect((await request).postDataJSON()["0"].path).toBe("/isolated/proj");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("1");
});

test("解锁表单的组合键发送原校验请求且不重复发送", async ({ page }) => {
	let requests = 0;
	await page.route("**/api/passcode/verify", async (route) => {
		requests++;
		expect(route.request().postDataJSON()).toEqual({ passcode: "isolated-test-only" });
		await route.fulfill({ contentType: "application/json", body: "{}" });
	});
	await page.goto(`${harnessPath}?view=unlock`);
	await page.getByPlaceholder("Passcode").fill("isolated-test-only");
	await page.getByPlaceholder("Passcode").press("Control+Enter");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("1");
	expect(requests).toBe(1);
});

test("关系详情的组合键不提交外层，保存关系保留可信键盘事件", async ({ page }) => {
	await page.goto(`${harnessPath}?view=relations`);
	await page.getByRole("button", { name: "添加关系", exact: true }).click();
	await page
		.locator('[data-counterpart-candidate-kanban-board-card="isolated-counterpart-workspace:other-task"] button')
		.click();
	await page.getByRole("button", { name: "详情", exact: true }).click();
	await page.getByText("可选详情", { exact: true }).click();
	const reason = page.locator('input[id$="-reason"]');
	await reason.fill("保留本条关系详情");
	await reason.press("Control+Enter");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
	await page.getByRole("button", { name: "收起详情", exact: true }).first().click();
	const request = page.waitForRequest((entry) =>
		entry.url().includes("workUnit.applyReferenceRelationModelingChangesDirectlyAsWebUiUser"),
	);
	await page.getByRole("button", { name: "保存关系变更", exact: true }).press("Control+Enter");
	const payload = (await request).postDataJSON()["0"];
	expect(payload.webUiUserDecisionClientCharacteristics.triggeringDomEventIsTrusted).toBe(true);
	expect(payload.referenceRelationDrafts[0].relationAssertionRationaleOneSentence).toBe("保留本条关系详情");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
});

test("添加关系的组合键保留可信事件及对端身份", async ({ page }) => {
	await page.goto(`${harnessPath}?view=assertion`);
	await page
		.locator('[data-counterpart-candidate-kanban-board-card="isolated-counterpart-workspace:other-task"] button')
		.click();
	const request = page.waitForRequest((entry) =>
		entry.url().includes("workUnit.assertReferenceRelationDirectlyAsWebUiUser"),
	);
	await page.getByRole("button", { name: "Add relation", exact: true }).press("Meta+Enter");
	const payload = (await request).postDataJSON()["0"];
	expect(payload.webUiUserDecisionClientCharacteristics.triggeringDomEventIsTrusted).toBe(true);
	expect(payload.counterpartWorkUnit).toMatchObject({
		workspaceId: "isolated-counterpart-workspace",
		bareTaskId: "other-task",
	});
	await expect(page.getByLabel("关系写入次数")).toHaveText("1");
	await expect(page.getByLabel("宿主提交次数")).toHaveText("0");
});
