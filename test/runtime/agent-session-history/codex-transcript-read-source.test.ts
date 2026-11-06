import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCodexNativeConversationTranscriptBeforeResume } from "../../../src/agent-session-history/codex-native-conversation-transcript-location-for-resume";
import {
	createCodexTranscriptReadSourceCache,
	openCodexTranscriptReadSource,
	readCodexDecodedTranscriptChunks,
	readCodexTranscriptSessionMetadata,
} from "../../../src/agent-session-history/codex-transcript-read-source";
import { compressedCodexSyntheticHistoryBase64 } from "../../utilities/codex-native-resume-compressed-history-fixture";
import {
	compressedCodexTranscriptFixtureBytes,
	compressedCodexTranscriptFixtureNativeSessionId,
} from "../../utilities/codex-native-resume-compressed-transcript-fixtures";

const directories: string[] = [];
const caches: ReturnType<typeof createCodexTranscriptReadSourceCache>[] = [];
afterEach(async () => {
	for (const cache of caches.splice(0)) await cache.dispose();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(maximumCachedDecodedBytes = 256 * 1024 * 1024) {
	const directory = await mkdtemp(join(tmpdir(), "kanban-codex-decoded-read-source-test-"));
	directories.push(directory);
	const cache = createCodexTranscriptReadSourceCache({ maximumCachedDecodedBytes });
	caches.push(cache);
	const path = join(directory, "rollout.jsonl");
	await writeFile(`${path}.zst`, Buffer.from(compressedCodexSyntheticHistoryBase64, "base64"));
	return { directory, path, cache };
}
async function readAll(source: Awaited<ReturnType<ReturnType<typeof createCodexTranscriptReadSourceCache>["open"]>>) {
	try {
		const metadata = await source.stat();
		const bytes = Buffer.alloc(metadata.size);
		expect((await source.read(bytes, 0, bytes.length, 0)).bytesRead).toBe(bytes.length);
		return bytes;
	} finally {
		await source.close();
	}
}

describe("Codex 普通与压缩转录的共享只读源", () => {
	it("对应格式恢复、UTF-8 范围、逻辑长度与普通内容一致，原生路径不指向缓存", async () => {
		const { cache, path } = await fixture();
		const source = await cache.open(path);
		expect(source.nativePath).toBe(`${path}.zst`);
		const content = await readAll(source);
		expect(content.toString("utf8")).toContain("合成历史回复 2");
		await writeFile(path, content);
		expect(await readAll(await cache.open(path))).toEqual(content);
		await rm(path);
		const ranged = await cache.open(path);
		try {
			const selected = Buffer.alloc(137);
			expect((await ranged.read(selected, 0, selected.length, 71)).bytesRead).toBe(137);
			expect(selected).toEqual(content.subarray(71, 208));
		} finally {
			await ranged.close();
		}
	});
	it("同版本并发单飞解码，淘汰和冷缓存重建不改变内容", async () => {
		const { cache, path, directory } = await fixture(8 * 1024);
		const contents = await Promise.all(Array.from({ length: 12 }, async () => readAll(await cache.open(path))));
		expect(contents.every((content) => content.equals(contents[0]))).toBe(true);
		expect(cache.inspect().completedDecodeCount).toBe(1);
		for (let index = 0; index < 4; index += 1) {
			const another = join(directory, `rollout-${index}.jsonl.zst`);
			await writeFile(another, await readFile(`${path}.zst`));
			await readAll(await cache.open(another));
		}
		expect(cache.inspect().cachedDecodedBytes).toBeLessThanOrEqual(8 * 1024);
		expect(cache.inspect().maximumObservedConcurrentDecodes).toBeLessThanOrEqual(2);
		expect(await readAll(await cache.open(path))).toEqual(contents[0]);
		await cache.dispose();
		expect(await readAll(await cache.open(path))).toEqual(contents[0]);
	});
	it("超出缓存预算仍能流式范围读取且不常驻快照", async () => {
		const { cache, path } = await fixture(32);
		const content = await readAll(await cache.open(path));
		expect(content.toString("utf8")).toContain("合成历史问题 1");
		expect(cache.inspect().cachedDecodedBytes).toBe(0);
	});
	it("不同源并发解码最多两个，活跃读取也不能突破总缓存容量", async () => {
		const { cache, path, directory } = await fixture(4 * 1024);
		const compressed = await readFile(`${path}.zst`);
		const sources = await Promise.all(
			Array.from({ length: 8 }, async (_, index) => {
				const another = join(directory, `parallel-${index}.jsonl.zst`);
				await writeFile(another, compressed);
				return cache.open(another);
			}),
		);
		try {
			expect(cache.inspect().maximumObservedConcurrentDecodes).toBe(2);
			expect(cache.inspect().cachedDecodedBytes).toBeLessThanOrEqual(4 * 1024);
		} finally {
			await Promise.all(sources.map((source) => source.close()));
		}
	});
	it("续接预检与正文读取共用全进程的两个解码席位", async () => {
		const { cache, directory } = await fixture();
		const compressed = compressedCodexTranscriptFixtureBytes("valid-long-distance-metadata");
		await Promise.all(
			Array.from({ length: 8 }, async (_, index) => {
				const home = join(directory, `concurrent-native-home-${index}`);
				const sessions = join(home, "sessions");
				await mkdir(sessions, { recursive: true });
				const path = join(sessions, `rollout-${compressedCodexTranscriptFixtureNativeSessionId}.jsonl.zst`);
				await writeFile(path, compressed);
				if (index < 4) await readAll(await cache.open(path));
				else
					expect(
						(
							await inspectCodexNativeConversationTranscriptBeforeResume({
								nativeSessionId: compressedCodexTranscriptFixtureNativeSessionId,
								transcriptPath: path,
								environmentOverrides: { CODEX_HOME: home },
							})
						).persistedTranscriptPath,
					).toBe(path);
			}),
		);
		expect(cache.inspect().maximumObservedConcurrentDecodes).toBeLessThanOrEqual(2);
	});
	it("解码席位被占用时，有界预检可以退出等待且不泄漏席位", async () => {
		const { cache, path } = await fixture();
		const handle = await open(`${path}.zst`, "r");
		const size = (await handle.stat()).size;
		const first = readCodexDecodedTranscriptChunks(handle, `${path}.zst`, size);
		const second = readCodexDecodedTranscriptChunks(handle, `${path}.zst`, size);
		let queued: ReturnType<typeof readCodexDecodedTranscriptChunks> | null = null;
		try {
			await Promise.all([first.next(), second.next()]);
			queued = readCodexDecodedTranscriptChunks(handle, `${path}.zst`, size, () => {}, AbortSignal.timeout(20));
			await expect(queued.next()).rejects.toThrow();
		} finally {
			await Promise.all([first.return(), second.return(), queued?.return()]);
			await handle.close();
		}
		expect((await readAll(await cache.open(path))).toString("utf8")).toContain("合成历史回复 2");
	});
	it("真实续接预检将三秒截止信号传给排队中的解码器", async () => {
		const { directory } = await fixture();
		const sessions = join(directory, "sessions");
		await mkdir(sessions);
		const path = join(sessions, `rollout-${compressedCodexTranscriptFixtureNativeSessionId}.jsonl.zst`);
		await writeFile(path, compressedCodexTranscriptFixtureBytes("persistent-main"));
		const handle = await open(path, "r");
		const size = (await handle.stat()).size;
		const first = readCodexDecodedTranscriptChunks(handle, path, size);
		const second = readCodexDecodedTranscriptChunks(handle, path, size);
		await Promise.all([first.next(), second.next()]);
		const deadlineController = new AbortController();
		const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadlineController.signal);
		const inspection = inspectCodexNativeConversationTranscriptBeforeResume({
			nativeSessionId: compressedCodexTranscriptFixtureNativeSessionId,
			transcriptPath: path,
			environmentOverrides: { CODEX_HOME: directory },
		});
		try {
			await vi.waitFor(() => expect(timeoutSignal).toHaveBeenCalledWith(3_000));
			deadlineController.abort(new Error("测试触发预检截止"));
			await expect(inspection).resolves.toMatchObject({ persistedTranscriptPath: null });
		} finally {
			timeoutSignal.mockRestore();
			await Promise.all([first.return(), second.return()]);
			await inspection;
			await handle.close();
		}
		expect(
			(
				await inspectCodexNativeConversationTranscriptBeforeResume({
					nativeSessionId: compressedCodexTranscriptFixtureNativeSessionId,
					transcriptPath: path,
					environmentOverrides: { CODEX_HOME: directory },
				})
			).persistedTranscriptPath,
		).toBe(path);
	});
	it.each(["valid", "wrong_identity", "outside_store"] as const)(
		"旧路径消失后只重查可信原生指针：%s",
		async (scenario) => {
			const { directory } = await fixture();
			const sessions = join(directory, "codex-home", "sessions");
			await mkdir(sessions, { recursive: true });
			const candidate = join(scenario === "outside_store" ? directory : sessions, "current-segment.jsonl.zst");
			await writeFile(
				candidate,
				compressedCodexTranscriptFixtureBytes(scenario === "wrong_identity" ? "wrong-identity" : "persistent-main"),
			);
			const database = new Database(join(directory, "codex-home", "state_5.sqlite"));
			try {
				database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
				database
					.prepare("INSERT INTO threads VALUES (?, ?)")
					.run(compressedCodexTranscriptFixtureNativeSessionId, candidate);
			} finally {
				database.close();
			}
			const pending = openCodexTranscriptReadSource(
				join(sessions, "missing-original.jsonl"),
				compressedCodexTranscriptFixtureNativeSessionId,
			);
			if (scenario !== "valid") await expect(pending).rejects.toThrow(/身份|目录/);
			else {
				const source = await pending;
				expect(source.nativePath).toBe(candidate);
				await source.close();
			}
		},
	);
	it.each(["invalid-checksum", "truncated-after-metadata-block"] as const)(
		"压缩完整性不成立时拒绝发布可读取源：%s",
		async (scenario) => {
			const { cache, path } = await fixture();
			await writeFile(`${path}.zst`, compressedCodexTranscriptFixtureBytes(scenario));
			await expect(cache.open(path)).rejects.toThrow();
			expect(cache.inspect().cachedDecodedBytes).toBe(0);
		},
	);
	it("原子替换不能复用旧解压缓存", async () => {
		const { cache, path } = await fixture();
		await readAll(await cache.open(path));
		await writeFile(`${path}.replacement`, compressedCodexTranscriptFixtureBytes("persistent-main"));
		await rename(`${path}.replacement`, `${path}.zst`);
		expect((await readAll(await cache.open(path))).toString("utf8")).not.toContain("合成历史问题 1");
	});
	it("大首行按流解析，只保留归属字段和真实逻辑行尾", async () => {
		const { cache, path } = await fixture();
		await writeFile(`${path}.zst`, compressedCodexTranscriptFixtureBytes("valid-long-distance-metadata"));
		const source = await cache.open(path);
		try {
			const metadata = await readCodexTranscriptSessionMetadata(source);
			expect(metadata.record.type).toBe("session_meta");
			expect(metadata.endByteOffset).toBeGreaterThan(256 * 1024);
			expect(JSON.stringify(metadata.record).length).toBeLessThan(1024);
		} finally {
			await source.close();
		}
	});
	it("拒绝经 sessions 内符号链接越出原生存储", async () => {
		const { cache, path, directory } = await fixture();
		await mkdir(join(directory, "sessions"));
		// 路径归属由共享源按真实路径核验；测试不需要接触任何真实会话。
		await symlink(`${path}.zst`, join(directory, "sessions", "outside.jsonl.zst"));
		await expect(cache.open(join(directory, "sessions", "outside.jsonl.zst"))).rejects.toThrow(/目录|归属/);
	});
});
