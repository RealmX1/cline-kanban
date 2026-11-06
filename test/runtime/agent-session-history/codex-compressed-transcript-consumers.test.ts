import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { compress, decompress } from "zstd-stream";
import { createAgentConversationModelTokenUsageIncrementalReader } from "../../../src/agent-session-history/agent-conversation-model-token-usage-incremental-reader";
import { readBoundedJsonLines } from "../../../src/agent-session-history/bounded-agent-transcript-reader";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import {
	reconcileCodexPromptSubmissionAcceptance,
	submittedPromptSha256,
} from "../../../src/agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import { createCodexUserQuestionPendingAndHistoryFileChangeCache } from "../../../src/agent-session-history/codex-user-question-pending-and-history-file-change-cache";
import { recoverCodexUserQuestionsFromKnownConversation } from "../../../src/agent-session-history/codex-user-question-transcript-recovery";
import { probePersistedAgentTranscriptLastConversationProgress } from "../../../src/agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";
import { loadTaskConversationHistoryPage } from "../../../src/agent-session-history/task-conversation-history-page";
import {
	codexNativeTurnPermissionTranscriptFingerprintOf,
	codexNativeTurnPermissionTranscriptFingerprintStillCurrent,
	readCodexNativeTurnPermissionEvidence,
} from "../../../src/codex-configuration-sync/codex-native-turn-permission-evidence";
import { readCodexProfileAdoptionNativeTurnCompletionEvidence } from "../../../src/codex-configuration-sync/codex-profile-adoption-native-turn-completion-evidence";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createCodexStatisticsVerifiedHistoryReadCache } from "../../../src/daily-work-progress-statistics/codex-statistics-verified-history-read-cache";
import {
	createEmptyTaskUserPromptStatisticsCursor,
	readTaskUserPromptStatisticsTranscriptIncrement,
} from "../../../src/daily-work-progress-statistics/task-user-prompt-statistics-transcript-reader";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const nativeSessionId = "01a147e5-2f4c-77c2-834d-a1f23008f27e";
const parentSegmentId = nativeSessionId;
const childSegmentId = "01a147e5-2f4c-77c2-834d-a1f23008f27f";
const timestamp = "2026-10-25T10:00:01Z";
const attemptedAtMs = Date.parse(timestamp) - 1000;
const card: RuntimeBoardCard = {
	id: "compressed-history-task",
	title: "压缩历史测试",
	prompt: "原始需求",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};
