// saveState 发起方标注（dd2db Y-EVENT-8）的浏览器端账本。
//
// Web UI 改 board 的方式是「各入口改本地 board state → useWorkspacePersistence 防抖后整板 saveState」，runtime 只能从
// 前后两份 board 的差里看出发生了什么，看不出是谁干的。这里分两步把「谁」补上：
//
// 1. 记录（改 board 的那一刻）：每个改 board 的入口按语义登记「这张卡的这一类变更，最近一次是谁发起的」——
//    按 (taskId, 变更面) 只留最新一条。变更面与 runtime board diff 的事件种类一一对应：建卡 / 改字段 /
//    移列（含移入、移出 trash）/ 永久删除。登记 null = 「确实改了，但说不清是谁」，用来盖掉更早的登记、避免错标。
// 2. 出标注（组 saveState 载荷的那一刻）：拿「runtime 最近一次确认持久化的 board」对「本次要保存的 board」做与
//    runtime 同一词表的 diff，每条差异按 (taskId, 变更面) 查第 1 步的登记，查到非 null 才出一条标注，并带上精确的
//    from/to 列与字段名。所以：没真正落到 board 上的登记不会出标注；同一窗口里 A→B→C 的连续移列只出一条 A→C；
//    runtime 侧还会看到但浏览器没改过的差异（例如水合物化的默认字段）不会被错配到某个手势上——它们如实记为缺标注。
//
// 成功保存后丢弃「组载荷时已存在」的登记；保存失败（冲突重试等）则原样保留到下一次。board 被 runtime 推送整板
// 替换（水合）或切换项目时，本地未保存的变更已经不在了，登记一并清空。

import type {
	WebUiBoardMutationInitiator,
	WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture,
} from "@runtime-kanban-web-ui-page-load-request-origin-nonce";
import type { BoardCard, BoardData } from "@/types";

type AnnotatedBoardMutationKind =
	WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture["annotatedBoardMutationKind"];

export type WebUiBoardMutationAspectOfTaskCard =
	| "task_card_creation"
	| "task_card_field_values"
	| "task_card_column_placement"
	| "task_card_permanent_removal";

export interface TaskCardMutationDerivedFromBoardDiffInRuntimeVocabulary {
	taskId: string;
	annotatedBoardMutationKind: AnnotatedBoardMutationKind;
	fromColumnId?: string;
	toColumnId?: string;
	changedCardFieldNames?: string[];
}

interface PendingWebUiBoardMutationInitiatorRecord {
	boardMutationInitiator: WebUiBoardMutationInitiator | null;
	pendingInitiatorRecordSequence: number;
}

// 与 runtime 的 board diff（src/inter-work-unit-relation-ledger/workspace-board-task-mutation-occurrence-diff.ts）
// 的排除集逐字一致：id/createdAt 是卡片限定引用本身，updatedAt 是每次写都变的噪声，
// taskDescriptionLastUpdatedAt 是 prompt/images 的派生时间戳。runtime 那份文件依赖 node:crypto，前端不能直接引用。
const TASK_CARD_FIELD_NAMES_EXCLUDED_FROM_RUNTIME_FIELD_VALUE_DIFF = new Set([
	"id",
	"createdAt",
	"updatedAt",
	"taskDescriptionLastUpdatedAt",
]);

const pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey = new Map<
	string,
	PendingWebUiBoardMutationInitiatorRecord
>();
let latestPendingWebUiBoardMutationInitiatorRecordSequence = 0;

function buildTaskCardAspectKey(
	taskId: string,
	boardMutationAspectOfTaskCard: WebUiBoardMutationAspectOfTaskCard,
): string {
	return `${boardMutationAspectOfTaskCard}\u0000${taskId}`;
}

function resolveWebUiBoardMutationAspectOfTaskCardForAnnotatedKind(
	annotatedBoardMutationKind: AnnotatedBoardMutationKind,
): WebUiBoardMutationAspectOfTaskCard {
	switch (annotatedBoardMutationKind) {
		case "task_card_created_on_board":
			return "task_card_creation";
		case "task_card_field_value_changed":
			return "task_card_field_values";
		case "task_card_permanently_removed_from_board":
			return "task_card_permanent_removal";
		case "task_card_moved_between_non_trash_board_columns":
		case "task_card_moved_to_trash_column":
		case "task_card_restored_from_trash_column":
			return "task_card_column_placement";
	}
}

// 与 runtime diff 的 canonicalJsonStringify 同一规则：对象键排序、undefined 键丢弃，用于判定字段值是否变化。
function canonicalJsonStringifyForTaskCardFieldValueComparison(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value
			.map((item) => (item === undefined ? "null" : canonicalJsonStringifyForTaskCardFieldValueComparison(item)))
			.join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringifyForTaskCardFieldValueComparison(record[key])}`)
		.join(",")}}`;
}

