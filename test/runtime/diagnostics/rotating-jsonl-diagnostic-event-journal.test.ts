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

	it("stamps every record with its own recording time, writer process and channel so lines stay self-describing", () => {
		// processId 不可省：多个 Kanban 实例共用同一组 journal 文件，没有它就无法按实例切分序列。
		const line = serializeDiagnosticEventJournalLine(
			"event-loop-delay-window-sample",
			{ p99Ms: 91.4, maxMs: 412.7 },
			"2026-08-16T04:05:06.007Z",
		);

		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line)).toEqual({
			recordedAtIso: "2026-08-16T04:05:06.007Z",
			processId: process.pid,
			channel: "event-loop-delay-window-sample",
			p99Ms: 91.4,
			maxMs: 412.7,
		});
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
		expect(parsed.processId).toBe(process.pid);
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
