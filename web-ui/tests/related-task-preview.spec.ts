import { expect, type Page, test } from "@playwright/test";
import type { DirectlyRelatedTaskPreviewEntry } from "../../src/core/work-unit-relation-read-api-contract";

function entry(
	taskId: string,
	column = "review",
	overrides: Partial<DirectlyRelatedTaskPreviewEntry> = {},
): DirectlyRelatedTaskPreviewEntry {
	return {
		task: { workUnitType: "kanban_board_card", workspaceId: "project-b", taskId, taskIncarnationCreatedAtEpochMs: 2 },
		title: `关联任务 ${taskId}`,
		workspaceRepositoryPath: "/isolated/project-b",
		lastKnownBoardColumnId: column,
		permanentlyRemovedFromBoardAt: null,
		identityKnownToLedger: true,
		mutedOnly: false,
		relations: [
			{
				relationId: taskId,
				relationKind: "provenance_created_by",
				relationClass: "recorded",
				directionFromPreviewSubject: "outgoing",
				mutedInPresentation: false,
				assertionActorKind: null,
				assertionDecisionSources: [],
			},
		],
		...overrides,
	};
}

async function openIsolatedPreview(page: Page, host = "board") {
	const reads: string[] = [];
	const taskCardSnapshotReadRequests: Array<Record<string, unknown>> = [];
	const mutations: Array<{ procedure: string; input: Record<string, unknown> }> = [];
	const pageErrors: string[] = [];
	const entries = [
		entry("review"),
		entry("backlog", "backlog"),
		entry("done", "trash"),
		entry("removed", "trash", { permanentlyRemovedFromBoardAt: 3 }),
		entry("unavailable", "review", {
			task: {
				workUnitType: "kanban_board_card",
				workspaceId: "unavailable-project",
				taskId: "unavailable",
				taskIncarnationCreatedAtEpochMs: 2,
			},
		}),
		entry("muted", "review", { mutedOnly: true }),
	];
	const taskCardSnapshots = new Map(
		entries.map((selected) => [
			selected.task.taskId,
			{
				taskCard: {
					id: selected.task.taskId,
					title: selected.title ?? selected.task.taskId,
					prompt: "完整卡片原始描述",
					agentId: "codex",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 2,
					updatedAt: 2,
				},
				boardColumnIdContainingTaskCard: selected.lastKnownBoardColumnId,
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		]),
	);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		// 所有网络读写都在浏览器内截获，不访问真实 HOME 的关系账本或看板。
		const request = route.request();
		const url = new URL(request.url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(
			request.method() === "GET" ? (url.searchParams.get("input") ?? "{}") : (request.postData() ?? "{}"),
		) as Record<string, Record<string, unknown>>;
		const results = procedures.map((procedure, index) => {
			const input = inputs[index] ?? {};
			if (request.method() === "POST") mutations.push({ procedure, input });
			else reads.push(procedure);
			let result: unknown = { tasks: [] };
			if (procedure === "workUnit.getDirectlyRelatedTaskPreviewPage")
				result = {
					subjectTask: input.task,
					entries,
					totalTaskCount: entries.length,
					mutedOnlyTaskCount: 1,
					standaloneSessionCount: 2,
					neighborhoodRevision: "stable",
					nextCursor: null,
				};
			if (procedure === "taskCardAction.readTaskCardWithBoardColumn") {
				taskCardSnapshotReadRequests.push(input);
				result = {
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: taskCardSnapshots.get(String(input.taskId)),
				};
			}
			if (request.method() === "POST" && procedure.startsWith("taskCardAction.")) {
				const snapshot = taskCardSnapshots.get(String(input.taskId));
				if (snapshot) {
					if (procedure === "taskCardAction.updateTaskCardFieldValues") {
						const fieldUpdate = input.taskCardFieldUpdate as { taskCardFieldValuePatch: Record<string, unknown> };
						Object.assign(snapshot.taskCard, fieldUpdate.taskCardFieldValuePatch);
					}
					if (procedure === "taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress")
						snapshot.boardColumnIdContainingTaskCard = "in_progress";
					if (procedure === "taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects")
						snapshot.boardColumnIdContainingTaskCard = String(input.targetBoardColumnId);
					result = {
						taskCardSnapshotAfterAction: snapshot,
						taskCardPlacementWasChangedByThisAction: true,
						boardColumnIdOfTaskCardBeforeAction: "review",
						agentSessionStartOutcome: "agent_session_started",
					};
				}
			}

			if (procedure === "deployment.getPostDeployVerificationState")
				result = { deploymentGroups: [], activeDeploymentId: null };
			return { result: { data: result } };
		});
		await route.fulfill({ json: results });
	});
	await page.routeWebSocket("**/*", () => {});
	await page.route("**/isolated-related-task-preview*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-related-task-preview?host=${host}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/related-task-preview-browser-harness.tsx" });
	const source =
		host === "focus"
			? page
					.locator(
						'[data-task-id="subject"]:visible, [data-task-card-render-role="focused_card_copy_under_sticky_stage_header"]:visible',
					)
					.first()
			: host === "sticky"
				? page.locator('[data-task-card-render-role="focused_card_copy_under_sticky_stage_header"]')
				: host === "mobile"
					? page.locator('[data-task-card-render-role="focused_task_card_copy_in_mobile_detail_header"]')
					: page.locator('[data-task-id="subject"]');
	const trigger = source.locator("[data-related-tasks-preview-trigger]");
	await expect(trigger).toBeVisible();

	return { reads, taskCardSnapshotReadRequests, mutations, pageErrors, trigger, source };
}

