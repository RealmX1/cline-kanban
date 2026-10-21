import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type KanbanBoardCardWorkUnitQualifiedReference,
	kanbanBoardCardWorkUnitQualifiedReferenceSchema,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	type IncomingWorkItem,
	type IncomingWorkItemRelationAnalysis,
	IncomingWorkItemTriageOperationError,
	type IncomingWorkItemTriageResponse,
	incomingWorkItemRelationAnalysisSchema,
	incomingWorkItemSchema,
	incomingWorkItemTriageResponseSchema,
	type TaskIndexingMaterial,
} from "../core/task-indexing-support-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	selectFullyCoveringExistingTask,
	taskIndexingMaterialIdentityKey,
	taskIndexingMaterialRequirementsFingerprint,
} from "./incoming-work-item-relation-analysis";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";
import { readTaskIndexingSupportJsonFile } from "./task-indexing-support-storage";

export interface IncomingWorkItemTriageEffects {
	allocateTaskIdentity: () => Promise<KanbanBoardCardWorkUnitQualifiedReference>;
	readCurrentMaterials: () => Promise<readonly TaskIndexingMaterial[]>;
	analyze: (materials: readonly TaskIndexingMaterial[]) => Promise<IncomingWorkItemRelationAnalysis>;
	createBacklogTask: (input: {
		taskReference: KanbanBoardCardWorkUnitQualifiedReference;
		item: IncomingWorkItem;
		operationId: string;
	}) => Promise<void>;
	appendComment: (input: {
		taskReference: KanbanBoardCardWorkUnitQualifiedReference;
		commentId: string;
		text: string;
		expectedRequirementsFingerprint?: string;
	}) => Promise<void>;
	assertUnverifiedRelations: (input: {
		subject: KanbanBoardCardWorkUnitQualifiedReference;
		analysis: IncomingWorkItemRelationAnalysis;
		item: IncomingWorkItem;
		operationId: string;
		expectedRequirementsFingerprintByTaskIdentity: Readonly<Record<string, string>>;
	}) => Promise<void>;
	recordDisposition: (input: {
		item: IncomingWorkItem;
		response: IncomingWorkItemTriageResponse;
		commentTaskReference: KanbanBoardCardWorkUnitQualifiedReference;
	}) => Promise<void>;
}

const operationSchema = z.object({
	schemaVersion: z.literal(1),
	operationId: z.string(),
	requestFingerprint: z.string(),
	incomingWorkItem: incomingWorkItemSchema,
	analysis: incomingWorkItemRelationAnalysisSchema.nullable(),
	expectedRequirementsFingerprintByTaskIdentity: z.record(z.string(), z.string()),
	allocatedTask: kanbanBoardCardWorkUnitQualifiedReferenceSchema.nullable(),
	response: incomingWorkItemTriageResponseSchema.nullable(),
	completedSteps: z.array(z.string()),
	startedSteps: z.array(z.string()).default([]),
	completed: z.boolean(),
});
export type IncomingWorkItemTriageOperation = z.infer<typeof operationSchema>;

