import type { ReferenceRelationModelingEditorDraft } from "@runtime-work-unit-relation-modeling-api-contract";
import type { ComponentProps } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskEditorDialog } from "@/components/task-editor-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as relationModelingHooks from "@/hooks/use-reference-relation-modeling-editor";
import {
	EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
	type SelectedCounterpartKanbanBoardCardForAddReferenceRelation,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import { agentPromptFileAttachmentQueries } from "@/runtime/agent-prompt-file-attachment-query";
import * as taskIdPrefetch from "@/runtime/runtime-allocated-task-id-prefetch-pool-for-new-web-ui-task-cards";
import * as taskCardActionQueries from "@/runtime/task-card-action-query";
import * as creationQueries from "@/runtime/task-editor-creation-submission-query";
import type { TaskEditorCreationSubmissionRequest, TaskEditorCreationSubmissionStatus } from "@/runtime/types";
import {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import * as relationModelingQueries from "@/runtime/work-unit-relation-modeling-query";
import * as taskCardActionCommands from "@/state/task-card-action-commands-for-any-workspace";
import * as creationBrowserRecovery from "@/state/task-editor-creation-submission-browser-recovery";
import * as taskProjectAssignmentPreflight from "@/state/task-project-assignment-preflight";

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
vi.mock("@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker", () => ({
	WorkUnitRelationCounterpartKanbanBoardCardPicker: ({
		onSelectedCounterpartKanbanBoardCardChange,
	}: {
		onSelectedCounterpartKanbanBoardCardChange: (
			value: SelectedCounterpartKanbanBoardCardForAddReferenceRelation,
		) => void;
	}) => (
		<button
			type="button"
			onClick={() =>
				onSelectedCounterpartKanbanBoardCardChange({
					counterpartKanbanBoardCardWorkspaceId: "counterpart-project",
					counterpartKanbanBoardCardTaskId: "ee150",
					counterpartKanbanBoardCardTitle: "明确选择的关联任务",
					counterpartKanbanProjectDisplayName: "关联项目",
				})
			}
		>
			选择关联任务
		</button>
	),
}));
function creationStatus(
	request: TaskEditorCreationSubmissionRequest,
	workspaceId = "project-1",
): TaskEditorCreationSubmissionStatus {
	return {
		submissionId: request.submissionId,
		workspaceId,
		taskId: request.newTaskCard.id,
		taskIncarnationCreatedAtEpochMs: request.newTaskCard.createdAt,
		cardPersisted: true,
		relationsCompleted: true,
		startRequested: request.startAgentAfterCreation,
		startCompleted: false,
		phase: "waiting_for_dependency",
		lastError: "模拟后续步骤暂不可用",
		recoveryCondition: "等待依赖恢复",
		attemptsInCurrentRecoveryRound: 3,
		acceptedAtEpochMs: 1,
		updatedAtEpochMs: 1,
	};
}
beforeEach(() => {
	vi.spyOn(creationQueries, "readTaskEditorCreationSubmissionStatus").mockResolvedValue(null);
	vi.spyOn(creationQueries, "submitTaskEditorCreation").mockImplementation(async (workspaceId, request) =>
		creationStatus(request, workspaceId),
	);
	vi.spyOn(creationQueries, "recoverLegacyTaskEditorCreationDraft").mockImplementation(
		async (_workspaceId, draft) => ({
			...draft,
			createdTaskId: null,
			createdTaskCardSnapshot: null,
			createdTaskWorkspaceId: undefined,
			referenceRelationDrafts: [],
			relationRevocations: [],
			creationPrompt: "",
			creationTitle: "",
		}),
	);
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
	const props: Props = {
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
	const create = props.onCreate;
	props.onCreate = vi.fn((options) => {
		let suppliedSnapshot = false;
		const taskId = create({
			...options,
			onNewTaskCardPreparedForRuntimeCreationSubmission: (card) => {
				suppliedSnapshot = true;
				options?.onNewTaskCardPreparedForRuntimeCreationSubmission?.(card);
			},
		});
		if (taskId && options?.delegateNewTaskCardPersistenceToRuntimeCreationSubmission && !suppliedSnapshot)
			options.onNewTaskCardPreparedForRuntimeCreationSubmission?.({
				id: taskId,
				title: options.taskNameOverride || "独立新任务",
				prompt: options.promptOverride ?? props.prompt,
				baseRef: options.baseRefOverride ?? props.branchRef,
				images: props.images,
				startInPlanMode: props.startInPlanMode,
				createdAt: 41,
				updatedAt: 41,
			});
		return taskId;
	});
	return props;
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
	const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务正文"]');
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

function ControlledCreationRecoveryEditor({ input }: { input: Props }) {
	const [prompt, setPrompt] = useState(input.prompt);
	const [title, setTitle] = useState(input.creatingTaskName ?? "");
	const [images, setImages] = useState(input.images);
	const [branchRef, setBranchRef] = useState(input.branchRef);
	return (
		<TaskEditorDialog
			{...input}
			prompt={prompt}
			creatingTaskName={title}
			images={images}
			branchRef={branchRef}
			onPromptChange={(value) => {
				setPrompt(value);
				input.onPromptChange(value);
			}}
			onCreatingTaskNameChange={(value) => {
				setTitle(value);
				input.onCreatingTaskNameChange?.(value);
			}}
			onImagesChange={(value) => {
				setImages(value);
				input.onImagesChange(value);
			}}
			onBranchRefChange={(value) => {
				setBranchRef(value);
				input.onBranchRefChange(value);
			}}
		/>
	);
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
			root.render(
				<TooltipProvider>
					<TaskEditorDialog {...props} />
				</TooltipProvider>,
			);
		});
	}

	it.each(["create", "edit"] as const)(
		"%s 从读取附件起禁用所有提交入口，完成后提交最新正文",
		async (taskEditorMode) => {
			const { resolveDraftRead } = prepareDeferredRelationDraftRead();
			let finishUpload!: (value: { fileName: string; filePath: string }) => void;
			const upload = vi.spyOn(agentPromptFileAttachmentQueries, "save").mockReturnValue(
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
			);
			const props = makeProps({
				taskEditorMode,
				editingTaskId: taskEditorMode === "edit" ? "abcde" : undefined,
				prompt: "原始正文",
				onCreateAndStart: vi.fn(() => null),
				onCreateStartAndOpen: vi.fn(() => null),
			});
			await render(props);
			await act(async () => resolveDraftRead(null));
			await act(async () => {
				const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
				Object.defineProperty(input, "files", { configurable: true, value: [new File(["材料"], "notes.txt")] });
				input.dispatchEvent(new Event("change", { bubbles: true }));
			});
			const saveButton = findButtonByText(taskEditorMode === "edit" ? "保存更改" : "创建任务")!;
			expect(saveButton.disabled).toBe(true);
			for (const button of Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))) {
				if (button.textContent?.includes("并启动") || button.getAttribute("aria-label") === "More start options")
					expect(button.disabled).toBe(true);
			}
			await typeIntoPrompt("上传期间最新正文");
			await act(async () => {
				saveButton.click();
				for (const modifiers of [
					{ ctrlKey: true },
					{ metaKey: true, shiftKey: true },
					{ altKey: true, shiftKey: true },
				]) {
					getPromptTextarea().dispatchEvent(
						new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifiers }),
					);
				}
			});
			expect(props.onCreate).not.toHaveBeenCalled();
			expect(props.onCreateAndStart).not.toHaveBeenCalled();
			expect(props.onCreateStartAndOpen).not.toHaveBeenCalled();
			await act(async () => vi.waitFor(() => expect(upload).toHaveBeenCalledOnce()));
			await act(async () => finishUpload({ fileName: "notes.txt", filePath: "/persistent/notes.txt" }));
			expect(saveButton.disabled).toBe(false);
			await act(async () => saveButton.click());
			expect(props.onCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					promptOverride: '上传期间最新正文\n\n附件："notes.txt"\n持久路径："/persistent/notes.txt"',
				}),
			);
		},
	);

	it.each([
		["create", "项目分析", "读取", "选择"],
		["edit", "项目分析", "上传", "拖放"],
		["create", "任务 ID 预取", "上传", "拖放"],
	] as const)(
		"%s 在%s期间新增附件，%s未完成时停止原提交并保留草稿（%s）",
		async (taskEditorMode, waitingStage, attachmentStage, attachmentInputMethod) => {
			const { resolveDraftRead } = prepareDeferredRelationDraftRead();
			let finishSubmissionPreparation!: () => void;
			const preparation = new Promise<void>((resolve) => {
				finishSubmissionPreparation = resolve;
			});
			if (waitingStage === "项目分析") {
				vi.mocked(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).mockImplementationOnce(
					async ({ workspaceId, baseRef }) => {
						await preparation;
						return { workspaceId, baseRef };
					},
				);
			} else {
				vi.spyOn(taskIdPrefetch, "ensureOneRuntimeAllocatedTaskIdReadyForTaskEditorSubmission").mockReturnValueOnce(
					preparation,
				);
			}
			let attachmentReader!: FileReader;
			vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
				attachmentReader = this;
			});
			const finishAttachmentRead = () => {
				Object.defineProperty(attachmentReader, "result", { value: "data:text/plain;base64,eA==" });
				attachmentReader.dispatchEvent(new Event("load"));
			};
			let finishUpload!: (value: { fileName: string; filePath: string }) => void;
			const upload = vi.spyOn(agentPromptFileAttachmentQueries, "save").mockReturnValue(
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
			);
			const props = makeProps({
				taskEditorMode,
				editingTaskId: taskEditorMode === "edit" ? "abcde" : undefined,
				prompt: "原始正文",
				onCreate: vi.fn(() => "abcde"),
			});
			await render(props);
			await act(async () => resolveDraftRead(null));
			if (waitingStage === "项目分析")
				await act(async () =>
					document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动分析项目归属"]')?.click(),
				);
			const actionLabel = taskEditorMode === "edit" ? "保存更改" : "创建任务";
			await act(async () => findButtonByText(actionLabel)?.click());
			await act(async () => {
				const files = [new File(["x"], "notes.txt")];
				if (attachmentInputMethod === "拖放") {
					const event = new Event("drop", { bubbles: true, cancelable: true });
					Object.defineProperty(event, "dataTransfer", { value: { files } });
					getPromptTextarea().dispatchEvent(event);
				} else {
					const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
					Object.defineProperty(input, "files", { configurable: true, value: files });
					input.dispatchEvent(new Event("change", { bubbles: true }));
				}
			});
			if (attachmentStage === "上传") await act(async () => finishAttachmentRead());
			await act(async () => finishSubmissionPreparation());
			expect(props.onCreate).not.toHaveBeenCalled();
			expect(creationQueries.submitTaskEditorCreation).not.toHaveBeenCalled();
			expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
			expect(getPromptTextarea().value).toBe("原始正文");
			expect(findButtonByText(actionLabel)?.disabled).toBe(true);
			await typeIntoPrompt("上传期间最新正文");
			if (attachmentStage === "读取") await act(async () => finishAttachmentRead());
			expect(upload).toHaveBeenCalledOnce();
			await act(async () => finishUpload({ fileName: "notes.txt", filePath: "/persistent/notes.txt" }));
			expect(findButtonByText(actionLabel)?.disabled).toBe(false);
			await act(async () => findButtonByText(actionLabel)?.click());
			expect(props.onCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					promptOverride: '上传期间最新正文\n\n附件："notes.txt"\n持久路径："/persistent/notes.txt"',
				}),
			);
		},
	);

	it.each(["create", "edit"] as const)("%s 已进入保存时不接受拖放附件", async (taskEditorMode) => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let finishPersistence!: () => void;
		const persistence = new Promise<void>((resolve) => {
			finishPersistence = resolve;
		});
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (workspaceId, request) => {
			await persistence;
			return creationStatus(request, workspaceId);
		});
		const attachmentRead = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => {});
		const upload = vi.spyOn(agentPromptFileAttachmentQueries, "save");
		const props = makeProps({
			taskEditorMode,
			editingTaskId: taskEditorMode === "edit" ? "abcde" : undefined,
			prompt: "已冻结的正文",
			onCreate: vi.fn((options) => {
				options?.onTaskPersistenceRequested?.(persistence.then(() => true));
				return "abcde";
			}),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText(taskEditorMode === "edit" ? "保存更改" : "创建任务")?.click());
		expect(props.onCreate).toHaveBeenCalledOnce();
		expect(getPromptTextarea().closest("fieldset")?.disabled).toBe(true);
		await act(async () => {
			const event = new Event("drop", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { value: { files: [new File(["x"], "late-notes.txt")] } });
			getPromptTextarea().dispatchEvent(event);
		});
		await act(async () => finishPersistence());
		expect(attachmentRead).not.toHaveBeenCalled();
		expect(upload).not.toHaveBeenCalled();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it.each(["关闭后重开", "切换编辑任务"])("%s 不接受上一张草稿的迟到附件", async (transition) => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let finishUpload!: (value: { fileName: string; filePath: string }) => void;
		const upload = vi.spyOn(agentPromptFileAttachmentQueries, "save").mockReturnValue(
			new Promise((resolve) => {
				finishUpload = resolve;
			}),
		);
		const props = makeProps({ taskEditorMode: "edit", editingTaskId: "abcde", prompt: "旧正文" });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => {
			const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
			Object.defineProperty(input, "files", { configurable: true, value: [new File(["材料"], "late.txt")] });
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => vi.waitFor(() => expect(upload).toHaveBeenCalledOnce()));
		if (transition === "关闭后重开") await render({ ...props, open: false });
		await render({ ...props, editingTaskId: transition === "关闭后重开" ? "abcde" : "bcdef", prompt: "新草稿正文" });
		await act(async () => finishUpload({ fileName: "late.txt", filePath: "/persistent/late.txt" }));
		expect(getPromptTextarea().value).toBe("新草稿正文");
		expect(findButtonByText("保存更改")?.disabled).toBe(false);
		expect(document.body.textContent).not.toContain("附件正在保存");
	});

	it.each([
		["create", "创建任务"],
		["create", "创建并启动"],
		["edit", "保存更改"],
		["edit", "保存并启动"],
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

	it("项目摘要位于单条和批量任务正文之前，初始焦点仍在原输入框", async () => {
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
		const taskInput = document.querySelector('textarea[aria-label="任务正文"]');
		expect(projectField).not.toBeNull();
		expect(taskInput).not.toBeNull();
		expect(
			Boolean((projectField?.compareDocumentPosition(taskInput as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING),
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
			(projectField?.compareDocumentPosition(batchInput as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
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

	it("旧创建草稿的身份不能把后来填写的任务 B 写回任务 A", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const props = makeProps({ prompt: "任务 B 的新正文", onCreate: vi.fn(() => "new02") });
		await render(props);
		await act(async () => resolveDraftRead(restoredCreationDraft("project-1")));
		await typeIntoPrompt("任务 B 的新正文");
		await act(async () => findButtonByText("创建任务")?.click());
		expect(taskCardActionQueries.updateTaskCardFieldValuesInWorkspace).not.toHaveBeenCalled();
		expect(props.onCreate).toHaveBeenCalled();
	});

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

	it("已选关系身份解析失败时，创建并启动不会建卡、保存关系或启动会话", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const startTask = mockSuccessfulTaskStart();
		vi.spyOn(relationModelingQueries, "resolveRelationModelingCounterpart").mockRejectedValueOnce(
			new Error("身份查询暂不可用"),
		);
		const props = makeProps({
			prompt: "必须关联已选任务",
			onCreate: vi.fn(() => "new03"),
			onCreateAndStart: vi.fn(() => null),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("添加关系")?.click());
		await act(async () => findButtonByText("选择关联任务")?.click());
		expect(document.body.textContent).toContain("身份查询暂不可用");
		await act(async () => findButtonByText("创建并启动")?.click());
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(applyChanges).not.toHaveBeenCalled();
		expect(startTask).not.toHaveBeenCalled();
		expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
	});
	it.each(["没有后续修改", "后来修改正文", "后来新增关系"] as const)(
		"Backlog 关系保存清空草稿后：%s",
		async (laterChange) => {
			const actualHook = relationModelingHooks.useReferenceRelationModelingEditor;
			let controller!: ReturnType<typeof actualHook>;
			vi.spyOn(relationModelingHooks, "useReferenceRelationModelingEditor").mockImplementation((input) => {
				controller = actualHook(input);
				return controller;
			});
			const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
			let completeApply!: () => void;
			applyChanges.mockImplementation(
				() =>
					new Promise((resolve) => {
						completeApply = () => resolve({ modelingSubmissionId: "restored-submission", alreadyApplied: false });
					}),
			);
			let completeClearedDraftPersistence!: () => void;
			vi.mocked(relationModelingQueries.persistRelationModelingEditorDraft).mockImplementation(
				async (_workspace, _scope, draft) => {
					if (draft === null)
						await new Promise<void>((resolve) => {
							completeClearedDraftPersistence = resolve;
						});
					return { saved: true };
				},
			);
			const props = makeProps({
				taskEditorMode: "edit",
				editingTaskId: "bcdef",
				prompt: "原始正文",
				onCreate: vi.fn(() => "bcdef"),
			});
			await render(props);
			const restored = { ...restoredCreationDraft("project-1"), createdTaskId: null };
			await act(async () => resolveDraftRead(restored));
			await act(async () => findButtonByText("保存更改")?.click());
			expect(applyChanges).toHaveBeenCalledOnce();
			await act(async () => completeApply());
			expect(controller.readLatestDraft().referenceRelationDrafts).toEqual([]);
			if (laterChange === "后来修改正文") await typeIntoPrompt("之后输入的正文");
			if (laterChange === "后来新增关系")
				await act(async () => controller.addDraft(restored.referenceRelationDrafts[0]!));
			await act(async () => completeClearedDraftPersistence());
			if (laterChange === "没有后续修改") expect(props.onOpenChange).toHaveBeenCalledWith(false);
			else expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
		},
	);
	it.each(["create", "edit"] as const)("%s 恢复的无效关系详情阻止提交和启动", async (taskEditorMode) => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const startTask = mockSuccessfulTaskStart();
		const props = makeProps({
			taskEditorMode,
			editingTaskId: taskEditorMode === "edit" ? "ed150" : null,
			prompt: "保留尚未修正的证据",
			onCreate: vi.fn(() => "new03"),
			onCreateAndStart: vi.fn(() => null),
		});
		await render(props);
		const draft = restoredCreationDraft("project-1");
		const { selectedCounterpartKanbanBoardCard: _counterpart, ...details } =
			EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT;
		await act(async () =>
			resolveDraftRead({
				...draft,
				createdTaskId: null,
				invalidReferenceRelationDetailsFormsByDraftId: {
					"restored-relation-project-1": {
						...details,
						currentTaskIsStatementSubject: true,
						relationAssertionEvidencePointersOnePerLineText: "x".repeat(1001),
					},
				},
			}),
		);
		expect(document.body.textContent).toContain("1000");
		await act(async () => findButtonByText(taskEditorMode === "create" ? "创建并启动" : "保存并启动")?.click());
		expect(props.onCreate).not.toHaveBeenCalled();
		expect(taskCardActionQueries.updateTaskCardFieldValuesInWorkspace).not.toHaveBeenCalled();
		expect(applyChanges).not.toHaveBeenCalled();
		expect(startTask).not.toHaveBeenCalled();
	});

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
		const onCreate: Props["onCreate"] = vi.fn(() => `b${String(++nextTaskNumber).padStart(4, "0")}`);
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
		const elapsedGestureClock = vi.spyOn(performance, "now").mockReturnValue(100);
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (workspaceId, request) => {
			elapsedGestureClock.mockReturnValue(2_500);
			return creationStatus(request, workspaceId);
		});
		await act(async () => submitButton?.click());
		expect(onCreate).toHaveBeenCalledTimes(2);
		expect(vi.mocked(onCreate).mock.calls.map(([options]) => options?.promptOverride)).toEqual([
			"第一项任务",
			"第二项任务",
		]);
		expect(applyChanges).not.toHaveBeenCalled();
		expect(startTask).not.toHaveBeenCalled();
		expect(creationQueries.submitTaskEditorCreation).toHaveBeenCalledTimes(2);
		expect(
			vi
				.mocked(creationQueries.submitTaskEditorCreation)
				.mock.calls.map(([, request]) => request.startAgentAfterCreation),
		).toEqual([action === "start", action === "start"]);
		expect(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).not.toHaveBeenCalled();
		expect(taskProjectAssignmentPreflight.rememberTaskProjectAssignmentAnalysisAccepted).not.toHaveBeenCalled();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("旧草稿身份变化时保留新正文，不向原卡发字段或迁移请求", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		vi.mocked(creationQueries.recoverLegacyTaskEditorCreationDraft).mockRejectedValue(
			new Error("任务身份已变化，保留原草稿等待核验"),
		);
		const props = makeProps({ prompt: "后来的新正文", onCreate: vi.fn(() => "new05") });
		await render(props);
		await act(async () => resolveDraftRead(restoredCreationDraft("project-1")));
		await act(async () => findButtonByText("创建任务")?.click());
		expect(getPromptTextarea().value).toBe("后来的新正文");
		expect(taskCardActionQueries.updateTaskCardFieldValuesInWorkspace).not.toHaveBeenCalled();
		expect(applyChanges).not.toHaveBeenCalled();
		expect(props.onCreate).not.toHaveBeenCalled();
	});

	it("跨项目保存成功后即关闭，后续关系与启动由冻结提交承接", async () => {
		saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: true });
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		vi.mocked(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).mockResolvedValue({
			workspaceId: "target-project",
			baseRef: "main",
		});
		const props = makeProps({
			prompt: "创建需求",
			workspaceId: "source-project",
			onCreate: vi.fn(() => "new06"),
			onCreateAndStart: vi.fn(() => null),
		});
		await render(props);
		await act(async () =>
			resolveDraftRead({
				...restoredCreationDraft("source-project"),
				createdTaskId: null,
				creationPrompt: "",
				creationTitle: "",
			}),
		);
		await act(async () => findButtonByText("创建并启动")?.click());
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(creationQueries.submitTaskEditorCreation).toHaveBeenCalledWith(
			"target-project",
			expect.objectContaining({
				newTaskCard: expect.objectContaining({ id: "new06", prompt: "创建需求" }),
				startAgentAfterCreation: true,
				referenceRelationDrafts: restoredCreationDraft("source-project").referenceRelationDrafts,
			}),
		);
		expect(applyChanges).not.toHaveBeenCalled();
		expect(taskCardActionQueries.updateTaskCardFieldValuesInWorkspace).not.toHaveBeenCalled();
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
		await act(async () => deferred.resolveDraftRead({ ...restoredCreationDraft("project-1"), createdTaskId: null }));
		expect(getPromptTextarea().value).toBe("恢复 project-1 的创建需求");
		expect(findButtonByText("放弃更改")).toBeDefined();
		await act(async () => findButtonByText("放弃更改")?.click());
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
			onCreate: vi.fn(() => "new03"),
			onCreateAndStart: vi.fn(() => "new-started-task"),
			onCreateStartAndOpen: vi.fn(() => "new-opened-task"),
		});
		await render(props);
		expect(findButtonByText("创建任务")?.disabled).toBe(true);
		expect(findButtonByText("创建并启动")?.disabled).toBe(true);
		expect(document.querySelector<HTMLButtonElement>('[aria-label="More start options"]')?.disabled).toBe(true);
		await act(async () => {
			findButtonByText("创建任务")?.click();
			findButtonByText("创建并启动")?.click();
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

	it("慢保存和重复点击只提交一次，确认落盘后即关闭而不等待后续步骤", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let confirm!: (status: TaskEditorCreationSubmissionStatus) => void;
		let acceptedRequest!: TaskEditorCreationSubmissionRequest;
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (_workspaceId, request) => {
			acceptedRequest = request;
			return new Promise((resolve) => {
				confirm = resolve;
			});
		});
		const props = makeProps({
			prompt: "慢保存的任务",
			onCreate: vi.fn(() => "slow1"),
			onCreateAndStart: vi.fn(() => null),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => {
			findButtonByText("创建并启动")?.click();
			findButtonByText("创建并启动")?.click();
		});
		expect(props.onCreate).toHaveBeenCalledTimes(1);
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(getPromptTextarea().value).toBe("慢保存的任务");
		await act(async () => confirm(creationStatus(acceptedRequest)));
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(acceptedRequest.startAgentAfterCreation).toBe(true);
	});

	it("迟到的保存回调不能关闭或清空下一张草稿", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let confirm!: (status: TaskEditorCreationSubmissionStatus) => void;
		let request!: TaskEditorCreationSubmissionRequest;
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (_workspaceId, input) => {
			request = input;
			return new Promise((resolve) => {
				confirm = resolve;
			});
		});
		const props = makeProps({ prompt: "任务 A", onCreate: vi.fn(() => "late1") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		await render({ ...props, open: false });
		await render({ ...props, prompt: "任务 B 的草稿" });
		await act(async () => confirm(creationStatus(request)));
		expect(getPromptTextarea().value).toBe("任务 B 的草稿");
		expect(props.onOpenChange).not.toHaveBeenCalled();
	});

	it("批量受理期间宿主回调变化不会重铺剩余列表或阻止关闭", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		let finishSecond!: (status: TaskEditorCreationSubmissionStatus) => void;
		let secondRequest!: TaskEditorCreationSubmissionRequest;
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (workspaceId, request) => {
			if (request.newTaskCard.id === "bat02") {
				secondRequest = request;
				return new Promise((resolve) => {
					finishSecond = resolve;
				});
			}
			return creationStatus(request, workspaceId);
		});
		let count = 0;
		const props = makeProps({ prompt: "- 批量 A\n- 批量 B", onCreate: vi.fn(() => `bat0${++count}`) });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("Split into 2 tasks")?.click());
		await act(async () => findButtonByText("Create 2 tasks")?.click());
		await render({ ...props, onTaskCreationCardPersisted: vi.fn() });
		await act(async () => finishSecond(creationStatus(secondRequest)));
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("创建、启动并打开在卡片保存后立即进入详情，不等待启动成功", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const openDetail = vi.fn();
		const props = makeProps({
			prompt: "保存后立即打开",
			onCreate: vi.fn(() => "open1"),
			onCreateStartAndOpen: vi.fn(() => null),
			onOpenCreatedTaskWithRelations: openDetail,
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true });
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(openDetail).toHaveBeenCalledWith("project-1", "open1");
	});

	it("保存已确认但身份冲突时关闭原表单，不自动打开同 ID 的新一世任务", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(async (workspaceId, request) => ({
			...creationStatus(request, workspaceId),
			phase: "identity_conflict",
			lastError: "同 ID 任务身份已变化，未执行旧提交。",
		}));
		const props = makeProps({
			prompt: "已保存的原任务",
			onCreate: vi.fn(() => "open1"),
			onCreateStartAndOpen: vi.fn(() => null),
			onOpenCreatedTaskWithRelations: vi.fn(),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true });
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(props.onOpenCreatedTaskWithRelations).not.toHaveBeenCalled();
		expect(
			creationBrowserRecovery.readPendingTaskEditorCreationSubmission(
				creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1"),
			),
		).toBeNull();
	});

	it.each([false, true])("迟到确认身份冲突时保护新稿且不自动打开任务，已有新稿=%s", async (hasLaterDraft) => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("确认超时"),
		);
		const props = makeProps({
			prompt: "迟到确认的原任务",
			onCreate: vi.fn(() => "open1"),
			onCreateStartAndOpen: vi.fn(() => null),
			onOpenCreatedTaskWithRelations: vi.fn(),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", altKey: true, shiftKey: true });
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		const pending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key);
		if (!pending) throw new Error("缺少冻结请求镜像");
		if (hasLaterDraft) await typeIntoPrompt("后来填写的新任务");
		vi.mocked(creationQueries.readTaskEditorCreationSubmissionStatus).mockResolvedValue({
			...creationStatus(pending.request, pending.workspaceId),
			phase: "identity_conflict",
			lastError: "同 ID 任务身份已变化，未执行旧提交。",
		});
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(props.onOpenCreatedTaskWithRelations).not.toHaveBeenCalled();
		if (hasLaterDraft) {
			expect(props.onOpenChange).not.toHaveBeenCalled();
			expect(getPromptTextarea().value).toBe("后来填写的新任务");
		} else expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key)).toBeNull();
	});

	it("连续创建清空正文、名称、简介和附件，保留设置", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const props = makeProps({
			prompt: "连续创建 A",
			creatingTaskName: "A 的名称",
			onCreatingTaskNameChange: vi.fn(),
			taskDescription: "A 的独立简介",
			onTaskDescriptionChange: vi.fn(),
			backlogTaskStartReadinessConditionsText: "依赖完成后开启 A",
			onBacklogTaskStartReadinessConditionsTextChange: vi.fn(),
			images: [{ id: "image1", name: "附件.png", data: "aW1hZ2U=", mimeType: "image/png" }],
			startInPlanMode: true,
			onCreate: vi.fn(() => "more1"),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		const label = Array.from(document.querySelectorAll("label")).find((entry) =>
			entry.textContent?.includes("连续创建"),
		);
		await act(async () => document.getElementById(label?.getAttribute("for") ?? "")?.click());
		await act(async () => findButtonByText("创建任务")?.click());
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(props.onCreatingTaskNameChange).toHaveBeenCalledWith("");
		expect(props.onTaskDescriptionChange).toHaveBeenCalledWith("");
		expect(props.onBacklogTaskStartReadinessConditionsTextChange).toHaveBeenCalledWith("");
		expect(props.onImagesChange).toHaveBeenCalledWith([]);
		expect(props.onStartInPlanModeChange).not.toHaveBeenCalled();
		expect(props.onWorktreeModeChange).not.toHaveBeenCalled();
	});

	it("恢复未完成的批量创建时同时恢复本批开启条件", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const props = makeProps({ onBacklogTaskStartReadinessConditionsTextChange: vi.fn() });
		await render(props);
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		localStorage.setItem(
			`${key}:remaining-batch-prompts`,
			JSON.stringify({
				prompts: ["剩余创建项"],
				backlogTaskStartReadinessConditionsText: "共同依赖完成后开启",
			}),
		);
		await act(async () => resolveDraftRead(null));
		expect(props.onBacklogTaskStartReadinessConditionsTextChange).toHaveBeenCalledWith("共同依赖完成后开启");
		expect(document.querySelector('input[value="剩余创建项"]')).not.toBeNull();
	});

	it("旧建卡草稿先迁入详情，后来的正文仍创建独立任务", async () => {
		const { resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		const props = makeProps({ prompt: "新输入的需求", onCreate: vi.fn(() => "new04") });
		await render(props);
		await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", metaKey: true });
		expect(props.onCreate).not.toHaveBeenCalled();
		const recoveredDraft = restoredCreationDraft("project-1");
		await act(async () => resolveDraftRead(recoveredDraft));
		expect(getPromptTextarea().value).toBe("新输入的需求");
		await act(async () => findButtonByText("创建任务")?.click());
		expect(creationQueries.recoverLegacyTaskEditorCreationDraft).toHaveBeenCalledWith("project-1", recoveredDraft);
		expect(props.onCreate).toHaveBeenCalledTimes(1);
		expect(applyChanges).not.toHaveBeenCalled();
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("切换项目后等待当前草稿水合，不把旧卡或关系带入新创建", async () => {
		const { readDraft, resolveDraftRead, applyChanges } = prepareDeferredRelationDraftRead();
		readDraft.mockResolvedValueOnce(restoredCreationDraft("project-1"));
		const props = makeProps({ prompt: "创建需求", onCreate: vi.fn(() => "new04") });
		await render(props);
		await render({ ...props, workspaceId: "project-2" });
		expect(findButtonByText("创建任务")?.disabled).toBe(true);
		await act(async () => resolveDraftRead(restoredCreationDraft("project-2")));
		await act(async () => findButtonByText("创建任务")?.click());
		expect(props.onCreate).toHaveBeenCalledTimes(1);
		expect(creationQueries.submitTaskEditorCreation).toHaveBeenCalledWith(
			"project-2",
			expect.objectContaining({ referenceRelationDrafts: [] }),
		);
		expect(applyChanges).not.toHaveBeenCalled();
	});

	it("输入法组字的提交组合键不穿透到 document 上的 Diff 快捷键", async () => {
		await render(makeProps());
		const documentShortcut = vi.fn();
		document.addEventListener("keydown", documentShortcut);
		try {
			for (const modifiers of [
				{ metaKey: true },
				{ ctrlKey: true, shiftKey: true },
				{ altKey: true, shiftKey: true },
			]) {
				await dispatchDocumentKeyDown({ key: "Enter", code: "Enter", isComposing: true, ...modifiers });
			}
			expect(documentShortcut).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", documentShortcut);
		}
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
	it("自动采纳另一项目与分支的迟到确认关闭未改动的草稿", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: true });
		vi.mocked(taskProjectAssignmentPreflight.runTaskProjectAssignmentPreflight).mockResolvedValue({
			workspaceId: "target-project",
			baseRef: "main",
		});
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("确认超时"),
		);
		const props = makeProps({ prompt: "自动采纳后的原正文", onCreate: vi.fn(() => "auto1") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		const pending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(
			creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1"),
		);
		if (!pending) throw new Error("缺少冻结请求镜像");
		vi.mocked(creationQueries.readTaskEditorCreationSubmissionStatus).mockResolvedValue(
			creationStatus(pending.request, pending.workspaceId),
		);
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		expect(props.onCreate).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).not.toContain("后来填写");
	});

	it("刷新后回填未受理的冻结正文、名称和附件并自动补送原请求", async () => {
		const { resolveDraftRead, readDraft } = prepareDeferredRelationDraftRead();
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("发送前断网"),
		);
		const attachment = { id: "saved-image", name: "原附件.png", data: "aW1hZ2U=", mimeType: "image/png" };
		const props = makeProps({
			prompt: "刷新前的冻结正文",
			creatingTaskName: "冻结名称",
			images: [attachment],
			onCreate: vi.fn(() => "fresh"),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		const pending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key);
		if (!pending) throw new Error("缺少待确认镜像");
		await act(async () => root.unmount());
		root = createRoot(container);
		readDraft.mockResolvedValue(null);
		let confirm!: (status: TaskEditorCreationSubmissionStatus) => void;
		vi.mocked(creationQueries.submitTaskEditorCreation).mockImplementation(
			async () =>
				new Promise((resolve) => {
					confirm = resolve;
				}),
		);
		const reloadedProps = makeProps({ onImagesChange: vi.fn(), onCreatingTaskNameChange: vi.fn() });
		await act(async () =>
			root.render(
				<TooltipProvider>
					<ControlledCreationRecoveryEditor input={reloadedProps} />
				</TooltipProvider>,
			),
		);
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(getPromptTextarea().value).toBe("刷新前的冻结正文");
		expect(reloadedProps.onCreatingTaskNameChange).toHaveBeenCalledWith("冻结名称");
		expect(reloadedProps.onImagesChange).toHaveBeenCalledWith([attachment]);
		expect(creationQueries.submitTaskEditorCreation).toHaveBeenCalledExactlyOnceWith(
			pending.workspaceId,
			pending.request,
		);
		await act(async () => confirm(creationStatus(pending.request)));
		expect(creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key)).toBeNull();
		expect(reloadedProps.onOpenChange).toHaveBeenCalledWith(false);
	});

	it("补送一轮失败后普通轮询不反复重投，online 才开启下一轮", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const confirm = vi
			.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence")
			.mockRejectedValue(new Error("仍未送达"));
		const props = makeProps({ prompt: "等待连接恢复", onCreate: vi.fn(() => "bound") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		expect(confirm).toHaveBeenCalledTimes(1);
		vi.useFakeTimers();
		try {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(15000);
			});
			expect(confirm).toHaveBeenCalledTimes(1);
			await act(async () => window.dispatchEvent(new Event("online")));
			expect(confirm).toHaveBeenCalledTimes(2);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(15000);
			});
			expect(confirm).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["新增关系", "撤销关系", "无效详情"] as const)("迟到保存确认保留提交后的%s草稿", async (kind) => {
		const actualHook = relationModelingHooks.useReferenceRelationModelingEditor;
		let controller!: ReturnType<typeof actualHook>;
		vi.spyOn(relationModelingHooks, "useReferenceRelationModelingEditor").mockImplementation((input) => {
			controller = actualHook(input);
			return controller;
		});
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("确认超时"),
		);
		const props = makeProps({ prompt: "已经发送的正文", onCreate: vi.fn(() => "rels1") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		const pending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key);
		if (!pending) throw new Error("缺少待确认镜像");
		const relation = restoredCreationDraft("project-1").referenceRelationDrafts[0];
		if (!relation) throw new Error("缺少隔离关系草稿");
		await act(async () => {
			if (kind === "新增关系") controller.addDraft(relation);
			else if (kind === "撤销关系")
				controller.updateDraft({
					relationRevocations: [
						{
							relationId: "later-revocation",
							expectedAssertedRelationStateVersion: 1,
							relationAssertionRevocationReason: "relation_was_incorrect",
						},
					],
				});
			else
				controller.updateDraft({
					invalidReferenceRelationDetailsFormsByDraftId: {
						"later-details": {
							...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
							currentTaskIsStatementSubject: true,
							relationAssertionEvidencePointersOnePerLineText: "后来填写但尚无效的详情",
						},
					},
				});
		});
		const laterRelationDraft = controller.readLatestDraft();
		vi.mocked(creationQueries.readTaskEditorCreationSubmissionStatus).mockResolvedValue(
			creationStatus(pending.request),
		);
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(controller.readLatestDraft()).toEqual(laterRelationDraft);
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(getPromptTextarea().value).toBe("已经发送的正文");
	});

	it("明确放弃批量剩余项后重新打开不会恢复旧列表", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		const props = makeProps({
			prompt: "- 第一张已保存\n- 第二张待创建",
			onCreate: vi.fn().mockReturnValueOnce("bat01").mockReturnValue(null),
		});
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("Split into 2 tasks")?.click());
		await act(async () => findButtonByText("Create 2 tasks")?.click());
		await act(async () => findCloseButton()?.click());
		await act(async () => findButtonByText("放弃更改")?.click());
		await render({ ...props, open: false, prompt: "" });
		await render({ ...props, prompt: "" });
		expect(
			localStorage.getItem(
				`${creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1")}:remaining-batch-prompts`,
			),
		).toBeNull();
		expect(document.querySelector<HTMLInputElement>('input[value="第二张待创建"]')).toBeNull();
	});
	it("放弃批量草稿仍保留已发送身份，迟到确认不能恢复列表或关闭新草稿", async () => {
		const { resolveDraftRead } = prepareDeferredRelationDraftRead();
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("保存确认超时"),
		);
		const props = makeProps({ prompt: "- 第一张尚未确认\n- 第二张尚未发送", onCreate: vi.fn(() => "sent1") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("Split into 2 tasks")?.click());
		await act(async () => findButtonByText("Create 2 tasks")?.click());
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		const originalPending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key);
		if (!originalPending) throw new Error("缺少已发送的原请求");
		await act(async () => findCloseButton()?.click());
		await act(async () => findButtonByText("放弃更改")?.click());
		expect(localStorage.getItem(`${key}:remaining-batch-prompts`)).toBeNull();
		expect(creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key)).toMatchObject({
			request: originalPending.request,
			editorDraftWasExplicitlyDiscarded: true,
			batchPromptsAfterCurrentCard: null,
		});
		await render({ ...props, open: false, prompt: "" });
		vi.mocked(props.onOpenChange).mockClear();
		vi.mocked(creationQueries.readTaskEditorCreationSubmissionStatus).mockResolvedValue(
			creationStatus(originalPending.request),
		);
		await render({ ...props, prompt: "明确放弃后新填的正文" });
		expect(creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key)).toBeNull();
		expect(getPromptTextarea().value).toBe("明确放弃后新填的正文");
		expect(props.onOpenChange).not.toHaveBeenCalled();
		expect(props.onCreate).toHaveBeenCalledTimes(1);
	});

	it("刷新后的原请求补证不覆盖已有的新正文和名称", async () => {
		const { resolveDraftRead, readDraft } = prepareDeferredRelationDraftRead();
		vi.spyOn(creationBrowserRecovery, "confirmTaskEditorCreationCardPersistence").mockRejectedValueOnce(
			new Error("确认超时"),
		);
		const props = makeProps({ prompt: "冻结的原正文", onCreate: vi.fn(() => "later") });
		await render(props);
		await act(async () => resolveDraftRead(null));
		await act(async () => findButtonByText("创建任务")?.click());
		const key = creationBrowserRecovery.taskEditorPendingCreationStorageKey("project-1");
		const pending = creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key);
		if (!pending) throw new Error("缺少待确认镜像");
		await act(async () => root.unmount());
		root = createRoot(container);
		readDraft.mockResolvedValue(null);
		vi.mocked(creationQueries.readTaskEditorCreationSubmissionStatus).mockResolvedValue(
			creationStatus(pending.request),
		);
		const reloadedProps = makeProps({ prompt: "后来填写的新正文", creatingTaskName: "后来填写的新名称" });
		await render(reloadedProps);
		expect(getPromptTextarea().value).toBe("后来填写的新正文");
		expect(reloadedProps.onOpenChange).not.toHaveBeenCalled();
		expect(reloadedProps.onImagesChange).not.toHaveBeenCalled();
		expect(creationBrowserRecovery.readPendingTaskEditorCreationSubmission(key)).toBeNull();
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
		const textarea = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务正文"]');
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