for (const host of ["board", "focus", "sticky"]) {
	test(`${host} 宿主悬停列表与右卡可达，预览不递归、不创建会话`, async ({ page }) => {
		const fixture = await openIsolatedPreview(page, host);
		expect(
			fixture.reads.filter((procedure) => procedure === "workUnit.getDirectlyRelatedTaskPreviewPage"),
		).toHaveLength(0);
		await fixture.trigger.hover();
		const popover = page.locator("[data-related-tasks-preview-dialog]");
		await expect(popover).toBeVisible();
		await popover.locator('[data-related-task-open="review"]').hover();
		const fullCard = popover.locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
		await expect(fullCard).toBeVisible();
		await fullCard.hover();
		await expect(popover).toBeVisible();
		await expect(fullCard).not.toHaveAttribute("data-task-id");
		await expect(fullCard.locator("[data-related-tasks-preview-trigger]")).toHaveCount(0);
		expect(
			fixture.reads.filter((procedure) => procedure === "taskCardAction.readTaskCardWithBoardColumn"),
		).toHaveLength(1);
		expect(fixture.mutations).toEqual([]);
		await expect(page.getByLabel("已打开任务")).toHaveText("");
		await page.screenshot({ path: test.info().outputPath(`${host}-preview.png`) });
		expect(fixture.pageErrors).toEqual([]);
	});
}

test("键盘打开、独立预览、完整删除确认与 Esc 逐层返回", async ({ page }) => {
	const fixture = await openIsolatedPreview(page);
	await fixture.trigger.focus();
	await page.keyboard.press("ArrowDown");
	const popover = page.locator("[data-related-tasks-preview-dialog]");
	await expect(popover).toBeFocused();
	await popover.locator('[data-related-task-preview="review"]').focus();
	await page.keyboard.press("Enter");
	const fullCard = popover.locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
	await fullCard.hover();
	await fullCard.getByRole("button", { name: "Delete task permanently", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.mouse.move(0, 0);
	await expect(popover).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(popover).toBeVisible();
	await expect.poll(() => popover.evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
	await expect(fixture.trigger).toBeFocused();
	await expect(page.getByLabel("已打开任务")).toHaveText("");
	await fixture.trigger.click();
	await popover.locator('[data-related-task-open="review"]').click();
	await expect(page.getByLabel("已打开任务")).toHaveText("project-b:review:2");
	expect(fixture.mutations).toEqual([]);
	expect(fixture.pageErrors).toEqual([]);
});

test("Done 保留恢复与导航，永久删除与不可用项目不可操作，静音单列", async ({ page }) => {
	const fixture = await openIsolatedPreview(page);
	await fixture.trigger.click();
	const popover = page.locator("[data-related-tasks-preview-dialog]");
	await popover.locator('[data-related-task-preview="done"]').click();
	await expect(popover.getByRole("button", { name: "Restore task from done", exact: true })).toBeVisible();
	await popover.locator('[data-related-task-preview="removed"]').click();
	await expect(popover.locator('[data-related-task-open="removed"]')).toBeDisabled();
	await expect(popover.locator("[data-related-full-task-card-preview]")).toHaveCount(0);
	await expect(popover).toContainText("已永久删除");
	await expect(popover.locator('[data-related-task-open="unavailable"]')).toBeDisabled();
	await expect(popover.locator('[data-related-task-open="muted"]')).not.toBeVisible();
	await popover.getByText("已静音关联 · 1", { exact: true }).click();
	await expect(popover.locator('[data-related-task-open="muted"]')).toBeVisible();
	await expect(popover).toContainText("另有 2 个关联独立会话");
	expect(fixture.pageErrors).toEqual([]);
});

test.describe("触屏等价入口", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	test("点按展开列表、完整卡片位于下方、编辑弹窗保持预览", async ({ page }) => {
		const fixture = await openIsolatedPreview(page, "mobile");
		await fixture.trigger.tap();
		const popover = page.locator("[data-related-tasks-preview-dialog]");
		await popover.locator('[data-related-task-preview="backlog"]').tap();
		const fullCard = popover.locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
		await expect(fullCard).toBeVisible();
		const previewBox = await page.locator("[data-related-full-task-card-preview]").boundingBox();
		const listBox = await popover.locator("ul").first().boundingBox();
		expect(previewBox!.y).toBeGreaterThan(listBox!.y);
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
		await fullCard.getByRole("button", { name: "Edit task title", exact: true }).tap();
		await expect(page.getByRole("dialog", { name: "编辑关联任务" })).toBeVisible();
		await expect(popover).toBeVisible();
		await page.getByLabel("关联任务描述").fill("触屏编辑仍保留预览");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "编辑关联任务" })).toHaveCount(0);
		await expect(popover).toBeVisible();
		await page.screenshot({ path: test.info().outputPath("mobile-preview.png") });
		expect(fixture.pageErrors).toEqual([]);
	});
});

