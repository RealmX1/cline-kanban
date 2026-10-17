import type * as filesystemPromises from "node:fs/promises";
import {
	appendFile,
	mkdir,
	mkdtemp,
	open,
	readdir,
	rename,
	rm,
	stat,
	truncate,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexUserQuestionPendingAndHistoryFileChangeCache } from "../../../src/agent-session-history/codex-user-question-pending-and-history-file-change-cache";
import { recoverCodexUserQuestionsFromKnownConversation } from "../../../src/agent-session-history/codex-user-question-transcript-recovery";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystemPromises>();
	return { ...original, open: vi.fn(original.open), readdir: vi.fn(original.readdir) };
});

const sessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
const metadata = (timestamp = "2026-10-17T03:00:00.000Z", historyBase: unknown = null, nativeSessionId = sessionId) =>
	JSON.stringify({
		type: "session_meta",
		timestamp,
		payload: { id: nativeSessionId, timestamp, history_mode: "paginated", history_base: historyBase },
	});
const question = (callId = "call-old") =>
	JSON.stringify({
		type: "response_item",
		timestamp: "2026-10-17T03:01:00.000Z",
		payload: {
			type: "function_call",
			name: "request_user_input",
			call_id: callId,
			arguments: JSON.stringify({
				questions: [{ id: "choice", header: "选择", question: "请选择", options: [{ label: "继续" }] }],
			}),
		},
	});
