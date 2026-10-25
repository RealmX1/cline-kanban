import type { WebUiUserDecisionClientCharacteristics } from "@runtime-work-unit-relation-assertion-write-api-contract";
import type {
	ReferenceRelationModelingDraft,
	ReferenceRelationModelingEditorDraft,
	RelationModelingPreviewResponse,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyTaskVisualizationStreamReconnected } from "@/stores/task-visualization-browser-bridge";
import { useReferenceRelationModelingEditor } from "./use-reference-relation-modeling-editor";

const queries = vi.hoisted(() => ({
	readRelationModelingEditorDraft: vi.fn(),
	persistRelationModelingEditorDraft: vi.fn(),
	readRelationModelingPreview: vi.fn(),
	applyReferenceRelationModelingChangesFromExplicitUserGesture: vi.fn(),
}));
vi.mock("@/runtime/work-unit-relation-modeling-query", () => queries);

const referenceDraft: ReferenceRelationModelingDraft = {
	draftId: "relation-draft",
	replacesRelationId: null,
	expectedAssertedRelationStateVersion: null,
	counterpartWorkUnit: {
		workUnitType: "kanban_board_card",
		workspaceId: "project-a",
		taskId: "counterpart",
		taskIncarnationCreatedAtEpochMs: 1,
	},
	relationKind: "reference_is_generally_related_with",
	currentTaskIsStatementSubject: true,
	relationAssertionRationaleOneSentence: "共享验收目标",
	relationAssertionEvidencePointers: [],
	assertedRelationKindSpecificAttributes: {},
};
let controller: ReturnType<typeof useReferenceRelationModelingEditor>;
let root: Root;
let container: HTMLDivElement;
function Harness({
	workspaceId = "project-a",
	taskId = null,
	active = true,
	taskIncarnationCreatedAtEpochMs,
	draftTaskTitle,
}: {
	workspaceId?: string;
	taskId?: string | null;
	active?: boolean;
	taskIncarnationCreatedAtEpochMs?: number;
	draftTaskTitle?: string;
}) {
	controller = useReferenceRelationModelingEditor({
		workspaceId,
		taskId,
		active,
		taskIncarnationCreatedAtEpochMs,
		draftTaskTitle,
	});
	return null;
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
	queries.readRelationModelingEditorDraft.mockResolvedValue(null);
	queries.persistRelationModelingEditorDraft.mockResolvedValue({ saved: true });
	queries.readRelationModelingPreview.mockResolvedValue({
		rootWorkUnitKey: "pending-task-creation",
		workUnits: [],
		relations: [],
		truncated: false,
		projectedThroughGlobalCommittedEventSequence: 0,
	});
	queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mockResolvedValue({ alreadyApplied: false });
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

describe("关系预览防抖与恢复", () => {
	it("连续输入标题仅在安静窗口后读取最终标题", async () => {
		queries.readRelationModelingPreview.mockClear();
		for (const title of ["新", "新增", "新增任务"]) {
			await act(async () => root.render(<Harness draftTaskTitle={title} />));
			await act(async () => vi.advanceTimersByTimeAsync(50));
		}
		expect(queries.readRelationModelingPreview).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(99));
		expect(queries.readRelationModelingPreview).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(1);
		expect(queries.readRelationModelingPreview.mock.calls[0]?.[1]).toMatchObject({ draftTaskTitle: "新增任务" });
		expect(queries.persistRelationModelingEditorDraft).not.toHaveBeenCalled();
	});

	it("等待防抖时切换项目取消旧目标的预览，只读取新项目", async () => {
		queries.readRelationModelingPreview.mockClear();
		await act(async () => root.render(<Harness workspaceId="project-a" draftTaskTitle="原项目任务" />));
		await act(async () => vi.advanceTimersByTimeAsync(100));
		await act(async () => root.render(<Harness workspaceId="project-b" draftTaskTitle="新项目任务" />));
		expect(controller.preview).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(1);
		expect(queries.readRelationModelingPreview.mock.calls[0]?.[0]).toBe("project-b");
		expect(queries.readRelationModelingPreview.mock.calls[0]?.[1]).toMatchObject({ draftTaskTitle: "新项目任务" });
	});

	it("切换任务完整身份立即取消旧读取，防抖期间的迟到结果不会覆盖新目标", async () => {
		let previousSignal: AbortSignal | undefined;
		let resolvePrevious: (value: RelationModelingPreviewResponse) => void = () => undefined;
		queries.readRelationModelingPreview.mockClear();
		queries.readRelationModelingPreview.mockImplementationOnce(
			(_workspaceId: string, _request: unknown, signal: AbortSignal) => {
				previousSignal = signal;
				return new Promise<RelationModelingPreviewResponse>((resolve) => {
					resolvePrevious = resolve;
				});
			},
		);
		await act(async () => root.render(<Harness taskId="same-task" taskIncarnationCreatedAtEpochMs={10} />));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(previousSignal?.aborted).toBe(false);
		await act(async () => root.render(<Harness taskId="same-task" taskIncarnationCreatedAtEpochMs={20} />));
		expect(previousSignal?.aborted).toBe(true);
		await act(async () =>
			resolvePrevious({
				rootWorkUnitKey: "旧任务身份",
				workUnits: [],
				relations: [],
				truncated: false,
				projectedThroughGlobalCommittedEventSequence: 1,
			}),
		);
		expect(controller.preview).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(2);
		expect(queries.readRelationModelingPreview.mock.calls[1]?.[1]).toMatchObject({
			workUnit: { kanbanBoardCard: { taskIncarnationCreatedAtEpochMs: 20 } },
		});
		expect(controller.preview?.rootWorkUnitKey).toBe("pending-task-creation");
	});

	it("防抖后的失败保持有界重试，显式刷新和网络重连仍能重新读取", async () => {
		queries.readRelationModelingPreview.mockClear();
		queries.readRelationModelingPreview
			.mockRejectedValueOnce(new Error("运行时暂不可用"))
			.mockRejectedValueOnce(new Error("运行时仍在恢复"));
		await act(async () => root.render(<Harness draftTaskTitle="恢复测试任务" />));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		await act(async () => vi.advanceTimersByTimeAsync(400));
		await act(async () => vi.advanceTimersByTimeAsync(1_200));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(3);
		expect(controller.error).toBeNull();
		expect(controller.preview).not.toBeNull();
		await act(async () => controller.refresh());
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(4);
		await act(async () => window.dispatchEvent(new Event("online")));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(5);
		await act(async () => notifyTaskVisualizationStreamReconnected("project-a"));
		await act(async () => vi.advanceTimersByTimeAsync(150));
		expect(queries.readRelationModelingPreview).toHaveBeenCalledTimes(6);
	});
});