test("完整卡片的启动、移列与置顶沿既有命令发送并携带一世身份", async ({ page }) => {
	const fixture = await openIsolatedPreview(page);
	await fixture.trigger.click();
	const popover = page.locator("[data-related-tasks-preview-dialog]");
	await popover.locator('[data-related-task-preview="review"]').click();
	const fullCard = popover.locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
	await fullCard.getByRole("button", { name: "Move task to validation", exact: true }).click();
	await expect.poll(() => fixture.mutations.length).toBe(1);
	expect(fixture.mutations[0]).toMatchObject({
		procedure: "taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects",
		input: { taskId: "review", targetBoardColumnId: "validation", expectedTaskIncarnationCreatedAtEpochMs: 2 },
	});
	await expect(fullCard).toHaveAttribute("data-column-id", "validation");
	await expect(popover.locator('[data-related-task-open="review"]')).toContainText("待验证");
	await popover.locator('[data-related-task-preview="backlog"]').click();
	await fullCard.getByRole("button", { name: "Start task", exact: true }).click();
	await expect.poll(() => fixture.mutations.length).toBe(2);
	expect(fixture.mutations[1]).toMatchObject({
		procedure: "taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress",
		input: { taskId: "backlog", expectedTaskIncarnationCreatedAtEpochMs: 2 },
	});
	await expect(fullCard).toHaveAttribute("data-column-id", "in_progress");
	await expect(popover.locator('[data-related-task-open="backlog"]')).toContainText("进行中");
	await fullCard.getByRole("button", { name: "Pin task to pinboard", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Pin task to pinboard" })).toBeVisible();
	await page
		.getByRole("dialog", { name: "Pin task to pinboard" })
		.getByRole("button", { name: "Pin", exact: true })
		.click();
	await expect.poll(() => fixture.mutations.length).toBe(3);
	expect(fixture.mutations[2]).toMatchObject({
		procedure: "taskCardAction.setTaskPinboardPinStateOfTaskCard",
		input: { taskId: "backlog", expectedTaskIncarnationCreatedAtEpochMs: 2 },
	});
	expect(fixture.pageErrors).toEqual([]);
});

test("完整关联卡的评论打开、保存前重读与最终写入均携带一世身份", async ({ page }) => {
	const fixture = await openIsolatedPreview(page);
	await fixture.trigger.click();
	const popover = page.locator("[data-related-tasks-preview-dialog]");
	await popover.locator('[data-related-task-preview="review"]').click();
	const fullCard = popover.locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
	await expect(fullCard).toBeVisible();
	const readCountBeforeComments = fixture.taskCardSnapshotReadRequests.length;
	await fullCard.getByRole("button", { name: "任务评论", exact: true }).click();
	const commentsDialog = page.getByRole("dialog", { name: "任务评论 · 关联任务 review", exact: true });
	await expect(commentsDialog).toBeVisible();
	await expect(popover).toBeVisible();
	await commentsDialog.getByPlaceholder("Write a task comment...").fill("评论仅保存到预览中的这一世任务");
	await commentsDialog.getByRole("button", { name: "Add comment", exact: true }).click();
	await expect.poll(() => fixture.mutations.length).toBe(1);
	expect(fixture.taskCardSnapshotReadRequests.slice(readCountBeforeComments, readCountBeforeComments + 2)).toEqual([
		{ taskId: "review", expectedTaskIncarnationCreatedAtEpochMs: 2 },
		{ taskId: "review", expectedTaskIncarnationCreatedAtEpochMs: 2 },
	]);
	expect(fixture.mutations[0]).toMatchObject({
		procedure: "taskCardAction.updateTaskCardFieldValues",
		input: {
			taskId: "review",
			expectedTaskIncarnationCreatedAtEpochMs: 2,
			taskCardFieldUpdate: {
				taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
				taskCardFieldValuePatch: {
					taskCommentEntries: [expect.objectContaining({ commentText: "评论仅保存到预览中的这一世任务" })],
				},
			},
		},
	});
	await expect(commentsDialog.getByPlaceholder("Edit task comment...")).toHaveValue("评论仅保存到预览中的这一世任务");
	await expect(commentsDialog.getByRole("alert")).toHaveCount(0);
	expect(fixture.pageErrors).toEqual([]);
});