const answer = JSON.stringify({
	type: "response_item",
	timestamp: "2026-10-17T03:02:00.000Z",
	payload: {
		type: "function_call_output",
		call_id: "call-old",
		output: JSON.stringify({ answers: { choice: { answers: ["继续"] } } }),
	},
});
const originalQuestionLine = question();
const originalTranscript = `${metadata()}\n${originalQuestionLine}\n`;
const isolatedCodexHomes: string[] = [];
async function createIsolatedTranscript() {
	const homeDirectoryPath = await mkdtemp(join(tmpdir(), "codex-question-query-cache-"));
	isolatedCodexHomes.push(homeDirectoryPath);
	const sessionDirectoryPath = join(homeDirectoryPath, "sessions", "2026", "10", "17");
	await mkdir(sessionDirectoryPath, { recursive: true });
	const transcriptPath = join(sessionDirectoryPath, `rollout-parent-${sessionId}.jsonl`);
	await writeFile(transcriptPath, originalTranscript);
	return { homeDirectoryPath, sessionDirectoryPath, transcriptPath, sessionId };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(isolatedCodexHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex pending/history 转录查询的文件变化缓存", () => {
	it("基线：原始恢复入口的重复查询每次都枚举、读取和重放相同问题", async () => {
		const input = await createIsolatedTranscript();
		const parseSpy = vi.spyOn(JSON, "parse");
		expect((await recoverCodexUserQuestionsFromKnownConversation(input)).exchanges).toHaveLength(1);
		const firstEnumerationCount = vi.mocked(readdir).mock.calls.length;
		const firstReadCount = vi.mocked(open).mock.calls.length;
		const firstQuestionProjectionParseCount = parseSpy.mock.calls.filter(
			([line]) => line === originalQuestionLine,
		).length;
		await recoverCodexUserQuestionsFromKnownConversation(input);
		expect(firstEnumerationCount).toBeGreaterThan(0);
		expect(firstReadCount).toBeGreaterThan(0);
		expect(firstQuestionProjectionParseCount).toBeGreaterThan(0);
		expect(vi.mocked(readdir).mock.calls.length).toBe(firstEnumerationCount * 2);
		expect(vi.mocked(open).mock.calls.length).toBe(firstReadCount * 2);
		expect(parseSpy.mock.calls.filter(([line]) => line === originalQuestionLine)).toHaveLength(
			firstQuestionProjectionParseCount * 2,
		);
	});

	it("同时的 pending/history 查询单飞，后续无变化查询不枚举、不读取也不重放 JSON", async () => {
		const input = await createIsolatedTranscript();
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		const parseSpy = vi.spyOn(JSON, "parse");
		const pendingQuery = recoverForQuery(input);
		const historyQuery = recoverForQuery(input);
		expect(pendingQuery).toBe(historyQuery);
		const [pending, history] = await Promise.all([pendingQuery, historyQuery]);
		expect(pending.exchanges).toHaveLength(1);
		expect(history).toBe(pending);
		const firstProjectionParseCount = parseSpy.mock.calls.filter(([line]) => line === originalQuestionLine).length;
		expect(firstProjectionParseCount).toBeGreaterThan(0);
		vi.mocked(open).mockClear();
		vi.mocked(readdir).mockClear();
		expect(await recoverForQuery(input)).toBe(pending);
		expect(vi.mocked(open)).not.toHaveBeenCalled();
		expect(vi.mocked(readdir)).not.toHaveBeenCalled();
		expect(parseSpy.mock.calls.filter(([line]) => line === originalQuestionLine)).toHaveLength(
			firstProjectionParseCount,
		);
	});

	it.each([
		"append_answer",
		"append_successor",
		"truncate",
		"rewrite_same_size_and_mtime",
		"replace_same_size_and_mtime",
		"native_identity",
	] as const)("同文件 %s 后立即失效，读取最新原生问答", async (mutation) => {
		const input = await createIsolatedTranscript();
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		expect((await recoverForQuery(input)).exchanges[0]?.callId).toBe("call-old");
		const originalIdentity = await stat(input.transcriptPath);
		if (mutation === "append_answer") await appendFile(input.transcriptPath, `${answer}\n`);
		else if (mutation === "append_successor") await appendFile(input.transcriptPath, `${question("call-new")}\n`);
		else if (mutation === "truncate") await truncate(input.transcriptPath, 0);
		else if (mutation === "native_identity")
			await writeFile(
				input.transcriptPath,
				`${metadata(undefined, null, "01a147e5-2f4c-77c2-834d-a1f23008f27f")}\n${originalQuestionLine}\n`,
			);
		else {
			const replacement = originalTranscript.replace("call-old", "call-new");
			expect(Buffer.byteLength(replacement)).toBe(originalIdentity.size);
			const replacementPath =
				mutation === "replace_same_size_and_mtime"
					? join(input.sessionDirectoryPath, "replacement.jsonl")
					: input.transcriptPath;
			await writeFile(replacementPath, replacement);
			await utimes(replacementPath, originalIdentity.atime, originalIdentity.mtime);
			if (replacementPath !== input.transcriptPath) await rename(replacementPath, input.transcriptPath);
		}
		vi.mocked(open).mockClear();
		vi.mocked(readdir).mockClear();
		const recovered = await recoverForQuery(input);
		expect(vi.mocked(readdir)).toHaveBeenCalled();
		if (mutation !== "truncate") expect(vi.mocked(open)).toHaveBeenCalled();
		if (mutation === "append_answer")
			expect(recovered.exchanges[0]?.resolution?.resolutionKind).toBe("answered_in_agent_terminal");
		else if (mutation === "append_successor") expect(recovered.exchanges.at(-1)?.callId).toBe("call-new");
		else if (mutation === "truncate" || mutation === "native_identity") {
			expect(recovered.coverage).toBe("unavailable");
			expect(recovered.exchanges).toEqual([]);
		} else expect(recovered.exchanges[0]?.callId).toBe("call-new");
	});

	it.each(["existing_date_directory", "new_date_directory"] as const)(
		"在 %s 新建恢复分片后重新发现最新父链",
		async (location) => {
			const input = await createIsolatedTranscript();
			const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
			const queryInput = { homeDirectoryPath: input.homeDirectoryPath, sessionId };
			expect((await recoverForQuery(queryInput)).exchanges).toHaveLength(1);
			const directory =
				location === "existing_date_directory"
					? input.sessionDirectoryPath
					: join(input.homeDirectoryPath, "sessions", "2027", "01", "01");
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, `rollout-restored-${sessionId}_01a14b76-bb96-78d0-b57b-94db3a6a0315.jsonl`),
				`${metadata("2026-10-17T04:00:00.000Z", { thread_id: sessionId, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(originalTranscript) })}\n${question("call-new")}\n`,
			);
			const recovered = await recoverForQuery(queryInput);
			expect(recovered.coverage).toBe("complete");
			expect(recovered.exchanges.map((exchange) => exchange.callId)).toEqual(["call-old", "call-new"]);
		},
	);

	it("父分片原位重写也使显式后继分片的缓存失效", async () => {
		const input = await createIsolatedTranscript();
		const childTranscriptPath = join(
			input.sessionDirectoryPath,
			`rollout-restored-${sessionId}_01a14b76-bb96-78d0-b57b-94db3a6a0315.jsonl`,
		);
		await writeFile(
			childTranscriptPath,
			`${metadata("2026-10-17T04:00:00.000Z", { thread_id: sessionId, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(originalTranscript) })}\n`,
		);
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		const queryInput = { ...input, transcriptPath: childTranscriptPath };
		expect((await recoverForQuery(queryInput)).exchanges[0]?.callId).toBe("call-old");
		await writeFile(input.transcriptPath, originalTranscript.replace("call-old", "call-new"));
		expect((await recoverForQuery(queryInput)).exchanges[0]?.callId).toBe("call-new");
	});

	it("恢复过程中发生追加时重试稳定快照，不能把旧快照作为新文件缓存", async () => {
		const input = await createIsolatedTranscript();
		const originalFilesystem = await vi.importActual<typeof filesystemPromises>("node:fs/promises");
		vi.mocked(open).mockImplementationOnce(async (...argumentsForOpen) => {
			await appendFile(input.transcriptPath, `${answer}\n`);
			return originalFilesystem.open(...argumentsForOpen);
		});
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		expect((await recoverForQuery(input)).exchanges[0]?.resolution?.resolutionKind).toBe(
			"answered_in_agent_terminal",
		);
		expect(vi.mocked(open).mock.calls.length).toBeGreaterThan(2);
		vi.mocked(open).mockClear();
		vi.mocked(readdir).mockClear();
		await recoverForQuery(input);
		expect(vi.mocked(open)).not.toHaveBeenCalled();
		expect(vi.mocked(readdir)).not.toHaveBeenCalled();
	});

	it("缓存按最近使用的会话数量淘汰，且不同读取预算使用独立键", async () => {
		const input = await createIsolatedTranscript();
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache({
			maximumCachedConversations: 2,
		});
		const first = { ...input, maximumTranscriptBytesToRead: 4096 };
		const second = { ...input, maximumTranscriptBytesToRead: 8192 };
		const third = { ...input, maximumTranscriptBytesToRead: 16384 };
		await recoverForQuery(first);
		await recoverForQuery(second);
		await recoverForQuery(first);
		await recoverForQuery(third);
		vi.mocked(readdir).mockClear();
		await recoverForQuery(first);
		expect(vi.mocked(readdir)).not.toHaveBeenCalled();
		await recoverForQuery(second);
		expect(vi.mocked(readdir)).toHaveBeenCalled();
	});

	it("超过结果字节预算不留存，且原始投递检查始终即时读取", async () => {
		const input = await createIsolatedTranscript();
		const boundedRecovery = createCodexUserQuestionPendingAndHistoryFileChangeCache({ maximumCachedResultBytes: 1 });
		await boundedRecovery(input);
		vi.mocked(open).mockClear();
		await boundedRecovery(input);
		expect(vi.mocked(open)).toHaveBeenCalled();
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		await recoverForQuery(input);
		await appendFile(input.transcriptPath, `${answer}\n`);
		const fresh = await recoverCodexUserQuestionsFromKnownConversation(input);
		expect(fresh.exchanges[0]?.resolution?.resolutionKind).toBe("answered_in_agent_terminal");
	});

	it("相同 native id 在不同隔离 HOME 不复用结果", async () => {
		const first = await createIsolatedTranscript();
		const second = await createIsolatedTranscript();
		await writeFile(second.transcriptPath, originalTranscript.replace("call-old", "call-new"));
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		expect((await recoverForQuery(first)).exchanges[0]?.callId).toBe("call-old");
		expect((await recoverForQuery(second)).exchanges[0]?.callId).toBe("call-new");
	});

	it("总字节预算会淘汰旧结果，而不只是拒绝单条超大结果", async () => {
		const input = await createIsolatedTranscript();
		const fresh = await recoverCodexUserQuestionsFromKnownConversation(input);
		const resultByteLength = Buffer.byteLength(JSON.stringify(fresh));
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache({
			maximumCachedResultBytes: resultByteLength + 1,
		});
		const first = { ...input, maximumTranscriptBytesToRead: 4096 };
		const second = { ...input, maximumTranscriptBytesToRead: 8192 };
		await recoverForQuery(first);
		await recoverForQuery(second);
		vi.mocked(readdir).mockClear();
		await recoverForQuery(first);
		expect(vi.mocked(readdir)).toHaveBeenCalled();
	});

	it("同一 native id 的不同显式转录路径使用独立缓存键", async () => {
		const input = await createIsolatedTranscript();
		const otherTranscriptPath = join(
			input.sessionDirectoryPath,
			`rollout-other-${sessionId}_01a14b76-bb96-78d0-b57b-94db3a6a0315.jsonl`,
		);
		await writeFile(otherTranscriptPath, `${metadata("2026-10-17T04:00:00.000Z")}\n${question("call-new")}\n`);
		const recoverForQuery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		expect((await recoverForQuery(input)).exchanges[0]?.callId).toBe("call-old");
		expect((await recoverForQuery({ ...input, transcriptPath: otherTranscriptPath })).exchanges[0]?.callId).toBe(
			"call-new",
		);
	});
});
