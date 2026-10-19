import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { RuntimeBoardData, RuntimePostDeployVerificationTask } from "../../src/core/api-contract";
import type { GetRelationNeighborhoodSummaryResponse } from "../../src/core/work-unit-relation-read-api-contract";
import type { Page } from "../../web-ui/node_modules/playwright-core";

export async function runPostDeployVerificationFollowUpTaskRealBrowserCheck(input: {
	page: Page;
	sourceWorkspaceId: string;
	otherWorkspaceId: string;
	sourceTaskId: string;
	webUiOrigin: string;
	evidenceOutputDirectory: string;
	readSourceBoard: () => Promise<RuntimeBoardData>;
	readOtherBoard: () => Promise<RuntimeBoardData>;
	readSourceVerificationTask: () => Promise<RuntimePostDeployVerificationTask>;
	readNeighborhood: (taskId: string) => Promise<GetRelationNeighborhoodSummaryResponse>;
	observeUntil: (predicate: () => Promise<boolean>, description: string) => Promise<void>;
	recordCheck: (description: string) => void;
}) {
	const { page, observeUntil, recordCheck } = input;
	const failedRequestEvidence: Array<{ apiPath: string; failure: string | null }> = [];
	page.on("requestfailed", (request) => {
		const apiPath = new URL(request.url()).pathname;
		if (!apiPath.startsWith("/api/")) return;
		failedRequestEvidence.push({ apiPath, failure: request.failure()?.errorText ?? null });
		writeFileSync(
			join(input.evidenceOutputDirectory, "pdv-follow-up-request-failures.json"),
			JSON.stringify(failedRequestEvidence, null, 2),
		);
	});
	const initialSourceBoard = await input.readSourceBoard();
	const initialOtherBoard = await input.readOtherBoard();
	const initialVerification = await input.readSourceVerificationTask();
	const initialCardCount = initialSourceBoard.columns.flatMap((column) => column.cards).length;
	// 当前浏览器在另一个项目，All projects 下的 PDV 必须按来源项目建卡。
	await page.goto(`${input.webUiOrigin}/${input.otherWorkspaceId}`);
	await page.getByRole("button", { name: "Show all projects", exact: true }).click();
	await page.getByTestId("open-post-deploy-verification-button").click();
	const zone = page.locator(
		'[data-post-deploy-verification-deployment-attribution-zone="task_commits_not_yet_deployed_or_task_unattributable"]',
	);
	const zoneToggle = zone.getByRole("button").first();
	if ((await zoneToggle.getAttribute("aria-expanded")) === "false") await zoneToggle.click();
	const entry = page.locator(`[data-post-deploy-verification-task-entry="${input.sourceTaskId}"]`);
	await entry.waitFor({ state: "visible" });
	expect(await entry.getByPlaceholder("添加自定义核对项").count()).toBe(0);
	await entry.getByRole("button", { name: "添加自定义核对项", exact: true }).click();
	await entry.getByPlaceholder("添加自定义核对项").fill("取消的自定义项");
	await entry.getByPlaceholder("添加自定义核对项").press("Escape");
	expect(await entry.getByPlaceholder("添加自定义核对项").count()).toBe(0);
	recordCheck("自定义项默认不占输入行，按需展开且 Escape 不关闭面板");
	await entry.getByRole("button", { name: "从核对项新建后续任务", exact: true }).click();
	await entry.getByRole("checkbox", { name: "选择核对项：浏览器核对项甲", exact: true }).check();
	await entry.getByRole("checkbox", { name: "选择核对项：浏览器核对项乙", exact: true }).check();
	await entry.getByRole("button", { name: "下一步", exact: true }).click();
	const dialog = page.getByRole("dialog").filter({ hasText: "New task" });
	const prompt = dialog.getByPlaceholder("Describe the task...");
	await observeUntil(async () => (await prompt.inputValue()).includes("浏览器核对项乙"), "两项上下文预填");
	expect(await prompt.inputValue()).toContain("浏览器核对项甲");
	expect(await prompt.inputValue()).toContain("尚未核对，不代表验证失败");
	expect(await dialog.getByTestId("task-creation-target-project-field").textContent()).toContain("e2e-project-alpha");
	await dialog.getByLabel("Task name", { exact: true }).fill("[TEST]PDV 后续任务创建验收");
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "pdv-follow-up-prefilled-desktop.png") });
	recordCheck("跨项目面板多选预填两项上下文，目标项目锁定来源项目");
	let failNextRelationWrite = true;
	await page.route("**/api/trpc/*", async (route) => {
		if (
			failNextRelationWrite &&
			route.request().url().includes("applyReferenceRelationModelingChangesDirectlyAsWebUiUser")
		) {
			failNextRelationWrite = false;
			await route.abort("failed");
		} else await route.continue();
	});
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await observeUntil(async () => !failNextRelationWrite, "模拟的关系写入失败已发生");
	await dialog.getByText(/已创建，关系尚未保存/).waitFor();
	await dialog.getByText("Failed to fetch", { exact: true }).first().waitFor();
	await page.unroute("**/api/trpc/*");
	await observeUntil(
		async () =>
			(await input.readSourceBoard()).columns.flatMap((column) => column.cards).length === initialCardCount + 1,
		"关系失败前建卡仅一次",
	);
	await page.reload();
	// 草稿按项目隔离：从同一 PDV 来源入口重开，不能让当前 beta 项目的普通建卡入口恢复 alpha 草稿。
	await page.getByTestId("open-post-deploy-verification-button").click();
	if ((await zoneToggle.getAttribute("aria-expanded")) === "false") await zoneToggle.click();
	await entry.getByRole("button", { name: "从核对项新建后续任务", exact: true }).click();
	await entry.getByRole("checkbox", { name: "选择核对项：浏览器核对项甲", exact: true }).check();
	await entry.getByRole("checkbox", { name: "选择核对项：浏览器核对项乙", exact: true }).check();
	await entry.getByRole("button", { name: "下一步", exact: true }).click();
	await page.getByRole("alertdialog").getByRole("button", { name: "Keep editing", exact: true }).click();
	await observeUntil(
		async () => (await prompt.inputValue()).includes("浏览器核对项乙"),
		"刷新后恢复同一张卡和关系草稿",
	);
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await dialog.waitFor({ state: "detached" });
	const cardsAfterRetry = (await input.readSourceBoard()).columns.flatMap((column) => column.cards);
	expect(cardsAfterRetry.length).toBe(initialCardCount + 1);
	const created = cardsAfterRetry.find((card) => card.title === "[TEST]PDV 后续任务创建验收");
	if (!created) throw new Error("后续任务未保存到来源项目");
	const relation = (await input.readNeighborhood(created.id)).assertedRelations;
	expect(relation).toHaveLength(1);
	expect(relation[0]).toMatchObject({
		relationKind: "reference_requirement_originates_from",
		relationStatementSubjectWorkUnitRef: { taskId: created.id, workspaceId: input.sourceWorkspaceId },
		relationStatementAnchorWorkUnitRef: { taskId: input.sourceTaskId, workspaceId: input.sourceWorkspaceId },
	});
	expect(await input.readOtherBoard()).toEqual(initialOtherBoard);
	expect(await input.readSourceVerificationTask()).toEqual(initialVerification);
	recordCheck("关系写入失败后跨刷新重试不重复建卡，来源关系落账且不改原核对结果");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("open-post-deploy-verification-button").click();
	if ((await zoneToggle.getAttribute("aria-expanded")) === "false") await zoneToggle.click();
	await entry.getByRole("button", { name: "从核对项新建后续任务", exact: true }).click();
	const selection = entry.getByRole("checkbox", { name: "选择核对项：浏览器核对项甲", exact: true });
	await selection.check();
	await page.screenshot({ path: join(input.evidenceOutputDirectory, "pdv-follow-up-selection-mobile.png") });
	expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
	await entry.getByRole("button", { name: "下一步", exact: true }).click();
	await observeUntil(async () => (await prompt.inputValue()).includes("浏览器核对项甲"), "单项预填");
	expect(await prompt.inputValue()).not.toContain("浏览器核对项乙");
	await dialog.getByLabel("Task name", { exact: true }).fill("[TEST]PDV 后续任务启动验收");
	let startedAfterRelationCommit = false;
	await page.route("**/api/trpc/taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress*", async (route) => {
		const body = route.request().postDataJSON() as { taskId?: string; "0"?: { taskId: string } };
		const taskId = body["0"]?.taskId ?? body.taskId;
		startedAfterRelationCommit = !!taskId && (await input.readNeighborhood(taskId)).assertedRelations.length === 1;
		await route.continue();
	});
	await prompt.press(process.platform === "darwin" ? "Meta+Shift+Enter" : "Control+Shift+Enter");
	await dialog.waitFor({ state: "detached" });
	expect(startedAfterRelationCommit).toBe(true);
	expect(
		(await input.readSourceBoard()).columns
			.find((column) => column.id === "in_progress")
			?.cards.some((card) => card.title === "[TEST]PDV 后续任务启动验收"),
	).toBe(true);
	expect(await input.readSourceVerificationTask()).toEqual(initialVerification);
	recordCheck("手机宽度可多选与新建，单项上下文准确，关系落账后才启动隔离 agent 桩");
	writeFileSync(
		join(input.evidenceOutputDirectory, "pdv-follow-up-created-task.json"),
		JSON.stringify(
			{ taskId: created.id, relation, initialCardCount, cardCountAfterRetry: cardsAfterRetry.length },
			null,
			2,
		),
	);
}
