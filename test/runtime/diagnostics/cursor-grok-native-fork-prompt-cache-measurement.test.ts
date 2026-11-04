import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
	analyzeCursorNativeTurn,
	armDetachedProcessGroupTimeout,
	cursorContextHasCompleteSecondControl,
	cursorContextShouldSkipOnResume,
	decodeCursorNativeSqliteMetadata,
	selectCurrentCursorGrokHighModelFromNativeCatalog,
	verifyCursorNativeForkStorageInheritance,
} from "../../../scripts/measure-cursor-grok-native-fork-prompt-cache.mjs";

const marker = "CACHE_MEASUREMENT_REQUEST=fixture-cursor-turn";
const frames = () => [
	{ type: "system", subtype: "init", session_id: "child", model: "Grok 4.7 256K High" },
	{ type: "user", session_id: "child", message: { content: [{ type: "text", text: marker }] } },
	{ type: "assistant", session_id: "child", message: { content: [{ type: "text", text: "OK" }] } },
	{
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: "child",
		request_id: "native-request-id",
		usage: { inputTokens: 128, outputTokens: 10, cacheReadTokens: 31_872, cacheWriteTokens: 0 },
	},
];
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("Cursor Grok 原生分身计量", () => {
	it("原生 meta 的 0 行是十六进制 JSON；只导出身份与配置，不导出私有密钥", () => {
		const native = {
			agentId: "native-child",
			latestRootBlobId: "root",
			mode: "default",
			blobEncryptionKey: "private-fixture-value",
		};
		expect(decodeCursorNativeSqliteMetadata(Buffer.from(JSON.stringify(native)).toString("hex"))).toEqual({
			agentId: "native-child",
			latestRootBlobId: "root",
			mode: "default",
			lastUsedModel: undefined,
		});
		for (const input of [undefined, "not-hex", "7b62726f6b656e", Buffer.from("{}").toString("hex")])
			expect(() => decodeCursorNativeSqliteMetadata(input)).toThrow();
	});
	it("把未缓存输入和缓存输入相加，不能直接把 inputTokens 当总输入", () => {
		const result = analyzeCursorNativeTurn(encode(frames()), "child", marker);
		expect(result.problems).toEqual([]);
		expect(result.request).toMatchObject({ inputTokens: 32_000, cachedInputTokens: 31_872, outputTokens: 10 });
		expect(result.nativeRequestId).toBe("native-request-id");
	});
	it("原生字段缺失或不合法时保留未知，不能默认为零", () => {
		const missing = frames();
		Reflect.deleteProperty(missing[3].usage ?? {}, "cacheReadTokens");
		expect(analyzeCursorNativeTurn(encode(missing), "child", marker).problems.length).toBeGreaterThan(0);
		const invalid = frames();
		if (invalid[3].usage) invalid[3].usage.inputTokens = -1;
		expect(analyzeCursorNativeTurn(encode(invalid), "child", marker).problems.length).toBeGreaterThan(0);
	});
	it("继承的其他会话计数不会当成本次请求，身份或接受记录缺失也不通过", () => {
		const inherited = frames().map((row) => ({ ...row, session_id: "parent" }));
		expect(analyzeCursorNativeTurn(encode([...inherited, ...frames()]), "child", marker).request?.inputTokens).toBe(
			32_000,
		);
		expect(analyzeCursorNativeTurn(encode(inherited), "child", marker).problems.length).toBeGreaterThan(0);
		expect(
			analyzeCursorNativeTurn(encode(frames().filter((row) => row.type !== "user")), "child", marker).problems
				.length,
		).toBeGreaterThan(0);
	});
	it("多次响应、工具调用、压缩及破损原生记录不冒充单次有效计量", () => {
		for (const extra of [
			frames()[3],
			frames()[2],
			{ type: "tool_call", session_id: "child" },
			{ type: "context_compaction", session_id: "child" },
		]) {
			expect(analyzeCursorNativeTurn(encode([...frames(), extra]), "child", marker).problems.length).toBeGreaterThan(
				0,
			);
		}
		expect(analyzeCursorNativeTurn(`${encode(frames())}\n{broken`, "child", marker).problems.length).toBeGreaterThan(
			0,
		);
	});
	it("缓存写入也计入总输入，但不能计为缓存读取", () => {
		const rows = frames();
		if (rows[3].usage) rows[3].usage.cacheWriteTokens = 1_000;
		expect(analyzeCursorNativeTurn(encode(rows), "child", marker).request).toMatchObject({
			inputTokens: 33_000,
			cachedInputTokens: 31_872,
			cacheCreationTokens: 1_000,
		});
	});
	it("从原生模型目录挑选最新一代非 Fast 的 Grok high，排除 xhigh", () => {
		expect(
			selectCurrentCursorGrokHighModelFromNativeCatalog(
				"cursor-grok-4.6-high - Grok 4.6\ngrok-4.7-high-fast - Fast\ngrok-4.7-xhigh - Xhigh\ngrok-4.7-high - Grok 4.7\ncomposer-2.5 - Composer",
			),
		).toBe("grok-4.7-high");
		expect(() => selectCurrentCursorGrokHighModelFromNativeCatalog("composer-2.5 - Composer")).toThrow();
	});
	it("只有独立原生身份、相同根指针和全部历史 blob 完整一致时，才认定继承成功", () => {
		const parent = {
			sessionId: "parent",
			latestRootBlobId: "root",
			model: "grok-4.7-high",
			mode: "default",
			blobs: [{ id: "root", sha256: "digest", bytes: 100 }],
		};
		const child = { ...parent, sessionId: "child" };
		expect(verifyCursorNativeForkStorageInheritance(parent, child)).toBe(true);
		for (const changed of [
			{ ...child, sessionId: "parent" },
			{ ...child, latestRootBlobId: "other" },
			{ ...child, blobs: [] },
			{ ...child, model: "other-model" },
			{ ...child, blobs: [{ id: "root", sha256: "changed", bytes: 100 }] },
		]) {
			expect(verifyCursorNativeForkStorageInheritance(parent, changed)).toBe(false);
		}
	});

	it("标成完成但第二轮对照无效时不能在恢复时跳过", () => {
		const valid = { status: "completed", measurement: { request: { inputTokens: 32_000 }, problems: [] } };
		const failed = { status: "insufficient_evidence", measurement: { problems: ["缺少成功结束"] } };
		expect(cursorContextHasCompleteSecondControl({ operations: [{ key: "fork-second-control", ...valid }] })).toBe(
			true,
		);
		expect(
			cursorContextShouldSkipOnResume({
				status: "completed",
				operations: [
					{ key: "fork-second-control", ...valid },
					{ key: "parent-hot-after", ...valid },
				],
			}),
		).toBe(true);
		expect(
			cursorContextShouldSkipOnResume({
				status: "completed",
				operations: [
					{ key: "fork-second-control", ...failed },
					{ key: "parent-hot-after", ...valid },
				],
			}),
		).toBe(false);
	});

	it("模型回合忽略 SIGTERM 时改为 SIGKILL，并在有界时间内结束等待", async () => {
		const ignoring = spawn(
			process.execPath,
			["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
			{
				detached: true,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);
		const signals: string[] = [];
		try {
			await once(ignoring, "message", { signal: AbortSignal.timeout(5_000) });
			await armDetachedProcessGroupTimeout(ignoring, {
				timeoutMs: 40,
				termGraceMs: 80,
				killGraceMs: 300,
				onSignal: (signal) => signals.push(signal),
			});
			expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		} finally {
			if (ignoring.pid) {
				try {
					process.kill(-ignoring.pid, "SIGKILL");
				} catch {
					// 进程组已退出。
				}
			}
		}
		const quick = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
		const unexpected: string[] = [];
		await armDetachedProcessGroupTimeout(quick, {
			timeoutMs: 5_000,
			termGraceMs: 50,
			killGraceMs: 50,
			onSignal: (signal) => unexpected.push(signal),
		});
		expect(unexpected).toEqual([]);
	});
});
