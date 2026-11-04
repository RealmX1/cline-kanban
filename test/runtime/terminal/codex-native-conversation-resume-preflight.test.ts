import { mkdirSync, renameSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import * as fileSystemPromises from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	inspectCodexNativeConversationTranscriptBeforeResume,
	listKnownCodexTranscriptSegmentPaths,
} from "../../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import {
	compressedCodexTranscriptFixtureBytes,
	compressedCodexTranscriptFixtureNativeSessionId,
} from "../../utilities/codex-native-resume-compressed-transcript-fixtures";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fileSystem = await importOriginal<typeof fileSystemPromises>();
	return { ...fileSystem, open: vi.fn(fileSystem.open) };
});

const directories: Array<ReturnType<typeof createTempDir>> = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(fileSystemPromises.open).mockReset();
	for (const directory of directories.splice(0)) directory.cleanup();
});

function isolatedCodexHome() {
	const directory = createTempDir("codex-native-resume-preflight-");
	directories.push(directory);
	return directory.path;
}

describe("Codex 原生转录续接预检", () => {
	it.each([
		{ scenario: "valid-rle-frame", accepted: true },
		{ scenario: "invalid-checksum", accepted: false },
		{ scenario: "valid-long-distance-metadata", accepted: true },
	] as const)("完整压缩流的帧边界校验：$scenario", async ({ scenario, accepted }) => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes(scenario));
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: accepted ? transcriptPath : null });
	});
	it.each(["saved-compressed-path", "saved-uncompressed-path", "discovery", "recovery-segment"])(
		"识别压缩转录及旧路径：%s",
		async (scenario) => {
			const home = isolatedCodexHome();
			const sessions = join(home, "sessions", "2026", "10", "23");
			mkdirSync(sessions, { recursive: true });
			const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
			const uncompressedPath = join(sessions, `rollout-${nativeSessionId}.jsonl`);
			const transcriptPath =
				scenario === "recovery-segment"
					? join(sessions, `rollout-${nativeSessionId}_recovered.jsonl.zst`)
					: `${uncompressedPath}.zst`;
			writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes());
			expect(
				await inspectCodexNativeConversationTranscriptBeforeResume({
					nativeSessionId,
					transcriptPath:
						scenario === "saved-compressed-path"
							? transcriptPath
							: scenario === "saved-uncompressed-path"
								? uncompressedPath
								: null,
					environmentOverrides: { CODEX_HOME: home },
				}),
			).toMatchObject({ persistedTranscriptPath: transcriptPath });
			// 正文读取者不因预检支持压缩文件而收到不兼容的输入。
			expect(await listKnownCodexTranscriptSegmentPaths(join(home, "sessions"), nativeSessionId)).toEqual([]);
		},
	);

	it("流式解压大体积中文首行并释放文件", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const transcriptPath = join(
			home,
			"sessions",
			`rollout-${compressedCodexTranscriptFixtureNativeSessionId}.jsonl.zst`,
		);
		writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes("large-chinese-metadata"));
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		const readSpy = vi.spyOn(handle, "read");
		const closeSpy = vi.spyOn(handle, "close");
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: compressedCodexTranscriptFixtureNativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
		expect(readSpy).toHaveBeenCalledExactlyOnceWith(
			expect.any(Buffer),
			0,
			compressedCodexTranscriptFixtureBytes("large-chinese-metadata").length,
			0,
		);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it.each([
		"wrong-identity",
		"wrong-session-id",
		"subagent",
		"internal",
		"memory_consolidation",
		"guardian_review",
		"malformed-tail",
		"missing-newline",
		"metadata-on-second-line",
		"corrupt-compression",
		"truncated-compression",
		"outside-home",
	] as const)("压缩转录仍拒绝 %s", async (scenario) => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(
			scenario === "outside-home" ? home : join(home, "sessions"),
			`rollout-${nativeSessionId}.jsonl.zst`,
		);
		const bytes =
			scenario === "corrupt-compression"
				? Buffer.from("损坏的 Zstandard 数据")
				: scenario === "truncated-compression"
					? compressedCodexTranscriptFixtureBytes().subarray(0, 12)
					: compressedCodexTranscriptFixtureBytes(scenario === "outside-home" ? "persistent-main" : scenario);
		writeFileSync(transcriptPath, bytes);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});

	it("完整多块帧可续接，但首行后截断的同帧不能作为证据", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		for (const [scenario, expectedPath] of [
			["valid-multi-block", transcriptPath],
			["truncated-after-metadata-block", null],
		] as const) {
			writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes(scenario));
			expect(
				await inspectCodexNativeConversationTranscriptBeforeResume({
					nativeSessionId,
					transcriptPath,
					environmentOverrides: { CODEX_HOME: home },
				}),
			).toMatchObject({ persistedTranscriptPath: expectedPath });
		}
	});

	it("拒绝声明内容大小与实际输出不一致的压缩帧", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		const bytes = compressedCodexTranscriptFixtureBytes();
		bytes[5] += 1;
		writeFileSync(transcriptPath, bytes);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
	});

	it("single-segment 帧窗口不随虚假内容大小分配", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		const bytes = compressedCodexTranscriptFixtureBytes("large-chinese-metadata");
		bytes.writeUInt32LE(64 * 1024 * 1024, 5);
		writeFileSync(transcriptPath, bytes);
		const arrayBuffersBefore = process.memoryUsage().arrayBuffers;
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
		expect(process.memoryUsage().arrayBuffers - arrayBuffersBefore).toBeLessThan(16 * 1024 * 1024);
	});

	it("正常 EOF 收尾可解压不足 18 字节的合法末帧", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes("short-final-frame"));
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
	});

	it("压缩转录解压超时仍关闭文件，不把部分身份当作成功", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const transcriptPath = join(
			home,
			"sessions",
			`rollout-${compressedCodexTranscriptFixtureNativeSessionId}.jsonl.zst`,
		);
		writeFileSync(transcriptPath, compressedCodexTranscriptFixtureBytes("large-chinese-metadata"));
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		const readSpy = vi.spyOn(handle, "read");
		const closeSpy = vi.spyOn(handle, "close");
		vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(3_000);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId: compressedCodexTranscriptFixtureNativeSessionId,
				transcriptPath,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
		expect(readSpy).toHaveBeenCalledOnce();
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it.each(["compress", "decompress"])("枚举后发生 %s 文件切换，只按同一 UUID 重查", async (scenario) => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const uncompressedPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl`);
		const compressedPath = `${uncompressedPath}.zst`;
		const originalPath = scenario === "compress" ? uncompressedPath : compressedPath;
		const replacementPath = scenario === "compress" ? compressedPath : uncompressedPath;
		const metadataLine = `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n`;
		writeFileSync(originalPath, scenario === "compress" ? metadataLine : compressedCodexTranscriptFixtureBytes());
		const originalOpen = fileSystemPromises.open;
		vi.mocked(fileSystemPromises.open).mockImplementationOnce(async (...args) => {
			writeFileSync(
				replacementPath,
				scenario === "compress" ? compressedCodexTranscriptFixtureBytes() : metadataLine,
			);
			unlinkSync(originalPath);
			return originalOpen(...args);
		});
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: replacementPath });
	});

	it("损坏压缩文件在读取期间被原子替换后可补证，但不会无限重试", async () => {
		const home = isolatedCodexHome();
		mkdirSync(join(home, "sessions"));
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		const transcriptPath = join(home, "sessions", `rollout-${nativeSessionId}.jsonl.zst`);
		writeFileSync(transcriptPath, "损坏压缩数据");
		const handle = await fileSystemPromises.open(transcriptPath, "r");
		const originalRead = handle.read.bind(handle);
		vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
			const result = await originalRead(...args);
			const replacementPath = `${transcriptPath}.replacement`;
			writeFileSync(replacementPath, compressedCodexTranscriptFixtureBytes());
			renameSync(replacementPath, transcriptPath);
			return result;
		});
		vi.mocked(fileSystemPromises.open).mockClear();
		vi.mocked(fileSystemPromises.open).mockResolvedValueOnce(handle);
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: transcriptPath });
		expect(fileSystemPromises.open).toHaveBeenCalledTimes(2);
	});

	it("重查一次后仍无有效压缩证据即返回，未变化的损坏文件只读取一次", async () => {
		const home = isolatedCodexHome();
		const sessions = join(home, "sessions");
		mkdirSync(sessions);
		const nativeSessionId = compressedCodexTranscriptFixtureNativeSessionId;
		writeFileSync(join(sessions, `rollout-${nativeSessionId}.jsonl.zst`), "损坏压缩数据");
		const readdirSpy = vi.spyOn(fileSystemPromises, "readdir");
		expect(
			await inspectCodexNativeConversationTranscriptBeforeResume({
				nativeSessionId,
				transcriptPath: null,
				environmentOverrides: { CODEX_HOME: home },
			}),
		).toMatchObject({ persistedTranscriptPath: null });
		expect(readdirSpy).toHaveBeenCalledTimes(2);
		expect(fileSystemPromises.open).toHaveBeenCalledOnce();
	});

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
