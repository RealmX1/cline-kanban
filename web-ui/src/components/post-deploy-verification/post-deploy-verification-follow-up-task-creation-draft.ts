import {
	type ReferenceRelationModelingDraft,
	referenceRelationModelingDraftSchema,
	referenceRelationModelingEditorDraftSchema,
} from "@runtime-work-unit-relation-modeling-api-contract";
import type { RuntimePostDeployVerificationChecklistItem, RuntimePostDeployVerificationTask } from "@/runtime/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export interface PostDeployVerificationFollowUpTaskCreationDraftSeed {
	initializationId: string;
	workspaceId: string;
	title: string;
	prompt: string;
	referenceRelationDrafts: ReferenceRelationModelingDraft[];
}

function renderChecklistItemGuidanceAndExecutionContext(item: RuntimePostDeployVerificationChecklistItem): string {
	return [
		...(item.guidance
			? [
					"核对步骤：",
					...item.guidance.steps.map((step, index) => `${index + 1}. ${step}`),
					`预期表现：${item.guidance.expectedObservation}`,
					...(item.guidance.failureSignature ? [`失败特征：${item.guidance.failureSignature}`] : []),
					...(item.guidance.anchor ? [`定位信息：${JSON.stringify(item.guidance.anchor)}`] : []),
				]
			: []),
		...(item.script ? [`脚本配置：${JSON.stringify(item.script)}`] : []),
		...(item.run ? [`已有脚本执行记录：${JSON.stringify(item.run)}`] : []),
	].join("\n");
}

function renderTextWithinSnapshotBudget(text: string, maximumCharacters: number): string {
	if (text.length <= maximumCharacters) return text;
	const summaryMarker = "…（内容已摘要）";
	return text.slice(0, Math.max(0, maximumCharacters - summaryMarker.length)) + summaryMarker;
}

function renderSelectedChecklistItemContext(
	item: RuntimePostDeployVerificationChecklistItem,
	maximumCharacters = Number.POSITIVE_INFINITY,
): string {
	const metadataCharacterBudget = Math.floor(maximumCharacters / 4);
	const heading = [
		`### ${renderTextWithinSnapshotBudget(item.label, metadataCharacterBudget)}`,
		`核对项 ID：${renderTextWithinSnapshotBudget(item.id, metadataCharacterBudget)}；来源：${item.source}；类型：${item.kind}`,
		"核对状态：尚未核对，不代表验证失败。",
	].join("\n");
	const details = renderChecklistItemGuidanceAndExecutionContext(item);
	return details
		? `${heading}\n${renderTextWithinSnapshotBudget(details, maximumCharacters - heading.length - 1)}`
		: heading;
}

