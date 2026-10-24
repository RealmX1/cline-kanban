import { describe, expect, it, vi } from "vitest";
import {
	type CodexAppServerRequestPort,
	forkCodexConversationBeforeReviewTurn,
	readCodexConversationTurns,
} from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";

const turn = (id: string, text: string, status = "completed") => ({
	id,
	status,
	items: [{ id: `user-${id}`, type: "userMessage", content: [{ type: "text", text }] }],
});

describe("Codex RVF 原生前缀恢复", () => {
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
			.mockResolvedValueOnce({ data: [turn("rvf", "开审")], nextCursor: null });
		expect((await readCodexConversationTurns({ request }, "source")).map((entry) => entry.id)).toEqual([
			"implementation",
			"rvf",
		]);
		expect(request.mock.calls[1]?.[1]).toMatchObject({ threadId: "source", cursor: "page-2", sortDirection: "asc" });
	});
	it("只分支到开审前的明确回合，并复验新分支历史", async () => {
		const original = [turn("implementation", "原需求"), turn("rvf", "开审"), turn("notification", "额外通知")];
		const request = vi.fn(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/fork")
				return { thread: { id: "restored", path: "/isolated/restored.jsonl", cwd: "/worktree" } };
			return { data: parameters.threadId === "source" ? original : original.slice(0, 1), nextCursor: null };
		});
		const saved = vi.fn();
		await expect(
			forkCodexConversationBeforeReviewTurn(
				{ request },
				{
					sourceThreadId: "source",
					boundaryTurnId: "rvf",
					lastPreReviewTurnId: "implementation",
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
			request: vi.fn().mockResolvedValue({ data: [turn("old", "旧回合"), turn("rvf", "开审")], nextCursor: null }),
		};
		await expect(
			forkCodexConversationBeforeReviewTurn(port, {
				sourceThreadId: "source",
				boundaryTurnId: "rvf",
				lastPreReviewTurnId: "missing",
				workingDirectory: "/worktree",
			}),
		).rejects.toThrow("开审分界");
		expect(port.request).toHaveBeenCalledTimes(1);
	});
	it("原生返回包含 RVF 的历史时拒绝切换身份", async () => {
		const original = [turn("implementation", "原需求"), turn("rvf", "开审")];
		const port = {
			request: vi.fn(async (method: string) =>
				method === "thread/fork"
					? { thread: { id: "restored", path: "/restored.jsonl", cwd: "/worktree" } }
					: { data: original, nextCursor: null },
			),
		};
		await expect(
			forkCodexConversationBeforeReviewTurn(port, {
				sourceThreadId: "source",
				boundaryTurnId: "rvf",
				lastPreReviewTurnId: "implementation",
				workingDirectory: "/worktree",
			}),
		).rejects.toThrow("恢复后的历史");
	});
	it("拒绝循环分页，避免无界等待", async () => {
		const port = { request: vi.fn().mockResolvedValue({ data: [], nextCursor: "same-page" }) };
		await expect(readCodexConversationTurns(port, "source")).rejects.toThrow("分页");
	});
});
