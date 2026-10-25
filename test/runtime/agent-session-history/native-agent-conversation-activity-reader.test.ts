import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS,
	readNativeAgentConversationActivity,
} from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof request }) => Promise<unknown>,
	) => operation({ request }),
}));
const directories: string[] = [];
afterEach(async () => {
	request.mockReset();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function summary(agentId: "claude" | "omp" | "codex", transcriptPath: string): RuntimeTaskSessionSummary {
	return applySessionFacets({
		taskId: "conversation",
		state: "running",
		agentId,
		workspacePath: "/isolated",
		pid: 12,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: agentId,
			nativeSessionId: "native",
			transcriptPath,
			observedAt: 1,
		},
		...(agentId === "codex"
			? {
					codexNativeSessionControlEndpoint: {
						socketPath: "/isolated/socket",
						workspaceId: "workspace",
						conversationSessionId: "conversation",
						runtimeSessionIncarnationId: "incarnation",
					},
				}
			: {}),
	});
}
async function fixture(agentId: "claude" | "omp") {
	const directory = await mkdtemp(join(tmpdir(), "kanban-native-activity-reader-"));
	directories.push(directory);
	const path = join(directory, "native.jsonl");
	await writeFile(path, "");
	return { path, target: summary(agentId, path) };
}
const baselineAtMs = Date.parse("2026-10-22T09:00:00Z");
const timestamp = "2026-10-22T10:00:00Z";
function claudeUser(uuid: string) {
	return {
		type: "user",
		promptSource: "typed",
		sessionId: "native",
		uuid,
		timestamp,
		message: { role: "user", content: "原文\u2028仍在同一 JSON 行" },
	};
}

describe("有界原生活动增量读取", () => {
	it("Codex 首次超预算的独立就绪结果不初始化活动基线，rewind 后只建立基线", async () => {
		const target = {
			...summary("codex", "/isolated/native.jsonl"),
			turnOwner: "user" as const,
			userTurnKind: "needs_input" as const,
		};
		const historicalTurn = {
			id: "historical",
			status: "completed",
			items: [
				{ id: "old-input", type: "userMessage" },
				{ id: "old-response", type: "agentMessage", text: "旧回答" },
			],
		};
		let turns = [
			{
				id: "rewound-turn",
				status: "completed",
				items: Array.from({ length: 512 }, (_, index) => ({ id: String(index), type: "userMessage" })),
			},
			historicalTurn,
		];
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: method === "thread/read"
					? { thread: { id: "native", status: { type: "idle" }, canAcceptDirectInput: true } }
					: { data: turns, nextCursor: null },
		);
		const overBudget = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		expect(overBudget?.events).toEqual([]);
		expect(overBudget?.codexNativeDirectInputReadiness).toBeDefined();
		turns = [historicalTurn];
		const afterRewind = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: overBudget?.cursor ?? null,
			observedAtMs: baselineAtMs + 1,
		});
		expect(afterRewind?.events).toEqual([]);
		expect(afterRewind?.codexNativeDirectInputReadiness).toBeDefined();
		turns = [
			{ id: "new-turn", status: "inProgress", items: [{ id: "new-input", type: "userMessage" }] },
			historicalTurn,
		];
		const newInput = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: afterRewind?.cursor ?? null,
			observedAtMs: baselineAtMs + 2,
		});
		expect(newInput?.events).toMatchObject([
			{ activityKind: "accepted_user_input", eventId: "codex:native:new-turn:new-input" },
		]);
	});
	it("活动游标超预算时仍可独立核验空闲，但不推进游标或重放接受", async () => {
		const target = {
			...summary("codex", "/isolated/native.jsonl"),
			turnOwner: "user" as const,
			userTurnKind: "needs_input" as const,
		};
		const cursor = { transport: "codex_control" as const, predecessorTurnId: "current", seenEventIds: [] };
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: method === "thread/read"
					? { thread: { id: "native", status: { type: "idle" }, canAcceptDirectInput: true } }
					: {
							data: [
								{
									id: "current",
									status: "completed",
									items: Array.from({ length: 513 }, (_, index) => ({
										id: String(index),
										type: "userMessage",
									})),
								},
							],
							nextCursor: null,
						},
		);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor,
			observedAtMs: baselineAtMs,
		});
		expect(result?.events).toEqual([]);
		expect(result?.cursor).toEqual(cursor);
		expect(result?.codexNativeDirectInputReadiness).toBeDefined();
	});
	it.each([null, "rewound-predecessor", "current"])(
		"普通 Codex rewind 的前驱为 %s 时，即使没有新消息仍独立报告输入就绪",
		async (predecessorTurnId) => {
			const target = {
				...summary("codex", "/isolated/native.jsonl"),
				turnOwner: "user" as const,
				userTurnKind: "needs_input" as const,
				reviewReason: null,
			};
			request.mockImplementation(async (method) => {
				if (method === "thread/loaded/list") return { data: ["native"] };
				if (method === "thread/read")
					return { thread: { id: "native", status: { type: "idle" }, canAcceptDirectInput: true } };
				return { data: [{ id: "current", status: "completed", items: [] }], nextCursor: null };
			});
			const result = await readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: target,
				cursor:
					predecessorTurnId === null ? null : { transport: "codex_control", predecessorTurnId, seenEventIds: [] },
				observedAtMs: baselineAtMs,
			});
			expect(result?.events).toEqual([]);
			expect(result?.codexNativeDirectInputReadiness).toEqual({
				nativeSessionId: "native",
				observedAtMs: baselineAtMs,
			});
		},
	);

	it.each([
		{ id: "native", status: { type: "active", activeFlags: ["waitingOnUserInput"] }, canAcceptDirectInput: true },
		{ id: "native", status: { type: "active", activeFlags: ["waitingOnApproval"] }, canAcceptDirectInput: false },
		{ id: "native", status: { type: "idle" }, canAcceptDirectInput: false },
		{ id: "native", status: { type: "idle" } },
		{ id: "other", status: { type: "idle" }, canAcceptDirectInput: true },
		{ id: "native", status: { type: "unknown" }, canAcceptDirectInput: true },
	])("原生等待、身份不符或字段未知时不证明就绪：%j", async (thread) => {
		const target = {
			...summary("codex", "/isolated/native.jsonl"),
			turnOwner: "user" as const,
			userTurnKind: "needs_input" as const,
		};
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: method === "thread/read"
					? { thread }
					: { data: [], nextCursor: null },
		);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		expect(result?.codexNativeDirectInputReadiness).toBeUndefined();
	});
	it.each(["claude", "omp"] as const)("%s 仅附件的真人输入也可确认，正文保持缺省", async (agentId) => {
		const { path, target } = await fixture(agentId);
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		const record =
			agentId === "claude"
				? {
						...claudeUser("image-only"),
						message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "fixture" } }] },
					}
				: {
						type: "message",
						id: "image-only",
						timestamp,
						message: { role: "user", attribution: "user", content: [{ type: "image", data: "fixture" }] },
					};
		await appendFile(path, `${JSON.stringify(record)}\n`);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(result?.events).toMatchObject([
			{ activityKind: "accepted_user_input", evidenceKind: "native_user_prompt_acceptance" },
		]);
		expect(result?.events[0]?.submittedPromptText).toBeUndefined();
	});
	it("半行未完成时不确认；LF 结束后读取完整记录，U+2028 不会拆帧", async () => {
		const { path, target } = await fixture("claude");
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		const line = JSON.stringify(claudeUser("new"));
		await appendFile(path, line.slice(0, -2));
		const partial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(partial?.events).toEqual([]);
		await appendFile(path, `${line.slice(-2)}\n`);
		const complete = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: partial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(complete?.events).toHaveLength(1);
		expect(complete?.events[0]).toMatchObject({
			activityKind: "accepted_user_input",
			submittedPromptText: "原文\u2028仍在同一 JSON 行",
		});
	});
	it("转录截断、旧用户记录追加及重复 native ID 均不制造接受边沿", async () => {
		const { path, target } = await fixture("claude");
		await writeFile(path, `${JSON.stringify(claudeUser("initial"))}\n`);
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		await appendFile(
			path,
			`${JSON.stringify(claudeUser("initial"))}\n${JSON.stringify({ ...claudeUser("old"), timestamp: "2026-10-20T10:00:00Z" })}\n`,
		);
		const repeated = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(repeated?.events).toEqual([]);
		await writeFile(path, `${JSON.stringify(claudeUser("rewritten"))}\n`);
		const rewritten = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: repeated?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(rewritten?.events).toEqual([]);
	});
	it("OMP 真人提交、assistant、工具返回和压缩分别产生真实活动", async () => {
		const { path, target } = await fixture("omp");
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		const records = [
			{ type: "message", id: "user", timestamp, message: { role: "user", attribution: "user", content: "继续" } },
			{
				type: "message",
				id: "output",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "输出" }] },
			},
			{
				type: "message",
				id: "tool",
				timestamp,
				message: { role: "toolResult", content: [{ type: "text", text: "完成" }] },
			},
			{ type: "compaction", id: "compact", timestamp, summary: "压缩完成" },
			{
				type: "message",
				id: "synthetic",
				timestamp,
				message: { role: "user", synthetic: true, content: "不是真人提交" },
			},
		];
		await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(result?.events.map((event) => event.activityKind)).toEqual([
			"accepted_user_input",
			"agent_output",
			"tool_activity",
			"context_compaction",
		]);
	});
	it("Claude 的主对话压缩、工具工作与输出分别归属，侧链和合成摘要不推进", async () => {
		const { path, target } = await fixture("claude");
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		const records = [
			{
				type: "assistant",
				uuid: "tool-call",
				sessionId: "native",
				timestamp,
				message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] },
			},
			{
				type: "user",
				uuid: "tool-result",
				sessionId: "native",
				timestamp,
				message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "完成" }] },
			},
			{ type: "system", subtype: "compact_boundary", uuid: "compact", sessionId: "native", timestamp },
			{
				type: "assistant",
				uuid: "answer",
				sessionId: "native",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "结论" }] },
			},
			{ ...claudeUser("summary"), isCompactSummary: true },
			{
				type: "assistant",
				uuid: "assistant-compact-summary",
				isCompactSummary: true,
				sessionId: "native",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "压缩摘要不能续期" }] },
			},
			{
				type: "assistant",
				uuid: "sidechain",
				isSidechain: true,
				sessionId: "native",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "子代理输出" }] },
			},
			{
				type: "assistant",
				uuid: "synthetic",
				sessionId: "native",
				timestamp,
				message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "本地占位" }] },
			},
		];
		await appendFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs,
		});
		expect(result?.events.map((event) => event.activityKind)).toEqual([
			"tool_activity",
			"tool_activity",
			"context_compaction",
			"agent_output",
			"agent_output",
		]);
		expect(result?.events.every((event) => event.nativeSessionId === "native")).toBe(true);
		expect(result?.events.map((event) => event.nativeAgentResponsePromptCacheReferenceObservation)).toEqual([
			{
				observedAtMs: Date.parse(timestamp),
				evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate",
			},
			undefined,
			undefined,
			{
				observedAtMs: Date.parse(timestamp),
				evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate",
			},
			undefined,
		]);
	});
	it.each(["inProgress", "completed"] as const)(
		"Codex %s 的真实响应可关联首条输入；queued 接受不冒称已处理，completed 不用发现时间续缓存",
		async (status) => {
			const target = summary("codex", "/isolated/native.jsonl");
			request.mockImplementation(async (method) =>
				method === "thread/loaded/list"
					? { data: ["native"] }
					: {
							data: [
								{
									id: "new-turn",
									status,
									items: [
										{ id: "new-input", type: "userMessage", content: [{ type: "text", text: "新的请求" }] },
										{ id: "response", type: "agentMessage", text: "直接回答，无工具" },
										{
											id: "queued-input",
											type: "userMessage",
											content: [{ type: "text", text: "排队输入" }],
										},
									],
								},
							],
							nextCursor: null,
						},
			);
			const discoveredAtMs = baselineAtMs + 60_000;
			const result = await readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: target,
				cursor: { transport: "codex_control", predecessorTurnId: null, seenEventIds: [] },
				observedAtMs: discoveredAtMs,
			});
			expect(result?.events[0]).toMatchObject({
				eventId: "codex:native:new-turn:new-input",
				acceptedNativeAgentTurnHasModelResponse: true,
			});
			expect(result?.events[2]).toMatchObject({ acceptedNativeAgentTurnHasModelResponse: false });
			const response = result?.events[1];
			if (status === "inProgress")
				expect(response?.nativeAgentResponsePromptCacheReferenceObservation).toEqual({
					observedAtMs: discoveredAtMs,
					evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate",
				});
			else expect(response?.nativeAgentResponsePromptCacheReferenceObservation).toBeUndefined();
		},
	);
	it("Codex 仅查当前已加载会话的最近一页，初始化不发接受事件，新增消息按原生 ID 确认", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		let data = [{ id: "before", status: "completed", items: [{ id: "old", type: "userMessage" }] }];
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"], nextCursor: null }
				: { data, nextCursor: "older-history-not-read" },
		);
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		expect(initial?.events).toEqual([]);
		data = [{ id: "after", status: "inProgress", items: [{ id: "new", type: "userMessage" }] }, ...data];
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs + 1,
		});
		expect(result?.events).toMatchObject([
			{
				activityKind: "accepted_user_input",
				evidenceKind: "native_user_prompt_acceptance",
				eventId: "codex:native:after:new",
				acceptedNativeAgentTurnIsInProgress: true,
			},
		]);
		expect(
			request.mock.calls.filter(
				([method, parameters]) => method === "thread/turns/list" && parameters.itemsView === "full",
			),
		).toHaveLength(2);
		expect(
			request.mock.calls.filter(
				([method, parameters]) => method === "thread/turns/list" && parameters.itemsView === "summary",
			),
		).toHaveLength(2);
		expect(request).toHaveBeenCalledWith("thread/turns/list", {
			threadId: "native",
			cursor: null,
			limit: MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS,
			sortDirection: "desc",
			itemsView: "full",
		});
		const unchanged = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: result?.cursor ?? null,
			observedAtMs: baselineAtMs + 2,
		});
		expect(unchanged?.events).toEqual([]);
	});
	it.each(["completed", "interrupted", "failed", "unknown_future_status"])(
		"Codex %s 回合中的新用户记录仍是接受事实，但不能据此推断当前 Agent 正在运行",
		async (status) => {
			const target = summary("codex", "/isolated/native.jsonl");
			request.mockImplementation(async (method) =>
				method === "thread/loaded/list"
					? { data: ["native"] }
					: {
							data: [
								{
									id: "current",
									status,
									items: [{ id: "accepted", type: "userMessage" }],
								},
							],
							nextCursor: null,
						},
			);
			const result = await readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: target,
				cursor: { transport: "codex_control", predecessorTurnId: "current", seenEventIds: [] },
				observedAtMs: baselineAtMs,
			});
			expect(result?.events).toMatchObject([
				{
					activityKind: "accepted_user_input",
					evidenceKind: "native_user_prompt_acceptance",
					eventId: "codex:native:current:accepted",
					acceptedNativeAgentTurnIsInProgress: false,
				},
			]);
		},
	);
	it.each([true, false])("跳过执行状态查询仍核验加载身份并读取消息接受：已加载=%s", async (isLoaded) => {
		const target = summary("codex", "/isolated/native.jsonl");
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: isLoaded ? ["native"] : [] };
			if (method === "thread/turns/list" && parameters.itemsView === "full")
				return {
					data: [
						{
							id: "current",
							status: "inProgress",
							items: [
								{ id: "accepted", type: "userMessage" },
								{ id: "tool-result", type: "commandExecution", status: "completed" },
							],
						},
					],
				};
			throw new Error(`不应执行的状态查询：${method}`);
		});
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: { transport: "codex_control", predecessorTurnId: "current", seenEventIds: [] },
			observedAtMs: baselineAtMs,
			shouldReadCodexNativeAgentTurnExecution: false,
		});
		if (isLoaded) {
			expect(result?.events).toMatchObject([
				{ activityKind: "accepted_user_input", eventId: "codex:native:current:accepted" },
				{ activityKind: "tool_activity" },
			]);
			expect(result?.codexNativeAgentTurnExecution).toBeUndefined();
			expect(result?.codexNativeDirectInputReadiness).toBeUndefined();
		} else expect(result).toBeNull();
		expect(request.mock.calls.map(([method]) => method)).toEqual(
			isLoaded ? ["thread/loaded/list", "thread/turns/list"] : ["thread/loaded/list"],
		);
	});
	it("Codex 首次确认的正文提取接受 text+skill，不把手册正文拼进投递正文", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: {
						data: [
							{
								id: "current",
								status: "inProgress",
								items: [
									{
										id: "accepted-with-skill",
										type: "userMessage",
										content: [
											{ type: "text", text: "逐字收尾正文 $base-branch-sync" },
											{ type: "skill", name: "base-branch-sync", path: "/isolated/SKILL.md" },
										],
									},
								],
							},
						],
						nextCursor: null,
					},
		);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: { transport: "codex_control", predecessorTurnId: "current", seenEventIds: [] },
			observedAtMs: baselineAtMs,
		});
		expect(result?.events).toMatchObject([
			{ activityKind: "accepted_user_input", submittedPromptText: "逐字收尾正文 $base-branch-sync" },
		]);
	});
	it("Codex 缺本代控制端点或无法找到固定前驱时保持未知，不补发提示", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		expect(
			await readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: { ...target, codexNativeSessionControlEndpoint: null },
				cursor: null,
				observedAtMs: baselineAtMs,
			}),
		).toBeNull();
		expect(request).not.toHaveBeenCalled();
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: {
						data: [{ id: "distant", status: "completed", items: [{ id: "unknown", type: "userMessage" }] }],
						nextCursor: "more",
					},
		);
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: { transport: "codex_control", predecessorTurnId: "not-in-recent-page", seenEventIds: [] },
			observedAtMs: baselineAtMs,
		});
		expect(result?.events).toEqual([]);
		expect(
			request.mock.calls.every(([method]) =>
				["thread/loaded/list", "thread/turns/list", "thread/read"].includes(method),
			),
		).toBe(true);
	});
	it("Codex 只计主调用与返回，子代理状态和工具计时刷新不冒充推进，plan 属于真实输出", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		const items: Array<Record<string, unknown>> = [];
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"] }
				: {
						data: [{ id: "current", status: "inProgress", items }],
						nextCursor: null,
					},
		);
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		items.push(
			{
				id: "collab",
				type: "collabAgentToolCall",
				status: "inProgress",
				agentsStates: { child: { status: "running" } },
			},
			{ id: "command", type: "commandExecution", status: "inProgress", durationMs: 10 },
			{ id: "plan", type: "plan", text: "先核对证据" },
		);
		const started = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs + 1,
		});
		expect(started?.events.map((event) => event.activityKind)).toEqual([
			"tool_activity",
			"tool_activity",
			"agent_output",
		]);
		items[0] = { ...items[0], agentsStates: { child: { status: "completed" } } };
		items[1] = { ...items[1], durationMs: 1_000 };
		const waiting = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: started?.cursor ?? null,
			observedAtMs: baselineAtMs + 2,
		});
		expect(waiting?.events).toEqual([]);
		items[0] = { ...items[0], status: "completed" };
		const received = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: waiting?.cursor ?? null,
			observedAtMs: baselineAtMs + 3,
		});
		expect(received?.events.map((event) => event.activityKind)).toEqual(["tool_activity"]);
	});
});