export function buildPostDeployVerificationFollowUpTaskCreationDraftSeed(input: {
	workspaceId: string;
	projectName: string;
	sourceTaskTitle: string;
	sourceTaskCreatedAt: number;
	deploymentId: string;
	deployedSourceCommit: string;
	deployedAtIso: string;
	task: RuntimePostDeployVerificationTask;
	selectedChecklistItemIds: readonly string[];
}): PostDeployVerificationFollowUpTaskCreationDraftSeed {
	const selectedIds = new Set(input.selectedChecklistItemIds);
	const selectedItems = input.task.checklist.filter((item) => !item.checked && selectedIds.has(item.id));
	if (selectedItems.length === 0) throw new Error("请选择至少一个仍待核对的项目。");
	const sourceTaskTitle = input.sourceTaskTitle.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim();
	const title = `[FIX]核查并修复${sourceTaskTitle.slice(0, 35)}的部署后问题`;
	const sourcePointer = `PDV workspace=${input.workspaceId} deployment=${input.deploymentId} task=${input.task.taskId}`;
	const sourceContext = [
		`项目：${input.projectName}（${input.workspaceId}）`,
		`原 Task：${input.task.taskId} ${input.sourceTaskTitle}`,
		`部署：${input.deploymentId}；时间：${input.deployedAtIso}；提交：${input.deployedSourceCommit}`,
	];
	const renderPrompt = (itemContexts: string[], summarizeSource = false) =>
		[
			"请核查以下部署后核对项涉及的问题；先确认是否存在，再修复并验证选中的断言。",
			"## 来源",
			...sourceContext.map((context) => (summarizeSource ? renderTextWithinSnapshotBudget(context, 1000) : context)),
			"需要原始需求时，用 kanban task get 按上述项目与 Task ID 读取；不要依赖原 worktree 或复用原 Session。",
			"## 实际现象",
			"（可补充复现过程、截图或错误信息；未填写时先调查，不预设核对失败。）",
			"## 选中的核对项（创建草稿时的快照）",
			...itemContexts,
			"## 目标与验收",
			"先依据当前代码和真实行为确认问题，再完成必要修复并验证以上断言；区分已复现、未复现与无法验证。",
			"原 Task 的核对结果与结案状态由原流程管理，本任务不自动将它标成通过或移入 Done。",
		].join("\n\n");
	const maximumPromptCharacters =
		referenceRelationModelingEditorDraftSchema.shape.creationPrompt.unwrap().maxLength ?? Number.POSITIVE_INFINITY;
	let prompt = renderPrompt(selectedItems.map((item) => renderSelectedChecklistItemContext(item)));
	const snapshotRequiresSummary = prompt.length > maximumPromptCharacters;
	if (snapshotRequiresSummary) {
		const summaryNotice =
			`快照超出草稿长度上限，以下为摘要：共选择 ${selectedItems.length} 项，过长来源、核对项名称/ID、指引和脚本配置/输出可能省略后文。` +
			"完整来源和全部所选核对项 ID/名称保留在预置需求来源关系的 originatedRequirementPortionSummary；" +
			"按该关系中的项目与原 Task ID 用 kanban task get 读取原始需求，并到该来源部署的 PDV 记录获取指引和执行记录全文。";
		// 每项至少留出身份摘要空间；集合再大时明确报出未展示数量，完整索引仍保存在关系属性中。
		const availableItemCharacters = maximumPromptCharacters - renderPrompt([summaryNotice, "", ""], true).length;
		const displayedItemCount = Math.min(selectedItems.length, Math.floor((availableItemCharacters - 100) / 256));
		const omittedItemsNotice =
			displayedItemCount < selectedItems.length
				? `正文仅展示前 ${displayedItemCount} 项摘要；其余 ${selectedItems.length - displayedItemCount} 项未在正文逐项展示，完整所选项索引见上述关系属性。`
				: "";
		const perItemCharacterBudget = Math.floor(
			(availableItemCharacters - omittedItemsNotice.length - 2 * (displayedItemCount - 1)) / displayedItemCount,
		);
		prompt = renderPrompt(
			[
				summaryNotice,
				selectedItems
					.slice(0, displayedItemCount)
					.map((item) => renderSelectedChecklistItemContext(item, perItemCharacterBudget))
					.join("\n\n"),
				omittedItemsNotice,
			],
			true,
		);
	}
	const maximumEvidencePointerCharacters =
		referenceRelationModelingDraftSchema.shape.relationAssertionEvidencePointers.unwrap().element.maxLength ??
		Number.POSITIVE_INFINITY;
	const sourcePointerRequiresSummary = sourcePointer.length > maximumEvidencePointerCharacters;
	const selectedItemIndex = selectedItems.map((item) => `${item.id}：${item.label}`).join("\n");
	return {
		initializationId: createRandomUuidV4WithInsecureContextFallback(),
		workspaceId: input.workspaceId,
		title,
		prompt,
		referenceRelationDrafts: [
			{
				draftId: createRandomUuidV4WithInsecureContextFallback(),
				replacesRelationId: null,
				expectedAssertedRelationStateVersion: null,
				counterpartWorkUnit: {
					workUnitType: "kanban_board_card",
					workspaceId: input.workspaceId,
					taskId: input.task.taskId,
					taskIncarnationCreatedAtEpochMs: input.sourceTaskCreatedAt,
				},
				relationKind: "reference_requirement_originates_from",
				currentTaskIsStatementSubject: true,
				relationAssertionRationaleOneSentence:
					"本任务的需求来自原任务中选定的部署后核对项，需核查并处理其涉及的问题。",
				relationAssertionEvidencePointers: [
					sourcePointerRequiresSummary
						? "PDV 完整来源与所选项索引见本关系的 originatedRequirementPortionSummary 属性。"
						: sourcePointer,
				],
				assertedRelationKindSpecificAttributes: {
					originatedRequirementPortionSummary:
						snapshotRequiresSummary || sourcePointerRequiresSummary
							? [sourcePointer, ...sourceContext, "完整所选项索引：", selectedItemIndex].join("\n")
							: selectedItemIndex,
				},
			},
		],
	};
}