const questionInput = {
	questions: [
		{
			id: "choice",
			header: "读取",
			question: "选择读取方式？",
			options: [
				{ label: "保留压缩", description: "只读兼容" },
				{ label: "解压存储", description: "原生路径" },
			],
		},
	],
};
const message = (text: string, role = "assistant") => ({
	type: "response_item",
	timestamp,
	payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const serialize = (records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

async function fixture(format: "jsonl" | "zstandard" | "mixed") {
	const directory = await mkdtemp(join(tmpdir(), "kanban-codex-compressed-consumers-"));
	directories.push(directory);
	const home = join(directory, "codex-home");
	const sessions = join(home, "sessions");
	await mkdir(sessions, { recursive: true });
	const metadata = {
		type: "session_meta",
		timestamp,
		payload: { id: nativeSessionId, cwd: directory, source: "cli" },
	};
	const history = [
		metadata,
		{ type: "turn_context", timestamp, payload: { model: "synthetic-model" } },
		{ type: "event_msg", timestamp, payload: { type: "user_message", message: "只发送一次的中文请求😀" } },
		message("只发送一次的中文请求😀", "user"),
		{
			type: "event_msg",
			timestamp,
			payload: {
				type: "item_completed",
				thread_id: nativeSessionId,
				turn_id: "turn-1",
				item: { type: "UserMessage", id: "user-1", content: [{ type: "text", text: "只发送一次的中文请求😀" }] },
			},
		},
		{
			type: "response_item",
			timestamp,
			payload: {
				type: "function_call",
				name: "request_user_input",
				call_id: "question-1",
				arguments: JSON.stringify(questionInput),
			},
		},
		{
			type: "response_item",
			timestamp,
			payload: {
				type: "function_call_output",
				call_id: "question-1",
				output: JSON.stringify({ answers: { choice: { answers: ["保留压缩"] } } }),
			},
		},
		{
			type: "event_msg",
			timestamp,
			payload: {
				type: "token_count",
				info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 } },
			},
		},
		...Array.from({ length: 220 }, (_, index) => message(`历史正文 ${index} 中文😀`)),
	];
	let path = join(sessions, `rollout-old-${nativeSessionId}.jsonl`);
	if (format === "mixed") {
		const parentRecords = history.slice(0, 120);
		const parent = serialize(parentRecords);
		await writeFile(`${path}.zst`, await compress(Buffer.from(parent)));
		path = join(sessions, `rollout-new-${nativeSessionId}_${childSegmentId}.jsonl`);
		await writeFile(
			path,
			serialize([
				{
					...metadata,
					payload: {
						...metadata.payload,
						history_mode: "paginated",
						history_base: {
							thread_id: parentSegmentId,
							end_byte_offset: Buffer.byteLength(parent),
							end_ordinal_exclusive: parentRecords.length,
						},
					},
				},
				...history.slice(120),
			]),
		);
	} else {
		const content = serialize(history);
		await writeFile(
			format === "jsonl" ? path : `${path}.zst`,
			format === "jsonl" ? content : await compress(Buffer.from(content)),
		);
	}
	const summary: RuntimeTaskSessionSummary = {
		taskId: card.id,
		agentId: "codex",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "exited",
		userTurnKind: "review",
		workspacePath: directory,
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: 0,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: path,
			observedAt: 1,
		},
		agentConversationPromptSubmissionAcceptance: {
			status: "unconfirmed",
			attemptedAtMs,
			runtimeSessionIncarnationId: "incarnation",
			submittedPromptSha256: submittedPromptSha256("只发送一次的中文请求😀"),
		},
	};
	const input = {
		request: {
			workspaceTaskId: card.id,
			taskConversationSessionId: card.id,
			transcriptReadConsistency: "stable_snapshot" as const,
		},
		card,
		sessions: { [card.id]: summary },
	};
	return { directory, home, path, summary, input };
}

