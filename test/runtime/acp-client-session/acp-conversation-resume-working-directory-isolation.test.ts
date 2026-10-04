import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpClientConnectionRuntime } from "../../../src/acp-client-session/acp-client-connection-runtime";
import { ACP_AGENT_METHODS, type AcpClientConnection } from "../../../src/acp-client-session/acp-protocol-boundary";

let temporaryDirectory: string | undefined;
afterEach(() => {
	if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

function createResumeFixture() {
	temporaryDirectory = mkdtempSync(join(tmpdir(), "kanban-acp-resume-directory-"));
	const taskDirectory = join(temporaryDirectory, "task-a");
	const siblingDirectory = join(temporaryDirectory, "task-b");
	const aliasDirectory = join(temporaryDirectory, "task-a-alias");
	mkdirSync(taskDirectory);
	mkdirSync(siblingDirectory);
	symlinkSync(taskDirectory, aliasDirectory, "junction");
	const runtime = new AcpClientConnectionRuntime({
		onSessionUpdate: vi.fn(),
		onPermissionRequest: vi.fn(),
		onElicitationRequest: vi.fn(),
		onConnectionClosed: vi.fn(),
	});
	const request = vi.fn();
	const connection = { agent: { request } } as unknown as AcpClientConnection;
	const resume = () =>
		// biome-ignore lint/complexity/useLiteralKeys: 测试私有协议边界，不增加生产公开 API。
		runtime["loadMostRecentAgentSessionForWorkingDirectory"](connection, { cwd: taskDirectory, taskId: "task-a" });
	return { runtime, connection, request, resume, taskDirectory, siblingDirectory, aliasDirectory };
}

describe("ACP 续跑独立验证目录和所有分页", () => {
	it("排除更新的兄弟目录和缺失 cwd；按真实路径选择后页的最近会话", async () => {
		const fixture = createResumeFixture();
		fixture.request
			.mockResolvedValueOnce({
				sessions: [
					{ sessionId: "sibling", cwd: fixture.siblingDirectory, updatedAt: "2030-01-01" },
					{ sessionId: "missing-cwd", updatedAt: "2031-01-01" },
					{ sessionId: "older", cwd: fixture.taskDirectory, updatedAt: "2020-01-01" },
				],
				nextCursor: "page-two",
			})
			.mockResolvedValueOnce({
				sessions: [
					{ sessionId: "correct", cwd: fixture.aliasDirectory, updatedAt: "2021-01-01" },
					{ sessionId: "invalid-date", cwd: fixture.taskDirectory, updatedAt: "invalid" },
				],
			})
			.mockImplementationOnce(async () => {
				expect(fixture.runtime.isReplayingPersistedConversationHistory("task-a")).toBe(true);
				return {};
			});
		await expect(fixture.resume()).resolves.toEqual({ sessionId: "correct" });
		expect(fixture.request.mock.calls).toEqual([
			[ACP_AGENT_METHODS.session_list, { cwd: fixture.taskDirectory }],
			[ACP_AGENT_METHODS.session_list, { cwd: fixture.taskDirectory, cursor: "page-two" }],
			[ACP_AGENT_METHODS.session_load, { cwd: fixture.taskDirectory, sessionId: "correct", mcpServers: [] }],
		]);
		expect(fixture.runtime.isReplayingPersistedConversationHistory("task-a")).toBe(false);
	});

	it("没有匹配目录就报错，不加载兄弟任务，也不开新会话", async () => {
		const fixture = createResumeFixture();
		fixture.request.mockResolvedValue({
			sessions: [
				{ sessionId: "sibling", cwd: fixture.siblingDirectory },
				{ sessionId: "missing-cwd" },
				{ sessionId: "relative", cwd: "." },
				{ sessionId: "deleted", cwd: join(fixture.taskDirectory, "deleted") },
			],
		});
		await expect(fixture.resume()).rejects.toThrow("no previous conversation in this task worktree");
		expect(fixture.request).toHaveBeenCalledTimes(1);
	});

	it("重复分页游标不能造成无限循环或使用不完整候选集", async () => {
		const fixture = createResumeFixture();
		fixture.request.mockResolvedValue({ sessions: [], nextCursor: "same" });
		await expect(fixture.resume()).rejects.toThrow("repeated");
		expect(fixture.request).toHaveBeenCalledTimes(2);
	});

	it("加载失败清理重播守卫和会话到任务的映射", async () => {
		const fixture = createResumeFixture();
		fixture.request
			.mockResolvedValueOnce({ sessions: [{ sessionId: "correct", cwd: fixture.taskDirectory }] })
			.mockRejectedValueOnce(new Error("load failed"));
		await expect(fixture.resume()).rejects.toThrow("load failed");
		expect(fixture.runtime.isReplayingPersistedConversationHistory("task-a")).toBe(false);
		// biome-ignore lint/complexity/useLiteralKeys: 核对加载失败后的私有映射清理。
		expect(fixture.runtime["sessionIdByConnection"].has(fixture.connection)).toBe(false);
	});
});
