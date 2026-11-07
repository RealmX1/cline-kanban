import type { ReferenceRelationModelingDraft } from "@runtime-work-unit-relation-modeling-api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReferenceRelationModelingEditor } from "@/hooks/use-reference-relation-modeling-editor";
import { ReferenceRelationModelingEditor } from "./reference-relation-modeling-editor";

const queries = vi.hoisted(() => ({
	readRelationModelingEditorDraft: vi.fn(),
	persistRelationModelingEditorDraft: vi.fn(),
	readRelationModelingPreview: vi.fn(),
	applyReferenceRelationModelingChangesFromExplicitUserGesture: vi.fn(),
	resolveRelationModelingCounterpart: vi.fn(),
	requestReferenceRelationModelingSuggestions: vi.fn(),
}));
vi.mock("@/runtime/work-unit-relation-modeling-query", () => queries);
vi.mock("@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker", () => ({
	WorkUnitRelationCounterpartKanbanBoardCardPicker: ({
		onSelectedCounterpartKanbanBoardCardChange,
	}: {
		onSelectedCounterpartKanbanBoardCardChange: (value: {
			counterpartKanbanBoardCardWorkspaceId: string;
			counterpartKanbanBoardCardTaskId: string;
			counterpartKanbanBoardCardTitle: string;
			counterpartKanbanProjectDisplayName: string;
		}) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onSelectedCounterpartKanbanBoardCardChange({
					counterpartKanbanBoardCardWorkspaceId: "counterpart-project",
					counterpartKanbanBoardCardTaskId: "counterpart-task",
					counterpartKanbanBoardCardTitle: "关联任务",
					counterpartKanbanProjectDisplayName: "关联项目",
				})
			}
		>
			选择关联任务
		</button>
	),
}));

const counterpartWorkUnit: ReferenceRelationModelingDraft["counterpartWorkUnit"] = {
	workUnitType: "kanban_board_card",
	workspaceId: "counterpart-project",
	taskId: "counterpart-task",
	taskIncarnationCreatedAtEpochMs: 1,
};
let controller: ReturnType<typeof useReferenceRelationModelingEditor>;
let root: Root;
let container: HTMLDivElement;
const onDraftInteraction = vi.fn();
const onUnstagedFormChange = vi.fn();
function Harness({
	workspaceId = "project-a",
	taskId = "task-a",
	targetWorkspaceId,
	showEditor = true,
	presentation,
}: {
	workspaceId?: string;
	taskId?: string | null;
	targetWorkspaceId?: string;
	showEditor?: boolean;
	presentation?: "embedded" | "foreground" | "task_editor";
}) {
	controller = useReferenceRelationModelingEditor({
		workspaceId,
		taskId,
		draftTaskTitle: "新要求",
		draftTaskPrompt: "当前完整要求",
	});
	return showEditor ? (
		<ReferenceRelationModelingEditor
			controller={controller}
			workspaceId={workspaceId}
			targetWorkspaceId={targetWorkspaceId}
			taskId={taskId}
			onDraftInteraction={onDraftInteraction}
			onUnstagedFormChange={onUnstagedFormChange}
			presentation={presentation}
		/>
	) : null;
}

async function clickButton(label: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!button) throw new Error(`找不到按钮：${label}`);
	await act(async () => button.click());
}

async function changeControlValue(selector: string, value: string) {
	const control = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
	if (!control) throw new Error(`找不到控件：${selector}`);
	await act(async () => {
		const prototype =
			control instanceof HTMLSelectElement
				? HTMLSelectElement.prototype
				: control instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
		control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	});
}

async function openAndFillRelationForm() {
	await clickButton("添加关系");
	await clickButton("选择关联任务");
}

