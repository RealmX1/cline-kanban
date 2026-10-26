import * as fileSystemPromises from "node:fs/promises";
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCodexStatisticsVerifiedHistoryReadCache } from "../../../src/daily-work-progress-statistics/codex-statistics-verified-history-read-cache";
import { createDailyWorkProgressStatisticsService } from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-service";
import {
	createEmptyTaskUserPromptStatisticsCursor,
	readTaskUserPromptStatisticsTranscriptIncrement,
	taskUserPromptStatisticsCursorSchema,
} from "../../../src/daily-work-progress-statistics/task-user-prompt-statistics-transcript-reader";
import {
	createDailyWorkProgressCollectionCostRecorder,
	type DailyWorkProgressCollectionCostWindow,
} from "../../../src/diagnostics/daily-work-progress-collection-cost-recorder";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fileSystemPromises>();
	return { ...original, stat: vi.fn(original.stat), readdir: vi.fn(original.readdir) };
});

const nativeSessionId = "01a10000-0000-7000-8000-000000000000";
const resumedThreadId = "01a10001-0000-7000-8000-000000000000";
const lines = (records: object[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const metadata = (historyBase: unknown = null) => ({
	type: "session_meta",
	payload: { id: nativeSessionId, history_mode: "paginated", history_base: historyBase },
});
const prompt = (text: string, second = 0) => ({
	type: "event_msg",
	timestamp: new Date(1_000_000 + second * 1_000).toISOString(),
	payload: { type: "user_message", message: text },
});
async function createHistory(directory: string) {
	const sessionsDirectory = join(directory, "sessions");
	const leafDirectory = join(sessionsDirectory, "2026/10/20");
	await mkdir(leafDirectory, { recursive: true });
	const parentPath = join(leafDirectory, `rollout-parent-${nativeSessionId}.jsonl`);
	const parentText = lines([metadata(), prompt("父段")]);
	await writeFile(parentPath, parentText);
	const transcriptPath = join(leafDirectory, `rollout-current-${nativeSessionId}_${resumedThreadId}.jsonl`);
	await writeFile(
		transcriptPath,
		lines([
			metadata({
				thread_id: nativeSessionId,
				end_byte_offset: Buffer.byteLength(parentText),
				end_ordinal_exclusive: 2,
			}),
			prompt("子段", 60),
		]),
	);
	return { sessionsDirectory, leafDirectory, parentPath, parentText, transcriptPath };
}

it("追平后没有正文/前缀读取、目录枚举或统计写入；持久游标在新进程缓存中重新验证", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-codex-steady-cost-"));
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	const recorder = createDailyWorkProgressCollectionCostRecorder({ writeWindow: (window) => windows.push(window) });
	let service: ReturnType<typeof createDailyWorkProgressStatisticsService> | undefined;
	try {
		const history = await createHistory(directory);
		const source = {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: history.transcriptPath,
			programmaticSubmissionReceipts: [],
		};
		const cache = createCodexStatisticsVerifiedHistoryReadCache();
		let collectionCount = 0;
		service = createDailyWorkProgressStatisticsService({
			storageFilePath: join(directory, "statistics.json"),
			costRecorder: recorder,
			warn: () => {},
			collect: async (state) => {
				collectionCount++;
				const result = await readTaskUserPromptStatisticsTranscriptIncrement({
					...source,
					cursor: state.transcriptCursorsByIdentityKey.native ?? createEmptyTaskUserPromptStatisticsCursor(),
					codexHistoryReadCache: cache,
				});
				expect(result.warning).toBeNull();
				state.transcriptCursorsByIdentityKey.native = result.cursor;
				return { projects: [], liveFactEventIds: [], hasPendingHistoricalReads: !result.cursor.complete };
			},
		});
		const request = { workspaceId: null, dateKey: "2026-10-20", timeZone: "UTC" };
		await Promise.all([service.getSummary(request), service.getSummary(request), service.getSummary(request)]);
		expect(collectionCount).toBe(1);
		recorder.flush();
		for (let round = 0; round < 30; round++) await service.refresh();
		recorder.flush();
		const steady = windows[1];
		expect(steady?.stages.codex_prefix_validation?.readBytes ?? 0).toBe(0);
		expect(steady?.stages.transcript_body_read?.readBytes ?? 0).toBe(0);
		expect(steady?.counters.codex_directory_enumerations ?? 0).toBe(0);
		expect(steady?.counters.codex_directory_candidate_filter_entries ?? 0).toBe(0);
		expect(steady?.stages.statistics_write?.writeOperations ?? 0).toBe(0);
		let cursor = (
			await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor: createEmptyTaskUserPromptStatisticsCursor(),
				codexHistoryReadCache: cache,
			})
		).cursor;
		cursor = taskUserPromptStatisticsCursorSchema.parse(JSON.parse(JSON.stringify(cursor)));
		await recorder.run("refresh", async () => {
			const restarted = await readTaskUserPromptStatisticsTranscriptIncrement({
				...source,
				cursor,
				codexHistoryReadCache: createCodexStatisticsVerifiedHistoryReadCache(),
			});
			expect(restarted.cursor.complete).toBe(true);
			expect(restarted.submissions).toEqual([]);
		});
		recorder.flush();
		expect(windows[2]?.stages.codex_prefix_validation?.readBytes).toBeGreaterThan(0);
	} finally {
		await service?.close();
		recorder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("深层目录新增歧义父段不会被 sessions 根目录的稳定 mtime 隐藏，移除后自动恢复", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-codex-deep-directory-change-"));
	try {
		const history = await createHistory(directory);
		const cache = createCodexStatisticsVerifiedHistoryReadCache();
		const source = {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: history.transcriptPath,
			programmaticSubmissionReceipts: [],
			codexHistoryReadCache: cache,
		};
		const first = await readTaskUserPromptStatisticsTranscriptIncrement({
			...source,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
		});
		expect(first.cursor.complete).toBe(true);
		const rootModifiedBefore = (await stat(history.sessionsDirectory, { bigint: true })).mtimeNs;
		const duplicate = join(history.leafDirectory, `rollout-duplicate-${nativeSessionId}.jsonl`);
		await writeFile(duplicate, history.parentText);
		expect((await stat(history.sessionsDirectory, { bigint: true })).mtimeNs).toBe(rootModifiedBefore);
		const ambiguous = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: first.cursor });
		expect(ambiguous.warning).toMatch(/身份不唯一/u);
		expect(ambiguous.cursor.complete).toBe(false);
		await rm(duplicate);
		await rm(history.parentPath);
		const missing = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: ambiguous.cursor });
		expect(missing.warning).toMatch(/缺失/u);
		await writeFile(history.parentPath, history.parentText);
		const recovered = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: missing.cursor });
		expect(recovered.warning).toBeNull();
		expect(recovered.cursor.complete).toBe(true);
		expect(recovered.submissions).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("无关不可读子树不阻断完整历史，恢复后重新检查歧义，必要父段缺失仍拒绝统计", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-codex-unreadable-directory-"));
	let unreadableDirectory: string | undefined;
	try {
		const history = await createHistory(directory);
		unreadableDirectory = join(history.sessionsDirectory, "unrelated-unreadable-history");
		await mkdir(unreadableDirectory);
		const duplicateParentPath = join(unreadableDirectory, `rollout-duplicate-${nativeSessionId}.jsonl`);
		await writeFile(duplicateParentPath, history.parentText);
		await chmod(unreadableDirectory, 0o000);
		const source = {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: history.transcriptPath,
			programmaticSubmissionReceipts: [],
		};
		const withoutCache = await readTaskUserPromptStatisticsTranscriptIncrement({
			...source,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
		});
		expect(withoutCache.warning).toBeNull();
		expect(withoutCache.cursor.complete).toBe(true);
		expect(withoutCache.submissions).toHaveLength(2);
		const cachedSource = { ...source, codexHistoryReadCache: createCodexStatisticsVerifiedHistoryReadCache() };
		const withCache = await readTaskUserPromptStatisticsTranscriptIncrement({
			...cachedSource,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
		});
		expect(withCache.warning).toBeNull();
		expect(withCache.cursor.complete).toBe(true);
		expect(withCache.submissions).toEqual(withoutCache.submissions);
		await rm(history.parentPath);
		const missingParent = await readTaskUserPromptStatisticsTranscriptIncrement({
			...cachedSource,
			cursor: withCache.cursor,
		});
		expect(missingParent.warning).toMatch(/缺失/u);
		expect(missingParent.cursor.complete).toBe(false);
		expect(missingParent.submissions).toEqual([]);
		await writeFile(history.parentPath, history.parentText);
		await chmod(unreadableDirectory, 0o700);
		const restoredDirectory = await readTaskUserPromptStatisticsTranscriptIncrement({
			...cachedSource,
			cursor: missingParent.cursor,
		});
		expect(restoredDirectory.warning).toMatch(/身份不唯一/u);
		expect(restoredDirectory.cursor.complete).toBe(false);
		await rm(duplicateParentPath);
		const recovered = await readTaskUserPromptStatisticsTranscriptIncrement({
			...cachedSource,
			cursor: restoredDirectory.cursor,
		});
		expect(recovered.warning).toBeNull();
		expect(recovered.cursor.complete).toBe(true);
		expect(recovered.submissions).toEqual([]);
	} finally {
		if (unreadableDirectory) await chmod(unreadableDirectory, 0o700);
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(["stat", "readdir"] as const)("目录 %s 失败不复用旧清单，也不缓存失败，后续自动重验", async (operation) => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-codex-directory-failure-retry-"));
	try {
		const history = await createHistory(directory);
		const cache = createCodexStatisticsVerifiedHistoryReadCache();
		const expectedPaths = [history.parentPath, history.transcriptPath].sort();
		expect((await cache.listSegmentPaths(history.sessionsDirectory, nativeSessionId)).sort()).toEqual(expectedPaths);
		if (operation === "readdir") await writeFile(join(history.sessionsDirectory, "non-segment.txt"), "目录变化");
		const failedOperation =
			operation === "stat"
				? vi.spyOn(fileSystemPromises, "stat").mockRejectedValueOnce(new Error("模拟目录元信息读取失败"))
				: vi.spyOn(fileSystemPromises, "readdir").mockRejectedValueOnce(new Error("模拟目录枚举失败"));
		try {
			await expect(cache.listSegmentPaths(history.sessionsDirectory, nativeSessionId)).resolves.toEqual([]);
		} finally {
			failedOperation.mockRestore();
		}
		expect((await cache.listSegmentPaths(history.sessionsDirectory, nativeSessionId)).sort()).toEqual(expectedPaths);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("已验证缓存仍能检测替换、同尺寸重写、截断、malformed 转录和身份不匹配，并继续追加读取", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-codex-replacement-recovery-"));
	try {
		const transcriptPath = join(directory, `rollout-${nativeSessionId}.jsonl`);
		const original = lines([metadata(), prompt("原文")]);
		await writeFile(transcriptPath, original);
		const source = {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath,
			programmaticSubmissionReceipts: [],
			codexHistoryReadCache: createCodexStatisticsVerifiedHistoryReadCache(),
		};
		let result = await readTaskUserPromptStatisticsTranscriptIncrement({
			...source,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
		});
		expect(result.submissions).toHaveLength(1);
		await writeFile(transcriptPath, original.replace("原文", "重写"));
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.submissions).toHaveLength(1);
		await writeFile(`${transcriptPath}.replacement`, lines([metadata(), prompt("替换", 120)]));
		await rename(`${transcriptPath}.replacement`, transcriptPath);
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.submissions).toHaveLength(1);
		await writeFile(transcriptPath, lines([metadata()]));
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.cursor.complete).toBe(true);
		await appendFile(transcriptPath, "{无法解析\n");
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.warning).toMatch(/格式/u);
		await writeFile(transcriptPath, original.replace(nativeSessionId, resumedThreadId));
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.warning).not.toBeNull();
		expect(result.cursor.complete).toBe(false);
		await writeFile(transcriptPath, original);
		result = await readTaskUserPromptStatisticsTranscriptIncrement({
			...source,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
		});
		expect(result.warning).toBeNull();
		await appendFile(transcriptPath, lines([prompt("追加", 180)]));
		result = await readTaskUserPromptStatisticsTranscriptIncrement({ ...source, cursor: result.cursor });
		expect(result.warning).toBeNull();
		expect(result.submissions).toHaveLength(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
