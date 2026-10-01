import { createHash } from "node:crypto";

import type { RuntimeBoardCard, RuntimeBoardData } from "../core/api-contract";
import type { TaskMutationEventKindDerivedFromBoardDiff } from "../core/inter-work-unit-relation-ledger-event-contract";

// 族 1 task_mutation_event 的统一来源：前后两份 board 的差。漏斗内的意图只负责附上行动者；
// 漏斗外（CLI 直接写盘、手改 JSON）写入的变更在下一次漏斗通过时由同一个 diff 检出（Y-EVENT-2 第 2 步）。

// 不参与逐字段 diff 的卡片字段：
// - id 与 createdAt 构成卡片限定引用本身；
// - updatedAt 每次写都变，只是噪声；
// - taskDescriptionLastUpdatedAt 是 prompt/附图变化的派生时间戳（base e50b74d0）：它只随 prompt/images 推进，
//   而那两个字段的变化本身已逐字段记账；前端首次水合还会给所有老卡物化回落值，计入 diff 会在首次保存时
//   产出一批「字段变更」噪声事件，把一次无意图的物化错记成保存方对每张卡的修改。
const TASK_CARD_FIELD_NAMES_EXCLUDED_FROM_FIELD_VALUE_DIFF = new Set([
	"id",
	"createdAt",
	"updatedAt",
	"taskDescriptionLastUpdatedAt",
]);
// 只存哈希、不留全文的字段：图片是 base64，体积大，且不承载需求文本。
const TASK_CARD_FIELD_NAMES_WITH_CONTENT_NOT_RETAINED_IN_LEDGER = new Set(["images"]);

export interface WorkspaceBoardTaskCardSnapshotEntry {
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	boardColumnId: string;
	fieldValueSha256ByFieldName: Record<string, string>;
}

export interface WorkspaceBoardSnapshotForTaskMutationDiff {
	taskCardSnapshotEntriesByTaskId: Record<string, WorkspaceBoardTaskCardSnapshotEntry>;
}

export interface TaskCardFieldValueRetainedContent {
	fieldValueSha256: string;
	fieldValueCanonicalJson: string;
}

export interface BoardDerivedTaskMutationOccurrence {
	eventKind: TaskMutationEventKindDerivedFromBoardDiff;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number | null;
	eventPayloadSpecificToEventKind: Record<string, unknown>;
}

export interface WorkspaceBoardSnapshotWithRetainedFieldContents {
	snapshot: WorkspaceBoardSnapshotForTaskMutationDiff;
	retainedFieldContentsBySha256: Map<string, TaskCardFieldValueRetainedContent>;
}

function canonicalJsonStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => (item === undefined ? "null" : canonicalJsonStringify(item))).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`).join(",")}}`;
}

export function computeSha256HexOfUtf8Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildWorkspaceBoardSnapshotWithRetainedFieldContents(
	board: RuntimeBoardData,
): WorkspaceBoardSnapshotWithRetainedFieldContents {
	const taskCardSnapshotEntriesByTaskId: Record<string, WorkspaceBoardTaskCardSnapshotEntry> = {};
	const retainedFieldContentsBySha256 = new Map<string, TaskCardFieldValueRetainedContent>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskCardSnapshotEntriesByTaskId[card.id] = {
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				boardColumnId: column.id,
				fieldValueSha256ByFieldName: digestTaskCardFieldValues(card, retainedFieldContentsBySha256),
			};
		}
	}
	return {
		snapshot: {
			taskCardSnapshotEntriesByTaskId,
		},
		retainedFieldContentsBySha256,
	};
}

function digestTaskCardFieldValues(
	card: RuntimeBoardCard,
	retainedFieldContentsBySha256: Map<string, TaskCardFieldValueRetainedContent>,
): Record<string, string> {
	const fieldValueSha256ByFieldName: Record<string, string> = {};
	for (const [fieldName, fieldValue] of Object.entries(card)) {
		if (fieldValue === undefined || TASK_CARD_FIELD_NAMES_EXCLUDED_FROM_FIELD_VALUE_DIFF.has(fieldName)) {
			continue;
		}
		const fieldValueCanonicalJson = canonicalJsonStringify(fieldValue);
		const fieldValueSha256 = computeSha256HexOfUtf8Text(fieldValueCanonicalJson);
		fieldValueSha256ByFieldName[fieldName] = fieldValueSha256;
		if (!TASK_CARD_FIELD_NAMES_WITH_CONTENT_NOT_RETAINED_IN_LEDGER.has(fieldName)) {
			retainedFieldContentsBySha256.set(fieldValueSha256, { fieldValueSha256, fieldValueCanonicalJson });
		}
	}
	return fieldValueSha256ByFieldName;
}

function describeColumnTransitionEventKind(
	fromBoardColumnId: string,
	toBoardColumnId: string,
): TaskMutationEventKindDerivedFromBoardDiff {
	if (toBoardColumnId === "trash") {
		return "task_card_moved_to_trash_column";
	}
	if (fromBoardColumnId === "trash") {
		return "task_card_restored_from_trash_column";
	}
	return "task_card_moved_between_non_trash_board_columns";
}

