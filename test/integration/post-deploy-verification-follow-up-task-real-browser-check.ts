import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type {
	RuntimeBoardData,
	RuntimePostDeployVerificationTask,
	RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse,
} from "../../src/core/api-contract";
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
	readNavigationTargets: (
		taskId: string,
	) => Promise<RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse>;
	recordAnotherDeployment: () => Promise<void>;
	restartRuntime: () => Promise<void>;
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
	await entry.getByRole("button", { name: "定位部署后验证", exact: true }).click();
	await observeUntil(
		async () => (await entry.getAttribute("class"))?.includes("verification-spotlight-active") === true,
		"从其他项目定位来源 Task 自身验证",
	);
	expect(new URL(page.url()).pathname).toBe(`/${input.otherWorkspaceId}`);
	recordCheck("其他项目视图中的 Task PDV 入口定位正确项目，保留当前看板范围");
	expect(await entry.getByPlaceholder("添加自定义核对项").count()).toBe(0);
	await entry.getByRole("button", { name: "添加自定义核对项", exact: true }).click();
	await entry.getByPlaceholder("添加自定义核对项").fill("取消的自定义项");
	await entry.getByPlaceholder("添加自定义核对项").press("Escape");
	expect(await entry.getByPlaceholder("添加自定义核对项").count()).toBe(0);
	recordCheck("自定义项默认不占输入行，按需展开且 Escape 不关闭面板");
	await entry.getByRole("button", { name: "创建关联续接任务", exact: true }).click();
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
	await entry.getByRole("button", { name: "创建关联续接任务", exact: true }).click();
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
	await entry.getByRole("button", { name: "创建关联续接任务", exact: true }).click();
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
	const sourceTarget = (await input.readNavigationTargets(created.id)).targets.find(
		(target) => target.navigationKind === "follow_up_origin_entry",
	);
	if (!sourceTarget) throw new Error("创建并刷新后缺少持久化来源定位");
	const sourceKey = JSON.stringify([
		sourceTarget.entry.workspaceId,
		sourceTarget.entry.deploymentId,
		sourceTarget.entry.taskId,
	]);
	const exactSourceEntry = page.locator(`[data-post-deploy-verification-entry-navigation-key='${sourceKey}']`);
	await input.recordAnotherDeployment();
	await input.restartRuntime();
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${input.webUiOrigin}/${input.sourceWorkspaceId}`);
	await page.getByTestId("open-post-deploy-verification-button").waitFor({ state: "visible" });
	const showCurrentProject = page.getByRole("button", { name: "Show only the current project", exact: true });
	if (await showCurrentProject.count()) await showCurrentProject.click();
	const createdCard = page.locator(`[data-task-id="${created.id}"]`);
	await createdCard.waitFor({ state: "visible" });
	await page.getByTestId("open-post-deploy-verification-button").click();
	await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板", exact: true }).click();
	await createdCard.getByRole("button", { name: "定位部署后验证", exact: true }).click();
	await exactSourceEntry.waitFor({ state: "visible" });
	await observeUntil(
		async () => (await exactSourceEntry.getAttribute("class"))?.includes("verification-spotlight-active") === true,
		"续接任务定位精确历史来源并高亮",
	);
	expect(await page.getByRole("dialog").count()).toBe(0);
	expect(sourceTarget.entry.deploymentId).not.toBe(
		(await input.readNavigationTargets(input.sourceTaskId)).targets.find(
			(target) => target.navigationKind === "task_own_entry",
		)?.entry.deploymentId,
	);
	await page.screenshot({
		path: join(input.evidenceOutputDirectory, "pdv-follow-up-exact-history-navigation-desktop.png"),
	});
	recordCheck("新部署且 runtime 重启后，续接 Task 仍精确定位历史来源，自动展开清单并高亮，点击不打开编辑器");
	await exactSourceEntry.getByRole("button", { name: "创建关联续接任务", exact: true }).click();
	await exactSourceEntry.getByRole("button", { name: "下一步", exact: true }).click();
	await observeUntil(
		async () => (await prompt.inputValue()).includes("仅携带来源任务和部署背景"),
		"历史来源可不选核对项创建草稿",
	);
	expect(await prompt.inputValue()).toContain(sourceTarget.entry.deploymentId);
	await page.keyboard.press("Escape");
	await page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();
	await dialog.waitFor({ state: "detached" });
	recordCheck("只读历史条目可仅携带背景创建关联续接草稿，取消后不增加卡片");
	await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板", exact: true }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await createdCard.getByRole("button", { name: "定位部署后验证", exact: true }).click();
	await exactSourceEntry.waitFor({ state: "visible" });
	await observeUntil(
		async () => (await exactSourceEntry.getAttribute("class"))?.includes("verification-spotlight-active") === true,
		"手机重复定位历史来源",
	);
	expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
	await page.screenshot({
		path: join(input.evidenceOutputDirectory, "pdv-follow-up-exact-history-navigation-mobile.png"),
	});
	recordCheck("手机上的 Task PDV 入口可重复展开历史来源，无横向溢出");
	await page.getByRole("button", { name: "折叠 Post-Deploy Verification 面板", exact: true }).click();
	await page.setViewportSize({ width: 1280, height: 900 });
	const ownTarget = (await input.readNavigationTargets(input.sourceTaskId)).targets.find(
		(target) => target.navigationKind === "task_own_entry",
	);
	if (!ownTarget) throw new Error("原 Task 缺少当前部署定位");
	const ownKey = JSON.stringify([ownTarget.entry.workspaceId, ownTarget.entry.deploymentId, ownTarget.entry.taskId]);
	const expandValidation = page.getByRole("button", { name: "Expand Validation column", exact: true });
	if (await expandValidation.count()) await expandValidation.click();
	await page
		.locator(`[data-task-id="${input.sourceTaskId}"]`)
		.getByRole("button", { name: "定位部署后验证", exact: true })
		.click();
	const exactOwnEntry = page.locator(`[data-post-deploy-verification-entry-navigation-key='${ownKey}']`);
	await observeUntil(
		async () => (await exactOwnEntry.getAttribute("class"))?.includes("verification-spotlight-active") === true,
		"原 Task 定位当前部署而非同号历史副本",
	);
	await page.screenshot({
		path: join(input.evidenceOutputDirectory, "pdv-original-task-current-deployment-navigation.png"),
	});
	recordCheck("原 Task 定位当前部署，续接来源定位精确历史副本，两种目标互不混淆");
	writeFileSync(
		join(input.evidenceOutputDirectory, "pdv-follow-up-created-task.json"),
		JSON.stringify(
			{ taskId: created.id, relation, initialCardCount, cardCountAfterRetry: cardsAfterRetry.length },
			null,
			2,
		),
	);
}
