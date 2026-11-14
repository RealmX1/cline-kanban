import { describe, expect, it, vi } from "vitest";
import {
	type CodexAppServerRequestPort,
	forkCodexConversationBeforeBoundaryTurn,
	readCodexConversationTurns,
} from "../../../src/codex-native-session-protocol/codex-native-conversation-history";

const turn = (id: string, text: string, status = "completed") => ({
	id,
	status,
	items: [{ id: `user-${id}`, type: "userMessage", content: [{ type: "text", text }] }],
});

describe("Codex 原生会话前缀恢复", () => {
	it("legacy 明确拒绝分页时，才使用原生完整历史读取", async () => {
		const request = vi
			.fn()
			.mockRejectedValueOnce(new Error("list_turns is not supported yet"))
			.mockResolvedValueOnce({ thread: { turns: [turn("legacy-turn", "旧格式历史")] } });
		expect(await readCodexConversationTurns({ request }, "legacy-thread")).toHaveLength(1);
		expect(request).toHaveBeenLastCalledWith("thread/read", { threadId: "legacy-thread", includeTurns: true });
	});
	it("网络失败或中途分页拒绝均不回退，防止把不完整历史当成完整", async () => {
		for (const failure of [new Error("timeout"), new Error("list_turns is not supported yet")]) {
			const request = vi.fn();
			if (failure.message !== "timeout")
				request.mockResolvedValueOnce({ data: [turn("first", "第一页")], nextCursor: "next" });
			request.mockRejectedValueOnce(failure);
			await expect(readCodexConversationTurns({ request }, "source")).rejects.toThrow(failure.message);
			expect(request.mock.calls.every(([method]) => method === "thread/turns/list")).toBe(true);
		}
	});
	it("逐页读取回合，不能只使用当前可见的最近一页", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: [turn("implementation", "原需求")], nextCursor: "page-2" })
			.mockResolvedValueOnce({ data: [turn("boundary", "边界")], nextCursor: null });
		expect((await readCodexConversationTurns({ request }, "source")).map((entry) => entry.id)).toEqual([
			"implementation",
			"boundary",
		]);
		expect(request.mock.calls[1]?.[1]).toMatchObject({ threadId: "source", cursor: "page-2", sortDirection: "asc" });
	});
	it("只分支到边界前的明确回合，并复验新分支历史", async () => {
		const original = [turn("implementation", "原需求"), turn("boundary", "边界"), turn("notification", "额外通知")];
		const request = vi.fn(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/fork")
				return { thread: { id: "restored", path: "/isolated/restored.jsonl", cwd: "/worktree" } };
			return { data: parameters.threadId === "source" ? original : original.slice(0, 1), nextCursor: null };
		});
		const saved = vi.fn();
		await expect(
			forkCodexConversationBeforeBoundaryTurn(
				{ request },
				{
					sourceThreadId: "source",
					boundaryTurnId: "boundary",
					lastPreBoundaryTurnId: "implementation",
					workingDirectory: "/worktree",
				},
				saved,
			),
		).resolves.toMatchObject({ nativeSessionId: "restored", transcriptPath: "/isolated/restored.jsonl" });
		expect(request).toHaveBeenCalledWith("thread/fork", {
			threadId: "source",
			lastTurnId: "implementation",
			cwd: "/worktree",
		});
		expect(saved).toHaveBeenCalledOnce();
	});
	it("拒绝错误起点，不能回落到最近回合", async () => {
		const port: CodexAppServerRequestPort = {
			request: vi
				.fn()
				.mockResolvedValue({ data: [turn("old", "旧回合"), turn("boundary", "边界")], nextCursor: null }),
		};
		await expect(
			forkCodexConversationBeforeBoundaryTurn(port, {
				sourceThreadId: "source",
				boundaryTurnId: "boundary",
				lastPreBoundaryTurnId: "missing",
				workingDirectory: "/worktree",
			}),
		).rejects.toThrow("原生回合边界");
		expect(port.request).toHaveBeenCalledTimes(1);
	});
	it("原生返回包含 边界 的历史时拒绝切换身份", async () => {
		const original = [turn("implementation", "原需求"), turn("boundary", "边界")];
		const port = {
			request: vi.fn(async (method: string) =>
				method === "thread/fork"
					? { thread: { id: "restored", path: "/restored.jsonl", cwd: "/worktree" } }
					: { data: original, nextCursor: null },
			),
		};
		await expect(
			forkCodexConversationBeforeBoundaryTurn(port, {
				sourceThreadId: "source",
				boundaryTurnId: "boundary",
				lastPreBoundaryTurnId: "implementation",
				workingDirectory: "/worktree",
			}),
		).rejects.toThrow("恢复后的历史");
	});
	it("拒绝循环分页，避免无界等待", async () => {
		const port = { request: vi.fn().mockResolvedValue({ data: [], nextCursor: "same-page" }) };
		await expect(readCodexConversationTurns(port, "source")).rejects.toThrow("分页");
	});
	it("相同回合 ID 的正文变化仍拒绝采用，并先保存候选身份", async () => {
		const original = [turn("implementation", "原始正文"), turn("boundary", "边界")];
		const saved = vi.fn();
		const port = {
			request: vi.fn(async (method: string, parameters: Record<string, unknown>) => {
				if (method === "thread/fork")
					return { thread: { id: "restored", path: "/restored.jsonl", cwd: "/worktree" } };
				return {
					data: parameters.threadId === "source" ? original : [turn("implementation", "被改变的正文")],
					nextCursor: null,
				};
			}),
		};
		await expect(
			forkCodexConversationBeforeBoundaryTurn(
				port,
				{
					sourceThreadId: "source",
					boundaryTurnId: "boundary",
					lastPreBoundaryTurnId: "implementation",
					workingDirectory: "/worktree",
				},
				saved,
			),
		).rejects.toThrow("原生内容");
		expect(saved).toHaveBeenCalledExactlyOnceWith({ nativeSessionId: "restored", transcriptPath: "/restored.jsonl" });
	});
});
