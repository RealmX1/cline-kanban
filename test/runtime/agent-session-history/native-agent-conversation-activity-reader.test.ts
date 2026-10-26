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
	it("已有可信前驱时完整读取超时，新回合首条用户输入仍由 summary 确认", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			if (method === "thread/read") return { thread: { id: "native", status: { type: "active" } } };
			if (parameters.itemsView === "full") throw new Error("完整读取超时");
			return {
				data: [
					{ id: "new", status: "inProgress", items: [{ id: "input", type: "userMessage" }] },
					{ id: "before", status: "completed", items: [{ id: "old", type: "userMessage" }] },
				],
			};
		});
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: {
				transport: "codex_control",
				predecessorTurnId: "before",
				lastAcceptedUserInputItemId: "old",
				seenEventIds: [],
			},
			observedAtMs: baselineAtMs,
		});
		expect(result?.events).toMatchObject([
			{ eventId: "codex:native:new:input", activityKind: "accepted_user_input" },
		]);
		expect(result?.nativeActivityProjectionReadFailure).toContain("超时");
	});
	it.each([0, 800])("summary 后备保留旧前驱 steering 的完整水位，工具条目数=%s", async (toolCount) => {
		const target = summary("codex", "/isolated/native.jsonl");
		const previousTurn = {
			id: "before",
			status: "completed",
			items: [
				{ id: "old", type: "userMessage" },
				...Array.from({ length: toolCount }, (_, index) => ({ id: `tool-${index}`, type: "commandExecution" })),
			],
		};
		let turns = [previousTurn];
		let fullReadFails = false;
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			if (parameters.itemsView === "full" && fullReadFails) throw new Error("完整读取超时");
			return {
				data: turns.slice(0, parameters.limit).map((turn) => ({
					...turn,
					items:
						parameters.itemsView === "summary"
							? turn.items.filter((item) => item.type === "userMessage").slice(0, 1)
							: turn.items,
				})),
				nextCursor: null,
			};
		});
		const read = (
			cursor: Parameters<typeof readNativeAgentConversationActivity>[0]["cursor"],
			observedAtMs: number,
		) =>
			readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: target,
				cursor,
				observedAtMs,
				shouldReadCodexNativeAgentTurnExecution: false,
			});
		const initial = await read(null, baselineAtMs);
		previousTurn.items.push({ id: "steering", type: "userMessage" });
		turns = [{ id: "after", status: "inProgress", items: [{ id: "new", type: "userMessage" }] }, previousTurn];
		fullReadFails = true;
		const fallback = await read(initial?.cursor ?? null, baselineAtMs + 1);
		expect(fallback?.events.map((event) => event.eventId)).toEqual(["codex:native:after:new"]);
		expect(fallback?.nativeActivityProjectionReadFailure).toContain("超时");
		expect(fallback?.cursor).toMatchObject({ predecessorTurnId: "before", lastAcceptedUserInputItemId: "old" });
		const repeatedFallback = await read(fallback?.cursor ?? null, baselineAtMs + 2);
		expect(repeatedFallback?.events).toEqual([]);
		fullReadFails = false;
		const recovered = await read(repeatedFallback?.cursor ?? null, baselineAtMs + 3);
		expect(recovered?.events.map((event) => event.eventId)).toEqual(["codex:native:before:steering"]);
		expect(recovered?.cursor).toMatchObject({ predecessorTurnId: "after", lastAcceptedUserInputItemId: "new" });
		const unchanged = await read(recovered?.cursor ?? null, baselineAtMs + 4);
		expect(unchanged?.events).toEqual([]);
	});
	it.each([
		{ fullReadFailsOnce: false, newHeadDuringRecovery: false },
		{ fullReadFailsOnce: true, newHeadDuringRecovery: false },
		{ fullReadFailsOnce: false, newHeadDuringRecovery: true },
	])("跨多页自动补出旧前驱输入，恢复边界=%j", async ({ fullReadFailsOnce, newHeadDuringRecovery }) => {
		const turns = [
			...Array.from({ length: 5 }, (_, index) => ({
				id: `turn-${5 - index}`,
				status: "completed",
				items: [{ id: `first-${5 - index}`, type: "userMessage" }],
			})),
			{
				id: "before",
				status: "completed",
				items: [
					{ id: "old", type: "userMessage" },
					...Array.from({ length: 800 }, (_, index) => ({ id: `tool-${index}`, type: "commandExecution" })),
					{ id: "steering", type: "userMessage" },
				],
			},
		];
		let fullPageFailureWasInjected = false;
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			if (
				fullReadFailsOnce &&
				!fullPageFailureWasInjected &&
				parameters.itemsView === "full" &&
				parameters.cursor === "4"
			) {
				fullPageFailureWasInjected = true;
				throw new Error("完整页暂不可用");
			}
			const offset = parameters.cursor === null ? 0 : Number(parameters.cursor);
			const page = turns.slice(offset, offset + Math.min(2, parameters.limit));
			return {
				data: page.map((turn) => ({
					...turn,
					items: parameters.itemsView === "summary" ? turn.items.slice(0, 1) : turn.items,
				})),
				nextCursor: offset + page.length < turns.length ? String(offset + page.length) : null,
			};
		});
		let cursor: Parameters<typeof readNativeAgentConversationActivity>[0]["cursor"] = {
			transport: "codex_control",
			predecessorTurnId: "before",
			lastAcceptedUserInputItemId: "old",
			acceptedSummaryUserInputEventIdsPendingFullRead: ["codex:native:turn-5:first-5"],
			seenEventIds: [],
		};
		const eventIds: Array<string | undefined> = [];
		for (let readIndex = 0; readIndex < 12; readIndex += 1) {
			if (newHeadDuringRecovery && readIndex === 3)
				turns.unshift({ id: "turn-6", status: "completed", items: [{ id: "first-6", type: "userMessage" }] });
			const result = await readNativeAgentConversationActivity({
				workspaceId: "workspace",
				summary: summary("codex", "/isolated/native.jsonl"),
				cursor,
				observedAtMs: baselineAtMs + readIndex,
				shouldReadCodexNativeAgentTurnExecution: false,
			});
			eventIds.push(...(result?.events.map((event) => event.eventId) ?? []));
			cursor = result?.cursor ?? null;
			if (!result?.codexFullMessageReadContinuation) break;
		}
		const expectedEventIds = fullReadFailsOnce
			? [
					"codex:native:turn-1:first-1",
					"codex:native:before:steering",
					"codex:native:turn-2:first-2",
					"codex:native:turn-3:first-3",
					"codex:native:turn-4:first-4",
				]
			: [
					"codex:native:before:steering",
					"codex:native:turn-1:first-1",
					"codex:native:turn-2:first-2",
					"codex:native:turn-3:first-3",
					"codex:native:turn-4:first-4",
				];
		if (newHeadDuringRecovery) expectedEventIds.push("codex:native:turn-6:first-6");
		expect(eventIds).toEqual(expectedEventIds);
		expect(cursor).toMatchObject({
			predecessorTurnId: newHeadDuringRecovery ? "turn-6" : "turn-5",
			lastAcceptedUserInputItemId: newHeadDuringRecovery ? "first-6" : "first-5",
		});
		expect(cursor).not.toHaveProperty("fullMessagePageReadRecovery");
		expect(
			request.mock.calls
				.filter(([method, parameters]) => method === "thread/turns/list" && parameters.itemsView === "full")
				.map(([, parameters]) => parameters.cursor),
		).toEqual(fullReadFailsOnce || newHeadDuringRecovery ? ["4", "4", "2", null] : ["4", "2", null]);
	});
	it.each([true, false])("待补完整前驱离开当前页时，存在更早分页=%s", async (hasOlderPage) => {
		const cursor = {
			transport: "codex_control" as const,
			predecessorTurnId: "before",
			lastAcceptedUserInputItemId: "old",
			acceptedSummaryUserInputEventIdsPendingFullRead: ["codex:native:after:new"],
			seenEventIds: [],
		};
		request.mockImplementation(async (method) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			return {
				data: [{ id: "after", status: "completed", items: [{ id: "new", type: "userMessage" }] }],
				nextCursor: hasOlderPage ? "earlier-turns" : null,
			};
		});
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: summary("codex", "/isolated/native.jsonl"),
			cursor,
			observedAtMs: baselineAtMs,
			shouldReadCodexNativeAgentTurnExecution: false,
		});
		expect(result?.events).toEqual([]);
		if (hasOlderPage) {
			expect(result?.cursor).toMatchObject({
				...cursor,
				fullMessagePageReadRecovery: { phase: "locating_predecessor", nextSummaryPageCursor: "earlier-turns" },
			});
			expect(result?.codexFullMessageReadContinuation?.madeProgress).toBe(true);
			expect(request).not.toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ itemsView: "full" }));
		} else {
			// 完整 summary 列表已证明前驱被移除，按 Rewind 建立当前分支基线。
			expect(result?.cursor).toMatchObject({ predecessorTurnId: "after", lastAcceptedUserInputItemId: "new" });
			expect(result?.cursor).not.toHaveProperty("acceptedSummaryUserInputEventIdsPendingFullRead");
		}
	});
	it.each([false, true])(
		"跨页证明旧前驱已移除后只建 Rewind 基线，基线完整读取再次失败=%s",
		async (baselineFailsOnce) => {
			let baselineFailureWasInjected = false;
			request.mockImplementation(async (method, parameters) => {
				if (method === "thread/loaded/list") return { data: ["native"] };
				if (parameters.itemsView === "full" && baselineFailsOnce && !baselineFailureWasInjected) {
					baselineFailureWasInjected = true;
					throw new Error("Rewind 基线暂不可读");
				}
				return parameters.cursor === null
					? {
							data: [{ id: "after", status: "completed", items: [{ id: "new", type: "userMessage" }] }],
							nextCursor: "older",
						}
					: {
							data: [
								{
									id: "historical",
									status: "completed",
									items: [{ id: "historical-input", type: "userMessage" }],
								},
							],
							nextCursor: null,
						};
			});
			let cursor: Parameters<typeof readNativeAgentConversationActivity>[0]["cursor"] = {
				transport: "codex_control",
				predecessorTurnId: "removed",
				lastAcceptedUserInputItemId: "old",
				acceptedSummaryUserInputEventIdsPendingFullRead: ["codex:native:after:new"],
				seenEventIds: [],
			};
			for (let readIndex = 0; readIndex < 5; readIndex += 1) {
				const result = await readNativeAgentConversationActivity({
					workspaceId: "workspace",
					summary: summary("codex", "/isolated/native.jsonl"),
					cursor,
					observedAtMs: baselineAtMs + readIndex,
					shouldReadCodexNativeAgentTurnExecution: false,
				});
				expect(result?.events).toEqual([]);
				cursor = result?.cursor ?? null;
				if (!result?.codexFullMessageReadContinuation) break;
			}
			expect(cursor).toMatchObject({ predecessorTurnId: "after", lastAcceptedUserInputItemId: "new" });
			expect(cursor).not.toHaveProperty("fullMessagePageReadRecovery");
		},
	);
	it("原生分页循环保留已推进的书签并返回无进展，避免重读第一页或发布旧输入", async () => {
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			return {
				data: [{ id: parameters.cursor === null ? "after" : "historical", status: "completed", items: [] }],
				nextCursor: "older",
			};
		});
		const input = {
			workspaceId: "workspace",
			summary: summary("codex", "/isolated/native.jsonl"),
			observedAtMs: baselineAtMs,
			shouldReadCodexNativeAgentTurnExecution: false,
		};
		const first = await readNativeAgentConversationActivity({
			...input,
			cursor: {
				transport: "codex_control",
				predecessorTurnId: "before",
				lastAcceptedUserInputItemId: "old",
				acceptedSummaryUserInputEventIdsPendingFullRead: [],
				seenEventIds: [],
			},
		});
		const looped = await readNativeAgentConversationActivity({ ...input, cursor: first?.cursor ?? null });
		expect(looped?.events).toEqual([]);
		expect(looped?.cursor).toEqual(first?.cursor);
		expect(looped?.codexFullMessageReadContinuation?.madeProgress).toBe(false);
		expect(looped?.nativeActivityProjectionReadFailure).toContain("分页没有向前推进");
		expect(request).toHaveBeenLastCalledWith("thread/turns/list", expect.objectContaining({ cursor: "older" }));
	});
	it("full 页未覆盖前驱时保留恢复位置，补齐后仅报告尚未消费的 steering", async () => {
		const previousTurn = {
			id: "before",
			status: "completed",
			items: [
				{ id: "old", type: "userMessage" },
				{ id: "steering", type: "userMessage" },
			],
		};
		const latestTurn = { id: "after", status: "inProgress", items: [{ id: "new", type: "userMessage" }] };
		let fullPageIsIncomplete = true;
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			if (parameters.itemsView === "full")
				return { data: fullPageIsIncomplete ? [latestTurn] : [latestTurn, previousTurn], nextCursor: "more" };
			return { data: [latestTurn, { ...previousTurn, items: previousTurn.items.slice(0, 1) }], nextCursor: null };
		});
		const input = {
			workspaceId: "workspace",
			summary: summary("codex", "/isolated/native.jsonl"),
			observedAtMs: baselineAtMs,
			shouldReadCodexNativeAgentTurnExecution: false,
		};
		const incomplete = await readNativeAgentConversationActivity({
			...input,
			cursor: {
				transport: "codex_control",
				predecessorTurnId: "before",
				lastAcceptedUserInputItemId: "old",
				seenEventIds: [],
			},
		});
		expect(incomplete?.events.map((event) => event.eventId)).toEqual(["codex:native:after:new"]);
		expect(incomplete?.cursor).toMatchObject({ predecessorTurnId: "before", lastAcceptedUserInputItemId: "old" });
		expect(incomplete?.nativeActivityProjectionReadFailure).toContain("保留恢复水位");
		fullPageIsIncomplete = false;
		const complete = await readNativeAgentConversationActivity({ ...input, cursor: incomplete?.cursor ?? null });
		expect(complete?.events.map((event) => event.eventId)).toEqual(["codex:native:before:steering"]);
		expect(complete?.cursor).toMatchObject({ predecessorTurnId: "after", lastAcceptedUserInputItemId: "new" });
	});

	it("原生进程已退出时仍从绑定转录补证历史接受，不查询或启动原生进程", async () => {
		const directory = await mkdtemp(join(tmpdir(), "kanban-offline-acceptance-"));
		directories.push(directory);
		const path = join(directory, "native.jsonl");
		await writeFile(
			path,
			`${[
				{ type: "session_meta", payload: { id: "native", cwd: "/isolated", source: "cli" } },
				{
					timestamp: new Date(baselineAtMs + 200).toISOString(),
					type: "event_msg",
					payload: {
						type: "item_completed",
						thread_id: "native",
						turn_id: "ended",
						item: { type: "UserMessage", id: "input", content: [{ type: "text", text: "继续" }] },
					},
				},
			]
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const target = {
			...summary("codex", path),
			codexNativeSessionControlEndpoint: null,
			agentConversationPromptSubmissionAcceptance: {
				status: "unconfirmed" as const,
				attemptedAtMs: baselineAtMs,
				runtimeSessionIncarnationId: "incarnation",
			},
		};
		const result = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs + 60_000,
		});
		expect(result?.events).toEqual([]);
		expect(result?.promptSubmissionAcceptanceReconciliation?.accepted).toEqual({
			eventId: "codex:native:ended:input",
			acceptedAtMs: baselineAtMs + 200,
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("单个回合超过 512 条工具记录后追加相同正文的新输入，独立水位只确认一次", async () => {
		const target = summary("codex", "/isolated/native.jsonl");
		const items = [
			{ id: "first", type: "userMessage", content: [{ type: "text", text: "继续" }] },
			...Array.from({ length: 800 }, (_, index) => ({ id: `tool-${index}`, type: "commandExecution" })),
		];
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list") return { data: ["native"] };
			if (method === "thread/read") return { thread: { id: "native", status: { type: "active" } } };
			return {
				data: [
					{ id: "current", status: "inProgress", items: parameters.itemsView === "summary" ? [items[0]] : items },
				],
			};
		});
		const initial = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: null,
			observedAtMs: baselineAtMs,
		});
		expect(initial?.events).toEqual([]);
		expect(initial?.cursor).toMatchObject({ lastAcceptedUserInputItemId: "first" });
		items.push({ id: "steering", type: "userMessage", content: [{ type: "text", text: "继续" }] });
		const added = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: initial?.cursor ?? null,
			observedAtMs: baselineAtMs + 1,
		});
		expect(added?.events).toMatchObject([{ eventId: "codex:native:current:steering", submittedPromptText: "继续" }]);
		const unchanged = await readNativeAgentConversationActivity({
			workspaceId: "workspace",
			summary: target,
			cursor: added?.cursor ?? null,
			observedAtMs: baselineAtMs + 2,
		});
		expect(unchanged?.events).toEqual([]);
	});

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
	it("旧活动游标超预算时建立独立接受水位，不重放历史接受", async () => {
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
		expect(result?.cursor).toMatchObject({ predecessorTurnId: "current", lastAcceptedUserInputItemId: "512" });
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
		).toHaveLength(4);
		expect(request).toHaveBeenCalledWith("thread/turns/list", {
			threadId: "native",
			cursor: null,
			limit: MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS,
			sortDirection: "desc",
			itemsView: "summary",
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
		request.mockImplementation(async (method) => {
			if (method === "thread/loaded/list") return { data: isLoaded ? ["native"] : [] };
			if (method === "thread/turns/list")
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
			isLoaded ? ["thread/loaded/list", "thread/turns/list", "thread/turns/list"] : ["thread/loaded/list"],
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
