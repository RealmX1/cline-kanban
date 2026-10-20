import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import * as fileSystemPromises from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fileSystem = await importOriginal<typeof fileSystemPromises>();
	return { ...fileSystem, open: vi.fn(fileSystem.open) };
});

const directories: Array<ReturnType<typeof createTempDir>> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) directory.cleanup();
});

function isolatedCodexHome() {
	const directory = createTempDir("codex-native-resume-preflight-");
	directories.push(directory);
	return directory.path;
}

describe("Codex 原生转录续接预检", () => {
	it.each([false, true])("相对 CODEX_HOME 按 agent 启动 cwd 解析（已保存路径=%s）", async (hasSavedPath) => {
		const home = isolatedCodexHome();
		const agentExecutionWorkingDirectoryPath = join(home, "agent-working-directory");
		const sessions = join(agentExecutionWorkingDirectoryPath, ".store", "sessions");
		mkdirSync(sessions, { recursive: true });
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"known","source":"cli"}}\n');
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath: hasSavedPath ? transcriptPath : null,
				agentExecutionWorkingDirectoryPath,
				environmentOverrides: { CODEX_HOME: ".store", HOME: home },
			}),
		).toEqual({ persistedTranscriptPath: transcriptPath, codexSessionsDirectoryPath: sessions });
	});

	it.each(["absolute-codex-home", "default-home", "omitted-agent-working-directory"])(
		"保留 %s 的有效转录根目录语义",
		async (configuration) => {
			const home = isolatedCodexHome();
			const agentExecutionWorkingDirectoryPath = join(home, "agent-working-directory");
			const codexHome = configuration === "default-home" ? join(home, ".codex") : join(home, "codex-home");
			const sessions = join(codexHome, "sessions");
			mkdirSync(sessions, { recursive: true });
			const transcriptPath = join(sessions, "rollout-known.jsonl");
			writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"known"}}\n');
			expect(
				await inspectCodexNativeConversationTranscriptBeforeResume({
					nativeSessionId: "known",
					transcriptPath,
					agentExecutionWorkingDirectoryPath:
						configuration === "omitted-agent-working-directory" ? undefined : agentExecutionWorkingDirectoryPath,
					environmentOverrides: {
						CODEX_HOME:
							configuration === "default-home"
								? undefined
								: configuration === "omitted-agent-working-directory"
									? relative(process.cwd(), codexHome)
									: codexHome,
						HOME: home,
					},
				}),
			).toEqual({ persistedTranscriptPath: transcriptPath, codexSessionsDirectoryPath: sessions });
		},
	);

	it.each([false, true])("已保存的原始 / 恢复分片可按原生 ID 验证（分片=%s）", async (resumedSegment) => {
		const home = isolatedCodexHome();
		const nativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";
		const directory = join(home, "sessions", "2026", "10", "19");
		mkdirSync(directory, { recursive: true });
		const transcriptPath = join(
			directory,
			`rollout-date-${nativeSessionId}${resumedSegment ? "_new-incarnation" : ""}.jsonl`,
		);
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`,
		);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
	});

	it("大体积 base_instructions 不限制元数据首行长度或字段顺序", async () => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		writeFileSync(
			transcriptPath,
			`${JSON.stringify({
				payload: {
					base_instructions: { text: '中文说明\n\t"\\'.repeat(64 * 1024) },
					source: "cli",
					id: "known",
					session_id: "known",
				},
				type: "session_meta",
			})}\n后续正文不是元数据，也不应参与预检`,
		);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
	});

	it.each([
		"wrong-identity",
		"wrong-session-id",
		"subagent",
		"internal",
		"memory_consolidation",
		"guardian_review",
		"malformed-tail",
		"incomplete",
	])("大体积元数据仍拒绝 %s", async (kind) => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		const metadataRecord = JSON.stringify({
			type: "session_meta",
			payload: {
				base_instructions: { text: "x".repeat(512 * 1024) },
				id: kind === "wrong-identity" ? "other" : "known",
				session_id: kind === "wrong-session-id" ? "other" : "known",
				source:
					kind === "subagent" || kind === "internal"
						? { [kind]: { thread_spawn: { parent_thread_id: "parent" } } }
						: kind === "memory_consolidation" || kind === "guardian_review"
							? kind
							: "cli",
			},
		});
		writeFileSync(
			transcriptPath,
			kind === "malformed-tail"
				? `${metadataRecord}unexpected\n`
				: kind === "incomplete"
					? metadataRecord.slice(0, -1)
					: `${metadataRecord}\n`,
		);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});

	it.each([
		'{"type":"other","payload":{"id":"known","type":"session_meta"}}',
		'{"type":"session_meta","payload":{"id":"known"},"payload":null}',
		'{"type":"session_meta","payload":{"id":"known","session_id":null}}',
		'{"type":"session_meta","payload":{"id":"known","source":{"internal":null}}}',
		'[{"type":"session_meta","payload":{"id":"known"}}]',
	])("按 JSON 字段层级与最后一次赋值判定身份：%s", async (metadataRecord) => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		writeFileSync(join(sessions, "rollout-known.jsonl"), `${metadataRecord}\n`);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});

	it("只按固定大小分块读首行，不读取大体积对话正文，并关闭文件", async () => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"known","source":"cli"}}\n');
		truncateSync(transcriptPath, 64 * 1024 * 1024);
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		const readSpy = vi.spyOn(handle, "read");
		const closeSpy = vi.spyOn(handle, "close");
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
		expect(readSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 64 * 1024, 0);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("元数据读取以打开时的文件大小封顶，不追读后来追加的内容", async () => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"known","source":"cli"}}\n');
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		const initialFileStatistics = await handle.stat();
		initialFileStatistics.size = 32;
		vi.spyOn(handle, "stat").mockResolvedValue(initialFileStatistics);
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		const readSpy = vi.spyOn(handle, "read");
		const closeSpy = vi.spyOn(handle, "close");
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
		expect(readSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Buffer), 0, 32, 0);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("超过预检时间预算即停止读取并关闭文件", async () => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(sessions, "rollout-known.jsonl");
		writeFileSync(transcriptPath, '{"type":"session_meta","payload":{"id":"known"}}\n');
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(3_000);
		const readSpy = vi.spyOn(handle, "read");
		const closeSpy = vi.spyOn(handle, "close");
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
		expect(readSpy).not.toHaveBeenCalled();
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it("缺失 ID 不借用同目录较新的其它对话", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		writeFileSync(
			join(home, "sessions", "rollout-other.jsonl"),
			`${JSON.stringify({ type: "session_meta", payload: { id: "other" } })}\n`,
		);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "missing",
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});

	it.each(["wrong-identity", "subagent", "outside-home", "malformed"])("拒绝 %s 转录", async (kind) => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const transcriptPath = join(kind === "outside-home" ? home : sessions, "rollout-known.jsonl");
		writeFileSync(
			transcriptPath,
			kind === "malformed"
				? "not-json\n"
				: `${JSON.stringify({ type: "session_meta", payload: { id: kind === "wrong-identity" ? "other" : "known", source: kind === "subagent" ? { subagent: { thread_spawn: { parent_thread_id: "parent" } } } : "cli" } })}\n`,
		);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: "known",
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});
});
