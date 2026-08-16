import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	appendDiagnosticEventToRotatingJsonlJournal,
	DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
	getDiagnosticEventJournalActiveFilePath,
	getDiagnosticEventJournalDirectoryPath,
	serializeDiagnosticEventJournalLine,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal";
import { createTempDir } from "../../utilities/temp-dir";

const originalJournalRootDir = process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR];

describe("rotating JSONL diagnostic event journal", () => {
	let tempDir: { path: string; cleanup: () => void };

	beforeEach(() => {
		tempDir = createTempDir("kanban-diagnostic-event-journal-");
		process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = tempDir.path;
	});

	afterEach(async () => {
		await waitForPendingDiagnosticEventJournalWrites();
		if (originalJournalRootDir === undefined) {
			delete process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR];
		} else {
			process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = originalJournalRootDir;
		}
		tempDir.cleanup();
	});

	it("stamps every record with its recording time, channel and writer process so lines stay self-describing", () => {
		// 多个 Kanban 实例共写同一组 journal 文件，缺了写入方标识就无法把样本拆回单进程视角。
		const line = serializeDiagnosticEventJournalLine(
			"event-loop-delay-window-sample",
			{ p99Ms: 91.4, maxMs: 412.7 },
			"2026-08-16T04:05:06.007Z",
		);
		const parsed = JSON.parse(line) as Record<string, unknown>;

		expect(line.endsWith("\n")).toBe(true);
		expect(parsed.recordedAtIso).toBe("2026-08-16T04:05:06.007Z");
		expect(parsed.channel).toBe("event-loop-delay-window-sample");
		expect(parsed.journalWriterProcessId).toBe(process.pid);
		// pid 会被系统回收复用，而 journal 可跨越数十天：必须配上启动时刻才是唯一键。
		expect(typeof parsed.journalWriterProcessStartedAtIso).toBe("string");
		expect(Number.isNaN(Date.parse(parsed.journalWriterProcessStartedAtIso as string))).toBe(false);
		expect(parsed.p99Ms).toBe(91.4);
		expect(parsed.maxMs).toBe(412.7);
	});

	it("keeps its authoritative fields even when a payload smuggles the same keys past the type guard", () => {
		// `processId?: never` 之类的类型约束挡不住声明为 Record<string, unknown> 的变量——TS 不会拿
		// 索引签名去比对可选属性，编译期一个错都不报。所以运行时必须再夺回一次所有权。
		const payloadSmugglingReservedKeys: Record<string, unknown> = {
			journalWriterProcessId: 999_999,
			journalWriterProcessStartedAtIso: "1999-01-01T00:00:00.000Z",
			channel: "git-command-failure",
			recordedAtIso: "1999-01-01T00:00:00.000Z",
			taskId: "w0n47",
		};

		const line = serializeDiagnosticEventJournalLine(
			"event-loop-delay-window-sample",
			payloadSmugglingReservedKeys,
			"2026-08-16T04:05:06.007Z",
		);
		const parsed = JSON.parse(line) as Record<string, unknown>;

		expect(parsed.journalWriterProcessId).toBe(process.pid);
		expect(parsed.channel).toBe("event-loop-delay-window-sample");
		expect(parsed.recordedAtIso).toBe("2026-08-16T04:05:06.007Z");
		expect(parsed.journalWriterProcessStartedAtIso).not.toBe("1999-01-01T00:00:00.000Z");
		// 非保留键照常保留。
		expect(parsed.taskId).toBe("w0n47");
	});

	it("degrades an unserializable payload into a self-explaining record instead of dropping the event", () => {
		const circularPayload: Record<string, unknown> = { taskId: "w0n47" };
		circularPayload.self = circularPayload;

		const line = serializeDiagnosticEventJournalLine(
			"git-command-failure",
			circularPayload,
			"2026-08-16T04:05:06.007Z",
		);
		const parsed = JSON.parse(line) as Record<string, unknown>;

		expect(parsed.channel).toBe("git-command-failure");
		expect(parsed.recordedAtIso).toBe("2026-08-16T04:05:06.007Z");
		expect(parsed.journalWriterProcessId).toBe(process.pid);
		expect(typeof parsed.journalWriterProcessStartedAtIso).toBe("string");
		expect(typeof parsed.journalPayloadSerializationError).toBe("string");
	});

	it("appends one parseable JSON object per line, in call order", async () => {
		for (let sampleIndex = 0; sampleIndex < 5; sampleIndex++) {
			appendDiagnosticEventToRotatingJsonlJournal("event-loop-delay-window-sample", { sampleIndex });
		}
		await waitForPendingDiagnosticEventJournalWrites();

		const activeFilePath = getDiagnosticEventJournalActiveFilePath("event-loop-delay-window-sample");
		const lines = readFileSync(activeFilePath, "utf8").trimEnd().split("\n");

		expect(lines).toHaveLength(5);
		expect(lines.map((line) => (JSON.parse(line) as { sampleIndex: number }).sampleIndex)).toEqual([0, 1, 2, 3, 4]);
	});

	it("rotates the active file once it is over the size cap and keeps the rotated generation readable", async () => {
		const journalDirectoryPath = getDiagnosticEventJournalDirectoryPath();
		const activeFilePath = getDiagnosticEventJournalActiveFilePath("git-command-failure");
		// 直接把活动文件预填到超过 8 MiB 上限，避免为了触发轮转而真写几百万行。
		writeFileSync(activeFilePath, `${"x".repeat(9 * 1024 * 1024)}\n`, "utf8");

		appendDiagnosticEventToRotatingJsonlJournal("git-command-failure", { exitCode: -1, errorCode: "EBADF" });
		await waitForPendingDiagnosticEventJournalWrites();

		const rotatedFilePath = join(journalDirectoryPath, "git-command-failure.1.jsonl");
		expect(readdirSync(journalDirectoryPath)).toContain("git-command-failure.1.jsonl");
		expect(readFileSync(rotatedFilePath, "utf8").startsWith("xxx")).toBe(true);

		const activeLines = readFileSync(activeFilePath, "utf8").trimEnd().split("\n");
		expect(activeLines).toHaveLength(1);
		expect((JSON.parse(activeLines[0]) as { errorCode: string }).errorCode).toBe("EBADF");
	});
});