async function beginDelayedCounterpartResolution() {
	let resolveCounterpart!: (value: typeof counterpartWorkUnit) => void;
	let rejectCounterpart!: (failure: Error) => void;
	queries.resolveRelationModelingCounterpart.mockReturnValueOnce(
		new Promise<typeof counterpartWorkUnit>((resolve, reject) => {
			resolveCounterpart = resolve;
			rejectCounterpart = reject;
		}),
	);
	await openAndFillRelationForm();
	expect(queries.resolveRelationModelingCounterpart).toHaveBeenCalledOnce();
	return {
		complete: () => act(async () => resolveCounterpart(counterpartWorkUnit)),
		fail: () => act(async () => rejectCounterpart(new Error("旧解析失败"))),
	};
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
	queries.readRelationModelingEditorDraft.mockResolvedValue(null);
	queries.persistRelationModelingEditorDraft.mockResolvedValue({ saved: true });
	queries.resolveRelationModelingCounterpart.mockResolvedValue(counterpartWorkUnit);
	queries.requestReferenceRelationModelingSuggestions.mockResolvedValue({
		availability: "available",
		unavailableReason: null,
		contextAsOf: 1,
		contextCompleteness: [],
		candidates: [],
	});
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () => root.render(<Harness />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("按需 AI 关系建议", () => {
	it("创建中的完整要求参与查询，选择候选后才进入草稿", async () => {
		await act(async () => root.render(<Harness taskId={null} />));
		expect(queries.requestReferenceRelationModelingSuggestions).not.toHaveBeenCalled();
		queries.requestReferenceRelationModelingSuggestions.mockResolvedValueOnce({
			availability: "available",
			unavailableReason: null,
			contextAsOf: 1,
			contextCompleteness: [],
			candidates: [
				{
					candidateId: "suggested",
					rationale: "两张卡处理同一问题",
					evidencePointers: ["src/file.ts:1"],
					relationDraft: {
						draftId: "suggested",
						replacesRelationId: null,
						expectedAssertedRelationStateVersion: null,
						counterpartWorkUnit,
						relationKind: "reference_is_generally_related_with",
						currentTaskIsStatementSubject: true,
						relationAssertionRationaleOneSentence: "两张卡处理同一问题",
						relationAssertionEvidencePointers: ["src/file.ts:1"],
						assertedRelationKindSpecificAttributes: {},
					},
				},
			],
		});
		await clickButton("获取关系建议");
		expect(queries.requestReferenceRelationModelingSuggestions).toHaveBeenCalledWith(
			"project-a",
			expect.objectContaining({ workUnit: null, draftTaskPrompt: "当前完整要求", draftTaskTitle: "新要求" }),
		);
		expect(container.textContent).toContain("两张卡处理同一问题");
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		await clickButton("加入草稿");
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
		expect(queries.applyReferenceRelationModelingChangesFromExplicitUserGesture).not.toHaveBeenCalled();
	});
	it("已有任务请求、零候选、不可用与失败分别呈现", async () => {
		await clickButton("获取关系建议");
		expect(queries.requestReferenceRelationModelingSuggestions).toHaveBeenCalledWith(
			"project-a",
			expect.objectContaining({
				workUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: "task-a",
					workspaceId: "project-a",
				},
			}),
		);
		expect(container.textContent).toContain("本次未找到相关任务");
		queries.requestReferenceRelationModelingSuggestions.mockResolvedValueOnce({
			availability: "unavailable",
			unavailableReason: "执行器尚未配置",
			contextAsOf: null,
			contextCompleteness: [],
			candidates: [],
		});
		await clickButton("获取关系建议");
		expect(container.textContent).toContain("执行器尚未配置");
		queries.requestReferenceRelationModelingSuggestions.mockRejectedValueOnce(new Error("服务断开"));
		await clickButton("获取关系建议");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("关系建议失败：服务断开");
	});
});

describe("关系表单迟到的身份解析", () => {
	it("身份解析失败保留已选关系的提交阻塞，重试成功或明确取消才解除", async () => {
		queries.resolveRelationModelingCounterpart.mockRejectedValueOnce(new Error("身份查询暂不可用"));
		await openAndFillRelationForm();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("身份查询暂不可用");
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(true);
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		await clickButton("添加关系到草稿");
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(false);
		await clickButton("移除关系");
		queries.resolveRelationModelingCounterpart.mockRejectedValueOnce(new Error("身份查询暂不可用"));
		await openAndFillRelationForm();
		await clickButton("取消");
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(false);
	});
	it.each(["browser", "runtime"] as const)(
		"无效详情在切换条目和 %s 恢复后仍保留原文、错误与提交阻塞",
		async (restoreFrom) => {
			await openAndFillRelationForm();
			const originalDraft = controller.draft.referenceRelationDrafts[0];
			if (!originalDraft) throw new Error("未暂存已选择的关系。");
			await act(async () =>
				controller.addDraft({
					...originalDraft,
					draftId: "another-relation",
					counterpartWorkUnit: { ...counterpartWorkUnit, taskId: "another-task" },
				}),
			);
			await clickButton("详情");
			const invalidEvidence = "x".repeat(1001);
			await changeControlValue('textarea[id$="-evidence"]', invalidEvidence);
			const detailButtons = [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
				(button) => button.textContent === "详情",
			);
			await act(async () => detailButtons[0]?.click());
			expect(onUnstagedFormChange).toHaveBeenLastCalledWith(true);
			expect(container.textContent).toContain("1000");
			await act(async () => vi.advanceTimersByTimeAsync(250));
			const persistedDraft = queries.persistRelationModelingEditorDraft.mock.calls.at(-1)?.[2];
			expect(persistedDraft).toMatchObject({
				invalidReferenceRelationDetailsFormsByDraftId: {
					[originalDraft.draftId]: {
						relationAssertionEvidencePointersOnePerLineText: invalidEvidence,
					},
				},
			});
			await act(async () => root.unmount());
			if (restoreFrom === "runtime") {
				localStorage.clear();
				queries.readRelationModelingEditorDraft.mockResolvedValueOnce(persistedDraft);
			}
			root = createRoot(container);
			await act(async () => root.render(<Harness />));
			expect(onUnstagedFormChange).toHaveBeenLastCalledWith(true);
			expect(container.textContent).toContain("1000");
			const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "保存关系变更",
			);
			expect(save?.disabled).toBe(true);
			await clickButton("详情");
			expect(container.querySelector<HTMLTextAreaElement>('textarea[id$="-evidence"]')?.value).toBe(invalidEvidence);
			await changeControlValue('textarea[id$="-evidence"]', "src/verified.ts");
			expect(onUnstagedFormChange).toHaveBeenLastCalledWith(false);
			expect(controller.draft.referenceRelationDrafts[0]?.relationAssertionEvidencePointers).toEqual([
				"src/verified.ts",
			]);
			expect(save?.disabled).toBe(false);
		},
	);
	it("移除包含无效详情的条目会同时移除原文并解除提交阻塞", async () => {
		await openAndFillRelationForm();
		await clickButton("详情");
		await changeControlValue('textarea[id$="-evidence"]', "x".repeat(1001));
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(true);
		await clickButton("移除关系");
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(controller.draft.invalidReferenceRelationDetailsFormsByDraftId).toEqual({});
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(false);
	});
	it("预览截断时仍按对端身份校验跨 project，切换目标与迁移后保留选择并阻止失效提交", async () => {
		const identity = {
			kanbanBoardCard: counterpartWorkUnit,
			canonicalKanbanBoardCard: counterpartWorkUnit,
			permanentlyRemovedFromBoardAt: null,
			currentTitle: "对端任务",
		};
		const preview = {
			rootWorkUnitKey: "root",
			workUnits: [
				{
					workUnitKey: "counterpart",
					workUnit: counterpartWorkUnit,
					workUnitDisplayLabel: "对端任务",
					kanbanBoardCardIdentity: identity,
				},
			],
			relations: [],
			truncated: true,
			projectedThroughGlobalCommittedEventSequence: 1,
		};
		queries.readRelationModelingPreview.mockResolvedValue(preview);
		await openAndFillRelationForm();
		await act(async () => vi.advanceTimersByTimeAsync(300));
		await changeControlValue(
			'select[aria-label="待保存关系及方向"]',
			"reference_is_cross_repository_counterpart_with",
		);
		const saveButton = () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "保存关系变更",
			);
		expect(saveButton()?.disabled).toBe(false);
		await act(async () => root.render(<Harness targetWorkspaceId="counterpart-project" />));
		expect(controller.draft.referenceRelationDrafts[0]?.relationKind).toBe(
			"reference_is_cross_repository_counterpart_with",
		);
		expect(saveButton()?.disabled).toBe(true);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("仅限不同 project");
		await act(async () => root.render(<Harness targetWorkspaceId="project-a" />));
		expect(saveButton()?.disabled).toBe(false);
		queries.readRelationModelingPreview.mockResolvedValue({
			...preview,
			workUnits: [
				{
					...preview.workUnits[0],
					kanbanBoardCardIdentity: {
						...identity,
						kanbanBoardCard: { ...counterpartWorkUnit, workspaceId: "project-a" },
					},
				},
			],
		});
		await clickButton("刷新关系");
		await act(async () => vi.advanceTimersByTimeAsync(300));
		expect(saveButton()?.disabled).toBe(true);
		expect(controller.draft.referenceRelationDrafts[0]?.counterpartWorkUnit).toEqual(counterpartWorkUnit);
	});
	it("重复选择同一任务可为新增条目改选另一类型，同时保留原普通关联", async () => {
		await openAndFillRelationForm();
		const originalDraft = controller.draft.referenceRelationDrafts[0];
		await openAndFillRelationForm();
		expect(controller.draft.referenceRelationDrafts).toEqual([originalDraft]);
		await changeControlValue('select[aria-label="关系及方向"]', "reference_reuses_produced_outputs_of");
		await clickButton("添加关系到草稿");
		expect(controller.draft.referenceRelationDrafts).toEqual([
			originalDraft,
			expect.objectContaining({
				relationKind: "reference_reuses_produced_outputs_of",
				counterpartWorkUnit,
			}),
		]);
		expect(onUnstagedFormChange).toHaveBeenLastCalledWith(false);
	});
	it.each(["embedded", "task_editor"] as const)("%s 仅在任务编辑器中默认收起关系图", async (presentation) => {
		queries.readRelationModelingPreview.mockResolvedValue({
			rootWorkUnitKey: "root",
			workUnits: [],
			relations: [],
			truncated: false,
			projectedThroughGlobalCommittedEventSequence: 0,
		});
		await act(async () => root.render(<Harness key={presentation} presentation={presentation} />));
		await act(async () => vi.advanceTimersByTimeAsync(300));
		expect(Boolean(container.querySelector('[aria-label="任务多跳关系图"]'))).toBe(presentation === "embedded");
		if (presentation === "task_editor") {
			await clickButton("关系图");
			expect(container.querySelector('[aria-label="任务多跳关系图"]')).not.toBeNull();
		}
	});
	it("自指与非法证据不放行，收起非法详情后仍显示错误且禁止保存", async () => {
		queries.resolveRelationModelingCounterpart.mockResolvedValueOnce({
			...counterpartWorkUnit,
			workspaceId: "project-a",
			taskId: "task-a",
		});
		await openAndFillRelationForm();
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("自身");
		await clickButton("取消");
		await openAndFillRelationForm();
		await clickButton("详情");
		await changeControlValue('textarea[id$="-evidence"]', "x".repeat(1001));
		await clickButton("收起详情");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("1000");
		const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "保存关系变更",
		);
		expect(save?.disabled).toBe(true);
		await clickButton("详情");
		await changeControlValue('textarea[id$="-evidence"]', "src/file.ts");
		expect(save?.disabled).toBe(false);
	});
	it("详情和方向立即进入草稿，收起、重新打开与刷新恢复均保留", async () => {
		await openAndFillRelationForm();
		await clickButton("详情");
		await changeControlValue(
			'select[aria-label="关系及方向"]',
			"reference_diagnoses_agent_execution_trajectory_of:inverse",
		);
		await changeControlValue('input[id$="-reason"]', "可选的说明");
		await clickButton("收起详情");
		expect(controller.draft.referenceRelationDrafts).toEqual([
			expect.objectContaining({
				relationKind: "reference_diagnoses_agent_execution_trajectory_of",
				currentTaskIsStatementSubject: false,
				relationAssertionRationaleOneSentence: "可选的说明",
				assertedRelationKindSpecificAttributes: {},
			}),
		]);
		const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "保存关系变更",
		);
		expect(save?.disabled).toBe(false);
		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);
		await act(async () => {
			root.render(<Harness />);
		});
		expect(controller.draft.referenceRelationDrafts[0]).toMatchObject({
			currentTaskIsStatementSubject: false,
			relationAssertionRationaleOneSentence: "可选的说明",
		});
		await clickButton("详情");
		expect(container.querySelector<HTMLInputElement>('input[id$="-reason"]')?.value).toBe("可选的说明");
	});
	it("重复选择不增加第二条关系，移除后可再次选择", async () => {
		await openAndFillRelationForm();
		await openAndFillRelationForm();
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("已在待保存列表");
		await clickButton("取消");
		await clickButton("移除关系");
		expect(controller.draft.referenceRelationDrafts).toHaveLength(0);
		await openAndFillRelationForm();
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
	});
	it("保存成功清空草稿后，打开的详情不会重新生成旧关系", async () => {
		await openAndFillRelationForm();
		await clickButton("详情");
		await act(async () => controller.updateDraft({ referenceRelationDrafts: [] }));
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
	});
	it("只选任务立即暂存普通关联，普通 HTTP 也生成合法 UUID", async () => {
		const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto));
		vi.stubGlobal("crypto", { getRandomValues });
		await openAndFillRelationForm();
		expect(controller.draft.referenceRelationDrafts).toEqual([
			expect.objectContaining({
				draftId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
				counterpartWorkUnit,
				relationAssertionRationaleOneSentence: "",
			}),
		]);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(onDraftInteraction).toHaveBeenCalledOnce();
		expect(getRandomValues).toHaveBeenCalled();
	});
	it("取消后不会把已取消关系加入草稿", async () => {
		const resolution = await beginDelayedCounterpartResolution();
		await clickButton("取消");
		await resolution.complete();
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(onDraftInteraction).not.toHaveBeenCalled();
	});
	it.each([
		{ workspaceId: "project-a", taskId: "task-b" },
		{ workspaceId: "project-b", taskId: "task-a" },
	])("切换到 $workspaceId / $taskId 后不会写入旧关系", async (nextScope) => {
		const resolution = await beginDelayedCounterpartResolution();
		await act(async () => root.render(<Harness {...nextScope} />));
		await resolution.complete();
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(onDraftInteraction).not.toHaveBeenCalled();
		expect(container.querySelector('[role="group"]')).toBeNull();
	});
	it("编辑器卸载后不会通过复用的 controller 写入草稿", async () => {
		const resolution = await beginDelayedCounterpartResolution();
		await act(async () => root.render(<Harness showEditor={false} />));
		await resolution.complete();
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(onDraftInteraction).not.toHaveBeenCalled();
	});
	it("取消后重新打开表单，旧失败不会污染新表单", async () => {
		const resolution = await beginDelayedCounterpartResolution();
		await clickButton("取消");
		await openAndFillRelationForm();
		await resolution.fail();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
		expect(onDraftInteraction).toHaveBeenCalledOnce();
	});
	it("未取消的身份解析完成后仍可正常暂存", async () => {
		const resolution = await beginDelayedCounterpartResolution();
		await resolution.complete();
		expect(controller.draft.referenceRelationDrafts).toEqual([
			expect.objectContaining({ counterpartWorkUnit, relationAssertionRationaleOneSentence: "" }),
		]);
		expect(onDraftInteraction).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="group"]')).toBeNull();
	});
});
