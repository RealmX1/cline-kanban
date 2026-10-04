// 离线读取诊断 journal：按「最旧分片 → 活动文件」顺序读出某通道在时间窗内的全部记录。
// 供 `kanban diagnostics` 报告使用，不依赖运行时在线。只读，绝不写 journal。

import { readFileSync } from "node:fs";
import {
	type DiagnosticEventJournalChannel,
	listExistingDiagnosticEventJournalShardFilePathsOldestFirst,
} from "./rotating-jsonl-diagnostic-event-journal";

export type DiagnosticEventJournalRecord = Record<string, unknown> & { recordedAtIso?: unknown };

export function parseDiagnosticEventJournalRecordsFromJsonlText(
	jsonlText: string,
	recordedAtOrAfterEpochMs: number | null,
): DiagnosticEventJournalRecord[] {
	const records: DiagnosticEventJournalRecord[] = [];
	for (const line of jsonlText.split("\n")) {
		if (line.trim().length === 0) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 轮转瞬间或写到一半的尾行：跳过。
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			continue;
		}
		const record = parsed as DiagnosticEventJournalRecord;
		if (recordedAtOrAfterEpochMs !== null) {
			const recordedAtEpochMs =
				typeof record.recordedAtIso === "string" ? Date.parse(record.recordedAtIso) : Number.NaN;
			if (!Number.isFinite(recordedAtEpochMs) || recordedAtEpochMs < recordedAtOrAfterEpochMs) {
				continue;
			}
		}
		records.push(record);
	}
	return records;
}

export function readDiagnosticEventJournalRecords(
	channel: DiagnosticEventJournalChannel,
	recordedAtOrAfterEpochMs: number | null,
): DiagnosticEventJournalRecord[] {
	const records: DiagnosticEventJournalRecord[] = [];
	for (const shardFilePath of listExistingDiagnosticEventJournalShardFilePathsOldestFirst(channel)) {
		let shardText: string;
		try {
			shardText = readFileSync(shardFilePath, "utf8");
		} catch {
			// 读取途中被轮转改名：丢的只是边界上的几行。
			continue;
		}
		records.push(...parseDiagnosticEventJournalRecordsFromJsonlText(shardText, recordedAtOrAfterEpochMs));
	}
	return records;
}
