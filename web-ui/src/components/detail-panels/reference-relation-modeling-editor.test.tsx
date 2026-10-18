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
function Harness({
	workspaceId = "project-a",
	taskId = "task-a",
	showEditor = true,
}: {
	workspaceId?: string;
	taskId?: string;
	showEditor?: boolean;
}) {
	controller = useReferenceRelationModelingEditor({ workspaceId, taskId });
	return showEditor ? (
		<ReferenceRelationModelingEditor
			controller={controller}
			workspaceId={workspaceId}
			taskId={taskId}
			onDraftInteraction={onDraftInteraction}
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

async function openAndFillRelationForm() {
	await clickButton("添加关系");
	await clickButton("选择关联任务");
	await act(async () => {
		const kind = container.querySelector<HTMLSelectElement>('select[aria-label="关系类型"]');
		const rationale = container.querySelector<HTMLInputElement>("input");
		if (!kind || !rationale) throw new Error("找不到关系表单");
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
			kind,
			"reference_is_generally_related_with",
		);
		kind.dispatchEvent(new Event("change", { bubbles: true }));
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(rationale, "共享验收目标");
		rationale.dispatchEvent(new Event("input", { bubbles: true }));
	});
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
	await clickButton("加入关系草稿");
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

describe("关系表单迟到的身份解析", () => {
	it("普通 HTTP 缺少 randomUUID 时仍可将表单暂存为合法 UUID 的关系草稿", async () => {
		const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto));
		vi.stubGlobal("crypto", { getRandomValues });
		await openAndFillRelationForm();
		await clickButton("加入关系草稿");
		expect(controller.draft.referenceRelationDrafts).toEqual([
			expect.objectContaining({
				draftId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
				counterpartWorkUnit,
				relationAssertionRationaleOneSentence: "共享验收目标",
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
		await clickButton("加入关系草稿");
		expect(controller.draft.referenceRelationDrafts).toHaveLength(1);
		expect(onDraftInteraction).toHaveBeenCalledOnce();
	});
	it("未取消的身份解析完成后仍可正常暂存", async () => {
		const resolution = await beginDelayedCounterpartResolution();
		await resolution.complete();
		expect(controller.draft.referenceRelationDrafts).toEqual([
			expect.objectContaining({ counterpartWorkUnit, relationAssertionRationaleOneSentence: "共享验收目标" }),
		]);
		expect(onDraftInteraction).toHaveBeenCalledOnce();
		expect(container.querySelector('[role="group"]')).toBeNull();
	});
});
