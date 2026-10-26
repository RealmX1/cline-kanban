import { expect, type Page, test } from "@playwright/test";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "../../src/core/api-contract";
import type { AssertedInterWorkUnitRelation } from "../../src/core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { RecordedInterWorkUnitRelation } from "../../src/core/inter-work-unit-recorded-relation-projection-contract";
import type { RelationModelingPreviewResponse } from "../../src/core/work-unit-relation-modeling-api-contract";
import type { WorkUnitDisplayEntry } from "../../src/core/work-unit-relation-read-api-contract";

function displayEntry(
	taskId: string,
	workspaceId = taskId === "root" ? "project-a" : "project-b",
): WorkUnitDisplayEntry {
	const workUnit = {
		workUnitType: "kanban_board_card" as const,
		workspaceId,
		taskId,
		taskIncarnationCreatedAtEpochMs: 1_000,
	};
	return {
		workUnitKey: `kanban_board_card:${workspaceId}:${taskId}:1000`,
		workUnit,
		workUnitDisplayLabel: `任务 ${taskId}`,
		kanbanBoardCardIdentity: {
			kanbanBoardCard: workUnit,
			workspaceRepositoryPath: `/isolated/${workspaceId}`,
			currentTitle: `任务 ${taskId}`,
			promptFirstParagraph: `描述 ${taskId}`,
			lastKnownBoardColumnId: taskId === "backlog" ? "backlog" : taskId === "done" ? "trash" : "review",
			movedToTrashColumnAt: taskId === "done" ? 2_000 : null,
			permanentlyRemovedFromBoardAt: taskId === "removed" ? 3_000 : null,
			creationActorKind: null,
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture",
		},
	};
}
async function openRelations(page: Page, host = "panel") {
	const entries = ["root", "review", "backlog", "done", "second-hop", "rebuilt", "removed"].map((taskId) =>
		displayEntry(taskId),
	);
	entries.push(displayEntry("unavailable", "unavailable-project"), displayEntry("missing", "unregistered-project"));
	entries.push({
		workUnitKey: "standalone:codex:session",
		workUnit: {
			workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId: "codex",
			nativeConversationSessionId: "session",
		},
		workUnitDisplayLabel: "关联独立会话",
		kanbanBoardCardIdentity: null,
	});
	const root = entries[0]!;
	const review = entries[1]!;
	const recorded = {
		relationId: "recorded-created",
		relationKind: "provenance_created_by",
		relationStatementSubjectWorkUnitRef: review.workUnit,
		relationStatementAnchorWorkUnitRef: root.workUnit,
		relationFirstEstablishedAt: 1_000,
		relationLastUpdatedAt: 1_000,
		mostRecentProjectedFromEventIds: [],
		captureChannelsOfDerivingEvents: ["live_runtime_capture"],
		occurrenceCountByTaskMutationEventKind: {},
		recordedRelationKindSpecificAttributes: {},
		isCreationTimePrimaryProvenanceOfSubjectCard: false,
		mutedInPresentationAt: null,
		mutedInPresentationByActorKind: null,
	} satisfies RecordedInterWorkUnitRelation;
	const asserted = {
		relationId: "asserted-backlog",
		relationKind: "reference_reuses_produced_outputs_of",
		relationStatementSubjectWorkUnitRef: root.workUnit,
		relationStatementAnchorWorkUnitRef: entries[2]!.workUnit,
		relationFirstEstablishedAt: 1_000,
		relationLastUpdatedAt: 1_000,
		assertedRelationStateVersion: 1,
		relationAsserterWorkUnitRef: root.workUnit,
		relationAsserterActorKind: "kanban_board_card_work_unit",
		relationAssertionRationaleOneSentence: "复用另一个任务的实现",
		relationAssertionEvidencePointers: [],
		assertedRelationKindSpecificAttributes: { reusedOutputSummary: "实现" },
		decisionSourcesOfEffectiveAssertion: [],
		relationContributingAgentWorkUnitRefs: [],
		relationAssertionNaturalKey: "asserted-backlog",
		assertionEffectivenessState: "applied_and_effective",
		relationAsserterPolicyIdentityKey: null,
		effectiveConfirmableChangeIdForCurrentAssertionState: "asserted-backlog",
		effectiveConfirmableChangeDecisionSource: "strategy_requires_no_user_review",
		effectiveConfirmableChangeAppliedAt: 1_000,
		reassertingActorKinds: [],
		revokedAt: null,
		relationAssertionRevocationReason: null,
		revokedByActorKind: null,
	} satisfies AssertedInterWorkUnitRelation;
	const preview: RelationModelingPreviewResponse = {
		rootWorkUnitKey: root.workUnitKey,
		workUnits: entries,
		relations: entries.slice(1).map((entry, index) => ({
			relationId: `edge-${index}`,
			subjectKey:
				entry.workUnit.workUnitType === "kanban_board_card" && entry.workUnit.taskId === "second-hop"
					? review.workUnitKey
					: root.workUnitKey,
			anchorKey: entry.workUnitKey,
			relationKind: index === 1 ? "reference_reuses_produced_outputs_of" : "provenance_created_by",
			relationPresentationState: "saved",
			assertedRelation: null,
		})),
		truncated: false,
		projectedThroughGlobalCommittedEventSequence: 1,
	};
	const reads: Array<{ procedure: string; input: Record<string, unknown> }> = [];
	const mutations: Array<{ procedure: string; input: Record<string, unknown> }> = [];
	const pageErrors: string[] = [];
	const failNextRead = { taskId: "" };
	const recreatedCounterpart = { taskId: "" };
	const snapshots = new Map<string, RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries>(
		entries
			.filter((entry) => entry.workUnit.workUnitType === "kanban_board_card")
			.map((entry): [string, RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries] => {
				const ref = entry.workUnit;
				if (ref.workUnitType !== "kanban_board_card") throw new Error("需要任务身份");
				return [
					ref.taskId,
					{
						taskCard: {
							id: ref.taskId,
							title: `任务 ${ref.taskId}`,
							prompt: `完整描述 ${ref.taskId}`,
							agentId: "codex",
							baseRef: "main",
							startInPlanMode: false,
							createdAt: ref.taskId === "rebuilt" ? 2_000 : 1_000,
							updatedAt: 1_000,
						},
						boardColumnIdContainingTaskCard:
							ref.taskId === "backlog" ? "backlog" : ref.taskId === "done" ? "trash" : "review",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				];
			}),
	);
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const procedures = url.pathname.split("/api/trpc/")[1]?.split(",") ?? [];
		const inputs = JSON.parse(
			request.method() === "GET" ? (url.searchParams.get("input") ?? "{}") : (request.postData() ?? "{}"),
		) as Record<string, Record<string, unknown>>;
		const results = procedures.map((procedure, index) => {
			const input = inputs[index] ?? {};
			(request.method() === "POST" ? mutations : reads).push({ procedure, input });
			let result: unknown = { tasks: [] };
			if (procedure === "workUnit.getRelationNeighborhoodSummary")
				result = {
					subjectWorkUnit: root,
					recordedRelations: [recorded],
					assertedRelations: [asserted],
					neighborWorkUnits: entries.slice(1),
					secondHopRecordedRelations: [],
					secondHopNeighborWorkUnits: [],
					conversationSessionOwnershipConflictDiagnostics: [],
					renderedNeighborhoodSummaryText: "隔离关系摘要",
					hasAnyRelationVisibleByDefault: true,
					recordedInterWorkUnitRelationProjectionTableVersion: 1,
					projectedThroughGlobalCommittedEventSequence: 1,
				};
			if (procedure === "projects.getAllProjectsTaskSearchIndex") result = { projects: [] };
			if (procedure === "workUnit.readRelationModelingEditorDraft") result = null;
			if (procedure === "workUnit.getRelationModelingPreview")
				result =
					input.workUnit === null
						? {
								...preview,
								rootWorkUnitKey: "pending-task-creation",
								workUnits: entries.slice(1),
								relations: preview.relations.map((relation) => ({
									...relation,
									subjectKey:
										relation.subjectKey === root.workUnitKey ? "pending-task-creation" : relation.subjectKey,
								})),
							}
						: preview;
			if (procedure === "workUnit.resolveKanbanBoardCardIdentityByBareTaskId") {
				const selected = entries.find(
					(entry) =>
						entry.workUnit.workUnitType === "kanban_board_card" && entry.workUnit.taskId === input.bareTaskId,
				)?.workUnit;
				result = {
					kanbanBoardCardIdentityCandidates:
						selected?.workUnitType === "kanban_board_card"
							? [
									{
										kanbanBoardCard: {
											...selected,
											taskIncarnationCreatedAtEpochMs:
												recreatedCounterpart.taskId === selected.taskId
													? 2_000
													: selected.taskIncarnationCreatedAtEpochMs,
										},
										permanentlyRemovedFromBoardAt: null,
									},
								]
							: [],
				};
			}
			if (procedure === "taskCardAction.readTaskCardWithBoardColumn") {
				if (failNextRead.taskId === input.taskId) {
					failNextRead.taskId = "";
					return {
						error: {
							message: "隔离读取故障",
							code: -32603,
							data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
						},
					};
				}
				result = {
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: snapshots.get(String(input.taskId)),
				};
			}
			if (request.method() === "POST" && procedure.startsWith("taskCardAction.")) {
				const snapshot = snapshots.get(String(input.taskId));
				if (snapshot) {
					if (procedure === "taskCardAction.updateTaskCardFieldValues")
						Object.assign(
							snapshot.taskCard,
							(input.taskCardFieldUpdate as { taskCardFieldValuePatch: Record<string, unknown> })
								.taskCardFieldValuePatch,
						);
					if (procedure === "taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects") {
						const columnId = input.targetBoardColumnId;
						if (columnId === "review" || columnId === "validation" || columnId === "in_progress")
							snapshot.boardColumnIdContainingTaskCard = columnId;
					}
					result = {
						taskCardSnapshotAfterAction: snapshot,
						taskCardPlacementWasChangedByThisAction: true,
						boardColumnIdOfTaskCardBeforeAction: "review",
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
	await page.route("**/isolated-relations-task-preview*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body></body></html>",
		}),
	);
	await page.goto(`/isolated-relations-task-preview?host=${host}`);
	await page.addScriptTag({
		type: "module",
		content:
			"import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;",
	});
	await page.addScriptTag({ type: "module", url: "/tests/relations-task-card-preview-browser-harness.tsx" });
	if (host === "panel") await expect(page.getByRole("region", { name: "Relations", exact: true })).toBeVisible();
	else await expect(page.getByRole("dialog", { name: "创建任务", exact: true })).toBeVisible();
	return { entries, reads, mutations, failNextRead, recreatedCounterpart, pageErrors };
}
const pane = (page: Page) => page.locator("[data-relations-task-card-preview]");
const fullCard = (page: Page) =>
	pane(page).locator('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
const node = (page: Page, taskId: string) =>
	page.locator(
		`.react-flow__node[data-id="kanban_board_card:${taskId === "root" ? "project-a" : "project-b"}:${taskId}:1000"]`,
	);

test("记录型与断言型摘要都可悬停、固定和切换，独立打开携带完整身份", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page);
	expect(
		fixture.reads.filter((entry) => entry.procedure === "taskCardAction.readTaskCardWithBoardColumn"),
	).toHaveLength(0);
	await page.getByRole("button", { name: "预览 任务 review", exact: true }).hover();
	await expect(fullCard(page)).toBeVisible();
	await expect(fullCard(page)).not.toHaveAttribute("data-task-id");
	await expect(fullCard(page).locator("[data-related-tasks-preview-trigger]")).toHaveCount(0);
	await page.getByRole("button", { name: "预览 任务 review", exact: true }).click();
	await page.getByRole("button", { name: "预览 任务 backlog", exact: true }).hover();
	await expect(fullCard(page)).toContainText("任务 review");
	await page.getByRole("button", { name: "预览 任务 backlog", exact: true }).click();
	await expect(fullCard(page)).toContainText("任务 backlog");
	await page.screenshot({ path: test.info().outputPath("desktop-relations-preview.png") });
	await fullCard(page).getByRole("button", { name: "Edit task title", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "编辑关联任务" })).toBeVisible();
	await expect(pane(page)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(pane(page)).toBeVisible();
	await page.getByRole("button", { name: "预览 任务 review", exact: true }).click();
	await pane(page).getByRole("button", { name: "打开任务", exact: true }).click();
	await expect(page.getByLabel("当前聚焦任务")).toHaveText("project-b:review");
	await expect(page.getByLabel("已导航任务")).toHaveText("project-b:review:1000");
	expect(fixture.pageErrors).toEqual([]);
});

test("图根、多跳节点均预览，固定切换保持缩放、草稿与图实例，导航同步退出前台", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page);
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	const foreground = page.locator('[data-expanded-foreground-view="active"]');
	await expect(node(page, "root")).toBeVisible();
	await node(page, "root").hover();
	await expect(fullCard(page)).toContainText("任务 root");
	await node(page, "second-hop").focus();
	await page.keyboard.press("Enter");
	await expect(fullCard(page)).toContainText("任务 second-hop");
	await foreground.getByRole("button", { name: "添加关系", exact: true }).click();
	await foreground.getByRole("textbox", { name: "关系理由", exact: true }).fill("切换预览仍保留这份草稿");
	await page.getByRole("button", { name: "放大关系图", exact: true }).click();
	const transform = await page.locator(".react-flow__viewport").getAttribute("style");
	await node(page, "review").click();
	await expect(fullCard(page)).toContainText("任务 review");
	await expect(foreground.getByRole("textbox", { name: "关系理由", exact: true })).toHaveValue(
		"切换预览仍保留这份草稿",
	);
	await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", transform!);
	await pane(page).getByRole("button", { name: "打开任务", exact: true }).click();
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(0);
	await expect(page.getByLabel("当前聚焦任务")).toHaveText("project-b:review");
	await expect(page).not.toHaveURL(/expandedView=/);
	await expect(page).toHaveURL(/projectId=project-b&taskId=review/);
	expect(fixture.pageErrors).toEqual([]);
});

test("真实评论与删除确认保持展开，Esc 依次退出模态框、预览、Relations", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page);
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	await node(page, "review").click();
	await expect(pane(page)).toHaveAttribute("data-preview-pinned", "true");
	await fullCard(page).getByRole("button", { name: "任务评论", exact: true }).click();
	const comments = page.getByRole("dialog", { name: "任务评论 · 任务 review", exact: true });
	await expect(comments).toBeVisible();
	await comments.getByPlaceholder("Write a task comment...").fill("只写到这一世关联任务");
	await comments.getByRole("button", { name: "Add comment", exact: true }).click();
	await expect(comments.getByPlaceholder("Edit task comment...")).toHaveValue("只写到这一世关联任务");
	await expect
		.poll(
			() =>
				fixture.mutations.filter((entry) => entry.procedure === "taskCardAction.updateTaskCardFieldValues").length,
		)
		.toBe(1);
	const commentWrites = fixture.mutations.filter(
		(entry) => entry.procedure === "taskCardAction.updateTaskCardFieldValues",
	);
	expect(commentWrites).toHaveLength(1);
	expect(commentWrites[0]?.input).toMatchObject({ taskId: "review", expectedTaskIncarnationCreatedAtEpochMs: 1_000 });
	await page.keyboard.press("Escape");
	await expect(comments).toHaveCount(0);
	await expect(pane(page)).toBeVisible();
	await expect.poll(() => pane(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await fullCard(page).getByRole("button", { name: "Delete task permanently", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(pane(page)).toBeVisible();
	await expect.poll(() => pane(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(pane(page)).toHaveCount(0);
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(0);
	expect(fixture.pageErrors).toEqual([]);
});

test("从预览建立关系时保留一世身份，同 ID 重建后不产生关系草稿", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page);
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	await node(page, "review").click();
	await expect(fullCard(page)).toBeVisible();
	await pane(page).getByRole("button", { name: "与当前任务建立关系", exact: true }).click();
	const editor = page.getByRole("region", { name: "任务关系建模", exact: true });
	await editor.getByLabel("关系类型", { exact: true }).selectOption("reference_is_generally_related_with");
	await editor.getByLabel("关系理由", { exact: true }).fill("只关联刚才预览的这一世任务");
	fixture.recreatedCounterpart.taskId = "review";
	await editor.getByRole("button", { name: "加入关系草稿", exact: true }).click();
	await expect(editor.getByRole("alert")).toContainText("预览中的任务已删除并重建");
	await expect(editor.getByRole("button", { name: "保存关系变更", exact: true })).toBeDisabled();
	expect(
		fixture.mutations
			.filter((entry) => entry.procedure === "workUnit.saveRelationModelingEditorDraft")
			.every((entry) => {
				const draft = entry.input.draft as { referenceRelationDrafts: unknown[] } | null;
				return !draft || draft.referenceRelationDrafts.length === 0;
			}),
	).toBe(true);
	expect(fixture.pageErrors).toEqual([]);
});

test("卡片动作沿用原流程；读取失败可重试，重建、墓碑和不可用项目给出说明", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page);
	await page.getByRole("button", { name: "展开关系图", exact: true }).click();
	fixture.failNextRead.taskId = "review";
	await node(page, "review").click();
	await expect(pane(page)).toContainText("隔离读取故障");
	await pane(page).getByRole("button", { name: "重试加载卡片", exact: true }).click();
	await fullCard(page).getByRole("button", { name: "Move task to validation", exact: true }).click();
	await expect(fullCard(page)).toHaveAttribute("data-column-id", "validation");
	expect(
		fixture.mutations.find(
			(entry) => entry.procedure === "taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects",
		)?.input,
	).toMatchObject({ taskId: "review", expectedTaskIncarnationCreatedAtEpochMs: 1_000 });
	await node(page, "done").click();
	await expect(fullCard(page).getByRole("button", { name: "Restore task from done", exact: true })).toBeVisible();
	await expect(fullCard(page).getByRole("button", { name: "Start task", exact: true })).toHaveCount(0);
	for (const [taskId, reason] of [
		["rebuilt", "原任务已删除并重建"],
		["removed", "已被永久删除"],
		["unavailable", "项目当前不可用"],
		["missing", "未注册或已移除"],
	]) {
		const workspaceId =
			taskId === "unavailable" ? "unavailable-project" : taskId === "missing" ? "unregistered-project" : "project-b";
		await page.locator(`.react-flow__node[data-id="kanban_board_card:${workspaceId}:${taskId}:1000"]`).click();
		await expect(pane(page)).toContainText(reason!);
		await expect(fullCard(page)).toHaveCount(0);
	}
	await page.locator('.react-flow__node[data-id="standalone:codex:session"]').click();
	await expect(pane(page)).toContainText("独立会话，没有对应的任务卡片");
	expect(fixture.pageErrors).toEqual([]);
});

test("真实创建任务浮窗不阻挡卡片预览，未创建的虚拟根只显示说明", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page, "creation-dialog");
	await page.getByRole("button", { name: "放大关系图", exact: true }).click();
	const graphViewportTransformBeforePreview = await page.locator(".react-flow__viewport").getAttribute("style");
	await page.locator('.react-flow__node[data-id="pending-task-creation"]').click();
	await expect(pane(page)).toContainText("任务尚未创建");
	await expect(page.getByRole("group", { name: "任务多跳关系图", exact: true })).toBeVisible();
	await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", graphViewportTransformBeforePreview!);
	expect(
		fixture.reads.filter((entry) => entry.procedure === "taskCardAction.readTaskCardWithBoardColumn"),
	).toHaveLength(0);
	await node(page, "review").click();
	await expect(fullCard(page)).toBeVisible();
	await expect(page.getByRole("group", { name: "任务多跳关系图", exact: true })).toBeVisible();
	await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", graphViewportTransformBeforePreview!);
	await expect(pane(page)).toHaveAttribute("data-preview-pinned", "true");
	await page.keyboard.press("Escape");
	await expect(pane(page)).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "创建任务", exact: true })).toBeVisible();
	expect(fixture.pageErrors).toEqual([]);
});

