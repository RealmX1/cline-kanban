import type { SharedTaskIndexingContext, TaskIndexingMaterial } from "../core/task-indexing-support-contract";
import type { TaskLookupScope } from "../core/task-lookup-conversation-contract";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";

// EXPERIMENT_NODE: 轻索引每批材料预算暂为 256 KiB，依据真实召回率、用量与时延调整。
export const TASK_LOOKUP_CONTEXT_MATERIAL_BYTE_BUDGET = 256 * 1024;

export function buildTaskLookupCurrentContextMetadata(
	workspaceId: string,
	materials: readonly TaskIndexingMaterial[],
	now: number,
): SharedTaskIndexingContext {
	const text = JSON.stringify(buildTaskLookupScopedOverview(materials, { projectIds: [], columnIds: [] }).rows);
	return {
		schemaVersion: 1,
		workspaceId,
		levelOneBoardTaskIndexText: text,
		levelTwoProjectTaskRecapsText: "",
		levelThreeAppendedChangesText: "",
		snapshotFingerprint: taskIndexingTextFingerprint(text),
		contextCompleteness: [],
		asOf: now,
		rebuildReason: null,
	};
}

export function buildTaskLookupScopedOverview(materials: readonly TaskIndexingMaterial[], scope: TaskLookupScope) {
	const materialsByReferenceKey = new Map<string, TaskIndexingMaterial>();
	const rows = materials
		.filter(
			(material) =>
				(scope.projectIds.length === 0 || scope.projectIds.includes(material.taskReference.workspaceId)) &&
				(scope.columnIds.length === 0 || scope.columnIds.includes(material.columnId)),
		)
		.sort((left, right) => JSON.stringify(left.taskReference).localeCompare(JSON.stringify(right.taskReference)))
		.map((material, index) => {
			const taskReferenceKey = `task-${index + 1}`;
			materialsByReferenceKey.set(taskReferenceKey, material);
			return {
				taskReferenceKey,
				workspaceId: material.taskReference.workspaceId,
				taskId: material.taskReference.taskId,
				taskName: material.title.slice(0, 80),
				boardColumnId: material.columnId,
				taskDescriptionSummaryText: material.taskDescription?.slice(0, 120) ?? "",
				descriptionSource: material.taskDescription ? "task_description" : "task_description_unavailable",
				taskProgressSummaryText: material.latestTaskProgressSummaryText?.slice(0, 160) ?? null,
			};
		});
	return { rows, materialsByReferenceKey };
}

export function partitionTaskLookupItemsWithinByteBudget<T>(
	items: readonly T[],
	byteBudget: number,
	serializeItems: (items: T[]) => string,
): T[][] {
	if (byteBudget < 1) throw new Error("查卡材料预算必须为正数。");
	const batches: T[][] = [];
	let batch: T[] = [];
	for (const item of items) {
		const next = [...batch, item];
		if (batch.length && Buffer.byteLength(serializeItems(next)) > byteBudget) {
			batches.push(batch);
			batch = [];
		}
		batch.push(item);
	}
	if (batch.length) batches.push(batch);
	return batches;
}

export function splitTaskLookupTextWithinByteBudget(text: string, byteBudget: number): string[] {
	if (byteBudget < 4) throw new Error("查卡原文分片预算至少需要四字节。");
	const segments: string[] = [];
	let characters: string[] = [];
	let bytes = 0;
	for (const character of text) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > byteBudget) {
			segments.push(characters.join(""));
			characters = [];
			bytes = 0;
		}
		characters.push(character);
		bytes += characterBytes;
	}
	if (characters.length) segments.push(characters.join(""));
	return segments;
}
