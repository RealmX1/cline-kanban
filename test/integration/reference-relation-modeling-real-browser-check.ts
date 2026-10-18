import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import type { GetRelationNeighborhoodSummaryResponse } from "../../src/core/work-unit-relation-read-api-contract";
import type { Page } from "../../web-ui/node_modules/playwright-core";

export async function runReferenceRelationModelingRealBrowserCheck(input: {
	page: Page;
	workspaceId: string;
	webUiOrigin: string;
	evidenceOutputDirectory: string;
	focusId: string;
	chainStartId: string;
	chainMiddleId: string;
	chainEndId: string;
	seedRelation: (subjectTaskId: string, anchorTaskId: string) => Promise<unknown>;
	readBoard: () => Promise<RuntimeBoardData>;
	readNeighborhood: (taskId: string) => Promise<GetRelationNeighborhoodSummaryResponse>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
	recordCheck: (description: string) => void;
}) {
	const { page, workspaceId, webUiOrigin, evidenceOutputDirectory, observeUntil, recordCheck } = input;
	await input.seedRelation(input.chainStartId, input.chainMiddleId);
	await input.seedRelation(input.chainMiddleId, input.chainEndId);
	const getEditor = () => page.getByRole("region", { name: "任务关系建模", exact: true });
	async function addReference(taskId: string, reason: string) {
		const editor = getEditor();
		await editor.getByRole("button", { name: "添加关系", exact: true }).click();
		const search = editor.getByPlaceholder("Search tasks in all projects (title, prompt or task id)");
		await search.fill(taskId);
		await editor.locator(`[data-counterpart-candidate-kanban-board-card="${workspaceId}:${taskId}"]`).first().click();
		await editor.getByLabel("关系类型", { exact: true }).selectOption("reference_is_generally_related_with");
		await editor.getByLabel("关系理由", { exact: true }).fill(reason);
		await editor.getByLabel("证据位置（可选，每行一个）").fill("before-edit.md");
		await editor.getByRole("button", { name: "加入关系草稿", exact: true }).click();
		await editor.getByRole("group", { name: "新增参照关系", exact: true }).waitFor({ state: "detached" });
	}
	await page.goto(`${webUiOrigin}/${workspaceId}?task=${input.focusId}`);
	const relations = page.getByRole("region", { name: "Relations", exact: true });
	await relations.getByRole("button", { name: /^Relations/ }).click();
	await relations.getByRole("button", { name: "关系图与建模", exact: true }).click();
	await addReference(input.chainStartId, "浏览器验证：人工关联焦点任务");
	await getEditor().getByRole("button", { name: "保存关系变更", exact: true }).click();
	await observeUntil(
		async () => (await input.readNeighborhood(input.focusId)).assertedRelations.length === 1,
		"焦点任务关系落账",
	);
	recordCheck("Focus View 原 Relations section 内人工新增关系");
	const graph = getEditor().getByRole("group", { name: "任务多跳关系图" });
	await graph.locator(`[data-id]`).first().waitFor();
	await getEditor().getByRole("combobox", { name: "关系图跳数" }).selectOption("3");
	await observeUntil(
		async () => (await graph.textContent())?.includes("重试启动") ?? false,
		"第三跳包含已有人工参照关系",
	);
	await page.screenshot({ path: join(evidenceOutputDirectory, "focus-relations-three-hops-desktop.png") });
	recordCheck("默认两跳可展开至三跳，人工断言关系也参与展开");
	await getEditor().getByRole("button", { name: "列表", exact: true }).click();
	await getEditor().getByRole("button", { name: "修改", exact: true }).first().click();
	await getEditor().getByLabel("关系理由", { exact: true }).fill("浏览器验证：修改后的理由");
	await getEditor().getByLabel("证据位置（可选，每行一个）").fill("after-edit.md");
	await getEditor().getByRole("button", { name: "暂存修改", exact: true }).click();
	await getEditor().getByRole("button", { name: "保存关系变更", exact: true }).click();
	await observeUntil(
		async () =>
			(await input.readNeighborhood(input.focusId)).assertedRelations.some(
				(entry) => entry.relationAssertionEvidencePointers.join() === "after-edit.md",
			),
		"修改替代旧证据",
	);
	recordCheck("修改保存替代旧证据，非追加并集");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Sessions", exact: true }).click();
	const mobileRelations = page.getByRole("region", { name: "Relations", exact: true });
	await mobileRelations.getByRole("button", { name: /^Relations/ }).click();
	await mobileRelations.getByRole("button", { name: "关系图与建模", exact: true }).click();
	await getEditor().getByRole("button", { name: "关系图", exact: true }).click();
	await graph.locator(".react-flow__node").first().waitFor({ state: "visible" });
	await graph.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(evidenceOutputDirectory, "focus-relations-mobile.png") });
	expect(
		await page.evaluate(() => {
			const browserViewport = globalThis as unknown as {
				document: { documentElement: { scrollWidth: number } };
				innerWidth: number;
			};
			return browserViewport.document.documentElement.scrollWidth <= browserViewport.innerWidth;
		}),
	).toBe(true);
	recordCheck("手机宽度可切换列表与关系图，页面无横向溢出");
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto(`${webUiOrigin}/${workspaceId}`);
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	const dialog = page.getByRole("dialog").filter({ hasText: "New task" });
	await dialog.getByPlaceholder("Describe the task...").fill("浏览器验证：创建时关联任务");
	await dialog.getByLabel("Task name", { exact: true }).fill("[TEST]创建关系验收");
	await addReference(input.chainStartId, "浏览器验证：创建草稿关系");
	expect((await dialog.boundingBox())?.width).toBeGreaterThanOrEqual(900);
	await observeUntil(
		async () => (await graph.locator(".react-flow__node").count()) >= 3,
		"创建前虚拟根和两跳关系图可见",
	);
	await graph.locator(".react-flow__node").first().waitFor({ state: "visible" });
	await getEditor().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(evidenceOutputDirectory, "creation-pending-relations-preview.png") });
	recordCheck("创建草稿以虚拟根预览两跳，宽屏列表与关系图同时可见");
	const originalCount = (await input.readBoard()).columns.flatMap((column) => column.cards).length;
	let failNextWrite = true;
	await page.route("**/api/trpc/*", async (route) => {
		if (failNextWrite && route.request().url().includes("applyReferenceRelationModelingChangesDirectlyAsWebUiUser")) {
			failNextWrite = false;
			await route.abort("failed");
		} else await route.continue();
	});
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await dialog.getByText(/已创建，关系尚未保存/).waitFor();
	await observeUntil(
		async () => (await input.readBoard()).columns.flatMap((column) => column.cards).length === originalCount + 1,
		"失败前只创建一次任务",
	);
	await observeUntil(
		async () => await dialog.getByRole("button", { name: "Create", exact: true }).isEnabled(),
		"失败后可重试",
	);
	await page.screenshot({ path: join(evidenceOutputDirectory, "creation-relation-write-recovery.png") });
	await page.reload();
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	await observeUntil(
		async () => (await dialog.getByPlaceholder("Describe the task...").inputValue()).includes("创建时关联任务"),
		"页面刷新后恢复创建需求与原任务身份",
	);
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await dialog.waitFor({ state: "detached" });
	const cards = (await input.readBoard()).columns.flatMap((column) => column.cards);
	expect(cards.length).toBe(originalCount + 1);
	const created = cards.find((entry) => entry.title === "[TEST]创建关系验收");
	if (!created) throw new Error("创建关系验收卡片缺失");
	expect((await input.readNeighborhood(created.id)).assertedRelations.length).toBe(1);
	recordCheck("创建关系失败保留表单；页面刷新后重试仍保存原任务关系，不重复建卡");
	writeFileSync(
		join(evidenceOutputDirectory, "relation-modeling-created-task.json"),
		JSON.stringify({ taskId: created.id, cardCountBefore: originalCount, cardCountAfter: cards.length }),
	);
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	await dialog.getByPlaceholder("Describe the task...").fill("浏览器验证：先保存关系再启动");
	await dialog.getByLabel("Task name", { exact: true }).fill("[TEST]创建关系后启动验收");
	await addReference(input.chainStartId, "浏览器验证：启动顺序");
	let verifiedStartAfterRelationCommit = false;
	await page.route("**/api/trpc/taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress*", async (route) => {
		const body = route.request().postDataJSON() as { taskId?: string; "0"?: { taskId: string } };
		const request = body["0"] ?? body;
		if (!request.taskId) {
			await route.abort("failed");
			return;
		}
		verifiedStartAfterRelationCommit = (await input.readNeighborhood(request.taskId)).assertedRelations.length === 1;
		await route.continue();
	});
	await dialog
		.getByPlaceholder("Describe the task...")
		.press(process.platform === "darwin" ? "Meta+Shift+Enter" : "Control+Shift+Enter");
	await dialog.waitFor({ state: "detached" });
	expect(verifiedStartAfterRelationCommit).toBe(true);
	const startedState = await input.readBoard();
	expect(
		startedState.columns
			.find((column) => column.id === "in_progress")
			?.cards.some((card) => card.title === "[TEST]创建关系后启动验收"),
	).toBe(true);
	recordCheck("键盘 Create & Start 发出启动请求前，任务及参照关系已落账");
}
