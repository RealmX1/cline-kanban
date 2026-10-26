import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPendingTaskMessageInjectionRecord } from "../../../src/core/task-message-injection-ledger";
import { createProgrammaticPromptReceiptTimeIndex } from "../../../src/daily-work-progress-statistics/programmatic-prompt-receipt-time-index";
import { createProgrammaticPromptReceiptWorkspaceReadCache } from "../../../src/daily-work-progress-statistics/programmatic-prompt-receipt-workspace-read-cache";
import {
	createEmptyTaskUserPromptStatisticsCursor,
	foldTaskUserPromptStatisticsRecord,
	readTaskUserPromptStatisticsTranscriptIncrement,
} from "../../../src/daily-work-progress-statistics/task-user-prompt-statistics-transcript-reader";

it("工具、上下文、显式机器来源与分身记录不进入回执候选查询", () => {
	let candidateQueryCount = 0;
	const cursor = createEmptyTaskUserPromptStatisticsCursor();
	for (const record of [
		{ type: "response_item", timestamp: 1_000, payload: { type: "function_call_output", output: "工具" } },
		{ type: "event_msg", timestamp: 1_000, payload: { type: "user_message", message: "<environment_context>环境" } },
		{
			type: "event_msg",
			timestamp: 1_000,
			payload: { type: "user_message", message: "<kanban-programmatic>自动来源" },
		},
		{ type: "event_msg", timestamp: 1_000, payload: { type: "user_message", message: "真人输入" } },
		{ type: "session_meta", payload: { source: { subagent: "分身" } } },
		{ type: "event_msg", timestamp: 1_000, payload: { type: "user_message", message: "分身输入" } },
	])
		foldTaskUserPromptStatisticsRecord({
			sourceAgentId: "codex",
			record,
			serializedRecord: JSON.stringify(record),
			cursor,
			programmaticPromptSha256s: new Set(),
			matchesProgrammaticPromptSha256AtRecordTimestamp: () => {
				candidateQueryCount++;
				return false;
			},
		});
	expect(candidateQueryCount).toBe(1);
});

import {
	createDailyWorkProgressCollectionCostRecorder,
	type DailyWorkProgressCollectionCostWindow,
} from "../../../src/diagnostics/daily-work-progress-collection-cost-recorder";

it("时间索引与原窗口规则等价，包含边界、同文后续人工输入及无效时间", () => {
	const receipts = Array.from({ length: 10_000 }, (_, index) => ({
		promptSha256: String(index % 13),
		confirmedAtEpochMs: index % 17 === 0 ? Number.NaN : index * 97,
	}));
	const index = createProgrammaticPromptReceiptTimeIndex([...receipts].reverse());
	for (let sample = 0; sample < 1_000; sample++) {
		const hash = String(sample % 17);
		const timestamp = sample % 19 === 0 ? Number.NaN : sample * 997 - 5_000;
		expect(index.containsWithinTimestampWindow(hash, timestamp, 5_000)).toBe(
			receipts.some(
				(receipt) => receipt.promptSha256 === hash && Math.abs(receipt.confirmedAtEpochMs - timestamp) <= 5_000,
			),
		);
	}
	const boundary = createProgrammaticPromptReceiptTimeIndex([{ promptSha256: "same", confirmedAtEpochMs: 10_000 }]);
	expect(
		[4_999, 5_000, 15_000, 15_001, 60_000].map((timestamp) =>
			boundary.containsWithinTimestampWindow("same", timestamp, 5_000),
		),
	).toEqual([false, true, true, false, false]);
});

