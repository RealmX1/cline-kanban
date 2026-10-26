import type { ReferenceRelationModelingEditorDraft } from "@runtime-work-unit-relation-modeling-api-contract";
import type { ComponentProps } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskEditorDialog } from "@/components/task-editor-dialog";
import * as relationModelingHooks from "@/hooks/use-reference-relation-modeling-editor";
import * as taskCardActionQueries from "@/runtime/task-card-action-query";
import {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import * as relationModelingQueries from "@/runtime/work-unit-relation-modeling-query";
import * as taskCardActionCommands from "@/state/task-card-action-commands-for-any-workspace";
import * as taskProjectAssignmentPreflight from "@/state/task-project-assignment-preflight";
import type { BoardCard } from "@/types";

type Props = ComponentProps<typeof TaskEditorDialog>;

vi.mock("@/state/task-project-assignment-preflight", () => ({
	runTaskProjectAssignmentPreflight: vi.fn(async (input: { workspaceId: string; baseRef: string }) => ({
		workspaceId: input.workspaceId,
		baseRef: input.baseRef,
	})),
	rememberTaskProjectAssignmentAnalysisAccepted: vi.fn(),
	hasAcceptedTaskProjectAssignmentAnalysis: vi.fn(() => true),
}));
vi.mock("@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards", () => ({
	ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission: vi.fn(async () => undefined),
}));
beforeEach(() => {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
	vi.mocked(taskProjectAssignmentPreflight.rememberTaskProjectAssignmentAnalysisAccepted).mockClear();
	vi.mocked(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight)
		.mockReset()
		.mockImplementation(async ({ workspaceId, baseRef }) => ({ workspaceId, baseRef }));
	vi.spyOn(taskCardActionQueries, "updateTaskCardFieldValuesInWorkspace").mockImplementation(
		async (_workspaceId, request) => ({
			taskCardSnapshotAfterAction: {
				taskCard: {
					id: request.taskId,
					title: "已恢复任务",
					prompt: "恢复内容",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				},
				boardColumnIdContainingTaskCard: "backlog",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		}),
	);
	vi.spyOn(taskCardActionQueries, "readTaskCardWithBoardColumnInWorkspace").mockImplementation(
		async (_workspaceId, taskId) => ({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: {
				taskCard: {
					id: taskId,
					title: "已恢复任务",
					prompt: "恢复内容",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				},
				boardColumnIdContainingTaskCard: "backlog",
				taskSessionSummaryLiveInRuntimeProcessMemory: null,
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		}),
	);
	localStorage.clear();
	sessionStorage.clear();
});

function makeProps(overrides: Partial<Props> = {}): Props {
	return {
		open: true,
		onOpenChange: vi.fn(),
		taskEditorMode: "create",
		prompt: "",
		onPromptChange: vi.fn(),
		images: [],
		onImagesChange: vi.fn(),
		onCreate: vi.fn(() => null),
		onCreateMultiple: vi.fn(() => []),
		startInPlanMode: false,
		onStartInPlanModeChange: vi.fn(),
		taskAgentPermissionMode: "bypass_all_permission_prompts",
		onTaskAgentPermissionModeChange: vi.fn(),
		taskConversationMode: "operational",
		onTaskConversationModeChange: vi.fn(),
		autoReviewEnabled: false,
		onAutoReviewEnabledChange: vi.fn(),
		autoReviewMode: "commit",
		onAutoReviewModeChange: vi.fn(),
		workspaceId: "project-1",
		branchRef: "main",
		branchOptions: [{ value: "main", label: "main" }],
		onBranchRefChange: vi.fn(),
		worktreeMode: "branch",
		onWorktreeModeChange: vi.fn(),
		agents: [],
		defaultAgentId: "claude",
		...overrides,
	};
}

function findButtonByText(label: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.trim() === label) as
		| HTMLButtonElement
		| undefined;
}

function findCloseButton(): HTMLButtonElement | null {
	return document.body.querySelector<HTMLButtonElement>('[aria-label="关闭任务编辑器"]');
}

function hasPlanModeOverridesPermissionTierNotice(): boolean {
	return document.body.textContent?.includes('"Start in plan mode" overrides this tier') ?? false;
}

function getPromptTextarea(): HTMLTextAreaElement {
	const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea");
	if (!textarea) throw new Error("找不到任务 Prompt 输入框");
	return textarea;
}
async function typeIntoPrompt(value: string): Promise<void> {
	await act(async () => {
		const textarea = getPromptTextarea();
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function ControlledFollowUpTaskEditor({ input }: { input: Props }) {
	const [prompt, setPrompt] = useState(input.prompt);
	return <TaskEditorDialog {...input} prompt={prompt} onPromptChange={setPrompt} />;
}

describe("TaskEditorDialog interactions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

		// Radix + rich inputs touch a few DOM APIs jsdom does not implement.
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			} as unknown as typeof ResizeObserver;
		}
		Element.prototype.scrollIntoView ??= () => {};
		Element.prototype.hasPointerCapture ??= () => false;
		Element.prototype.setPointerCapture ??= () => {};
		Element.prototype.releasePointerCapture ??= () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "{}",
			})),
		);

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function render(props: Props): Promise<void> {
		await act(async () => {
			root.render(<TaskEditorDialog {...props} />);
		});
	}

	it.each([
		["create", "创建任务"],
		["create", "Start task"],
		["edit", "保存更改"],
		["edit", "Save and start"],
	] as const)("默认关闭时 %s 的 %s 沿用项目与分支且不接受分析缓存", async (taskEditorMode, actionLabel) => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		mockSuccessfulTaskStart();
		const props = makeProps({
			taskEditorMode,
			editingTaskId: taskEditorMode === "edit" ? "abcde" : undefined,
			prompt: "关闭自动分析后提交任务",
			onCreate: vi.fn((options) => {
				options?.onTaskPersistenceRequested?.(Promise.resolve(true));
				return "abcde";
			}),
			onCreateAndStart: vi.fn(() => null),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		expect(
			document.querySelector('[role="switch"][aria-label="自动分析项目归属"]')?.getAttribute("aria-checked"),
		).toBe("false");
		await act(async () => findButtonByText(actionLabel)?.click());
		expect(props.onCreate).toHaveBeenCalledWith(
			expect.objectContaining({ targetWorkspaceIdOverride: "project-1", baseRefOverride: "main" }),
		);
		expect(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).not.toHaveBeenCalled();
		expect(taskProjectAssignmentPreflight.rememberTaskProjectAssignmentAnalysisAccepted).not.toHaveBeenCalled();
	});

	it("默认关闭仍能手动分析，开关跨项目与编辑模式共享", async () => {
		vi.spyOn(relationModelingQueries, "readRelationModelingEditorDraft").mockResolvedValue(null);
		vi.spyOn(relationModelingQueries, "persistRelationModelingEditorDraft").mockResolvedValue({ saved: true });
		const props = makeProps({ prompt: "手动分析" });
		await render(props);
		await act(async () => findButtonByText("分析项目归属")?.click());
		expect(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).toHaveBeenCalledTimes(1);
		expect(props.onCreate).not.toHaveBeenCalled();
		await act(async () =>
			document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动分析项目归属"]')?.click(),
		);
		await render(makeProps({ taskEditorMode: "edit", editingTaskId: "bcdef", workspaceId: "project-2" }));
		expect(
			document.querySelector('[role="switch"][aria-label="自动分析项目归属"]')?.getAttribute("aria-checked"),
		).toBe("true");
	});

	it("开启后提交分析，分析开始后关闭开关仍完成本轮提交", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let completeAnalysis!: (result: { workspaceId: string; baseRef: string }) => void;
		vi.mocked(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).mockReturnValueOnce(
			new Promise((resolve) => {
				completeAnalysis = resolve;
			}),
		);
		const props = makeProps({ prompt: "需要分析的任务", onCreate: vi.fn(() => "abcde") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () =>
			document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动分析项目归属"]')?.click(),
		);
		await act(async () => findButtonByText("创建任务")?.click());
		expect(Array.from(document.querySelectorAll('[role="status"]')).map((status) => status.textContent)).toContain(
			"正在分析项目归属…",
		);
		await act(async () =>
			document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动分析项目归属"]')?.click(),
		);
		await act(async () => completeAnalysis({ workspaceId: "project-1", baseRef: "main" }));
		expect(props.onCreate).toHaveBeenCalledTimes(1);
		expect(taskProjectAssignmentPreflight.rememberTaskProjectAssignmentAnalysisAccepted).toHaveBeenCalledTimes(1);
		expect(
			document.querySelector('[role="switch"][aria-label="自动分析项目归属"]')?.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("项目分组与单条和批量任务正文并列，初始焦点仍在原输入框", async () => {
		vi.spyOn(relationModelingQueries, "readRelationModelingEditorDraft").mockResolvedValue(null);
		vi.spyOn(relationModelingQueries, "persistRelationModelingEditorDraft").mockResolvedValue({ saved: true });
		await render(
			makeProps({
				prompt: "- 第一项任务\n- 第二项任务",
				taskCreationTargetProjectField: {
					taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope",
					selectedTargetWorkspaceId: "project-1",
					selectableProjects: [{ workspaceId: "project-1", projectName: "cline-kanban" }],
					onSelectTargetWorkspaceId: vi.fn(),
				},
			}),
		);
		const projectField = document.querySelector('[data-testid="task-creation-target-project-field"]');
		const taskInput = document.querySelector("textarea");
		expect(projectField).not.toBeNull();
		expect(taskInput).not.toBeNull();
		expect(
			Boolean((projectField?.compareDocumentPosition(taskInput as Node) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING),
		).toBe(true);
		expect(projectField?.contains(document.activeElement)).toBe(false);
		const splitButton = Array.from(document.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Split into 2 tasks"),
		);
		expect(splitButton).toBeDefined();
		await act(async () => {
			splitButton?.click();
		});
		const batchInput = document.querySelector('input[placeholder="Describe the task..."]');
		expect(batchInput).not.toBeNull();
		expect(
			(projectField?.compareDocumentPosition(batchInput as Node) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING,
		).toBeTruthy();
	});

	it("closes immediately via the X button when the form has no edits", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(findButtonByText("放弃更改")).toBeUndefined();
	});

	it("asks for confirmation via the X button when the form has edits, and does not close until confirmed", async () => {
		const onOpenChange = vi.fn();
		// 打开时基线为空 prompt；随后受控地填入内容，模拟用户输入。
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});

		// 有编辑 → 弹确认，不直接关闭
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("放弃更改")).toBeDefined();
		expect(findButtonByText("继续编辑")).toBeDefined();

		await act(async () => {
			findButtonByText("放弃更改")?.click();
		});

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the dialog open when the user chooses to keep editing", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, prompt: "" }));
		await render(makeProps({ onOpenChange, prompt: "Fix the bug" }));

		await act(async () => {
			findCloseButton()?.click();
		});
		expect(findButtonByText("放弃更改")).toBeDefined();

		await act(async () => {
			findButtonByText("继续编辑")?.click();
		});

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("放弃更改")).toBeUndefined();
	});

	it("编辑模式在显式关闭时也检查未保存更改", async () => {
		const onOpenChange = vi.fn();
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", editingTaskId: "task-1", prompt: "旧内容" }));
		await render(makeProps({ onOpenChange, taskEditorMode: "edit", editingTaskId: "task-1", prompt: "新内容" }));
		await act(async () => {
			findCloseButton()?.click();
		});
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(findButtonByText("放弃更改")).toBeDefined();
	});

	it("warns that plan-mode start swallows the permission tier on single-axis harnesses", async () => {
		await render(makeProps({ defaultAgentId: "droid", startInPlanMode: true }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(true);
	});

	// 这两条钉住「组字期间整体让开」在 document 级热键上也成立。输入框各自的局部守卫拦不住它们：
	// 守卫早退时不再 preventDefault，而这两条热键只看 defaultPrevented，于是组字中的组合键会穿透过来
	// 把任务真的建出来 / 启动掉——用户当时只是在敲拼音。
	async function dispatchDocumentKeyDown(init: KeyboardEventInit): Promise<void> {
		await act(async () => {
			getPromptTextarea().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
		});
	}

	function prepareDeferredRelationDraftRead() {
		let resolveDraftRead!: (draft: ReferenceRelationModelingEditorDraft | null) => void;
		const pendingDraftRead = new Promise<ReferenceRelationModelingEditorDraft | null>((resolve) => {
			resolveDraftRead = resolve;
		});
		const readDraft = vi
			.spyOn(relationModelingQueries, "readRelationModelingEditorDraft")
			.mockReturnValue(pendingDraftRead);
		vi.spyOn(relationModelingQueries, "persistRelationModelingEditorDraft").mockResolvedValue({ saved: true });
		vi.spyOn(relationModelingQueries, "readRelationModelingPreview").mockResolvedValue({
			rootWorkUnitKey: "pending-task-creation",
			workUnits: [],
			relations: [],
			truncated: false,
			projectedThroughGlobalCommittedEventSequence: 0,
		});
		const applyChanges = vi
			.spyOn(relationModelingQueries, "applyReferenceRelationModelingChangesFromExplicitUserGesture")
			.mockResolvedValue({ modelingSubmissionId: "restored-submission", alreadyApplied: false });
		return { readDraft, resolveDraftRead, applyChanges };
	}

	function restoredCreationDraft(workspaceId: string): ReferenceRelationModelingEditorDraft {
		return {
			createdTaskId: `already-created-${workspaceId}`,
			createdTaskCardSnapshot: null,
			modelingSubmissionId: `restored-submission-${workspaceId}`,
			creationPrompt: `恢复 ${workspaceId} 的创建需求`,
			creationTitle: `恢复 ${workspaceId} 的任务名称`,
			relationRevocations: [],
			referenceRelationDrafts: [
				{
					draftId: `restored-relation-${workspaceId}`,
					replacesRelationId: null,
					expectedAssertedRelationStateVersion: null,
					counterpartWorkUnit: {
						workUnitType: "kanban_board_card",
						workspaceId,
						taskId: "counterpart",
						taskIncarnationCreatedAtEpochMs: 1,
					},
					relationKind: "reference_is_generally_related_with",
					currentTaskIsStatementSubject: true,
					relationAssertionRationaleOneSentence: "恢复尚未提交的关系",
					relationAssertionEvidencePointers: [],
					assertedRelationKindSpecificAttributes: {},
				},
			],
		};
	}

	function followUpSeed(workspaceId = "project-1") {
		return {
			initializationId: "pdv-follow-up-1",
			workspaceId,
			title: "[FIX]核查部署后问题",
			prompt: "核查选中的核对项",
			referenceRelationDrafts: restoredCreationDraft(workspaceId).referenceRelationDrafts,
		};
	}

	function mockSuccessfulTaskStart() {
		return vi
			.spyOn(taskCardActionCommands, "startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime")
			.mockImplementation(async ({ taskId }) => ({
				taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
				response: {
					boardColumnIdOfTaskCardBeforeAction: "backlog",
					taskCardWasMovedIntoInProgressColumnByThisAction: true,
					agentSessionStartOutcome: "agent_session_started",
					agentSessionStartFailureMessage: null,
					ensuredTaskWorktreeWarningMessage: null,
					startedAgentSessionSummary: null,
					taskCardSnapshotAfterAction: {
						taskCard: {
							id: taskId,
							title: "创建任务",
							prompt: "创建内容",
							baseRef: "main",
							startInPlanMode: false,
							createdAt: 41,
							updatedAt: 41,
						},
						boardColumnIdContainingTaskCard: "in_progress",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				},
			}));
	}

	it.each(["create", "start"] as const)("批量 %s 在真实关系 hook inactive 且未就绪时仍逐项提交", async (action) => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const actualRelationHook = relationModelingHooks.useReferenceRelationModelingEditor;
		let observedInactiveRelationHookWithoutReady = false;
		vi.spyOn(relationModelingHooks, "useReferenceRelationModelingEditor").mockImplementation(
			function useObservedRealRelationModelingEditor(input) {
				const controller = actualRelationHook(input);
				if (input.active === false && !controller.ready) observedInactiveRelationHookWithoutReady = true;
				return controller;
			},
		);
		const startTask = mockSuccessfulTaskStart();
		let nextTaskNumber = 0;
		const onCreate: Props["onCreate"] = vi.fn(() => `batch-task-${++nextTaskNumber}`);
		const props = makeProps({
			prompt: "- 第一项任务\n- 第二项任务",
			onCreate,
			onCreateAndStartMultiple: vi.fn(() => []),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("Split into 2 tasks")?.click());
		expect(observedInactiveRelationHookWithoutReady).toBe(true);
		const submitButton = findButtonByText(action === "create" ? "Create 2 tasks" : "Start 2 tasks");
		expect(submitButton).toBeDefined();
		expect(submitButton?.disabled).toBe(false);
		await act(async () => submitButton?.click());
		expect(onCreate).toHaveBeenCalledTimes(2);
		expect(vi.mocked(onCreate).mock.calls.map(([options]) => options?.promptOverride)).toEqual([
			"第一项任务",
			"第二项任务",
		]);
		expect(applyChanges).not.toHaveBeenCalled();
		expect(startTask).toHaveBeenCalledTimes(action === "start" ? 2 : 0);
		expect(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).not.toHaveBeenCalled();
		expect(taskProjectAssignmentPreflight.rememberTaskProjectAssignmentAnalysisAccepted).not.toHaveBeenCalled();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("恢复卡片在检查后被同 ID 重建，字段更新按原 createdAt 拒绝且不覆盖新一世", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const recoveredSnapshot: BoardCard = {
			id: "abcde",
			title: "原任务",
			prompt: "原任务内容",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 41,
			updatedAt: 41,
		};
		const recreatedTask = { ...recoveredSnapshot, title: "重新创建的新任务", prompt: "新一世内容", createdAt: 99 };
		// 初次核验成功后，更新请求到达前由另一动作删除并重建；服务端须在写锁内再次核验身份。
		vi.spyOn(relationModelingQueries, "ensureRelationModelingCreatedTaskCardPersisted").mockResolvedValue(undefined);
		const updateTask = vi
			.spyOn(taskCardActionQueries, "updateTaskCardFieldValuesInWorkspace")
			.mockImplementation(async (_workspaceId, request) => {
				if (
					request.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
					request.expectedTaskIncarnationCreatedAtEpochMs !== recreatedTask.createdAt
				)
					throw new Error("任务身份已变化，未写入编辑内容。");
				if (
					request.taskCardFieldUpdate.taskCardFieldUpdateInputKind === "three_state_task_card_field_value_patch"
				) {
					recreatedTask.prompt =
						request.taskCardFieldUpdate.taskCardFieldValuePatch.prompt ?? recreatedTask.prompt;
				}
				return {
					taskCardSnapshotAfterAction: {
						taskCard: recreatedTask,
						boardColumnIdContainingTaskCard: "backlog",
						taskSessionSummaryLiveInRuntimeProcessMemory: null,
						taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
					},
				};
			});
		const props = makeProps();
		await render(props);
		await act(async () =>
			resolveDraftRead({
				...restoredCreationDraft("project-1"),
				createdTaskId: recoveredSnapshot.id,
				createdTaskWorkspaceId: "project-1",
				createdTaskCardSnapshot: recoveredSnapshot,
			}),
		);
		await act(async () => findButtonByText("创建任务")?.click());
		expect(recreatedTask.prompt).toBe("新一世内容");
		expect(recreatedTask.title).toBe("重新创建的新任务");
		expect(updateTask).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ expectedTaskIncarnationCreatedAtEpochMs: 41 }),
		);
		expect(applyChanges).not.toHaveBeenCalled();
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("任务身份已变化，未写入编辑内容。");
	});

	it("采纳其他项目后关系保存成功但启动失败，重试保留目标项目和同一世身份", async () => {
		saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: true });
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		vi.spyOn(taskProjectAssignmentPreflight, "runTaskProjectAssignmentPreflight").mockResolvedValue({
			workspaceId: "target-project",
			baseRef: "main",
		});
		const snapshot: BoardCard = {
			id: "abcde",
			title: "跨项目创建",
			prompt: "创建需求",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 41,
			updatedAt: 41,
		};
		const ensureTask = vi
			.spyOn(relationModelingQueries, "ensureRelationModelingCreatedTaskCardPersisted")
			.mockImplementation(async (workspaceId, card) => {
				if (workspaceId !== "target-project" || card.id !== snapshot.id || card.createdAt !== snapshot.createdAt)
					throw new Error("恢复身份或目标项目错误，拒绝重复建卡。");
			});
		const transferTask = vi.spyOn(taskCardActionQueries, "transferNeverStartedBacklogTaskToProjectInWorkspace");
		const startTask = mockSuccessfulTaskStart().mockResolvedValueOnce({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: "模拟 Agent 启动失败",
		});
		const onCreate: Props["onCreate"] = vi.fn((options) => {
			expect(options?.targetWorkspaceIdOverride).toBe("target-project");
			options?.onTaskCardAllocatedForRelationModeling?.(snapshot);
			return snapshot.id;
		});
		const props = makeProps({ workspaceId: "source-project", onCreate, onCreateAndStart: vi.fn(() => null) });
		await render(props);
		await act(async () =>
			resolveDraftRead({
				...restoredCreationDraft("source-project"),
				createdTaskId: null,
				creationPrompt: snapshot.prompt,
				creationTitle: snapshot.title ?? "",
			}),
		);
		await act(async () => findButtonByText("Start task")?.click());
		expect(applyChanges).toHaveBeenCalledExactlyOnceWith(
			"target-project",
			expect.objectContaining({
				workUnit: expect.objectContaining({ workspaceId: "target-project", bareTaskId: "abcde" }),
			}),
		);
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("模拟 Agent 启动失败");
		const mirrorKey = Object.keys(localStorage).find((key) => key.startsWith("reference-relation-modeling:"));
		expect(mirrorKey).toBeDefined();
		expect(JSON.parse(localStorage.getItem(mirrorKey ?? "") ?? "null")).toMatchObject({
			createdTaskId: snapshot.id,
			createdTaskWorkspaceId: "target-project",
			createdTaskCardSnapshot: { id: snapshot.id, createdAt: snapshot.createdAt },
			referenceRelationDrafts: [],
		});
		await act(async () => findButtonByText("Start task")?.click());
		expect(onCreate).toHaveBeenCalledTimes(1);
		expect(ensureTask).toHaveBeenCalledExactlyOnceWith("target-project", snapshot);
		expect(taskCardActionQueries.updateTaskCardFieldValuesInWorkspace).toHaveBeenCalledWith(
			"target-project",
			expect.objectContaining({ taskId: snapshot.id, expectedTaskIncarnationCreatedAtEpochMs: snapshot.createdAt }),
		);
		expect(transferTask).not.toHaveBeenCalled();
		expect(startTask).toHaveBeenCalledTimes(2);
		for (const [request] of startTask.mock.calls)
			expect(request).toMatchObject({ workspaceId: "target-project", taskId: snapshot.id });
		expect(applyChanges).toHaveBeenCalledTimes(1);
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("PDV 预填等待关系草稿恢复，且只初始化一次", async () => {
		const deferred = prepareDeferredRelationDraftRead();
		const seed = followUpSeed();
		const input = makeProps({ postDeployVerificationFollowUpTaskCreationDraftSeed: seed });
		await act(async () => root.render(<ControlledFollowUpTaskEditor input={input} />));
		expect(getPromptTextarea().value).toBe("");
		await act(async () => deferred.resolveDraftRead(null));
		expect(getPromptTextarea().value).toBe(seed.prompt);
		await typeIntoPrompt("用户补充的实际现象");
		await act(async () => root.render(<ControlledFollowUpTaskEditor input={input} />));
		expect(getPromptTextarea().value).toBe("用户补充的实际现象");
		expect(
			JSON.parse(
				localStorage.getItem(
					`reference-relation-modeling:project-1:task-being-created:${sessionStorage.getItem("reference-relation-modeling-browser-tab-identity")}`,
				) ?? "null",
			).referenceRelationDrafts,
		).toEqual(seed.referenceRelationDrafts);
	});

	it("PDV 预填不覆盖恢复的草稿，确认放弃后才使用新上下文", async () => {
		const deferred = prepareDeferredRelationDraftRead();
		const seed = followUpSeed();
		await act(async () =>
			root.render(
				<ControlledFollowUpTaskEditor
					input={makeProps({ postDeployVerificationFollowUpTaskCreationDraftSeed: seed })}
				/>,
			),
		);
		await act(async () => deferred.resolveDraftRead(restoredCreationDraft("project-1")));
		expect(getPromptTextarea().value).toBe("恢复 project-1 的创建需求");
		expect(findButtonByText("放弃草稿")).toBeDefined();
		await act(async () => findButtonByText("放弃草稿")?.click());
		expect(getPromptTextarea().value).toBe(seed.prompt);
	});

	it("PDV 来源项目未就绪时不初始化到当前项目", async () => {
		const deferred = prepareDeferredRelationDraftRead();
		const seed = followUpSeed("source-project");
		await render(makeProps({ postDeployVerificationFollowUpTaskCreationDraftSeed: seed }));
		await act(async () => deferred.resolveDraftRead(null));
		expect(getPromptTextarea().value).toBe("");
		expect(findButtonByText("创建任务")?.disabled).toBe(true);
	});

	it("草稿尚未水合时按钮和全部创建快捷键均等待，空草稿水合后照常创建", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const props = makeProps({
			prompt: "普通创建需求",
			onCreate: vi.fn(() => "new-task"),
			onCreateAndStart: vi.fn(() => "new-started-task"),
			onCreateStartAndOpen: vi.fn(() => "new-opened-task"),
		});
		await render(props);
		expect(findButtonByText("创建任务")?.disabled).toBe(true);
		expect(findButtonByText("Start task")?.disabled).toBe(true);
		expect(document.querySelector<HTMLButtonElement>('[aria-label="More start options"]')?.disabled).toBe(true);
		await act(async () => {
			findButtonByText("创建任务")?.click();
			findButtonByText("Start task")?.click();
		});
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true });
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true, shiftKey: true });
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true });
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(props.onCreateAndStart).not.toHaveBeenCalled();
		expect(props.onCreateStartAndOpen).not.toHaveBeenCalled();
		expect(applyChanges).not.toHaveBeenCalled();
		await act(async () => resolveDraftRead(null));
		expect(findButtonByText("创建任务")?.disabled).toBe(false);
		await act(async () => findButtonByText("创建任务")?.click());
		expect(props.onCreate).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ promptOverride: "普通创建需求" }),
		);
		expect(applyChanges).not.toHaveBeenCalled();
	});

	it("首次打开等待恢复关系及原卡身份，水合完成后复用原卡而不重复建卡", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const props = makeProps({ prompt: "新输入的需求", onCreate: vi.fn(() => "incorrect-new-task") });
		await render(props);
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true });
		expect(props.onCreate).not.toHaveBeenCalled();
		const recoveredDraft = restoredCreationDraft("project-1");
		await act(async () => resolveDraftRead(recoveredDraft));
		expect(document.querySelector("textarea")?.value).toBe(recoveredDraft.creationPrompt);
		await act(async () => findButtonByText("创建任务")?.click());
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toBeUndefined();
		expect(applyChanges).toHaveBeenCalledExactlyOnceWith(
			"project-1",
			expect.objectContaining({
				workUnit: expect.objectContaining({ bareTaskId: recoveredDraft.createdTaskId }),
				referenceRelationDrafts: recoveredDraft.referenceRelationDrafts,
			}),
		);
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("切换项目后等当前 scope 草稿水合，不把旧项目的关系或卡片身份用于新项目", async () => {
		const { readDraft, resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		readDraft.mockResolvedValueOnce(restoredCreationDraft("project-1"));
		const props = makeProps({ prompt: "创建需求", onCreate: vi.fn(() => "incorrect-new-task") });
		await render(props);
		await render({ ...props, workspaceId: "project-2" });
		expect(findButtonByText("创建任务")?.disabled).toBe(true);
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true });
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(applyChanges).not.toHaveBeenCalled();
		const recoveredDraft = restoredCreationDraft("project-2");
		await act(async () => resolveDraftRead(recoveredDraft));
		await act(async () => findButtonByText("创建任务")?.click());
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(applyChanges).toHaveBeenCalledExactlyOnceWith(
			"project-2",
			expect.objectContaining({
				workUnit: expect.objectContaining({ bareTaskId: recoveredDraft.createdTaskId, workspaceId: "project-2" }),
				referenceRelationDrafts: recoveredDraft.referenceRelationDrafts,
			}),
		);
	});

	it("does not create the task on a Mod+Enter emitted while the IME is still composing", async () => {
		const onCreate: Props["onCreate"] = vi.fn(() => "task-1");
		await render(makeProps({ onCreate, prompt: "测试任务" }));

		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true, isComposing: true });
		expect(onCreate).not.toHaveBeenCalled();

		// 组字结束后的真 Mod+Enter 必须照常建卡——守卫不能把正常路径也堵死。
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true });
		expect(onCreate).toHaveBeenCalledTimes(1);
	});

	it("does not start-and-open on an Alt+Shift+Enter emitted while the IME is still composing", async () => {
		const onCreate: Props["onCreate"] = vi.fn(() => null);
		const onCreateStartAndOpen: Props["onCreateStartAndOpen"] = vi.fn(() => "task-1");
		await render(makeProps({ onCreateStartAndOpen, onCreate, prompt: "测试任务" }));

		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true, isComposing: true });
		expect(onCreateStartAndOpen).not.toHaveBeenCalled();

		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true });
		expect(onCreate).toHaveBeenCalledTimes(1);
		expect(onCreateStartAndOpen).not.toHaveBeenCalled();
	});

	it("does not warn about a plan-mode conflict when the harness keeps the two axes independent", async () => {
		await render(makeProps({ defaultAgentId: "droid", startInPlanMode: false }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(false);

		await render(makeProps({ defaultAgentId: "claude", startInPlanMode: true }));
		expect(hasPlanModeOverridesPermissionTierNotice()).toBe(false);
	});
	// （编辑既有卡片显示的是卡自己的 baseRef、用户手动改过显示的是他自己的选择），它们就是在撒谎。
	describe("base ref 来源提示的显示条件", () => {
		const rememberedBaseRefProps: Partial<Props> = {
			branchOptions: [
				{ value: "main", label: "main" },
				{ value: "feature/remembered", label: "feature/remembered" },
			],
			taskCreateBaseRefRememberedForCurrentProject: "feature/remembered",
			repositoryDefaultBranchRef: "main",
		};
		const discardedRememberedBaseRefProps: Partial<Props> = {
			rememberedTaskCreateBaseRefDiscardedBecauseBranchNoLongerExists: "feature/deleted",
			repositoryDefaultBranchRef: "main",
			resolvedDefaultTaskCreateBaseRef: "main",
		};

		function hasRememberedHint(): boolean {
			return document.body.textContent?.includes("Remembered from the last task you created") ?? false;
		}
		function hasDiscardedRememberedHint(): boolean {
			return document.body.textContent?.includes("no longer exists") ?? false;
		}

		it("建卡模式下显示「记住的」提示，用户手动改回默认分支后不再显示", async () => {
			await render(makeProps({ ...rememberedBaseRefProps, branchRef: "feature/remembered" }));
			expect(hasRememberedHint()).toBe(true);

			await render(makeProps({ ...rememberedBaseRefProps, branchRef: "main" }));
			expect(hasRememberedHint()).toBe(false);
		});

		it("编辑既有卡片时不显示「记住的」提示——那显示的是卡自己的 baseRef", async () => {
			await render(
				makeProps({ ...rememberedBaseRefProps, taskEditorMode: "edit", branchRef: "feature/remembered" }),
			);
			expect(hasRememberedHint()).toBe(false);
		});

		it("建卡模式下显示「记忆分支已消失」提示", async () => {
			await render(makeProps({ ...discardedRememberedBaseRefProps, branchRef: "main" }));
			expect(hasDiscardedRememberedHint()).toBe(true);
		});

		it("编辑既有卡片时不显示「记忆分支已消失」提示", async () => {
			await render(makeProps({ ...discardedRememberedBaseRefProps, taskEditorMode: "edit", branchRef: "main" }));
			expect(hasDiscardedRememberedHint()).toBe(false);
		});

		it("用户手动挑了别的分支后不再把它说成自动回落的结果", async () => {
			await render(
				makeProps({
					...discardedRememberedBaseRefProps,
					branchOptions: [
						{ value: "main", label: "main" },
						{ value: "release/1", label: "release/1" },
					],
					branchRef: "release/1",
				}),
			);
			expect(hasDiscardedRememberedHint()).toBe(false);
		});
	});
});

