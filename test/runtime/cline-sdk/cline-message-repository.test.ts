import { describe, expect, it, vi } from "vitest";

import {
	createInMemoryClineMessageRepository,
	createTaskEntryFromPersistedSession,
} from "../../../src/cline-sdk/cline-message-repository";
import type { ClinePersistedTaskSessionSnapshot } from "../../../src/cline-sdk/cline-session-runtime";
import {
	type ClineTaskSessionEntry,
	createDefaultSummary,
	createMessage,
} from "../../../src/cline-sdk/cline-session-state";

function createPersistedSnapshot(
	messages: NonNullable<ClinePersistedTaskSessionSnapshot>["messages"],
): ClinePersistedTaskSessionSnapshot {
	return {
		record: {
			sessionId: "task-1-abc123",
			source: "core" as ClinePersistedTaskSessionSnapshot["record"]["source"],
			status: "completed",
			startedAt: "2026-03-17T10:00:00.000Z",
			updatedAt: "2026-03-17T10:05:00.000Z",
			interactive: true,
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			cwd: "/tmp/worktree",
			workspaceRoot: "/tmp/repo",
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			isSubagent: false,
		},
		messages,
	};
}

function createEntry(taskId: string): ClineTaskSessionEntry {
	return {
		summary: createDefaultSummary(taskId),
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map<string, string>(),
		toolInputByToolCallId: new Map<string, unknown>(),
	};
}

describe("InMemoryClineMessageRepository", () => {
	it("hydrates persisted SDK history into Kanban chat messages and caches the result", async () => {
		const repository = createInMemoryClineMessageRepository();
		const loadPersistedSession = vi.fn(async () =>
			createPersistedSnapshot([
				{
					role: "user",
					content: "Investigate startup",
				},
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "Inspecting logs",
						},
						{
							type: "tool_use",
							id: "tool-1",
							name: "read_file",
							input: {
								path: "src/index.ts",
							},
						},
						{
							type: "text",
							text: "I found the issue.",
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: "console.log('ready')",
						},
					],
				},
			]),
		);

		const firstLoad = await repository.hydrateTaskMessages("task-1", loadPersistedSession);
		const secondLoad = await repository.hydrateTaskMessages("task-1", loadPersistedSession);

		expect(firstLoad.map((message) => ({ role: message.role, content: message.content }))).toEqual([
			{
				role: "user",
				content: "Investigate startup",
			},
			{
				role: "reasoning",
				content: "Inspecting logs",
			},
			{
				role: "tool",
				content: 'Tool: read_file\nInput:\n{\n  "path": "src/index.ts"\n}\nOutput:\nconsole.log(\'ready\')',
			},
			{
				role: "assistant",
				content: "I found the issue.",
			},
		]);
		expect(secondLoad).toEqual(firstLoad);
		expect(repository.listMessages("task-1")).toEqual(firstLoad);
		expect(loadPersistedSession).toHaveBeenCalledTimes(1);
	});

	it("prefers live in-memory task entries over persisted history hydration", async () => {
		const repository = createInMemoryClineMessageRepository();
		const entry = createEntry("task-1");
		entry.messages.push(createMessage("task-1", "assistant", "Live response"));
		repository.setTaskEntry("task-1", entry);
		const loadPersistedSession = vi.fn(async () =>
			createPersistedSnapshot([
				{
					role: "assistant",
					content: "Persisted response",
				},
			]),
		);

		const messages = await repository.hydrateTaskMessages("task-1", loadPersistedSession);

		expect(messages.map((message) => message.content)).toEqual(["Live response"]);
		expect(loadPersistedSession).not.toHaveBeenCalled();
	});

	it("drops hydrated message cache when explicitly cleared", async () => {
		const repository = createInMemoryClineMessageRepository();
		const loadPersistedSession = vi
			.fn()
			.mockResolvedValueOnce(
				createPersistedSnapshot([
					{
						role: "assistant",
						content: "Persisted response",
					},
				]),
			)
			.mockResolvedValueOnce(null);

		expect(
			(await repository.hydrateTaskMessages("task-1", loadPersistedSession)).map((message) => message.content),
		).toEqual(["Persisted response"]);
		repository.clearHydratedTaskMessages("task-1");
		expect(await repository.hydrateTaskMessages("task-1", loadPersistedSession)).toEqual([]);
		expect(loadPersistedSession).toHaveBeenCalledTimes(2);
	});

	it("logs and recovers when the persisted-session loader throws instead of silently returning []", async () => {
		const repository = createInMemoryClineMessageRepository();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const loadPersistedSession = vi.fn(async () => {
			throw new Error("disk read failed");
		});

		const messages = await repository.hydrateTaskMessages("task-broken", loadPersistedSession);

		expect(messages).toEqual([]);
		const combined = stderrSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
		expect(combined).toContain("[tui-freeze] hydration-error");
		expect(combined).toContain("task-broken");
		stderrSpy.mockRestore();
	});

	it("warns when persisted session exists but yields zero hydrated messages", async () => {
		const repository = createInMemoryClineMessageRepository();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const loadPersistedSession = vi.fn(async () => createPersistedSnapshot([]));

		const messages = await repository.hydrateTaskMessages("task-empty", loadPersistedSession);

		expect(messages).toEqual([]);
		const combined = stderrSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
		expect(combined).toContain("[tui-freeze] hydration-empty");
		expect(combined).toContain("task-empty");
		stderrSpy.mockRestore();
	});
});