function collectChangedTaskCardFieldNamesInRuntimeDiffVocabulary(
	cardBefore: BoardCard,
	cardAfter: BoardCard,
): string[] {
	if (cardBefore === cardAfter) {
		return [];
	}
	const recordBefore = cardBefore as unknown as Record<string, unknown>;
	const recordAfter = cardAfter as unknown as Record<string, unknown>;
	const fieldNames = new Set([...Object.keys(recordBefore), ...Object.keys(recordAfter)]);
	const changedFieldNames: string[] = [];
	for (const fieldName of fieldNames) {
		if (TASK_CARD_FIELD_NAMES_EXCLUDED_FROM_RUNTIME_FIELD_VALUE_DIFF.has(fieldName)) {
			continue;
		}
		const valueBefore = recordBefore[fieldName];
		const valueAfter = recordAfter[fieldName];
		if (valueBefore === valueAfter) {
			continue;
		}
		const canonicalBefore =
			valueBefore === undefined ? null : canonicalJsonStringifyForTaskCardFieldValueComparison(valueBefore);
		const canonicalAfter =
			valueAfter === undefined ? null : canonicalJsonStringifyForTaskCardFieldValueComparison(valueAfter);
		if (canonicalBefore !== canonicalAfter) {
			changedFieldNames.push(fieldName);
		}
	}
	return changedFieldNames.sort();
}

function describeColumnTransitionInRuntimeDiffVocabulary(
	fromColumnId: string,
	toColumnId: string,
): AnnotatedBoardMutationKind {
	if (toColumnId === "trash") {
		return "task_card_moved_to_trash_column";
	}
	if (fromColumnId === "trash") {
		return "task_card_restored_from_trash_column";
	}
	return "task_card_moved_between_non_trash_board_columns";
}

function indexTaskCardsWithColumnByTaskId(board: BoardData): Map<string, { card: BoardCard; columnId: string }> {
	const indexed = new Map<string, { card: BoardCard; columnId: string }>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			indexed.set(card.id, { card, columnId: column.id });
		}
	}
	return indexed;
}

// 与 runtime board diff 同一词表、同一判据（卡片身份 = id + createdAt）的浏览器端 diff。
export function deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary(
	boardBefore: BoardData,
	boardAfter: BoardData,
): TaskCardMutationDerivedFromBoardDiffInRuntimeVocabulary[] {
	if (boardBefore === boardAfter) {
		return [];
	}
	const derived: TaskCardMutationDerivedFromBoardDiffInRuntimeVocabulary[] = [];
	const entriesBefore = indexTaskCardsWithColumnByTaskId(boardBefore);
	const entriesAfter = indexTaskCardsWithColumnByTaskId(boardAfter);
	for (const [taskId, entryBefore] of entriesBefore) {
		const entryAfter = entriesAfter.get(taskId);
		if (!entryAfter || entryAfter.card.createdAt !== entryBefore.card.createdAt) {
			derived.push({ taskId, annotatedBoardMutationKind: "task_card_permanently_removed_from_board" });
		}
	}
	for (const [taskId, entryAfter] of entriesAfter) {
		const entryBefore = entriesBefore.get(taskId);
		if (!entryBefore || entryBefore.card.createdAt !== entryAfter.card.createdAt) {
			derived.push({ taskId, annotatedBoardMutationKind: "task_card_created_on_board" });
			continue;
		}
		const changedCardFieldNames = collectChangedTaskCardFieldNamesInRuntimeDiffVocabulary(
			entryBefore.card,
			entryAfter.card,
		);
		if (changedCardFieldNames.length > 0) {
			derived.push({ taskId, annotatedBoardMutationKind: "task_card_field_value_changed", changedCardFieldNames });
		}
		if (entryBefore.columnId !== entryAfter.columnId) {
			derived.push({
				taskId,
				annotatedBoardMutationKind: describeColumnTransitionInRuntimeDiffVocabulary(
					entryBefore.columnId,
					entryAfter.columnId,
				),
				fromColumnId: entryBefore.columnId,
				toColumnId: entryAfter.columnId,
			});
		}
	}
	return derived;
}

export function recordWebUiBoardMutationInitiatorForTaskCardAspect(input: {
	taskId: string;
	boardMutationAspectOfTaskCard: WebUiBoardMutationAspectOfTaskCard;
	// null = 这次变更确实发生了，但找不到确定的发起方：盖掉更早的登记，让它在 runtime 侧如实记为缺标注。
	boardMutationInitiator: WebUiBoardMutationInitiator | null;
}): void {
	latestPendingWebUiBoardMutationInitiatorRecordSequence += 1;
	pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.set(
		buildTaskCardAspectKey(input.taskId, input.boardMutationAspectOfTaskCard),
		{
			boardMutationInitiator: input.boardMutationInitiator,
			pendingInitiatorRecordSequence: latestPendingWebUiBoardMutationInitiatorRecordSequence,
		},
	);
}