export async function listDurableIncomingWorkItemTriageOperations(
	operationDirectoryPath: string,
): Promise<IncomingWorkItemTriageOperation[]> {
	let filenames: string[];
	try {
		filenames = await readdir(operationDirectoryPath);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const operations: IncomingWorkItemTriageOperation[] = [];
	for (const filename of filenames.sort()) {
		if (!/^incoming-work-item-[a-f0-9]{64}\.json$/u.test(filename)) continue;
		const operation = operationSchema.parse(
			await readTaskIndexingSupportJsonFile(join(operationDirectoryPath, filename)),
		);
		if (`${operation.operationId}.json` !== filename)
			throw new Error("分诊回执文件名与操作身份不一致，拒绝补查覆盖。");
		operations.push(operation);
	}
	return operations;
}

export function incomingWorkItemTriageOperationId(workspaceId: string, key: string): string {
	return `incoming-work-item-${taskIndexingTextFingerprint(JSON.stringify([workspaceId, key]))}`;
}
export function renderIncomingWorkItemRelatedFindingComment(
	item: IncomingWorkItem,
	response: IncomingWorkItemTriageResponse,
): string {
	const candidates = response.relation_candidates
		.map(
			(candidate) =>
				`- 可能与 ${candidate.task_reference.workspaceId}/${candidate.task_reference.taskId} 相关（${candidate.confidence}）：${candidate.rationale}`,
		)
		.join("\n");
	return `关联发现：${item.title}\n\n${item.prompt}\n\n${item.evidence.length ? `证据：\n${item.evidence.join("\n")}\n\n` : ""}关系分诊：${response.decision}。以下为 support Agent 未经用户或独立核验确认的声称。\n${candidates || "未发现相关候选。"}\n\n分诊回执：${response.operation_id}`;
}

export async function triageIncomingWorkItemWithDurableOperation(input: {
	workspaceId: string;
	item: IncomingWorkItem;
	operationDirectoryPath: string;
	effects: IncomingWorkItemTriageEffects;
}): Promise<IncomingWorkItemTriageResponse> {
	const { item, effects } = input;
	if (item.existing_finding_task && item.existing_finding_task.workspaceId !== input.workspaceId)
		throw new Error("补查发现卡必须属于当前项目。");
	const operationId = incomingWorkItemTriageOperationId(input.workspaceId, item.work_item_key);
	const path = join(input.operationDirectoryPath, `${operationId}.json`);
	return await lockedFileSystem.withLock({ path }, async () => {
		const fingerprint = taskIndexingTextFingerprint(JSON.stringify(item));
		const persisted = await readTaskIndexingSupportJsonFile(path);
		const operation: IncomingWorkItemTriageOperation =
			persisted === null
				? {
						schemaVersion: 1,
						operationId,
						requestFingerprint: fingerprint,
						incomingWorkItem: item,
						analysis: null,
						expectedRequirementsFingerprintByTaskIdentity: {},
						allocatedTask: null,
						response: null,
						completedSteps: [],
						startedSteps: [],
						completed: false,
					}
				: operationSchema.parse(persisted);
		if (operation.requestFingerprint !== fingerprint)
			throw new Error(`同一 work_item_key 对应了不同工作项，未覆盖原回执：${operationId}`);
		if (operation.completed && operation.response) return operation.response;
		const save = () => lockedFileSystem.writeJsonFileAtomic(path, operation, { lock: null });
		await save();
		try {
			if (!operation.analysis) {
				const materials = await effects.readCurrentMaterials();
				operation.analysis = incomingWorkItemRelationAnalysisSchema.parse(await effects.analyze(materials));
				for (const candidate of operation.analysis.relation_candidates) {
					const material = materials.find(
						(entry) => taskIndexingMaterialIdentityKey(entry) === JSON.stringify(candidate.task_reference),
					);
					if (!material) throw new Error("候选身份不存在，未采用分析结果。");
					operation.expectedRequirementsFingerprintByTaskIdentity[taskIndexingMaterialIdentityKey(material)] =
						taskIndexingMaterialRequirementsFingerprint(material);
				}
				for (const reference of [item.source_task, item.existing_finding_task]) {
					const material =
						reference &&
						materials.find((entry) => taskIndexingMaterialIdentityKey(entry) === JSON.stringify(reference));
					if (material)
						operation.expectedRequirementsFingerprintByTaskIdentity[taskIndexingMaterialIdentityKey(material)] =
							taskIndexingMaterialRequirementsFingerprint(material);
				}
				await save();
			}
			const analysis = operation.analysis;
			const fullyCovering = selectFullyCoveringExistingTask(analysis);
			if (!operation.response) {
				if (!fullyCovering && !item.existing_finding_task && !operation.allocatedTask) {
					operation.allocatedTask = await effects.allocateTaskIdentity();
					await save();
				}
				operation.response = {
					...analysis,
					operation_id: operationId,
					as_of: Date.now(),
					decision: fullyCovering
						? "linked_to_existing_task"
						: analysis.relation_candidates.length
							? "created_task_with_possible_relations"
							: "created_task_without_relations",
					...(fullyCovering
						? { linked_task_id: fullyCovering.task_reference.taskId }
						: { created_task_id: (item.existing_finding_task ?? operation.allocatedTask)?.taskId }),
					...(item.existing_finding_task ? { existing_finding_task_preserved: true } : {}),
				};
				await save();
			}
			const response = operation.response;
			const currentMaterials = await effects.readCurrentMaterials();
			for (const [identity, expected] of Object.entries(operation.expectedRequirementsFingerprintByTaskIdentity)) {
				const current = currentMaterials.find((entry) => taskIndexingMaterialIdentityKey(entry) === identity);
				if (!current || taskIndexingMaterialRequirementsFingerprint(current) !== expected) {
					if (operation.startedSteps.length === 0) {
						operation.analysis = null;
						operation.response = null;
						operation.expectedRequirementsFingerprintByTaskIdentity = {};
						await save();
					}
					throw new Error(
						"候选任务身份、要求或所在列已变化，拒绝用过时分析写入；尚未执行写入时下次重试会重新分析，已有部分写入时保留回执待核对。",
					);
				}
			}
			const step = async (key: string, effect: () => Promise<void>) => {
				if (operation.completedSteps.includes(key)) return;
				if (!operation.startedSteps.includes(key)) {
					operation.startedSteps.push(key);
					await save();
				}
				await effect();
				operation.completedSteps.push(key);
				await save();
			};
			const commentTarget = fullyCovering?.task_reference ?? item.existing_finding_task ?? operation.allocatedTask;
			if (!commentTarget) throw new Error("分诊处置缺少目标任务身份。");
			if (!fullyCovering && operation.allocatedTask)
				await step("create_backlog_task", () =>
					effects.createBacklogTask({
						taskReference: operation.allocatedTask as KanbanBoardCardWorkUnitQualifiedReference,
						item,
						operationId,
					}),
				);
			await step("append_related_finding", () =>
				effects.appendComment({
					taskReference: commentTarget,
					commentId: `${operationId}:related-finding`,
					text: renderIncomingWorkItemRelatedFindingComment(item, response),
					expectedRequirementsFingerprint:
						operation.expectedRequirementsFingerprintByTaskIdentity[JSON.stringify(commentTarget)],
				}),
			);
			if (item.existing_finding_task && JSON.stringify(commentTarget) !== JSON.stringify(item.existing_finding_task))
				await step("annotate_preserved_finding_card", () =>
					effects.appendComment({
						taskReference: item.existing_finding_task as KanbanBoardCardWorkUnitQualifiedReference,
						commentId: `${operationId}:preserved-finding`,
						text: `关系分诊已关联到 ${commentTarget.workspaceId}/${commentTarget.taskId}。原发现卡保留，请由用户确认后续处置。\n\n${renderIncomingWorkItemRelatedFindingComment(item, response)}`,
					}),
				);
			const resolvableSource =
				item.source_task &&
				currentMaterials.some(
					(material) => taskIndexingMaterialIdentityKey(material) === JSON.stringify(item.source_task),
				)
					? item.source_task
					: undefined;
			const subject =
				item.existing_finding_task ?? (!fullyCovering ? operation.allocatedTask : null) ?? resolvableSource;
			if (subject) {
				if (subject === operation.allocatedTask) {
					operation.expectedRequirementsFingerprintByTaskIdentity[JSON.stringify(subject)] =
						taskIndexingMaterialRequirementsFingerprint({
							taskReference: subject,
							title: item.title,
							prompt: item.prompt,
							columnId: "backlog",
						});
					await save();
				}
				await step("assert_unverified_reference_relations", () =>
					effects.assertUnverifiedRelations({
						subject,
						analysis,
						item,
						operationId,
						expectedRequirementsFingerprintByTaskIdentity:
							operation.expectedRequirementsFingerprintByTaskIdentity,
					}),
				);
			}
			await step("record_disposition", () =>
				effects.recordDisposition({ item, response, commentTaskReference: commentTarget }),
			);
			operation.completed = true;
			await save();
			return response;
		} catch (error) {
			throw new IncomingWorkItemTriageOperationError(
				`分诊未完成（operation_id=${operationId}；已完成步骤=${operation.completedSteps.join(",") || "无"}）：${error instanceof Error ? error.message : String(error)}`,
				{
					operation_id: operationId,
					completed_steps: [...operation.completedSteps],
					started_steps: [...operation.startedSteps],
				},
				error,
			);
		}
	});
}