// Cline 的 summary 不跨进程重启持久化：重建出来的会话若把 lastSubstantiveOutputAt 留成 null，
// 随后第一个 status 心跳会把它镜像成「刚刚」，卡片在重启后谎报 agent 刚响应过。
// 故从落盘消息里回捞真实的 assistant 时间戳。
describe("createTaskEntryFromPersistedSession lastSubstantiveOutputAt reconstruction", () => {
	const FIRST_ASSISTANT_AT = 1_700_000_000_000;
	const LAST_ASSISTANT_AT = FIRST_ASSISTANT_AT + 120_000;

	it("reconstructs the stamp from the newest assistant message timestamp", () => {
		const entry = createTaskEntryFromPersistedSession(
			"task-restart",
			[
				{ role: "user", content: "Investigate startup", ts: FIRST_ASSISTANT_AT - 5_000 },
				{ role: "assistant", content: "First answer", ts: FIRST_ASSISTANT_AT },
				{ role: "assistant", content: "Second answer", ts: LAST_ASSISTANT_AT },
				// user 消息更晚也不算「agent 上次响应」。
				{ role: "user", content: "Follow-up question", ts: LAST_ASSISTANT_AT + 60_000 },
			],
			{ state: "awaiting_review", reviewReason: "attention", lastOutputAt: Date.now() },
		);

		expect(entry.summary.lastSubstantiveOutputAt).toBe(LAST_ASSISTANT_AT);
	});

	it("keeps the stamp null when no persisted assistant message carries a timestamp", () => {
		const entry = createTaskEntryFromPersistedSession(
			"task-restart-no-ts",
			[
				{ role: "user", content: "Investigate startup" },
				{ role: "assistant", content: "First answer" },
			],
			{ state: "awaiting_review", reviewReason: "attention", lastOutputAt: Date.now() },
		);

		// 回捞不到就保持 null——卡片隐去该段，宁可不显示也不显示错的「刚刚」。
		expect(entry.summary.lastSubstantiveOutputAt ?? null).toBeNull();
	});

	it("lets an explicit caller-supplied stamp win over reconstruction", () => {
		const explicitStamp = LAST_ASSISTANT_AT + 999;
		const entry = createTaskEntryFromPersistedSession(
			"task-restart-explicit",
			[{ role: "assistant", content: "First answer", ts: FIRST_ASSISTANT_AT }],
			{ state: "awaiting_review", lastSubstantiveOutputAt: explicitStamp },
		);

		expect(entry.summary.lastSubstantiveOutputAt).toBe(explicitStamp);
	});

	// SDK 把承载 tool_result 的消息落盘为 role:"user"（@clinebot/core 的 ModelMessage→MessageWithMetadata
	// 回程把内部 role:"tool" 改写成 "user"、ts 取 createdAt），而 live 路径的 tool-finished 事件
	// 明确把工具完成计作实质产出。回捞必须与之对齐，否则「以工具收尾」的会话重启后时间偏早或缺失。
	const TOOL_FINISHED_AT = LAST_ASSISTANT_AT + 30_000;

	it("counts a tool_result-carrying user message as agent output", () => {
		const entry = createTaskEntryFromPersistedSession(
			"task-restart-tool-tail",
			[
				{ role: "assistant", content: "Reading the file now", ts: LAST_ASSISTANT_AT },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "src/index.ts" } }],
					ts: LAST_ASSISTANT_AT + 10_000,
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }],
					ts: TOOL_FINISHED_AT,
				},
			],
			{ state: "awaiting_review", reviewReason: "attention", lastOutputAt: Date.now() },
		);

		expect(entry.summary.lastSubstantiveOutputAt).toBe(TOOL_FINISHED_AT);
	});

	it("reconstructs from a tool_result-only session that never produced assistant text", () => {
		const entry = createTaskEntryFromPersistedSession(
			"task-restart-tool-only",
			[
				{ role: "user", content: "Run the migration", ts: FIRST_ASSISTANT_AT - 5_000 },
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-2", content: "migration applied" }],
					ts: TOOL_FINISHED_AT,
				},
			],
			{ state: "awaiting_review", reviewReason: "attention", lastOutputAt: Date.now() },
		);

		expect(entry.summary.lastSubstantiveOutputAt).toBe(TOOL_FINISHED_AT);
	});

	it("never counts a genuine user message as agent output", () => {
		const entry = createTaskEntryFromPersistedSession(
			"task-restart-user-tail",
			[
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call-3", content: "done" }],
					ts: TOOL_FINISHED_AT,
				},
				// 富内容的用户发言（文本 + 图片）同样只是「用户上次说话」。
				{
					role: "user",
					content: [
						{ type: "text", text: "Here is a screenshot" },
						{ type: "image", data: "AAAA", mediaType: "image/png" },
					],
					ts: TOOL_FINISHED_AT + 60_000,
				},
			],
			{ state: "awaiting_review", reviewReason: "attention", lastOutputAt: Date.now() },
		);

		expect(entry.summary.lastSubstantiveOutputAt).toBe(TOOL_FINISHED_AT);
	});
});
