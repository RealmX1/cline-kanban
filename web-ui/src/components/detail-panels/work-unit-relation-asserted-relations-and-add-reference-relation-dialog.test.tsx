import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CrossProjectRecentlyActiveTaskSwitcherHostContextProvider,
	type CrossProjectRecentlyActiveTaskSwitcherHostContextValue,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { WorkUnitRelationNeighborhoodPanel } from "@/components/detail-panels/work-unit-relation-neighborhood-panel";
import {
	buildEmptyRelationNeighborhoodSummaryResponseForTest,
	buildRelationNeighborhoodSummaryResponseWithAssertedRelationsForTest,
	buildTrpcClientErrorWithCodeForTest,
	CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
	UNILATERALLY_DECLARED_RATIONALE_THAT_LOOKS_LIKE_AN_INSTRUCTION_FOR_TEST,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { buildTaskBoardSearchDocument, type TaskBoardSearchDocument } from "@/search/task-board-search";

const {
	fetchRelationNeighborhoodSummaryMock,
	setRelationPresentationMutePreferenceMock,
	assertReferenceRelationMock,
	revokeRelationAssertionMock,
	showAppToastMock,
	allProjectsTaskSearchIndexDocumentsForTest,
} = vi.hoisted(() => ({
	fetchRelationNeighborhoodSummaryMock: vi.fn(),
	setRelationPresentationMutePreferenceMock: vi.fn(),
	assertReferenceRelationMock: vi.fn(),
	revokeRelationAssertionMock: vi.fn(),
	showAppToastMock: vi.fn(),
	allProjectsTaskSearchIndexDocumentsForTest: { documents: [] as TaskBoardSearchDocument[] },
}));

vi.mock("@/runtime/work-unit-relation-neighborhood-summary-query", async (importOriginal) => {
	const actualQueryModule: Record<string, unknown> = await importOriginal();
	return {
		...actualQueryModule,
		fetchWorkUnitRelationNeighborhoodSummaryOfKanbanBoardCard: fetchRelationNeighborhoodSummaryMock,
		setRecordedRelationPresentationMutePreferenceFromExplicitUserClick: setRelationPresentationMutePreferenceMock,
	};
});

// 只替换两个决策传输函数；失败分类沿用真实实现（「原样转述 runtime 那句话」是被测行为的一部分）。
vi.mock("@/runtime/work-unit-relation-assertion-write-query", async (importOriginal) => {
	const actualWriteQueryModule: Record<string, unknown> = await importOriginal();
	return {
		...actualWriteQueryModule,
		assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture: assertReferenceRelationMock,
		revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture: revokeRelationAssertionMock,
	};
});

// 选择器的跨项目任务索引：直接给一份文档（端点本身由 Spotlight 的测试覆盖）。
vi.mock("@/search/use-all-projects-task-search-index", () => ({
	useAllProjectsTaskSearchIndex: () => ({
		documents: allProjectsTaskSearchIndexDocumentsForTest.documents,
		status: "ready",
		refetch: vi.fn(),
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
	notifyError: vi.fn(),
}));

function buildTaskSearchDocumentForTest(input: {
	projectId: string;
	projectName: string;
	taskId: string;
	title: string;
}): TaskBoardSearchDocument {
	return buildTaskBoardSearchDocument({
		...input,
		columnId: "in_progress",
		prompt: `${input.title} prompt`,
		taskCreatedAtEpochMs: 1_000,
		taskLastModifiedAtEpochMs: 2_000,
		taskAgentOverrideAgentId: null,
		mostRecentlyLaunchedAgentSessionAgentId: null,
	});
}

function buildKanbanProjectSummaryForTest(workspaceId: string, projectName: string): RuntimeProjectSummary {
	return {
		id: workspaceId,
		path: `/repos/${projectName}`,
		name: projectName,
		availability: { status: "available" },
	} as RuntimeProjectSummary;
}

function setFormControlValueAsUser(
	formControl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	value: string,
): void {
	// 直接赋 .value 会被 React 的 value tracker 吞掉；走原型上的 setter 再派发事件。
	const prototypeWithValueSetter =
		formControl instanceof HTMLSelectElement
			? HTMLSelectElement.prototype
			: formControl instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototypeWithValueSetter, "value")?.set?.call(formControl, value);
	formControl.dispatchEvent(
		new Event(formControl instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
	);
}

// dd2db 2.1：断言型关系区块（分组、引用式理由、两种撤销）与「添加关系」对话框（选择器、校验、提交、失败原样转述）。
describe("Relations panel · asserted relations and Add relation dialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	async function flushPendingPromiseCallbacks(): Promise<void> {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	async function renderExpandedPanel(): Promise<void> {
		const crossProjectTaskOpenHost: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
			projects: [
				buildKanbanProjectSummaryForTest(CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST, "current-project"),
				buildKanbanProjectSummaryForTest(OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST, "other-project"),
			],
			notificationLogByWorkspaceId: {},
			currentProjectId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			isBoardScopeAllProjectsSelected: false,
			focusedTaskInProject: null,
			onOpenTaskInProject: vi.fn(),
			onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
			onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
			onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
		};
		await act(async () => {
			root.render(
				<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={crossProjectTaskOpenHost}>
					<WorkUnitRelationNeighborhoodPanel
						workspaceId={CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}
						kanbanBoardCardTaskId={SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST}
					/>
				</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>,
			);
		});
		await flushPendingPromiseCallbacks();
		const headerToggleButton = container.querySelector<HTMLButtonElement>('section[aria-label="Relations"] button');
		expect(headerToggleButton).not.toBeNull();
		await clickElement(headerToggleButton!);
	}

	async function clickElement(element: Element): Promise<void> {
		await act(async () => {
			element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await flushPendingPromiseCallbacks();
	}

	async function changeFormControlValue(
		formControl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
		value: string,
	): Promise<void> {
		await act(async () => {
			setFormControlValueAsUser(formControl, value);
		});
	}

	function findAssertedRelationRow(relationId: string): HTMLElement {
		const assertedRelationRow = container.querySelector<HTMLElement>(`[data-asserted-relation-id="${relationId}"]`);
		expect(assertedRelationRow).not.toBeNull();
		return assertedRelationRow!;
	}

	function findButtonByText(scope: ParentNode, buttonText: string): HTMLButtonElement {
		const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
			(candidate) => candidate.textContent?.trim() === buttonText,
		);
		expect(button, `button "${buttonText}"`).toBeDefined();
		return button!;
	}

	function findOpenAddRelationDialog(): HTMLElement {
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		return dialog!;
	}

	function findLabeledFormControl<FormControlElement extends HTMLElement>(
		dialog: HTMLElement,
		labelText: string,
	): FormControlElement {
		const label = [...dialog.querySelectorAll("label")].find((candidate) =>
			candidate.textContent?.startsWith(labelText),
		);
		expect(label, `label "${labelText}"`).toBeDefined();
		const formControl = dialog.querySelector<FormControlElement>(`[id="${label!.htmlFor}"]`);
		expect(formControl).not.toBeNull();
		return formControl!;
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		fetchRelationNeighborhoodSummaryMock.mockReset();
		setRelationPresentationMutePreferenceMock.mockReset();
		assertReferenceRelationMock.mockReset();
		revokeRelationAssertionMock.mockReset();
		showAppToastMock.mockReset();
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildRelationNeighborhoodSummaryResponseWithAssertedRelationsForTest(),
		);
		revokeRelationAssertionMock.mockResolvedValue({
			relationAssertionWriteOutcome: "effective_relation_assertion_revoked",
		});
		allProjectsTaskSearchIndexDocumentsForTest.documents = [
			buildTaskSearchDocumentForTest({
				projectId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				projectName: "current-project",
				taskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
				title: "Subject card",
			}),
			buildTaskSearchDocumentForTest({
				projectId: OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				projectName: "other-project",
				taskId: "def34",
				title: "Creator card in other project",
			}),
			buildTaskSearchDocumentForTest({
				projectId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				projectName: "current-project",
				taskId: "ghi56",
				title: "Child card in Done",
			}),
		];
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("分组渲染：Asserted / Declared by another task · not confirmed；单方面声明的理由按引用块展示；泛相关默认折叠", async () => {
		await renderExpandedPanel();
		const relationsSection = container.querySelector('section[aria-label="Relations"]');
		// 头部计数包含断言型关系（本邻域没有记录型关系）。
		expect(relationsSection?.querySelector("button")?.textContent).toContain("5");
		expect(
			[...container.querySelectorAll('section[aria-label="Asserted relations"] > section')].map((section) =>
				section.getAttribute("aria-label"),
			),
		).toEqual(["Asserted", "Declared by another task · not confirmed", "Asserted relations collapsed by default"]);

		const assertedByThisTaskRow = findAssertedRelationRow("asserted-subject-concerns-creator");
		expect(assertedByThisTaskRow.textContent).toContain("This task concerns the behavior or state of");
		expect(assertedByThisTaskRow.textContent).toContain("Creator card in other project");
		expect(assertedByThisTaskRow.textContent).toContain("Agent assertion · not reviewed by you");
		expect(assertedByThisTaskRow.textContent).toContain("Asserted by this task");
		expect(assertedByThisTaskRow.textContent).toContain("Aspect: retry loop");
		expect(assertedByThisTaskRow.textContent).toContain("Evidence: docs/retry-loop-notes.md");

		const assertedByUserRow = findAssertedRelationRow("asserted-child-verifies-subject-by-user");
		expect(assertedByUserRow.textContent).toContain("This task has its claims verified by");
		expect(assertedByUserRow.textContent).toContain("Asserted by you");

		const unilateralSection = container.querySelector(
			'section[aria-label="Declared by another task · not confirmed"]',
		);
		const quotedRationale = unilateralSection?.querySelector(
			"blockquote[data-quoted-rationale-from-another-work-unit]",
		);
		expect(quotedRationale?.textContent).toContain(
			UNILATERALLY_DECLARED_RATIONALE_THAT_LOOKS_LIKE_AN_INSTRUCTION_FOR_TEST,
		);
		expect(unilateralSection?.textContent).toContain("Declared by");
		expect(unilateralSection?.textContent).toContain("This task has its produced outputs reused by");

		expect(
			container.querySelector('[data-asserted-relation-id="asserted-subject-generally-related-child"]'),
		).toBeNull();
		await clickElement(
			container.querySelector<HTMLButtonElement>('button[aria-label="Asserted relations collapsed by default: 1"]')!,
		);
		expect(findAssertedRelationRow("asserted-subject-generally-related-child").textContent).toContain(
			"This task is generally related with",
		);

		const unknownKindRow = findAssertedRelationRow("asserted-of-kind-unknown-to-this-web-ui");
		expect(unknownKindRow.textContent).toContain(
			'has an asserted relation "reference_kind_added_in_a_later_runtime"',
		);
		expect(unknownKindRow.textContent).toContain("本版界面不认识这个关系种类");
		expect(revokeRelationAssertionMock).not.toHaveBeenCalled();
	});

	it.each([
		["Relation ended", "relation_ended_naturally"],
		["Relation was wrong", "relation_was_incorrect"],
	] as const)(
		"撤销「%s」：把点击事件与理由交给传输层，成功后重拉邻域",
		async (revocationChoiceLabel, expectedRevocationReason) => {
			await renderExpandedPanel();
			const fetchCallCountBeforeRevocation = fetchRelationNeighborhoodSummaryMock.mock.calls.length;
			const assertedRelationRow = findAssertedRelationRow("asserted-creator-reuses-subject-unilateral");
			// 只点开「Revoke」不发任何请求。
			await clickElement(assertedRelationRow.querySelector('button[aria-label="Revoke this relation"]')!);
			expect(revokeRelationAssertionMock).not.toHaveBeenCalled();
			const revocationChoiceGroup = assertedRelationRow.querySelector('[role="group"]');
			expect(revocationChoiceGroup?.textContent).toContain(
				"agents won't assert it again unless they bring new evidence",
			);

			await clickElement(findButtonByText(revocationChoiceGroup!, revocationChoiceLabel));
			expect(revokeRelationAssertionMock).toHaveBeenCalledTimes(1);
			const [triggeringUserGestureEvent, revocationInput] = revokeRelationAssertionMock.mock.calls[0]!;
			expect(triggeringUserGestureEvent.nativeEvent).toBeInstanceOf(MouseEvent);
			expect(revocationInput).toEqual({
				workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				relationId: "asserted-creator-reuses-subject-unilateral",
				relationAssertionRevocationReason: expectedRevocationReason,
			});
			expect(fetchRelationNeighborhoodSummaryMock.mock.calls.length).toBe(fetchCallCountBeforeRevocation + 1);
			expect(showAppToastMock).not.toHaveBeenCalled();
		},
	);

	it("撤销失败：toast 原样转述 runtime 那句话", async () => {
		revokeRelationAssertionMock.mockRejectedValue(
			buildTrpcClientErrorWithCodeForTest(
				"FORBIDDEN",
				"web_ui_user_decision_requires_trusted_user_dom_event: This decision was triggered by a synthetic (untrusted) DOM event.",
			),
		);
		await renderExpandedPanel();
		const assertedRelationRow = findAssertedRelationRow("asserted-subject-concerns-creator");
		await clickElement(assertedRelationRow.querySelector('button[aria-label="Revoke this relation"]')!);
		await clickElement(findButtonByText(assertedRelationRow, "Relation ended"));
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "danger",
				message:
					"撤销没有保存：runtime 没有把这次操作认作你的决定（This decision was triggered by a synthetic (untrusted) DOM event.）",
			}),
		);
	});

	it("添加关系：先校验必填；选跨项目对端、选 kind、填专有属性后提交，成功即关闭、重拉、提示", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildEmptyRelationNeighborhoodSummaryResponseForTest(),
		);
		assertReferenceRelationMock.mockResolvedValue({
			relationAssertionWriteOutcome: "asserted_relation_applied_and_effective",
			relationStatementReadFromSubjectPerspective: "task abc12 concerns the behavior or state of task def34",
		});
		await renderExpandedPanel();
		await clickElement(findButtonByText(container, "Add relation"));
		const dialog = findOpenAddRelationDialog();

		// 什么都没填就提交：显示问题、不调用决策传输。
		await clickElement(findButtonByText(dialog, "Add relation"));
		expect(dialog.querySelector('[aria-label="Add relation form problems"]')?.textContent).toContain(
			"Choose the other task.",
		);
		expect(assertReferenceRelationMock).not.toHaveBeenCalled();

		// 选择器：面板主体自己不在候选里；跨项目卡可选。
		expect(
			dialog.querySelector(
				`[data-counterpart-candidate-kanban-board-card="${CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}:${SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST}"]`,
			),
		).toBeNull();
		await changeFormControlValue(findLabeledFormControl<HTMLInputElement>(dialog, "Other task"), "Creator");
		const crossProjectCandidate = dialog.querySelector(
			`[data-counterpart-candidate-kanban-board-card="${OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}:def34"] button`,
		);
		expect(crossProjectCandidate).not.toBeNull();
		await clickElement(crossProjectCandidate!);
		expect(
			dialog.querySelector(
				`[data-selected-counterpart-kanban-board-card="${OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}:def34"]`,
			),
		).not.toBeNull();

		await changeFormControlValue(
			findLabeledFormControl<HTMLSelectElement>(dialog, "Relation"),
			"reference_concerns_behavior_or_state_of",
		);
		expect(dialog.querySelector("[data-relation-statement-preview]")?.textContent).toContain(
			"This task concerns the behavior or state of Creator card in other project",
		);
		await changeFormControlValue(
			findLabeledFormControl<HTMLInputElement>(dialog, "Rationale"),
			"Diagnosing its retry loop.",
		);
		await clickElement(findButtonByText(dialog, "Add relation"));
		// 只差 concerns 的必填 aspect。
		expect(dialog.querySelector('[aria-label="Add relation form problems"]')?.textContent).toBe(
			"Fill in Concerned aspect.",
		);
		expect(assertReferenceRelationMock).not.toHaveBeenCalled();

		await changeFormControlValue(findLabeledFormControl<HTMLInputElement>(dialog, "Concerned aspect"), "retry loop");
		await changeFormControlValue(
			findLabeledFormControl<HTMLSelectElement>(dialog, "Nature of the concern"),
			"diagnoses_failure_of",
		);
		await changeFormControlValue(
			findLabeledFormControl<HTMLTextAreaElement>(dialog, "Evidence pointers"),
			"docs/retry-notes.md\n",
		);
		expect(dialog.querySelector('[aria-label="Add relation form problems"]')).toBeNull();
		const fetchCallCountBeforeSubmit = fetchRelationNeighborhoodSummaryMock.mock.calls.length;
		await clickElement(findButtonByText(dialog, "Add relation"));

		expect(assertReferenceRelationMock).toHaveBeenCalledTimes(1);
		const [triggeringUserGestureEvent, assertionInput] = assertReferenceRelationMock.mock.calls[0]!;
		expect(triggeringUserGestureEvent.nativeEvent).toBeInstanceOf(MouseEvent);
		expect(assertionInput).toEqual({
			workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
			referenceRelationAssertion: {
				subjectWorkUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
					workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				},
				relationKind: "reference_concerns_behavior_or_state_of",
				counterpartWorkUnit: {
					workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
					bareTaskId: "def34",
					workspaceId: OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
				},
				relationAssertionRationaleOneSentence: "Diagnosing its retry loop.",
				relationAssertionEvidencePointers: ["docs/retry-notes.md"],
				assertedRelationKindSpecificAttributes: {
					concernedAspectSummary: "retry loop",
					concernNature: "diagnoses_failure_of",
				},
			},
		});
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		expect(fetchRelationNeighborhoodSummaryMock.mock.calls.length).toBe(fetchCallCountBeforeSubmit + 1);
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({
				intent: "success",
				message: "已添加关系：task abc12 concerns the behavior or state of task def34",
			}),
		);
	});

	it("添加关系被 runtime 拒绝（同项目跨仓配对）：对话框不关，原样显示 runtime 那句话", async () => {
		fetchRelationNeighborhoodSummaryMock.mockImplementation(async () =>
			buildEmptyRelationNeighborhoodSummaryResponseForTest(),
		);
		assertReferenceRelationMock.mockRejectedValue(
			buildTrpcClientErrorWithCodeForTest(
				"BAD_REQUEST",
				"asserted_relation_endpoints_invalid: A cross-repository counterpart must live in a different Kanban project; use a generally-related relation instead.",
			),
		);
		await renderExpandedPanel();
		await clickElement(findButtonByText(container, "Add relation"));
		const dialog = findOpenAddRelationDialog();
		await clickElement(
			dialog.querySelector(
				`[data-counterpart-candidate-kanban-board-card="${CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST}:ghi56"] button`,
			)!,
		);
		await changeFormControlValue(
			findLabeledFormControl<HTMLSelectElement>(dialog, "Relation"),
			"reference_is_cross_repository_counterpart_with",
		);
		// 同项目只提示、不拦（runtime 是权威）。
		expect(dialog.textContent).toContain("Both tasks are in the same project");
		await changeFormControlValue(
			findLabeledFormControl<HTMLInputElement>(dialog, "Shared contract pointer"),
			"api/schema.json",
		);
		await changeFormControlValue(
			findLabeledFormControl<HTMLInputElement>(dialog, "Rationale"),
			"They share the API schema.",
		);
		await clickElement(findButtonByText(dialog, "Add relation"));

		expect(assertReferenceRelationMock).toHaveBeenCalledTimes(1);
		expect(findOpenAddRelationDialog().querySelector('[aria-label="Add relation failure"]')?.textContent).toBe(
			"关系没有保存：A cross-repository counterpart must live in a different Kanban project; use a generally-related relation instead.",
		);
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
