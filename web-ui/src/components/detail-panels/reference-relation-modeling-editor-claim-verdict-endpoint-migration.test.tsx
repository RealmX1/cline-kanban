import type { ReferenceClaimVerificationVerdict } from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type {
	ReferenceRelationModelingDraft,
	RelationModelingPreviewResponse,
} from "@runtime-work-unit-relation-modeling-api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReferenceRelationModelingEditorController } from "@/hooks/use-reference-relation-modeling-editor";
import type { SelectedCounterpartKanbanBoardCardForAddReferenceRelation } from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import {
	buildAssertedRelationForTest,
	buildKanbanBoardCardDisplayEntryForTest,
} from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import { ReferenceRelationModelingEditor } from "./reference-relation-modeling-editor";

const queries = vi.hoisted(() => ({ resolveRelationModelingCounterpart: vi.fn() }));
vi.mock("@/runtime/work-unit-relation-modeling-query", () => queries);
vi.mock("@/components/detail-panels/reference-relation-modeling-graph", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ReferenceRelationModelingGraph: () => null,
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
					counterpartKanbanBoardCardWorkspaceId: "project-b",
					counterpartKanbanBoardCardTaskId: "replacement-counterpart",
					counterpartKanbanBoardCardTitle: "另一个关联任务",
					counterpartKanbanProjectDisplayName: "关联项目",
				})
			}
		>
			改选关联任务
		</button>
	),
}));

const rootDisplayEntry = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: "project-a",
	taskId: "root-task",
	currentTitle: "当前任务",
});
const counterpartDisplayEntry = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: "project-b",
	taskId: "counterpart-task",
	currentTitle: "关联任务",
});
const rootWorkUnit = rootDisplayEntry.workUnit;
const counterpartWorkUnit = counterpartDisplayEntry.workUnit;
let root: Root;
let container: HTMLDivElement;
let addDraft: ReferenceRelationModelingEditorController["addDraft"];

async function renderExistingClaimRelation(input: {
	verdict: ReferenceClaimVerificationVerdict;
	currentTaskIsStatementSubject?: boolean;
}) {
	const currentTaskIsStatementSubject = input.currentTaskIsStatementSubject ?? true;
	const savedRelation = buildAssertedRelationForTest({
		relationId: "existing-claim-relation",
		relationKind: "reference_verifies_claims_of",
		relationStatementSubjectWorkUnitRef: currentTaskIsStatementSubject ? rootWorkUnit : counterpartWorkUnit,
		relationStatementAnchorWorkUnitRef: currentTaskIsStatementSubject ? counterpartWorkUnit : rootWorkUnit,
		assertedRelationKindSpecificAttributes: {
			claimsUnderVerification: [{ claimSummary: "缓存已失效", verificationVerdict: input.verdict }],
		},
	});
	const preview: RelationModelingPreviewResponse = {
		rootWorkUnitKey: rootDisplayEntry.workUnitKey,
		workUnits: [rootDisplayEntry, counterpartDisplayEntry],
		relations: [
			{
				relationId: savedRelation.relationId,
				subjectKey: currentTaskIsStatementSubject
					? rootDisplayEntry.workUnitKey
					: counterpartDisplayEntry.workUnitKey,
				anchorKey: currentTaskIsStatementSubject
					? counterpartDisplayEntry.workUnitKey
					: rootDisplayEntry.workUnitKey,
				relationKind: savedRelation.relationKind,
				relationPresentationState: "saved",
				assertedRelation: savedRelation,
			},
		],
		truncated: false,
		projectedThroughGlobalCommittedEventSequence: 1,
	};
	const controller: ReferenceRelationModelingEditorController = {
		draft: {
			referenceRelationDrafts: [],
			relationRevocations: [],
			createdTaskId: null,
			createdTaskCardSnapshot: null,
			modelingSubmissionId: "submission",
			creationPrompt: "",
			creationTitle: "",
		},
		ready: true,
		preview,
		error: null,
		draftPersistenceError: null,
		saving: false,
		depth: 2,
		setDepth: vi.fn(),
		addDraft,
		updateDraft: vi.fn(),
		applyToTask: vi.fn(),
		readLatestDraft: vi.fn(),
		persistDraftNow: vi.fn(),
		refresh: vi.fn(),
		hasChanges: false,
		discard: vi.fn(),
	};
	await act(async () =>
		root.render(
			<ReferenceRelationModelingEditor controller={controller} workspaceId="project-a" taskId="root-task" />,
		),
	);
	await clickButton("修改");
}