async function relocateTranscriptWithTrustedNativePointer(f: Awaited<ReturnType<typeof fixture>>) {
	const originalPath = f.path;
	const currentPath = join(f.home, "sessions", `relocated-${nativeSessionId}_${childSegmentId}.jsonl`);
	try {
		await rename(originalPath, currentPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await rename(`${originalPath}.zst`, `${currentPath}.zst`);
	}
	const database = new Database(join(f.home, "state_5.sqlite"));
	try {
		database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
		database.prepare("INSERT INTO threads VALUES (?, ?)").run(nativeSessionId, currentPath);
	} finally {
		database.close();
	}
}

describe("Codex 压缩历史的所有只读消费者", () => {
	it.each(["jsonl", "zstandard"] as const)("%s：默认查询保留尾部半行之前的完整历史", async (format) => {
		const f = await fixture(format);
		const nativePath = format === "jsonl" ? f.path : `${f.path}.zst`;
		const content = await readFile(nativePath);
		const decoded = format === "jsonl" ? content : Buffer.from(await decompress(content));
		const withPartialLine = Buffer.concat([decoded, Buffer.from('{"type":"response_item","text":"未完成😀')]);
		await writeFile(nativePath, format === "jsonl" ? withPartialLine : await compress(withPartialLine));
		const contents: string[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page += 1) {
			const result = await loadTaskConversationHistoryPage({
				...f.input,
				request: { ...f.input.request, transcriptReadConsistency: undefined, cursor },
			});
			expect(result.availability, result.notice ?? "").toBe("available");
			contents.unshift(
				...result.messages.filter((entry) => entry.role === "assistant").map((entry) => entry.content),
			);
			cursor = result.nextCursor;
			if (!cursor) break;
		}
		expect(cursor).toBeNull();
		expect(contents).toEqual(Array.from({ length: 220 }, (_, index) => `历史正文 ${index} 中文😀`));
	});
	it("默认查询仍拒绝首次快照后增长的半行，稳定快照保留原完整前缀", async () => {
		const f = await fixture("jsonl");
		await appendFile(f.path, '{"type":"response_item","text":"未完成');
		const first = await loadTaskConversationHistoryPage({
			...f.input,
			request: { ...f.input.request, transcriptReadConsistency: undefined },
		});
		expect(first.availability).toBe("available");
		const stable = await loadTaskConversationHistoryPage(f.input);
		await appendFile(f.path, "继续写入");
		expect(
			(
				await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, transcriptReadConsistency: undefined, cursor: first.nextCursor },
				})
			).availability,
		).toBe("unavailable");
		expect(
			(
				await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, cursor: stable.nextCursor },
				})
			).availability,
		).toBe("available");
	});
	it.each(["jsonl", "zstandard", "mixed"] as const)("%s：显式归档路径按同一存储范围恢复问答与父段", async (format) => {
		const f = await fixture(format);
		const archive = join(f.home, "archived_sessions");
		await rename(join(f.home, "sessions"), archive);
		await mkdir(join(f.home, "sessions"));
		const transcriptPath = f.path.replace(join(f.home, "sessions"), archive);
		const cachedRecovery = createCodexUserQuestionPendingAndHistoryFileChangeCache();
		for (const read of [recoverCodexUserQuestionsFromKnownConversation, cachedRecovery]) {
			const recovered = await read({ sessionId: nativeSessionId, homeDirectoryPath: f.home, transcriptPath });
			expect(recovered.coverage).toBe("complete");
			expect(recovered.exchanges).toHaveLength(1);
			expect(JSON.stringify(recovered.exchanges)).toContain("保留压缩");
		}
		if (format === "mixed") {
			const parentPath = join(archive, `rollout-old-${nativeSessionId}.jsonl.zst`);
			const parent = Buffer.from(await decompress(await readFile(parentPath))).toString("utf8");
			await writeFile(parentPath, await compress(Buffer.from(parent.replaceAll("保留压缩", "解压存储"))));
			const refreshed = await cachedRecovery({
				sessionId: nativeSessionId,
				homeDirectoryPath: f.home,
				transcriptPath,
			});
			expect(refreshed.coverage).toBe("complete");
			expect(refreshed.exchanges[0].resolution?.answersForQuestions[0].answerText).toBe("解压存储");
		}
	});
	it.each(["jsonl", "zstandard", "mixed"] as const)("%s：分页在可信指针回退后校验实际原生路径", async (format) => {
		const f = await fixture(format);
		await relocateTranscriptWithTrustedNativePointer(f);
		for (const transcriptReadConsistency of [undefined, "stable_snapshot"] as const) {
			const contents: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 10; page += 1) {
				const result = await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, transcriptReadConsistency, cursor },
				});
				expect(result.availability, result.notice ?? "").toBe("available");
				contents.unshift(
					...result.messages.filter((entry) => entry.role === "assistant").map((entry) => entry.content),
				);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			expect(cursor).toBeNull();
			expect(contents).toEqual(Array.from({ length: 220 }, (_, index) => `历史正文 ${index} 中文😀`));
		}
	});
	it.each(["jsonl", "zstandard", "mixed"] as const)(
		"%s：活动、权限及完成补证使用已有 UUID 重查原生指针",
		async (format) => {
			const f = await fixture(format);
			const nativePath = format === "zstandard" ? `${f.path}.zst` : f.path;
			const content = await readFile(nativePath);
			const decoded = format === "zstandard" ? Buffer.from(await decompress(content)) : content;
			const completed = Buffer.concat([
				decoded,
				Buffer.from(
					serialize([
						{
							type: "turn_context",
							timestamp,
							payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } },
						},
						{
							type: "event_msg",
							timestamp,
							payload: { type: "task_complete", turn_id: "completed-native-turn" },
						},
					]),
				),
			]);
			await writeFile(nativePath, format === "zstandard" ? await compress(completed) : completed);
			const expectedProgress = await probePersistedAgentTranscriptLastConversationProgress({
				agentId: "codex",
				workspacePath: f.directory,
				agentNativeConversationSessionIdentity: f.summary.agentNativeConversationSessionIdentity,
			});
			expect(expectedProgress?.observedAtMs).toBe(Date.parse(timestamp));
			await relocateTranscriptWithTrustedNativePointer(f);
			expect(
				await probePersistedAgentTranscriptLastConversationProgress({
					agentId: "codex",
					workspacePath: f.directory,
					agentNativeConversationSessionIdentity: f.summary.agentNativeConversationSessionIdentity,
				}),
			).toEqual(expectedProgress);
			const permission = await readCodexNativeTurnPermissionEvidence({
				summary: f.summary,
				configurationChangedAtMs: attemptedAtMs,
				selectedFields: { [JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" } },
			});
			expect(permission).not.toBeNull();
			if (!permission) throw new Error("缺少权限证据");
			const fingerprint = codexNativeTurnPermissionTranscriptFingerprintOf(permission);
			expect(fingerprint).not.toBeNull();
			if (!fingerprint) throw new Error("缺少权限转录指纹");
			expect(await codexNativeTurnPermissionTranscriptFingerprintStillCurrent(f.path, fingerprint)).toBe(true);
			expect((await readCodexProfileAdoptionNativeTurnCompletionEvidence(f.summary))?.nativeTurnId).toBe(
				"completed-native-turn",
			);
		},
	);
	it("混合分片继续追加时保留输入接受扫描水位，不能因文件增长从头扫描", async () => {
		const f = await fixture("mixed");
		const first = await reconcileCodexPromptSubmissionAcceptance({
			summary: f.summary,
			observedAtMs: Date.parse(timestamp) + 10000,
			maximumReadBytes: 512,
			force: true,
		});
		expect(first?.verification.transcriptCursor?.nextByteOffset).toBeGreaterThan(0);
		if (f.summary.agentConversationPromptSubmissionAcceptance && first)
			f.summary.agentConversationPromptSubmissionAcceptance.verification = JSON.parse(
				JSON.stringify(first.verification),
			);
		await appendFile(f.path, serialize([message("追加工具历史不应阻塞接受补证")]));
		const next = await reconcileCodexPromptSubmissionAcceptance({
			summary: f.summary,
			observedAtMs: Date.parse(timestamp) + 11000,
			maximumReadBytes: 512,
			force: true,
		});
		expect(next?.verification.transcriptCursor?.fileIdentity).toBe(
			first?.verification.transcriptCursor?.fileIdentity,
		);
		expect(next?.verification.transcriptCursor?.nextByteOffset).toBeGreaterThan(
			first?.verification.transcriptCursor?.nextByteOffset ?? 0,
		);
	});
	it.each(["jsonl", "zstandard", "mixed"] as const)(
		"%s：分页与问答恢复保留完整历史、整行边界与去重",
		async (format) => {
			const f = await fixture(format);
			const contents: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 10; page += 1) {
				const result = await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, cursor },
				});
				expect(result.availability, result.notice ?? "").toBe("available");
				contents.unshift(
					...result.messages.filter((entry) => entry.role === "assistant").map((entry) => entry.content),
				);
				cursor = result.nextCursor;
				if (!cursor) break;
			}
			expect(cursor).toBeNull();
			expect(contents).toEqual(Array.from({ length: 220 }, (_, index) => `历史正文 ${index} 中文😀`));
			for (const read of [
				recoverCodexUserQuestionsFromKnownConversation,
				createCodexUserQuestionPendingAndHistoryFileChangeCache(),
			]) {
				const recovered = await read({
					sessionId: nativeSessionId,
					homeDirectoryPath: f.home,
					transcriptPath: f.path,
				});
				expect(recovered.coverage).toBe("complete");
				expect(recovered.exchanges).toHaveLength(1);
				expect(recovered.exchanges[0].resolution?.resolutionKind).toBe("answered_in_agent_terminal");
			}
		},
	);
	it.each(["jsonl", "zstandard", "mixed"] as const)(
		"%s：活动时间、token、用户接受补证保持原始事件语义",
		async (format) => {
			const f = await fixture(format);
			const progress = await probePersistedAgentTranscriptLastConversationProgress({
				agentId: "codex",
				workspacePath: f.directory,
				agentNativeConversationSessionIdentity: f.summary.agentNativeConversationSessionIdentity,
			});
			expect(progress?.observedAtMs).toBe(Date.parse(timestamp));
			const tokens = createAgentConversationModelTokenUsageIncrementalReader();
			const first = await tokens.readCodexCumulativeTokenUsage(f.path, nativeSessionId);
			expect(first).toMatchObject({
				cumulativeInputTokens: 80,
				cumulativeCacheReadInputTokens: 20,
				cumulativeOutputTokens: 30,
				modelIds: ["synthetic-model"],
			});
			expect(await tokens.readCodexCumulativeTokenUsage(f.path, nativeSessionId)).toEqual(first);
			const reconciliation = await reconcileCodexPromptSubmissionAcceptance({
				summary: f.summary,
				observedAtMs: Date.parse(timestamp) + 10_000,
			});
			expect(reconciliation?.accepted).toEqual({
				eventId: `codex:${nativeSessionId}:turn-1:user-1`,
				acceptedAtMs: Date.parse(timestamp),
			});
		},
	);
	it.each(["jsonl", "zstandard", "mixed"] as const)("%s：提示词统计完整且重复读取/重启不重复发布", async (format) => {
		const f = await fixture(format);
		const cache = createCodexStatisticsVerifiedHistoryReadCache();
		let cursor = createEmptyTaskUserPromptStatisticsCursor();
		const submissions: string[] = [];
		for (let attempt = 0; attempt < 12; attempt += 1) {
			const result = await readTaskUserPromptStatisticsTranscriptIncrement({
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: f.path,
				cursor,
				programmaticSubmissionReceipts: [],
				codexHistoryReadCache: cache,
			});
			expect(result.warning).toBeNull();
			cursor = JSON.parse(JSON.stringify(result.cursor));
			submissions.push(...result.submissions.map((entry) => entry.submissionId));
			if (cursor.complete) break;
		}
		expect(cursor.complete).toBe(true);
		expect(submissions).toHaveLength(1);
		const restarted = await readTaskUserPromptStatisticsTranscriptIncrement({
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: f.path,
			cursor,
			programmaticSubmissionReceipts: [],
			codexHistoryReadCache: createCodexStatisticsVerifiedHistoryReadCache(),
		});
		expect(restarted.warning).toBeNull();
		expect(restarted.submissions).toEqual([]);
	});
	it("格式切换、原子替换与新读取器不改变快照阅读位置，正文改写仍使快照失效", async () => {
		const f = await fixture("jsonl");
		const first = await loadTaskConversationHistoryPage(f.input);
		const content = await readFile(f.path);
		await writeFile(`${f.path}.zst`, await compress(content));
		await rm(f.path);
		const second = await loadTaskConversationHistoryPage({
			...f.input,
			request: { ...f.input.request, cursor: first.nextCursor },
		});
		expect(second.availability, second.notice ?? "").toBe("available");
		expect(second.messages.filter((entry) => entry.role === "assistant").at(-1)?.content).toBe("历史正文 119 中文😀");
		await writeFile(`${f.path}.replacement`, content);
		await rename(`${f.path}.replacement`, f.path);
		await rm(`${f.path}.zst`);
		expect(
			(
				await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, cursor: second.nextCursor },
				})
			).availability,
		).toBe("available");
		await writeFile(f.path, content.toString("utf8").replace("历史正文 0", "改写正文 0"));
		expect(
			(
				await loadTaskConversationHistoryPage({
					...f.input,
					request: { ...f.input.request, cursor: first.nextCursor },
				})
			).unavailabilityReason,
		).toBe("snapshot_invalid");
	});
	it("有界读取的预算与截断状态按解压字节计算，UTF-8 半行不泄漏", async () => {
		const f = await fixture("zstandard");
		const result = await readBoundedJsonLines(f.path, 1, 1024, "codex");
		expect(result.transcriptWasTruncated).toBe(true);
		expect(result.lines.join("\n")).not.toContain("�");
		expect(result.lines.every((line) => JSON.parse(line))).toBe(true);
	});
	it.each([
		"wrong_uuid",
		"thread_source",
		"subagent",
		"internal",
		"memory_consolidation",
		"corrupt",
		"truncated",
	] as const)("%s：不能放行历史、补记答案或确认输入", async (scenario) => {
		const f = await fixture("zstandard");
		let compressed = await readFile(`${f.path}.zst`);
		if (scenario === "corrupt") compressed = Buffer.from("无效的 Zstandard 数据");
		else if (scenario === "truncated") compressed = compressed.subarray(0, compressed.length - 8);
		else {
			const records = Buffer.from(await decompress(compressed))
				.toString("utf8")
				.trimEnd()
				.split("\n");
			const first = JSON.parse(records[0]);
			if (scenario === "wrong_uuid") first.payload.id = childSegmentId;
			else if (scenario === "thread_source") first.payload.thread_source = "subagent";
			else
				first.payload.source =
					scenario === "memory_consolidation" ? scenario : { [scenario]: { parent_thread_id: "background" } };
			records[0] = JSON.stringify(first);
			compressed = Buffer.from(await compress(Buffer.from(`${records.join("\n")}\n`)));
		}
		await writeFile(`${f.path}.zst`, compressed);
		expect(
			(
				await inspectCodexNativeConversationTranscriptBeforeResume({
					nativeSessionId,
					transcriptPath: f.path,
					environmentOverrides: { CODEX_HOME: f.home },
				})
			).persistedTranscriptPath,
		).toBeNull();
		expect((await loadTaskConversationHistoryPage(f.input)).availability).toBe("unavailable");
		expect(
			(
				await recoverCodexUserQuestionsFromKnownConversation({
					sessionId: nativeSessionId,
					homeDirectoryPath: f.home,
					transcriptPath: f.path,
				})
			).exchanges,
		).toEqual([]);
		expect(
			(
				await reconcileCodexPromptSubmissionAcceptance({
					summary: f.summary,
					observedAtMs: Date.parse(timestamp) + 10_000,
				})
			)?.accepted,
		).toBeUndefined();
		const statistics = await readTaskUserPromptStatisticsTranscriptIncrement({
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: f.path,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
			programmaticSubmissionReceipts: [],
		});
		expect(statistics.submissions).toEqual([]);
		expect(statistics.cursor.complete).toBe(false);
	});
	it.each(["jsonl", "zstandard"] as const)("%s：大元数据首行不会永久挡住统计和接受补证", async (format) => {
		const f = await fixture(format);
		const original =
			format === "jsonl" ? await readFile(f.path) : Buffer.from(await decompress(await readFile(`${f.path}.zst`)));
		const lines = original.toString("utf8").trimEnd().split("\n");
		const metadata = JSON.parse(lines[0]);
		metadata.payload.base_instructions = { text: "完整说明".repeat(150_000) };
		lines[0] = JSON.stringify(metadata);
		const content = Buffer.from(`${lines.join("\n")}\n`);
		await writeFile(
			format === "jsonl" ? f.path : `${f.path}.zst`,
			format === "jsonl" ? content : await compress(content),
		);
		expect((await loadTaskConversationHistoryPage(f.input)).availability).toBe("available");
		let cursor = createEmptyTaskUserPromptStatisticsCursor();
		const cache = createCodexStatisticsVerifiedHistoryReadCache();
		const submissions: string[] = [];
		let accepted = false;
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const statistics = await readTaskUserPromptStatisticsTranscriptIncrement({
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: f.path,
				cursor,
				programmaticSubmissionReceipts: [],
				codexHistoryReadCache: cache,
			});
			expect(statistics.warning).toBeNull();
			expect(statistics.cursor.nextByteOffset - cursor.nextByteOffset).toBeLessThanOrEqual(256 * 1024);
			cursor = JSON.parse(JSON.stringify(statistics.cursor));
			submissions.push(...statistics.submissions.map((entry) => entry.submissionId));
			const reconciliation = await reconcileCodexPromptSubmissionAcceptance({
				summary: f.summary,
				observedAtMs: Date.parse(timestamp) + 10_000,
				force: true,
			});
			if (reconciliation) {
				if (f.summary.agentConversationPromptSubmissionAcceptance)
					f.summary.agentConversationPromptSubmissionAcceptance.verification = JSON.parse(
						JSON.stringify(reconciliation.verification),
					);
				accepted ||= reconciliation.accepted !== undefined;
			}
			if (cursor.complete && accepted) break;
		}
		expect(cursor.complete).toBe(true);
		expect(submissions).toHaveLength(1);
		expect(accepted).toBe(true);
	});
	it("兼容带完整前缀证据的旧普通文件游标，包括后续压缩转换", async () => {
		const f = await fixture("jsonl");
		const first = await loadTaskConversationHistoryPage(f.input);
		const cursor = JSON.parse(Buffer.from(first.nextCursor ?? "", "base64url").toString("utf8"));
		delete cursor.internalVersion;
		delete cursor.nativeSessionId;
		for (const snapshot of cursor.stableSnapshotFiles) delete snapshot.filePrefix.codexLogicalContent;
		const identity = f.summary.agentNativeConversationSessionIdentity;
		cursor.sourceRevision = createHash("sha256")
			.update(
				JSON.stringify([
					card.id,
					card.createdAt,
					f.summary.taskId,
					f.summary.workspacePath,
					identity?.sourceAgentId,
					identity?.nativeSessionId,
					identity?.transcriptPath,
				]),
			)
			.digest("hex");
		const legacyCursor = Buffer.from(JSON.stringify(cursor)).toString("base64url");
		expect(
			(await loadTaskConversationHistoryPage({ ...f.input, request: { ...f.input.request, cursor: legacyCursor } }))
				.availability,
		).toBe("available");
		await writeFile(`${f.path}.zst`, await compress(await readFile(f.path)));
		await rm(f.path);
		expect(
			(await loadTaskConversationHistoryPage({ ...f.input, request: { ...f.input.request, cursor: legacyCursor } }))
				.availability,
		).toBe("available");
	});
	it("统计游标经压缩、解压、原子替换和重启后不再发布已计数输入", async () => {
		const f = await fixture("jsonl");
		let result = await readTaskUserPromptStatisticsTranscriptIncrement({
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: f.path,
			cursor: createEmptyTaskUserPromptStatisticsCursor(),
			programmaticSubmissionReceipts: [],
		});
		expect(result.submissions).toHaveLength(1);
		const content = await readFile(f.path);
		for (const compressed of [true, false]) {
			if (compressed) {
				await writeFile(`${f.path}.zst`, await compress(content));
				await rm(f.path);
			} else {
				await writeFile(f.path, content);
				await rm(`${f.path}.zst`);
			}
			result = await readTaskUserPromptStatisticsTranscriptIncrement({
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: f.path,
				cursor: JSON.parse(JSON.stringify(result.cursor)),
				programmaticSubmissionReceipts: [],
			});
			expect(result.warning).toBeNull();
			expect(result.cursor.complete).toBe(true);
			expect(result.submissions).toEqual([]);
		}
	});
});