// 按 board 前后差把每张变了的卡、每个变了的面都登记成同一个发起方——适合「一个入口、一种发起方」的写法。
export function recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards(input: {
	boardBeforeMutation: BoardData;
	boardAfterMutation: BoardData;
	boardMutationInitiator: WebUiBoardMutationInitiator | null;
}): void {
	for (const mutation of deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary(
		input.boardBeforeMutation,
		input.boardAfterMutation,
	)) {
		recordWebUiBoardMutationInitiatorForTaskCardAspect({
			taskId: mutation.taskId,
			boardMutationAspectOfTaskCard: resolveWebUiBoardMutationAspectOfTaskCardForAnnotatedKind(
				mutation.annotatedBoardMutationKind,
			),
			boardMutationInitiator: input.boardMutationInitiator,
		});
	}
}

// 包一层 setBoard updater：updater 真改了 board 才按前后差登记，no-op 不留登记。
export function withWebUiBoardMutationInitiatorRecordedForChangedTaskCards(
	boardMutationInitiator: WebUiBoardMutationInitiator | null,
	boardUpdater: (currentBoard: BoardData) => BoardData,
): (currentBoard: BoardData) => BoardData {
	return (currentBoard) => {
		const nextBoard = boardUpdater(currentBoard);
		if (nextBoard !== currentBoard) {
			recordWebUiBoardMutationInitiatorForTaskCardsChangedBetweenBoards({
				boardBeforeMutation: currentBoard,
				boardAfterMutation: nextBoard,
				boardMutationInitiator,
			});
		}
		return nextBoard;
	};
}

export function readPendingWebUiBoardMutationInitiatorForTaskCardAspect(
	taskId: string,
	boardMutationAspectOfTaskCard: WebUiBoardMutationAspectOfTaskCard,
): WebUiBoardMutationInitiator | null | undefined {
	return pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.get(
		buildTaskCardAspectKey(taskId, boardMutationAspectOfTaskCard),
	)?.boardMutationInitiator;
}

export function buildWebUiBoardMutationInitiatorAnnotationsForSaveStatePayload(input: {
	// null = 还不知道 runtime 手上是哪份 board（尚未水合）；此时不出任何标注。
	boardLastConfirmedPersistedByRuntime: BoardData | null;
	boardAboutToBeSaved: BoardData;
}): {
	boardMutationInitiatorAnnotationsForTaskMutationEventCapture: WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture[];
	pendingInitiatorRecordSequenceCoveredBySaveStatePayload: number;
} {
	const pendingInitiatorRecordSequenceCoveredBySaveStatePayload =
		latestPendingWebUiBoardMutationInitiatorRecordSequence;
	if (
		!input.boardLastConfirmedPersistedByRuntime ||
		pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.size === 0
	) {
		return {
			boardMutationInitiatorAnnotationsForTaskMutationEventCapture: [],
			pendingInitiatorRecordSequenceCoveredBySaveStatePayload,
		};
	}
	const annotations: WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture[] = [];
	for (const mutation of deriveTaskCardMutationsBetweenBoardsInRuntimeDiffVocabulary(
		input.boardLastConfirmedPersistedByRuntime,
		input.boardAboutToBeSaved,
	)) {
		const record = pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.get(
			buildTaskCardAspectKey(
				mutation.taskId,
				resolveWebUiBoardMutationAspectOfTaskCardForAnnotatedKind(mutation.annotatedBoardMutationKind),
			),
		);
		if (!record || record.boardMutationInitiator === null) {
			continue;
		}
		annotations.push({ ...mutation, boardMutationInitiator: record.boardMutationInitiator });
	}
	return {
		boardMutationInitiatorAnnotationsForTaskMutationEventCapture: annotations,
		pendingInitiatorRecordSequenceCoveredBySaveStatePayload,
	};
}

export function discardWebUiBoardMutationInitiatorRecordsCoveredBySuccessfulSaveState(
	pendingInitiatorRecordSequenceCoveredBySaveStatePayload: number,
): void {
	for (const [key, record] of pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey) {
		if (record.pendingInitiatorRecordSequence <= pendingInitiatorRecordSequenceCoveredBySaveStatePayload) {
			pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.delete(key);
		}
	}
}

export function discardAllPendingWebUiBoardMutationInitiatorRecords(): void {
	pendingWebUiBoardMutationInitiatorRecordByTaskCardAspectKey.clear();
}
