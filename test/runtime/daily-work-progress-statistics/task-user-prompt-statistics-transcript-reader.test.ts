import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createEmptyTaskUserPromptStatisticsCursor,
	foldTaskUserPromptStatisticsRecord,
	readTaskUserPromptStatisticsTranscriptIncrement,
	taskUserPromptStatisticsCursorSchema,
} from "../../../src/daily-work-progress-statistics/task-user-prompt-statistics-transcript-reader";

function record(kind: "event_msg" | "response_item", text: string, timestamp = "2026-10-23T12:00:00Z") {
	return {
		type: kind,
		timestamp,
		payload:
			kind === "event_msg"
				? { type: "user_message", message: text }
				: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	};
}
function fold(records: Record<string, unknown>[], sourceAgentId = "codex") {
	const cursor = createEmptyTaskUserPromptStatisticsCursor();
	return records.flatMap((record) => {
		const result = foldTaskUserPromptStatisticsRecord({
			sourceAgentId,
			record,
			serializedRecord: JSON.stringify(record),
			cursor,
			programmaticPromptSha256s: new Set(),
		});
		return result ? [result] : [];
	});
}
const segmentedNativeSessionId = "01a14b40-0000-7000-8000-000000000000";
const resumedRolloutThreadId = "01a14ba0-0000-7000-8000-000000000000";
function codexSegmentMetadata(historyBase: unknown = null, nativeSessionId = segmentedNativeSessionId) {
	return {
		type: "session_meta",
		timestamp: "2026-10-23T12:00:00Z",
		payload: { id: nativeSessionId, history_mode: "paginated", history_base: historyBase },
	};
}
function transcriptJsonLines(records: Record<string, unknown>[]) {
	return `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
describe("人工 prompt 统计的原生证据", () => {
	it("旧持久游标自动补齐分段字段", () => {
		const parsed = taskUserPromptStatisticsCursorSchema.parse({
			nextByteOffset: 0,
			fileIdentity: null,
			rejectedDescendantSession: false,
			complete: false,
			firstPromptAtEpochMs: null,
			pendingCodexRepresentation: null,
		});
		expect(parsed.codexHistorySegmentCursorsByTranscriptPath).toEqual({});
		expect(parsed.codexHistoryConfirmedSubmissionIds).toEqual([]);
	});
	it("大父分段跨批次及进程重启续读，验证前不发布，跨段双表示仍只计一次", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-history-budget-"));
		try {
			const records = [
				codexSegmentMetadata(),
				record("event_msg", "不应持久化的人工正文"),
				...Array.from({ length: 12 }, () => ({
					type: "response_item",
					payload: { type: "function_call_output", output: "大".repeat(16_000) },
				})),
			];
			const prefix = transcriptJsonLines(records);
			await writeFile(join(directory, `rollout-old-${segmentedNativeSessionId}.jsonl`), prefix);
			const transcriptPath = join(
				directory,
				`rollout-current-${segmentedNativeSessionId}_${resumedRolloutThreadId}.jsonl`,
			);
			await writeFile(
				transcriptPath,
				transcriptJsonLines([
					codexSegmentMetadata({
						thread_id: segmentedNativeSessionId,
						end_ordinal_exclusive: records.length,
						end_byte_offset: Buffer.byteLength(prefix),
					}),
					record("response_item", "不应持久化的人工正文"),
					record("event_msg", "后续人工提交", "2026-10-23T12:01:00Z"),
				]),
			);
			const source = {
				sourceAgentId: "codex",
				nativeSessionId: segmentedNativeSessionId,
				transcriptPath,
				programmaticSubmissionReceipts: [],
			};
			const first = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(first.warning).toBeNull();
			expect(first.cursor.complete).toBe(false);
			expect(first.submissions).toEqual([]);
			expect(JSON.stringify(first.cursor)).not.toContain("不应持久化的人工正文");
			let cursor = first.cursor;
			const submissions = [...first.submissions];
			for (let batch = 0; batch < 10 && !cursor.complete; batch += 1) {
				const result = await readTaskUserPromptStatisticsTranscriptIncrement({
					...source,
					cursor: taskUserPromptStatisticsCursorSchema.parse(JSON.parse(JSON.stringify(cursor))),
				});
				expect(result.warning).toBeNull();
				submissions.push(...result.submissions);
				cursor = result.cursor;
			}
			expect(cursor.complete).toBe(true);
			expect(submissions).toHaveLength(2);
			expect(new Set(submissions.map((submission) => submission.submissionId)).size).toBe(2);
			const unchanged = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor });
			expect(unchanged.submissions).toEqual([]);
			await appendFile(
				transcriptPath,
				transcriptJsonLines([record("event_msg", "追加提交", "2026-10-23T12:02:00Z")]),
			);
			const appended = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: unchanged.cursor,
			});
			expect(appended.warning).toBeNull();
			expect(appended.submissions).toHaveLength(1);
			expect(appended.cursor.complete).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("缺父分段时保留覆盖不足，父段恢复后自动追赶且不重计", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-history-recovery-"));
		try {
			const prefix = transcriptJsonLines([codexSegmentMetadata(), record("event_msg", "父段提交")]);
			const transcriptPath = join(
				directory,
				`rollout-current-${segmentedNativeSessionId}_${resumedRolloutThreadId}.jsonl`,
			);
			await writeFile(
				transcriptPath,
				transcriptJsonLines([
					codexSegmentMetadata({
						thread_id: segmentedNativeSessionId,
						end_ordinal_exclusive: 2,
						end_byte_offset: Buffer.byteLength(prefix),
					}),
					record("event_msg", "当前提交", "2026-10-23T12:01:00Z"),
				]),
			);
			const source = {
				sourceAgentId: "codex",
				nativeSessionId: segmentedNativeSessionId,
				transcriptPath,
				programmaticSubmissionReceipts: [],
			};
			const missing = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(missing.warning).toContain("父分段缺失");
			expect(missing.cursor.complete).toBe(false);
			expect(missing.submissions).toEqual([]);
			await writeFile(join(directory, `rollout-old-${segmentedNativeSessionId}.jsonl`), prefix);
			const recovered = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: taskUserPromptStatisticsCursorSchema.parse(JSON.parse(JSON.stringify(missing.cursor))),
			});
			expect(recovered.warning).toBeNull();
			expect(recovered.cursor.complete).toBe(true);
			expect(recovered.submissions).toHaveLength(2);
			const repeated = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: recovered.cursor,
			});
			expect(repeated.submissions).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("当前段中出现其他会话的记录时回退本批游标，纠正后可恢复", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-history-record-identity-"));
		try {
			const prefix = transcriptJsonLines([codexSegmentMetadata(), record("event_msg", "父段提交")]);
			await writeFile(join(directory, `rollout-old-${segmentedNativeSessionId}.jsonl`), prefix);
			const transcriptPath = join(
				directory,
				`rollout-current-${segmentedNativeSessionId}_${resumedRolloutThreadId}.jsonl`,
			);
			const metadata = codexSegmentMetadata({
				thread_id: segmentedNativeSessionId,
				end_ordinal_exclusive: 2,
				end_byte_offset: Buffer.byteLength(prefix),
			});
			await writeFile(
				transcriptPath,
				transcriptJsonLines([
					metadata,
					{ ...record("event_msg", "错误归属的提交"), sessionId: "other-native-session" },
				]),
			);
			const source = {
				sourceAgentId: "codex",
				nativeSessionId: segmentedNativeSessionId,
				transcriptPath,
				programmaticSubmissionReceipts: [],
			};
			const mismatched = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(mismatched.warning).toBe("原生会话身份与转录不匹配");
			expect(mismatched.cursor.complete).toBe(false);
			expect(mismatched.submissions).toHaveLength(1);
			await writeFile(
				transcriptPath,
				transcriptJsonLines([metadata, record("event_msg", "归属纠正后的提交", "2026-10-23T12:01:00Z")]),
			);
			const recovered = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: taskUserPromptStatisticsCursorSchema.parse(JSON.parse(JSON.stringify(mismatched.cursor))),
			});
			expect(recovered.warning).toBeNull();
			expect(recovered.cursor.complete).toBe(true);
			expect(recovered.submissions).toHaveLength(1);
			expect(recovered.submissions[0]?.submittedAtEpochMs).toBe(Date.parse("2026-10-23T12:01:00Z"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it.each([
		"different_native_identity",
		"ambiguous_parent",
		"corrupted_prefix",
		"incorrect_ordinal",
		"partial_record_boundary",
		"cyclic_parent",
	] as const)("父分段 %s 时不把未验证历史当作人工提交", async (scenario) => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-history-invalid-"));
		try {
			const prefix = transcriptJsonLines([
				codexSegmentMetadata(
					scenario === "cyclic_parent"
						? { thread_id: resumedRolloutThreadId, end_ordinal_exclusive: 2, end_byte_offset: 1 }
						: null,
					scenario === "different_native_identity"
						? "01a14b40-9999-7000-8000-000000000000"
						: segmentedNativeSessionId,
				),
				record("event_msg", "不可采信的父段提交"),
			]);
			const parentText = scenario === "corrupted_prefix" ? `${prefix}损坏记录\n` : prefix;
			await writeFile(join(directory, `rollout-old-${segmentedNativeSessionId}.jsonl`), parentText);
			if (scenario === "ambiguous_parent")
				await writeFile(join(directory, `rollout-duplicate-${segmentedNativeSessionId}.jsonl`), prefix);
			const transcriptPath = join(
				directory,
				`rollout-current-${segmentedNativeSessionId}_${resumedRolloutThreadId}.jsonl`,
			);
			await writeFile(
				transcriptPath,
				transcriptJsonLines([
					codexSegmentMetadata({
						thread_id: segmentedNativeSessionId,
						end_ordinal_exclusive: scenario === "incorrect_ordinal" ? 3 : 2,
						end_byte_offset: Buffer.byteLength(parentText) - (scenario === "partial_record_boundary" ? 1 : 0),
					}),
					record("event_msg", "当前提交"),
				]),
			);
			const source = {
				sourceAgentId: "codex",
				nativeSessionId: segmentedNativeSessionId,
				transcriptPath,
				programmaticSubmissionReceipts: [],
			};
			let result = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			for (let batch = 0; batch < 3 && !result.warning; batch += 1)
				result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
			expect(result.warning).not.toBeNull();
			expect(result.cursor.complete).toBe(false);
			expect(result.submissions).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("按明确父分段累计还原多段历史，排除旁支和父段边界后的输入", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-history-segments-"));
		try {
			const sessionsDirectory = join(directory, "sessions");
			await mkdir(sessionsDirectory);
			const inheritedPrompt = record("event_msg", "最早提交");
			const oldestPrefix = transcriptJsonLines([codexSegmentMetadata(), inheritedPrompt]);
			await writeFile(
				join(sessionsDirectory, `rollout-old-${segmentedNativeSessionId}.jsonl`),
				oldestPrefix + transcriptJsonLines([record("event_msg", "未选中的分叉尾部")]),
			);
			const middlePrefix = transcriptJsonLines([
				codexSegmentMetadata({
					thread_id: segmentedNativeSessionId,
					end_ordinal_exclusive: 2,
					end_byte_offset: Buffer.byteLength(oldestPrefix),
				}),
				record("event_msg", "中间提交", "2026-10-23T12:01:00Z"),
			]);
			await writeFile(
				join(sessionsDirectory, `rollout-middle-${segmentedNativeSessionId}_${resumedRolloutThreadId}.jsonl`),
				middlePrefix,
			);
			await writeFile(
				join(
					sessionsDirectory,
					`rollout-sibling-${segmentedNativeSessionId}_01a14bca-0000-7000-8000-000000000000.jsonl`,
				),
				transcriptJsonLines([codexSegmentMetadata(), record("event_msg", "旁支输入")]),
			);
			const transcriptPath = join(
				sessionsDirectory,
				`rollout-current-${segmentedNativeSessionId}_01a14bea-0000-7000-8000-000000000000.jsonl`,
			);
			await writeFile(
				transcriptPath,
				transcriptJsonLines([
					codexSegmentMetadata({
						thread_id: resumedRolloutThreadId,
						end_ordinal_exclusive: 4,
						end_byte_offset: Buffer.byteLength(middlePrefix),
					}),
					inheritedPrompt,
					record("event_msg", "当前提交", "2026-10-23T12:02:00Z"),
				]),
			);
			const source = {
				transcriptPath,
				nativeSessionId: segmentedNativeSessionId,
				sourceAgentId: "codex",
				programmaticSubmissionReceipts: [],
			};
			const first = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(first.warning).toBeNull();
			expect(first.cursor.complete).toBe(true);
			expect(first.submissions.map((submission) => submission.submittedAtEpochMs)).toEqual([
				Date.parse("2026-10-23T12:00:00Z"),
				Date.parse("2026-10-23T12:01:00Z"),
				Date.parse("2026-10-23T12:02:00Z"),
			]);
			const restarted = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: taskUserPromptStatisticsCursorSchema.parse(JSON.parse(JSON.stringify(first.cursor))),
			});
			expect(restarted.submissions).toEqual([]);
			expect(restarted.cursor.complete).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("Codex 同一次提交的两种转录表示只计一次，重复正文的新提交分别计数", () => {
		const records = [
			record("event_msg", "继续"),
			record("response_item", "继续"),
			record("event_msg", "继续", "2026-10-23T12:01:00Z"),
			record("response_item", "继续", "2026-10-23T12:01:00Z"),
		];
		expect(fold(records)).toHaveLength(2);
	});
	it("反向到达的双表示同样只计一次，单表示连续输入保留", () => {
		expect(fold([record("response_item", "执行"), record("event_msg", "执行")])).toHaveLength(1);
		expect(fold([record("event_msg", "执行"), record("event_msg", "执行", "2026-10-23T12:00:01Z")])).toHaveLength(2);
	});
	it("过滤上下文、自动通知、工具结果以及无时间证据的记录", () => {
		expect(
			fold([
				record("response_item", "<environment_context>上下文</environment_context>"),
				record("event_msg", "<task-notification>完成</task-notification>"),
				{ type: "response_item", payload: { type: "function_call_output", output: "工具结果" } },
				{ type: "event_msg", payload: { type: "user_message", message: "缺时间" } },
			]),
		).toHaveLength(0);
	});
	it("fork 继承的相同原生记录保持同一个提交标识", () => {
		const inherited = record("event_msg", "原始输入");
		expect(fold([inherited])[0]?.submissionId).toBe(fold([inherited])[0]?.submissionId);
	});
	it("新 native identity 的 fork 副本保留原提交身份，外部父段不作为本会话的新输入", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-codex-fork-history-"));
		try {
			const inherited = record("event_msg", "原始人工提交");
			const originalPath = join(directory, `rollout-original-${segmentedNativeSessionId}.jsonl`);
			const originalText = transcriptJsonLines([codexSegmentMetadata(), inherited]);
			await writeFile(originalPath, originalText);
			const forkNativeSessionId = "01a14b40-9999-7000-8000-000000000000";
			const forkPath = join(directory, `rollout-fork-${forkNativeSessionId}.jsonl`);
			await writeFile(
				forkPath,
				transcriptJsonLines([
					codexSegmentMetadata(null, forkNativeSessionId),
					inherited,
					record("event_msg", "fork 后真人新提交", "2026-10-23T12:01:00Z"),
				]),
			);
			const source = { sourceAgentId: "codex", programmaticSubmissionReceipts: [] };
			const original = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				nativeSessionId: segmentedNativeSessionId,
				transcriptPath: originalPath,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			const fork = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				nativeSessionId: forkNativeSessionId,
				transcriptPath: forkPath,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(
				new Set([...original.submissions, ...fork.submissions].map((submission) => submission.submissionId)).size,
			).toBe(2);
			await writeFile(
				forkPath,
				transcriptJsonLines([
					codexSegmentMetadata(
						{
							thread_id: segmentedNativeSessionId,
							end_ordinal_exclusive: 2,
							end_byte_offset: Buffer.byteLength(originalText),
						},
						forkNativeSessionId,
					),
					record("event_msg", "fork 当前输入"),
				]),
			);
			const externalParent = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				nativeSessionId: forkNativeSessionId,
				transcriptPath: forkPath,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(externalParent.cursor.complete).toBe(false);
			expect(externalParent.warning).not.toBeNull();
			expect(externalParent.submissions).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("OMP 的自动注入不计入人工输入", () => {
		const human = {
			type: "message",
			timestamp: "2026-10-23T12:00:00Z",
			id: "human",
			message: { role: "user", content: [{ type: "text", text: "实现" }], attribution: "user" },
		};
		expect(
			fold([human, { ...human, id: "automatic", message: { ...human.message, attribution: "agent" } }], "omp"),
		).toHaveLength(1);
	});
	it("跨批次双表示去重，坏转录的历史缺口不会在下次空读时消失", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-transcript-reader-"));
		try {
			const transcriptPath = join(directory, "native-session.jsonl");
			await writeFile(transcriptPath, `${JSON.stringify(record("event_msg", "继续"))}\n`);
			const source = {
				transcriptPath,
				nativeSessionId: "native-session",
				sourceAgentId: "codex",
				programmaticSubmissionReceipts: [],
			};
			const first = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
			});
			expect(first.submissions).toHaveLength(1);
			await appendFile(transcriptPath, `${JSON.stringify(record("response_item", "继续"))}\n`);
			const duplicate = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: first.cursor });
			expect(duplicate.submissions).toEqual([]);
			expect(duplicate.cursor.nextByteOffset).toBeGreaterThan(first.cursor.nextByteOffset);
			await appendFile(transcriptPath, "不是合法的 JSON 记录\n");
			const broken = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: duplicate.cursor });
			expect(broken.warning).toBe("部分转录记录格式无法识别");
			const repeated = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: broken.cursor });
			expect(repeated.warning).toBe(broken.warning);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("程序化提交的同文真人输入在稍后提交时仍计数", async () => {
		const directory = await mkdtemp(join(tmpdir(), "work-progress-programmatic-submission-"));
		try {
			const transcriptPath = join(directory, "native-session.jsonl");
			const firstAt = Date.parse("2026-10-23T12:00:00Z");
			await writeFile(
				transcriptPath,
				`${[record("event_msg", "继续"), record("event_msg", "继续", "2026-10-23T12:01:00Z")].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
			const result = await readTaskUserPromptStatisticsTranscriptIncrement({
				transcriptPath,
				nativeSessionId: "native-session",
				sourceAgentId: "codex",
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
				programmaticSubmissionReceipts: [
					{ promptSha256: createHash("sha256").update("继续").digest("hex"), confirmedAtEpochMs: firstAt },
				],
			});
			expect(result.submissions).toHaveLength(1);
			expect(result.submissions[0]?.submittedAtEpochMs).toBe(firstAt + 60_000);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