it("限定身份继续恢复原有草稿，历史一世只读且不覆盖当前草稿", async () => {
	const owner = sessionStorage.getItem("reference-relation-modeling-browser-tab-identity");
	const key = `reference-relation-modeling:project-a:existing-task:${owner}`;
	localStorage.setItem(key, JSON.stringify({ ...controller.draft, referenceRelationDrafts: [referenceDraft] }));
	queries.readRelationModelingPreview.mockImplementation(async (_workspace, input) => {
		const ref = input.workUnit.kanbanBoardCard;
		const rootKey = `kanban_board_card:${ref.workspaceId}:${ref.taskId}:${ref.taskIncarnationCreatedAtEpochMs}`;
		return {
			rootWorkUnitKey: rootKey,
			workUnits: [
				{
					workUnitKey: rootKey,
					workUnit: ref,
					kanbanBoardCardIdentity: {
						permanentlyRemovedFromBoardAt: ref.taskIncarnationCreatedAtEpochMs === 10 ? null : 20,
					},
				},
			],
			relations: [],
			truncated: false,
			projectedThroughGlobalCommittedEventSequence: 1,
		};
	});
	await act(async () => root.render(<Harness taskId="existing-task" taskIncarnationCreatedAtEpochMs={10} />));
	expect(controller.draft.referenceRelationDrafts).toEqual([referenceDraft]);
	await act(async () => vi.advanceTimersByTimeAsync(150));
	await act(async () => vi.advanceTimersByTimeAsync(250));
	expect(queries.readRelationModelingPreview.mock.calls.at(-1)?.[1].referenceRelationDrafts).toEqual([referenceDraft]);
	queries.persistRelationModelingEditorDraft.mockClear();
	await act(async () => root.render(<Harness taskId="existing-task" taskIncarnationCreatedAtEpochMs={5} />));
	await act(async () => vi.advanceTimersByTimeAsync(250));
	expect(queries.readRelationModelingPreview.mock.calls.at(-1)?.[1]).toMatchObject({
		referenceRelationDrafts: [],
		relationRevocations: [],
		workUnit: { kanbanBoardCard: { taskIncarnationCreatedAtEpochMs: 5 } },
	});
	expect(queries.persistRelationModelingEditorDraft).not.toHaveBeenCalled();
	expect(JSON.parse(localStorage.getItem(key) ?? "null").referenceRelationDrafts).toEqual([referenceDraft]);
});