/**
 * 逐字输入已下沉为对话框本地 state（A-P0-1）：不再每次按键都经 `onPromptChange` 打到
 * `App` 根节点连同整棵卡片树重渲。下面几例钉住这次下沉的三条不变量——不逐键上抛、
 * 失焦上抛、以及提交时必须把最新草稿交出去（否则用户刚敲完就点提交会丢掉最后一段）。
 */
describe("TaskEditorDialog prompt draft ownership", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		if (typeof globalThis.ResizeObserver === "undefined") {
			globalThis.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			} as unknown as typeof ResizeObserver;
		}
		Element.prototype.scrollIntoView ??= () => {};
		Element.prototype.hasPointerCapture ??= () => false;
		Element.prototype.setPointerCapture ??= () => {};
		Element.prototype.releasePointerCapture ??= () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({}),
				text: async () => "{}",
			})),
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function getPromptTextarea(): HTMLTextAreaElement {
		const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) {
			throw new Error("Expected the prompt textarea to be rendered.");
		}
		return textarea;
	}

	// React 受控 textarea：直接赋值不触发 onChange，需走原生 setter + input 事件。
	async function typeIntoPrompt(value: string): Promise<void> {
		const textarea = getPromptTextarea();
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		await act(async () => {
			setter?.call(textarea, value);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("does not push every keystroke up to the parent", async () => {
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange })} />);
		});

		for (const value of ["F", "Fi", "Fix", "Fix ", "Fix t", "Fix th", "Fix the"]) {
			await typeIntoPrompt(value);
		}

		expect(onPromptChange).not.toHaveBeenCalled();
		expect(getPromptTextarea().value).toBe("Fix the");
	});

	it("pushes the draft up on blur", async () => {
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange })} />);
		});

		await typeIntoPrompt("Fix the bug");
		expect(onPromptChange).not.toHaveBeenCalled();

		// React 的 onBlur 由委托在 root 上的 focusout 合成，派发不冒泡的 blur 事件到不了它。
		await act(async () => {
			getPromptTextarea().focus();
			getPromptTextarea().blur();
		});

		expect(onPromptChange).toHaveBeenCalledWith("Fix the bug");
	});

	it("hands the newest draft to onCreate even when the textarea never lost focus", async () => {
		// 回归保护：提交那一刻父层 state 必然落后一拍，若不经 promptOverride 显式交接，
		// 「敲完直接点 Create」会用上一次上抛的旧文本建卡。
		const onCreate: Props["onCreate"] = vi.fn(() => "task-1");
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onCreate, prompt: "" })} />);
		});

		await typeIntoPrompt("Ship the fix");

		await act(async () => {
			findButtonByText("创建任务")?.click();
		});

		expect(onCreate).toHaveBeenCalledTimes(1);
		expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ promptOverride: "Ship the fix" }));
	});

	it("adopts a prompt value changed by the parent (reopening on a different task)", async () => {
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ prompt: "First task body" })} />);
		});
		expect(getPromptTextarea().value).toBe("First task body");

		await typeIntoPrompt("Locally edited body");
		expect(getPromptTextarea().value).toBe("Locally edited body");

		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ prompt: "Second task body" })} />);
		});

		expect(getPromptTextarea().value).toBe("Second task body");
	});

	// 对话框关闭后组件仍保持挂载（App 无条件渲染 <TaskEditorDialog open={...}/>），
	// 所以「关闭」必须同时做两件事：把本地草稿拉回父层当前值、并让挂起的停顿上抛失效。
	// 下面三例分别钉住这两条以及它们不能误伤的既有行为。
	async function waitPastIdlePropagation(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => {
				// 需真实超过 PROMPT_DRAFT_IDLE_PROPAGATION_DELAY_MS（1500ms）。
				setTimeout(resolve, 1800);
			});
		});
	}

	it("does not write the submitted prompt back to the parent after the dialog closed", async () => {
		// 回归保护：提交后父层 newTaskPrompt 本就是空串，setNewTaskPrompt("") 被 React bail out、
		// prop 不变，渲染期 prop 同步无从触发。若挂起的停顿上抛不受 open 约束，它会在关闭之后
		// 才 fire，把已提交的文本写回父层——下次打开 New task 就是幽灵内容，再点一次 Create 即重复建卡。
		const onPromptChange = vi.fn();
		const onCreate: Props["onCreate"] = vi.fn(() => "task-1");
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, onCreate, prompt: "" })} />);
		});

		await typeIntoPrompt("Ship the fix");
		await act(async () => {
			findButtonByText("创建任务")?.click();
		});

		// create 路径关闭：open 翻 false，而父层 prompt 依旧是空串。
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, onCreate, prompt: "", open: false })} />);
		});

		await waitPastIdlePropagation();

		expect(onPromptChange).not.toHaveBeenCalled();
	});

	it("still propagates the draft after an idle pause while the dialog is open", async () => {
		// 守住崩溃兜底：给去抖回调加 open 守卫不能顺手把「停顿即上抛」杀掉，
		// 否则编辑模式的草稿写盘会永远等不到内容。
		const onPromptChange = vi.fn();
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ onPromptChange, prompt: "" })} />);
		});

		await typeIntoPrompt("Typed but never blurred");
		expect(onPromptChange).not.toHaveBeenCalled();

		await waitPastIdlePropagation();

		expect(onPromptChange).toHaveBeenCalledWith("Typed but never blurred");
	});

	it("restores the parent prompt into the local draft when an edit dialog is reopened", async () => {
		// 守住关闭同步不能吃掉编辑模式的正文：重新打开同一张卡时应看到父层正文，
		// 而不是上次未提交的本地草稿。
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "Original body" })} />);
		});
		expect(getPromptTextarea().value).toBe("Original body");

		await typeIntoPrompt("Abandoned local edit");
		expect(getPromptTextarea().value).toBe("Abandoned local edit");

		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "", open: false })} />);
		});
		await act(async () => {
			root.render(<TaskEditorDialog {...makeProps({ taskEditorMode: "edit", prompt: "Original body" })} />);
		});

		expect(getPromptTextarea().value).toBe("Original body");
	});

	// 这两条提示都在解释「下拉框里这个值是怎么来的」。只要下拉框显示的不是那个自动解析出来的值
});