async function clickButton(label: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!button) throw new Error(`找不到按钮：${label}`);
	await act(async () => button.click());
}

async function changeFormValue(label: string, value: string) {
	const labelElement = [...container.querySelectorAll("label")].find(
		(candidate) => candidate.firstChild?.textContent?.trim() === label,
	);
	const field = labelElement?.querySelector("input, textarea, select");
	if (
		!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)
	) {
		throw new Error(`找不到表单项：${label}`);
	}
	const prototype =
		field instanceof HTMLSelectElement
			? HTMLSelectElement.prototype
			: field instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
	await act(async () => {
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
		field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	});
}

function expectSavedClaims(claims: { claimSummary: string; verificationVerdict: ReferenceClaimVerificationVerdict }[]) {
	expect(addDraft).toHaveBeenCalledOnce();
	const draft = vi.mocked(addDraft).mock.calls[0]?.[0];
	expect(draft?.assertedRelationKindSpecificAttributes.claimsUnderVerification).toEqual(claims);
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	queries.resolveRelationModelingCounterpart.mockResolvedValue(counterpartWorkUnit);
	addDraft = vi.fn<(value: ReferenceRelationModelingDraft) => void>();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("核验结论与有序端点身份绑定", () => {
	it.each(["confirmed", "refuted"] as const)("更换对端后同名主张不会继承 %s", async (verdict) => {
		await renderExistingClaimRelation({ verdict });
		await clickButton("改选关联任务");
		queries.resolveRelationModelingCounterpart.mockResolvedValue({
			...counterpartWorkUnit,
			taskId: "replacement-counterpart",
		});
		await clickButton("暂存修改");
		expectSavedClaims([{ claimSummary: "缓存已失效", verificationVerdict: "pending" }]);
	});
	it.each([true, false])(
		"原当前任务为主语：%s，反转陈述方向后同名主张回到 pending",
		async (currentTaskIsStatementSubject) => {
			await renderExistingClaimRelation({ verdict: "confirmed", currentTaskIsStatementSubject });
			await changeFormValue("陈述方向", currentTaskIsStatementSubject ? "other" : "current");
			await clickButton("暂存修改");
			expectSavedClaims([{ claimSummary: "缓存已失效", verificationVerdict: "pending" }]);
		},
	);
	it("同一项目与 taskId 的对端 incarnation 已变化时重新核验", async () => {
		await renderExistingClaimRelation({ verdict: "confirmed" });
		queries.resolveRelationModelingCounterpart.mockResolvedValue({
			...counterpartWorkUnit,
			taskIncarnationCreatedAtEpochMs: 2_000,
		});
		await clickButton("暂存修改");
		expectSavedClaims([{ claimSummary: "缓存已失效", verificationVerdict: "pending" }]);
	});
	it.each([true, false])("原当前任务为主语：%s，仅改理由证据仍保留结论", async (currentTaskIsStatementSubject) => {
		await renderExistingClaimRelation({ verdict: "refuted", currentTaskIsStatementSubject });
		await changeFormValue("关系理由", "更新核验依据");
		await changeFormValue("证据位置（可选，每行一个）", "docs/new-evidence.md");
		await clickButton("暂存修改");
		expectSavedClaims([{ claimSummary: "缓存已失效", verificationVerdict: "refuted" }]);
	});
	it("端点与方向保持不变时，保留同名主张结论而新增主张为 pending", async () => {
		await renderExistingClaimRelation({ verdict: "confirmed" });
		await changeFormValue("要核验的主张", "缓存已失效\n新增主张");
		await clickButton("暂存修改");
		expectSavedClaims([
			{ claimSummary: "缓存已失效", verificationVerdict: "confirmed" },
			{ claimSummary: "新增主张", verificationVerdict: "pending" },
		]);
	});
});