describe("关系编辑草稿与失败恢复", () => {
	it("普通 HTTP 缺少 randomUUID 时可初始化、修改、保存及放弃草稿", async () => {
		await act(async () => root.unmount());
		sessionStorage.clear();
		const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto));
		vi.stubGlobal("crypto", { getRandomValues });
		root = createRoot(container);
		await act(async () => root.render(<Harness />));
		const submissionIds = [controller.draft.modelingSubmissionId];
		expect(controller.ready).toBe(true);
		await act(async () => controller.addDraft(referenceDraft));
		submissionIds.push(controller.draft.modelingSubmissionId);
		await act(async () => controller.updateDraft({ referenceRelationDrafts: [referenceDraft] }));
		submissionIds.push(controller.draft.modelingSubmissionId);
		await act(async () => controller.applyToTask("created-task", {} as WebUiUserDecisionClientCharacteristics));
		submissionIds.push(controller.draft.modelingSubmissionId);
		expect(controller.hasChanges).toBe(false);
		expect(controller.draft.createdTaskId).toBe("created-task");
		await act(async () => controller.discard());
		submissionIds.push(controller.draft.modelingSubmissionId);
		expect(controller.draft.createdTaskId).toBeNull();
		const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(sessionStorage.getItem("reference-relation-modeling-browser-tab-identity")).toMatch(uuidV4Pattern);
		for (const submissionId of submissionIds) expect(submissionId).toMatch(uuidV4Pattern);
		expect(new Set(submissionIds).size).toBe(submissionIds.length);
		expect(getRandomValues).toHaveBeenCalled();
	});
	it("未知写入结果重试复用提交标识，创建卡片身份保留到流程完成", async () => {
		await act(async () => controller.addDraft(referenceDraft));
		await act(async () => controller.updateDraft({ creationPrompt: "创建需求", creationTitle: "创建标题" }));
		const submissionId = controller.draft.modelingSubmissionId;
		queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mockRejectedValueOnce(new Error("网络中断"));
		const gesture = {} as WebUiUserDecisionClientCharacteristics;
		await act(async () => {
			await expect(controller.applyToTask("created-task", gesture)).rejects.toThrow("网络中断");
		});
		expect(controller.draft.createdTaskId).toBe("created-task");
		expect(controller.hasChanges).toBe(true);
		await act(async () => controller.updateDraft({ creationTitle: "改标题不会创建新关系提交" }));
		expect(controller.draft.modelingSubmissionId).toBe(submissionId);
		await act(async () => controller.applyToTask("created-task", gesture));
		const requests = queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mock.calls;
		expect(requests.map((call) => call[1].modelingSubmissionId)).toEqual([submissionId, submissionId]);
		expect(controller.hasChanges).toBe(false);
		expect(controller.draft.createdTaskId).toBe("created-task");
		await act(async () => controller.discard());
		expect(controller.readLatestDraft().createdTaskId).toBeNull();
	});
	it("刷新后恢复浏览器镜像，坏镜像回退服务端而不会使界面崩溃", async () => {
		await act(async () => controller.addDraft(referenceDraft));
		await act(async () => root.unmount());
		root = createRoot(container);
		await act(async () => root.render(<Harness />));
		expect(controller.draft.referenceRelationDrafts).toEqual([referenceDraft]);
		const mirrorKey = Object.keys(localStorage).find((key) => key.startsWith("reference-relation-modeling:"));
		if (!mirrorKey) throw new Error("没有持久化镜像");
		await act(async () => root.unmount());
		localStorage.setItem(mirrorKey, '{"referenceRelationDrafts":null}');
		root = createRoot(container);
		await act(async () => root.render(<Harness />));
		expect(controller.ready).toBe(true);
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
	});
	it("关系保存清理保留跨项目已创建卡片的项目、快照和同一世身份，重挂载可恢复", async () => {
		const snapshot = {
			id: "abcde",
			title: "目标项目任务",
			prompt: "创建内容",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 41,
			updatedAt: 41,
		};
		await act(async () =>
			controller.updateDraft({
				createdTaskId: snapshot.id,
				createdTaskWorkspaceId: "project-b",
				createdTaskCardSnapshot: snapshot,
				creationPrompt: snapshot.prompt,
				creationTitle: snapshot.title,
				referenceRelationDrafts: [referenceDraft],
			}),
		);
		await act(async () =>
			controller.applyToTask(snapshot.id, {} as WebUiUserDecisionClientCharacteristics, "project-b"),
		);
		expect(controller.hasChanges).toBe(false);
		const expectedRecovery = {
			createdTaskId: snapshot.id,
			createdTaskWorkspaceId: "project-b",
			createdTaskCardSnapshot: snapshot,
			creationPrompt: snapshot.prompt,
			creationTitle: snapshot.title,
			referenceRelationDrafts: [],
			relationRevocations: [],
		};
		expect(controller.readLatestDraft()).toMatchObject(expectedRecovery);
		expect(queries.persistRelationModelingEditorDraft).toHaveBeenLastCalledWith(
			"project-a",
			expect.any(String),
			expect.objectContaining(expectedRecovery),
		);
		await act(async () => root.unmount());
		root = createRoot(container);
		await act(async () => root.render(<Harness />));
		expect(controller.draft).toMatchObject(expectedRecovery);
		expect(queries.applyReferenceRelationModelingChangesFromExplicitUserGesture).toHaveBeenCalledTimes(1);
	});
	it("旧保存未完成时放弃并重开，草稿读取等待删除完成且不会复活旧内容", async () => {
		await act(async () => controller.addDraft(referenceDraft));
		let serverDraft: ReferenceRelationModelingEditorDraft | null = controller.readLatestDraft();
		queries.readRelationModelingEditorDraft.mockImplementation(async () => serverDraft);
		let finishOldSave: (() => void) | undefined;
		const oldSavePending = new Promise<void>((resolve) => {
			finishOldSave = resolve;
		});
		queries.persistRelationModelingEditorDraft.mockImplementation(
			async (_workspaceId: string, _draftScopeId: string, value: ReferenceRelationModelingEditorDraft | null) => {
				if (value) await oldSavePending;
				serverDraft = value;
				return { saved: true };
			},
		);
		await act(async () => vi.advanceTimersByTimeAsync(250));
		expect(queries.persistRelationModelingEditorDraft).toHaveBeenCalledTimes(1);
		await act(async () => {
			controller.discard();
			root.render(<Harness active={false} />);
		});
		await act(async () => root.render(<Harness />));
		const wasReadyBeforeDeletionCompleted = controller.ready;
		await act(async () => finishOldSave?.());
		await act(async () => vi.advanceTimersByTimeAsync(300));
		expect(controller.ready).toBe(true);
		expect(controller.draft.referenceRelationDrafts).toEqual([]);
		expect(controller.hasChanges).toBe(false);
		expect(serverDraft).toBeNull();
		expect(wasReadyBeforeDeletionCompleted).toBe(false);
		expect(Object.keys(localStorage).filter((key) => key.startsWith("reference-relation-modeling:"))).toEqual([]);
	});
	it("同一任务关闭重开时保留保存锁，旧提交完成只清除已提交条目", async () => {
		await act(async () => root.render(<Harness taskId="focused-task" />));
		let serverDraft: ReferenceRelationModelingEditorDraft | null = null;
		queries.readRelationModelingEditorDraft.mockImplementation(async () => serverDraft);
		queries.persistRelationModelingEditorDraft.mockImplementation(
			async (_workspaceId: string, _draftScopeId: string, value: ReferenceRelationModelingEditorDraft | null) => {
				serverDraft = value;
				return { saved: true };
			},
		);
		await act(async () => controller.addDraft(referenceDraft));
		let finishApply: (() => void) | undefined;
		queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishApply = resolve;
				}),
		);
		let pendingApply: Promise<void> | undefined;
		await act(async () => {
			pendingApply = controller.applyToTask("focused-task", {} as WebUiUserDecisionClientCharacteristics);
		});
		expect(controller.saving).toBe(true);
		await act(async () => root.render(<Harness taskId="focused-task" active={false} />));
		await act(async () => root.render(<Harness taskId="focused-task" />));
		const wasSavingAfterReopen = controller.saving;
		const nextReferenceDraft = { ...referenceDraft, draftId: "unsubmitted-next-reference" };
		await act(async () => controller.addDraft(nextReferenceDraft));
		await act(async () => {
			finishApply?.();
			await pendingApply;
		});
		await act(async () => vi.advanceTimersByTimeAsync(300));
		expect(controller.draft.referenceRelationDrafts).toEqual([nextReferenceDraft]);
		expect(serverDraft).toMatchObject({ referenceRelationDrafts: [nextReferenceDraft] });
		expect(wasSavingAfterReopen).toBe(true);
		expect(controller.saving).toBe(false);
	});
	it("不同任务可各自保存，切回同一任务仍保留其在途保存锁", async () => {
		let finishFirstApply: (() => void) | undefined;
		let finishSecondApply: (() => void) | undefined;
		queries.applyReferenceRelationModelingChangesFromExplicitUserGesture
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishFirstApply = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishSecondApply = resolve;
					}),
			);
		await act(async () => root.render(<Harness taskId="first-task" />));
		await act(async () => controller.addDraft(referenceDraft));
		let firstApply: Promise<void> | undefined;
		await act(async () => {
			firstApply = controller.applyToTask("first-task", {} as WebUiUserDecisionClientCharacteristics);
		});
		await act(async () => root.render(<Harness taskId="second-task" />));
		expect(controller.saving).toBe(false);
		const secondReferenceDraft = { ...referenceDraft, draftId: "second-task-reference" };
		await act(async () => controller.addDraft(secondReferenceDraft));
		let secondApply: Promise<void> | undefined;
		await act(async () => {
			secondApply = controller.applyToTask("second-task", {} as WebUiUserDecisionClientCharacteristics);
		});
		await act(async () => root.render(<Harness taskId="first-task" />));
		const wasFirstTaskSavingAfterReturn = controller.saving;
		await act(async () => {
			finishFirstApply?.();
			await firstApply;
		});
		expect(controller.saving).toBe(false);
		await act(async () => root.render(<Harness taskId="second-task" />));
		const wasSecondTaskStillSaving = controller.saving;
		expect(controller.draft.referenceRelationDrafts).toEqual([secondReferenceDraft]);
		await act(async () => {
			finishSecondApply?.();
			await secondApply;
		});
		expect(wasFirstTaskSavingAfterReturn).toBe(true);
		expect(wasSecondTaskStillSaving).toBe(true);
		expect(controller.saving).toBe(false);
	});
	it("切换项目时不会把旧项目草稿写入新项目", async () => {
		await act(async () => controller.addDraft(referenceDraft));
		await act(async () => root.render(<Harness workspaceId="project-b" taskId="focused-task" />));
		await act(async () => vi.advanceTimersByTimeAsync(300));
		const newProjectWrites = queries.persistRelationModelingEditorDraft.mock.calls.filter(
			(call) => call[0] === "project-b",
		);
		expect(newProjectWrites).toHaveLength(0);
	});
	it("保存途中切换任务，旧请求完成时不会清空新任务的草稿", async () => {
		await act(async () => controller.addDraft(referenceDraft));
		let finishSaving: (() => void) | undefined;
		queries.applyReferenceRelationModelingChangesFromExplicitUserGesture.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishSaving = resolve;
				}),
		);
		let previousTaskSave: Promise<void> | undefined;
		await act(async () => {
			previousTaskSave = controller.applyToTask("previous-task", {} as WebUiUserDecisionClientCharacteristics);
		});
		await act(async () => root.render(<Harness workspaceId="project-b" taskId="next-task" />));
		await act(async () => controller.addDraft({ ...referenceDraft, draftId: "next-task-draft" }));
		await act(async () => {
			finishSaving?.();
			await previousTaskSave;
		});
		expect(controller.draft.referenceRelationDrafts[0]?.draftId).toBe("next-task-draft");
	});
});
