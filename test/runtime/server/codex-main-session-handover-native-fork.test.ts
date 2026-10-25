import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCodexMainSessionHandoverNativeForkWithPort } from "../../../src/server/codex-main-session-handover-native-fork";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const turns = [
	{ id: "first", status: "completed", items: [] },
	{ id: "last", status: "completed", items: [] },
];
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-handover-native-fork-"));
	directories.push(directory);
	const input = {
		handoverId: "handover",
		sourceTaskConversationSessionId: "source-session",
		sourceNativeSessionId: "source-native",
		workingDirectoryPath: directory,
		codexConversationStorageHomeDirectoryPath: join(directory, "codex-home"),
		receiptFilePath: join(directory, "fork-preparation.json"),
	};
	return { directory, input };
}
describe("交接前固定完整 Codex 原生分支", () => {
	it("子身份先持久化，校验中断后复验原分支，不再 fork 或启动模型", async () => {
		const { directory, input } = await fixture();
		let rejectChildRead = true;
		const request = vi.fn(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/fork")
				return {
					thread: {
						id: "child-native",
						cwd: directory,
						path: join(input.codexConversationStorageHomeDirectoryPath, "sessions", "child.jsonl"),
					},
				};
			if (parameters.threadId === "child-native" && rejectChildRead) throw new Error("模拟校验断线");
			return { data: turns, nextCursor: null };
		});
		await expect(prepareCodexMainSessionHandoverNativeForkWithPort({ request }, input)).rejects.toThrow(
			"模拟校验断线",
		);
		expect(JSON.parse(await readFile(input.receiptFilePath, "utf8"))).toMatchObject({
			sourceNativeSessionId: "source-native",
			expectedTurnIds: ["first", "last"],
			attempts: [{ childIdentity: { nativeSessionId: "child-native" } }],
		});
		rejectChildRead = false;
		const result = await prepareCodexMainSessionHandoverNativeForkWithPort({ request }, input);
		expect(result.nativeSessionId).toBe("child-native");
		expect(request.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(1);
		expect(request.mock.calls.every(([method]) => ["thread/turns/list", "thread/fork"].includes(method))).toBe(true);
	});
	it("来源边界变化或最后回合未完成时保留原主责任，不 fork", async () => {
		const { directory, input } = await fixture();
		let sourceTurns = turns;
		const request = vi.fn(async (method: string) =>
			method === "thread/fork"
				? { thread: { id: "child-native", cwd: directory, path: join(directory, "child.jsonl") } }
				: { data: sourceTurns, nextCursor: null },
		);
		await prepareCodexMainSessionHandoverNativeForkWithPort({ request }, input);
		sourceTurns = [...turns, { id: "newer", status: "completed", items: [] }];
		await expect(prepareCodexMainSessionHandoverNativeForkWithPort({ request }, input)).rejects.toThrow(
			"来源完整回合边界已经变化",
		);
		expect(request.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(1);
	});
	it("未知准备尝试有界重建，保留每次未知结果且从不启动模型", async () => {
		const { input } = await fixture();
		let now = 1;
		const request = vi.fn(async (method: string) => {
			if (method === "thread/fork") throw new Error("分支响应丢失");
			return { data: turns, nextCursor: null };
		});
		for (let index = 0; index < 3; index++) {
			await expect(
				prepareCodexMainSessionHandoverNativeForkWithPort({ request }, { ...input, now: () => now }),
			).rejects.toThrow("分支响应丢失");
			now += 15_000;
		}
		await expect(
			prepareCodexMainSessionHandoverNativeForkWithPort({ request }, { ...input, now: () => now }),
		).rejects.toThrow("有界重验");
		expect(request.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(3);
		expect(JSON.parse(await readFile(input.receiptFilePath, "utf8")).attempts).toHaveLength(3);
	});
	it("显式恢复只 fork 原固定前缀，排除旧失败汇报；运行中的来源不会被 fork", async () => {
		const { input } = await fixture();
		const sourceTurns = [...turns, { id: "old-failed-report", status: "completed", items: [] }];
		const request = vi.fn(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/fork")
				return {
					thread: {
						id: "recovery-native",
						cwd: input.workingDirectoryPath,
						path: join(input.codexConversationStorageHomeDirectoryPath, "sessions", "recovery.jsonl"),
					},
				};
			return { data: parameters.threadId === "recovery-native" ? turns : sourceTurns, nextCursor: null };
		});
		await prepareCodexMainSessionHandoverNativeForkWithPort(
			{ request },
			{ ...input, expectedTurnIds: ["first", "last"], allowAdditionalSourceTurnsAfterFrozenBoundary: true },
		);
		expect(request.mock.calls.find(([method]) => method === "thread/fork")?.[1]).toMatchObject({
			lastTurnId: "last",
		});
		request.mockClear();
		sourceTurns.push({ id: "still-running", status: "inProgress", items: [] });
		await expect(
			prepareCodexMainSessionHandoverNativeForkWithPort(
				{ request },
				{ ...input, receiptFilePath: join(input.workingDirectoryPath, "busy-source-preparation.json") },
			),
		).rejects.toThrow("完整结束");
		expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
	});
});