function createdOccurrence(entry: WorkspaceBoardTaskCardSnapshotEntry): BoardDerivedTaskMutationOccurrence {
	return {
		eventKind: "task_card_created_on_board",
		taskId: entry.taskId,
		taskIncarnationCreatedAtEpochMs: entry.taskIncarnationCreatedAtEpochMs,
		eventPayloadSpecificToEventKind: {
			boardColumnIdAtCreation: entry.boardColumnId,
			fieldValueSha256ByFieldNameAtCreation: entry.fieldValueSha256ByFieldName,
		},
	};
}

function removedOccurrence(entry: WorkspaceBoardTaskCardSnapshotEntry): BoardDerivedTaskMutationOccurrence {
	return {
		eventKind: "task_card_permanently_removed_from_board",
		taskId: entry.taskId,
		taskIncarnationCreatedAtEpochMs: entry.taskIncarnationCreatedAtEpochMs,
		eventPayloadSpecificToEventKind: {
			lastBoardColumnIdBeforeRemoval: entry.boardColumnId,
			lastFieldValueSha256ByFieldNameBeforeRemoval: entry.fieldValueSha256ByFieldName,
		},
	};
}

export function diffWorkspaceBoardSnapshotsIntoTaskMutationOccurrences(
	previousSnapshot: WorkspaceBoardSnapshotForTaskMutationDiff,
	nextSnapshot: WorkspaceBoardSnapshotForTaskMutationDiff,
): BoardDerivedTaskMutationOccurrence[] {
	const occurrences: BoardDerivedTaskMutationOccurrence[] = [];
	const previousEntries = previousSnapshot.taskCardSnapshotEntriesByTaskId;
	const nextEntries = nextSnapshot.taskCardSnapshotEntriesByTaskId;

	for (const previousEntry of Object.values(previousEntries)) {
		const nextEntry = nextEntries[previousEntry.taskId];
		if (!nextEntry || nextEntry.taskIncarnationCreatedAtEpochMs !== previousEntry.taskIncarnationCreatedAtEpochMs) {
			occurrences.push(removedOccurrence(previousEntry));
		}
	}

	for (const nextEntry of Object.values(nextEntries)) {
		const previousEntry = previousEntries[nextEntry.taskId];
		if (
			!previousEntry ||
			previousEntry.taskIncarnationCreatedAtEpochMs !== nextEntry.taskIncarnationCreatedAtEpochMs
		) {
			occurrences.push(createdOccurrence(nextEntry));
			continue;
		}
		const fieldNames = new Set([
			...Object.keys(previousEntry.fieldValueSha256ByFieldName),
			...Object.keys(nextEntry.fieldValueSha256ByFieldName),
		]);
		for (const fieldName of [...fieldNames].sort()) {
			const fieldValueBeforeSha256 = previousEntry.fieldValueSha256ByFieldName[fieldName] ?? null;
			const fieldValueAfterSha256 = nextEntry.fieldValueSha256ByFieldName[fieldName] ?? null;
			if (fieldValueBeforeSha256 === fieldValueAfterSha256) {
				continue;
			}
			occurrences.push({
				eventKind: "task_card_field_value_changed",
				taskId: nextEntry.taskId,
				taskIncarnationCreatedAtEpochMs: nextEntry.taskIncarnationCreatedAtEpochMs,
				eventPayloadSpecificToEventKind: {
					changedTaskCardFieldName: fieldName,
					fieldValueBeforeSha256,
					fieldValueAfterSha256,
					fieldValueContentRetainedInLedger:
						!TASK_CARD_FIELD_NAMES_WITH_CONTENT_NOT_RETAINED_IN_LEDGER.has(fieldName),
				},
			});
		}
		if (previousEntry.boardColumnId !== nextEntry.boardColumnId) {
			occurrences.push({
				eventKind: describeColumnTransitionEventKind(previousEntry.boardColumnId, nextEntry.boardColumnId),
				taskId: nextEntry.taskId,
				taskIncarnationCreatedAtEpochMs: nextEntry.taskIncarnationCreatedAtEpochMs,
				eventPayloadSpecificToEventKind: {
					fromBoardColumnId: previousEntry.boardColumnId,
					toBoardColumnId: nextEntry.boardColumnId,
				},
			});
		}
	}

	return occurrences;
}

export function collectRetainedFieldContentsReferencedByOccurrences(
	occurrences: BoardDerivedTaskMutationOccurrence[],
	retainedFieldContentsBySha256: Map<string, TaskCardFieldValueRetainedContent>,
): TaskCardFieldValueRetainedContent[] {
	const referencedSha256s = new Set<string>();
	for (const occurrence of occurrences) {
		const payload = occurrence.eventPayloadSpecificToEventKind;
		if (occurrence.eventKind === "task_card_field_value_changed") {
			for (const sha256 of [payload.fieldValueBeforeSha256, payload.fieldValueAfterSha256]) {
				if (typeof sha256 === "string") referencedSha256s.add(sha256);
			}
		}
		if (occurrence.eventKind === "task_card_created_on_board") {
			for (const sha256 of Object.values(payload.fieldValueSha256ByFieldNameAtCreation as Record<string, string>)) {
				referencedSha256s.add(sha256);
			}
		}
	}
	const contents: TaskCardFieldValueRetainedContent[] = [];
	for (const sha256 of referencedSha256s) {
		const content = retainedFieldContentsBySha256.get(sha256);
		if (content) contents.push(content);
	}
	return contents;
}