it.each(
	[1_000, 10_000].flatMap((recordCount) => [1_000, 10_000].map((receiptCount) => ({ recordCount, receiptCount }))),
)("$recordCount 条记录与 $receiptCount 条回执只对候选输入查询，复杂度不相乘", async ({ recordCount, receiptCount }) => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-receipt-complexity-"));
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	const recorder = createDailyWorkProgressCollectionCostRecorder({ writeWindow: (window) => windows.push(window) });
	try {
		const transcriptPath = join(directory, "claude.jsonl");
		const hash = createHash("sha256").update("相同正文").digest("hex");
		const receiptIndex = createProgrammaticPromptReceiptTimeIndex(
			Array.from({ length: receiptCount }, (_, index) => ({
				promptSha256: hash,
				confirmedAtEpochMs: index * 60_000,
			})),
		);
		await writeFile(
			transcriptPath,
			`${Array.from({ length: recordCount }, (_, index) =>
				JSON.stringify(
					index % 10 === 0
						? {
								type: "user",
								promptSource: "typed",
								uuid: String(index),
								timestamp: index * 60_000,
								message: { role: "user", content: "相同正文" },
							}
						: { type: "tool_result", timestamp: index * 60_000, output: "工具输出" },
				),
			).join("\n")}\n`,
		);
		let cursor = createEmptyTaskUserPromptStatisticsCursor();
		await recorder.run("refresh", async () => {
			for (let round = 0; round < 20 && !cursor.complete; round++) {
				const result = await readTaskUserPromptStatisticsTranscriptIncrement({
					transcriptPath,
					nativeSessionId: "native",
					sourceAgentId: "claude",
					cursor,
					programmaticSubmissionReceipts: [],
					programmaticReceiptTimeIndex: receiptIndex,
				});
				expect(result.warning).toBeNull();
				cursor = result.cursor;
			}
		});
		expect(cursor.complete).toBe(true);
		recorder.close();
		expect(windows[0]?.counters.receipt_candidate_queries).toBe(recordCount / 10);
		expect(windows[0]?.counters.receipt_comparisons).toBeLessThanOrEqual(
			(recordCount / 10) * Math.ceil(Math.log2(receiptCount + 1)),
		);
	} finally {
		recorder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("回执缓存保持任务及实际目标归属，原子替换、坏文件与恢复均重新核验", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-receipt-recovery-"));
	try {
		const path = join(directory, "receipts.json");
		const record = {
			...createPendingTaskMessageInjectionRecord({
				taskId: "owner",
				attemptId: "peer-main",
				source: "test",
				idempotencyKey: "same",
				promptSha256: "hash",
				nowIso: new Date(10_000).toISOString(),
			}),
			terminal_delivery_status: "delivered_and_submit_confirmed" as const,
		};
		await writeFile(
			path,
			JSON.stringify([
				record,
				{ ...record, attempt_id: "failed-peer", terminal_delivery_status: "delivery_failed" },
			]),
		);
		const cache = createProgrammaticPromptReceiptWorkspaceReadCache();
		const first = await cache.read(path);
		expect(cache.find(first, "owner", "peer-main")?.containsWithinTimestampWindow("hash", 10_000, 5_000)).toBe(true);
		expect(cache.find(first, "other-owner", "peer-main")).toBeUndefined();
		expect(cache.find(first, "owner", "failed-peer")).toBeUndefined();
		expect(await cache.read(path)).toBe(first);
		const original = await readFile(path, "utf8");
		await writeFile(`${path}.replacement`, original.replaceAll("peer-main", "peer-next"));
		await rename(`${path}.replacement`, path);
		const replaced = await cache.read(path);
		expect(cache.find(replaced, "owner", "peer-main")).toBeUndefined();
		expect(cache.find(replaced, "owner", "peer-next")).toBeDefined();
		await writeFile(path, "{损坏");
		await expect(cache.read(path)).rejects.toThrow();
		await writeFile(path, original);
		expect(cache.find(await cache.read(path), "owner", "peer-main")).toBeDefined();
		await rm(path);
		expect(cache.find(await cache.read(path), "owner", "peer-main")).toBeUndefined();
		await writeFile(path, original);
		expect(cache.find(await cache.read(path), "owner", "peer-main")).toBeDefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