test("收起的真实非模态浮窗允许背景图键盘预览，独立确认框仍阻止切换", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page, "creation-window-with-background");
	const creationWindow = page.getByRole("dialog", { name: "创建任务", exact: true });
	await creationWindow.getByRole("button", { name: "收起任务编辑器", exact: true }).click();
	await page.getByRole("button", { name: "展开关系图", exact: true }).focus();
	await page.keyboard.press("Enter");
	const foreground = page.locator('[data-expanded-foreground-view="active"]');
	await expect(foreground).toBeVisible();
	await expect(foreground.getByRole("button", { name: "返回", exact: true })).toBeFocused();
	const foregroundReviewNode = foreground.locator(
		'.react-flow__node[data-id="kanban_board_card:project-b:review:1000"]',
	);
	await expect(foregroundReviewNode).toHaveCount(1);
	await expect(foregroundReviewNode).toBeVisible();
	await foregroundReviewNode.focus();
	await expect(foregroundReviewNode).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(fullCard(page)).toContainText("任务 review");
	await expect(pane(page)).toHaveAttribute("data-preview-pinned", "true");
	await fullCard(page).getByRole("button", { name: "Delete task permanently", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	const snapshotReadCountBeforeBlockedSelection = fixture.reads.filter(
		(entry) => entry.procedure === "taskCardAction.readTaskCardWithBoardColumn",
	).length;
	await foreground
		.locator('.react-flow__node[data-id="kanban_board_card:project-b:second-hop:1000"]')
		.dispatchEvent("keydown", { key: "Enter" });
	await expect(fullCard(page)).toContainText("任务 review");
	expect(
		fixture.reads.filter((entry) => entry.procedure === "taskCardAction.readTaskCardWithBoardColumn"),
	).toHaveLength(snapshotReadCountBeforeBlockedSelection);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(pane(page)).toBeVisible();
	await expect.poll(() => pane(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(pane(page)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-expanded-foreground-view="active"]')).toHaveCount(0);
	await expect(creationWindow).toBeVisible();
	await expect(creationWindow.getByRole("button", { name: "展开任务编辑器", exact: true })).toBeVisible();
	expect(fixture.pageErrors).toEqual([]);
});

test("真实浮窗内标题编辑首次 Esc 只取消编辑，之后依次关闭预览与浮窗", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	const fixture = await openRelations(page, "creation-dialog");
	const creationWindow = page.getByRole("dialog", { name: "创建任务", exact: true });
	await node(page, "review").click();
	await expect(fullCard(page)).toContainText("任务 review");
	await fullCard(page).getByRole("button", { name: "任务评论", exact: true }).click();
	const comments = page.getByRole("dialog", { name: "任务评论 · 任务 review", exact: true });
	await expect(comments).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(comments).toHaveCount(0);
	await expect(pane(page)).toBeVisible();
	await expect.poll(() => pane(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await fullCard(page).getByRole("button", { name: "Delete task permanently", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(pane(page)).toBeVisible();
	await expect.poll(() => pane(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
	await fullCard(page).getByRole("button", { name: "Edit task title", exact: true }).click();
	const titleEditor = fullCard(page).locator("textarea");
	await titleEditor.fill("取消后不应保存的标题草稿");
	await titleEditor.press("Escape");
	await expect(titleEditor).toHaveCount(0);
	await expect(fullCard(page)).toContainText("任务 review");
	await expect(pane(page)).toBeVisible();
	await expect(creationWindow).toBeVisible();
	expect(fixture.mutations.filter((entry) => entry.procedure.startsWith("taskCardAction."))).toHaveLength(0);
	await page.keyboard.press("Escape");
	await expect(pane(page)).toHaveCount(0);
	await expect(creationWindow).toBeVisible();
	await expect(node(page, "review")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(creationWindow).toHaveCount(0);
	expect(fixture.pageErrors).toEqual([]);
});

test.describe("手机触屏", () => {
	test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
	test("点按固定，卡片在下方且可独立滚动，图和页面均不横向溢出", async ({ page }) => {
		const fixture = await openRelations(page);
		await page.getByRole("button", { name: "展开关系图", exact: true }).tap();
		await node(page, "review").tap();
		await expect(fullCard(page)).toBeVisible();
		await expect(pane(page)).toHaveAttribute("data-preview-pinned", "true");
		const graphBox = await page.getByRole("group", { name: "任务多跳关系图", exact: true }).boundingBox();
		const previewBox = await pane(page).boundingBox();
		expect(previewBox!.y).toBeGreaterThan(graphBox!.y);
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
		await fullCard(page).getByRole("button", { name: "任务评论", exact: true }).tap();
		await expect(page.getByRole("dialog", { name: "任务评论 · 任务 review", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(pane(page)).toBeVisible();
		await pane(page).scrollIntoViewIfNeeded();
		await page.screenshot({ path: test.info().outputPath("mobile-relations-preview.png") });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		expect(fixture.pageErrors).toEqual([]);
	});
});
