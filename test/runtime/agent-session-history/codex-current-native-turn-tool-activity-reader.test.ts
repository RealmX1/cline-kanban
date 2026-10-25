import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodexCurrentNativeTurnToolActivityReadCursor,
	readCodexCurrentNativeTurnToolActivity,
} from "../../../src/agent-session-history/codex-current-native-turn-tool-activity-reader";
import { mergeLastEffectiveAgentConversationActivityObservation } from "../../../src/core/agent-conversation-activity-observation";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../../../src/core/codex-native-agent-turn-execution-observation";

const directories: string[] = [];
const NOW = 1_790_000_000_000;
const jsonLine = (type: string, payload: Record<string, unknown>, timestamp = NOW + 1) =>
	`${JSON.stringify({ type, payload, timestamp: new Date(timestamp).toISOString() })}\n`;
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "codex-native-turn-tool-activity-"));
	directories.push(directory);
	const transcriptPath = join(directory, "native.jsonl");
	const metadata = jsonLine("session_meta", { id: "native", source: "vscode", cwd: directory }, NOW - 1000);
	const start = jsonLine("event_msg", { type: "task_started", turn_id: "current" }, NOW - 1000);
	await writeFile(
		transcriptPath,
		metadata +
			start +
			jsonLine(
				"response_item",
				{ type: "custom_tool_call", name: "exec", call_id: "old", input: "旧调用" },
				NOW - 1000,
			),
	);
	const summary: RuntimeTaskSessionSummary = {
		taskId: "background-wait",
		agentId: "codex",
		state: "running",
		workspacePath: directory,
		pid: 12,
		startedAt: NOW - 1000,
		updatedAt: NOW,
		lastOutputAt: NOW,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath,
			observedAt: NOW,
		},
	};
	const execution: CodexNativeAgentTurnExecutionObservation = {
		workspaceId: "isolated",
		conversationSessionId: summary.taskId,
		runtimeSessionIncarnationId: "incarnation",
		nativeSessionId: "native",
		nativeTurnId: "current",
		nativeTurnStartedAtMs: NOW - 1000,
		observedAtMs: NOW,
		threadStatus: "active",
		nativeTurnStatus: "inProgress",
		activeFlags: [],
		canAcceptDirectInput: true,
		executionStatus: "running",
	};
	const read = (cursor: CodexCurrentNativeTurnToolActivityReadCursor | null, maximumReadBytes = 256 * 1024) =>
		readCodexCurrentNativeTurnToolActivity({
			summary,
			execution,
			cursor,
			observedAtMs: NOW + 10_000,
			maximumReadBytes,
		});
	// 首次基线按读取时刻固定，后续新增记录有自己的原始时间。
	const initial = await readCodexCurrentNativeTurnToolActivity({
		summary,
		execution,
		cursor: null,
		observedAtMs: NOW,
		maximumReadBytes: 256 * 1024,
	});
	return { transcriptPath, metadata, start, summary, execution, read, initial };
}

describe("当前原生回合工具活动的增量补充", () => {
	it("基线不重放历史；exec / write_stdin 空结果保留原始时间，重复读取不更新", async () => {
		const f = await fixture();
		expect(f.initial?.events).toEqual([]);
		await appendFile(
			f.transcriptPath,
			jsonLine("response_item", {
				type: "custom_tool_call",
				name: "exec",
				call_id: "new",
				input: "await tools.write_stdin({session_id:69092})",
			}) + jsonLine("response_item", { type: "custom_tool_call_output", call_id: "new", output: "" }, NOW + 2),
		);
		const result = await f.read(f.initial?.cursor ?? null);
		expect(result?.events.map((event) => [event.activityKind, event.observedAtMs])).toEqual([
			["tool_activity", NOW + 1],
			["tool_activity", NOW + 2],
		]);
		expect(
			result?.events.every(
				(event) =>
					event.nativeAgentResponsePromptCacheReferenceObservation === undefined &&
					event.evidenceKind === "persisted_agent_transcript",
			),
		).toBe(true);
		expect((await f.read(result?.cursor ?? null))?.events).toEqual([]);
	});
	it("扫描开始后追加的合法时间戳不会丢失，也不阻塞随后已到时的记录", async () => {
		const f = await fixture();
		const laterTool = jsonLine(
			"response_item",
			{ type: "function_call", name: "write_stdin", call_id: "later", arguments: "{}" },
			NOW + 5,
		);
		await appendFile(
			f.transcriptPath,
			laterTool +
				jsonLine(
					"response_item",
					{ type: "function_call", name: "write_stdin", call_id: "ready", arguments: "{}" },
					NOW + 1,
				),
		);
		const raced = await readCodexCurrentNativeTurnToolActivity({
			summary: f.summary,
			execution: f.execution,
			cursor: f.initial?.cursor ?? null,
			observedAtMs: NOW + 1,
			maximumReadBytes: 256 * 1024,
		});
		expect(raced?.events.some((event) => event.observedAtMs === NOW + 1)).toBe(true);
		const subsequent = await f.read(raced?.cursor ?? null);
		expect(
			[...(raced?.events ?? []), ...(subsequent?.events ?? [])].map((event) => event.observedAtMs).sort(),
		).toEqual([NOW + 1, NOW + 5]);
		await appendFile(f.transcriptPath, laterTool);
		expect((await f.read(subsequent?.cursor ?? null))?.events).toEqual([]);
	});
	it("远未来工具时间仍经实际时间门禁拒绝，工具事件不携带缓存参考", async () => {
		const f = await fixture();
		await appendFile(
			f.transcriptPath,
			jsonLine(
				"response_item",
				{ type: "function_call", name: "write_stdin", call_id: "forged-future", arguments: "{}" },
				NOW + 3_600_000,
			),
		);
		const result = await f.read(f.initial?.cursor ?? null);
		expect(result?.events).toHaveLength(1);
		const previous = {
			observedAtMs: NOW,
			evidenceKind: "persisted_agent_transcript",
			activityKind: "tool_activity",
		} as const;
		for (const event of result?.events ?? []) {
			expect(mergeLastEffectiveAgentConversationActivityObservation(previous, event, { nowMs: NOW + 100 })).toBe(
				previous,
			);
			expect(event.nativeAgentResponsePromptCacheReferenceObservation).toBeUndefined();
		}
	});
	it("半行不消费；完成后精确处理一次，接受用户输入不会从补充通道冒出", async () => {
		const f = await fixture();
		const tool = jsonLine("response_item", { type: "function_call", name: "wait", call_id: "wait", arguments: "{}" });
		await appendFile(f.transcriptPath, tool.slice(0, -2));
		const partial = await f.read(f.initial?.cursor ?? null);
		expect(partial?.events).toEqual([]);
		expect(partial?.cursor.nextByteOffset).toBe(f.initial?.cursor.nextByteOffset);
		await appendFile(
			f.transcriptPath,
			tool.slice(-2) +
				jsonLine("response_item", {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "不许补确认" }],
				}),
		);
		expect((await f.read(partial?.cursor ?? null))?.events).toHaveLength(1);
	});
	it("过滤旧回合、rewind 后未确认片段、合成和子代理记录", async () => {
		const f = await fixture();
		const payload = { type: "custom_tool_call", name: "exec", call_id: "filtered", input: "ignored" };
		await appendFile(
			f.transcriptPath,
			JSON.stringify({
				type: "response_item",
				synthetic: true,
				payload,
				timestamp: new Date(NOW + 1).toISOString(),
			}) +
				"\n" +
				JSON.stringify({
					type: "response_item",
					isSidechain: true,
					payload,
					timestamp: new Date(NOW + 1).toISOString(),
				}) +
				"\n" +
				jsonLine("event_msg", { type: "task_started", turn_id: "old-branch" }) +
				jsonLine("response_item", payload) +
				jsonLine("event_msg", { type: "thread_rolled_back" }) +
				jsonLine("response_item", payload),
		);
		expect((await f.read(f.initial?.cursor ?? null))?.events).toEqual([]);
	});
	it("已完成回合之后的旧追加结果不作为进行中的工具活动", async () => {
		const f = await fixture();
		await appendFile(
			f.transcriptPath,
			jsonLine("event_msg", { type: "task_complete", turn_id: "current" }) +
				jsonLine("response_item", { type: "custom_tool_call_output", call_id: "old", output: "迟到旧结果" }),
		);
		expect((await f.read(f.initial?.cursor ?? null))?.events).toEqual([]);
	});
	it("转录替换与截断建立新基线，不把历史当成新活动", async () => {
		const f = await fixture();
		await rename(f.transcriptPath, `${f.transcriptPath}.old`);
		await writeFile(
			f.transcriptPath,
			f.metadata +
				f.start +
				jsonLine("response_item", {
					type: "custom_tool_call",
					name: "exec",
					call_id: "replacement",
					input: "history",
				}),
		);
		expect((await f.read(f.initial?.cursor ?? null))?.events).toEqual([]);
	});
	it("超预算基线分段验证完整边界，历史工具与当前增量仍分开", async () => {
		const f = await fixture();
		await writeFile(
			f.transcriptPath,
			f.metadata +
				f.start +
				Array.from({ length: 40 }, (_, index) =>
					jsonLine(
						"response_item",
						{ type: "custom_tool_call", name: "exec", call_id: `history-${index}`, input: "历史" },
						NOW - 1000,
					),
				).join(""),
		);
		let result = await readCodexCurrentNativeTurnToolActivity({
			summary: f.summary,
			execution: f.execution,
			cursor: null,
			observedAtMs: NOW,
			maximumReadBytes: 500,
		});
		let reads = 1;
		while (result?.moreAppendedTranscriptBytesRemain && reads++ < 50) {
			expect(result.events).toEqual([]);
			result = await f.read(result.cursor, 500);
		}
		expect(reads).toBeGreaterThan(1);
		expect(result?.events).toEqual([]);
		await appendFile(
			f.transcriptPath,
			jsonLine("response_item", { type: "custom_tool_call", name: "exec", call_id: "fresh", input: "新工具" }),
		);
		expect((await f.read(result?.cursor ?? null, 500))?.events).toHaveLength(1);
	});
	it.each([
		["首次历史扫描", "thread_rolled_back"],
		["已有基线后的增量", "thread_rolled_back"],
		["首次历史扫描", "message"],
		["已有基线后的增量", "function_call_output"],
	])("%s 跨片跳过超长 %s 记录后恢复新回合", async (phase, payloadType) => {
		const f = await fixture();
		const readBudgetBytes = 256 * 1024;
		const oversizedBoundary = jsonLine(payloadType === "thread_rolled_back" ? "event_msg" : "response_item", {
			type: payloadType,
			role: "user",
			call_id: "oversized-record",
			additional_details: "回退".repeat(readBudgetBytes),
		});
		const resumedTurn =
			jsonLine("response_item", { type: "function_call", call_id: "unverified", arguments: "{}" }) + f.start;
		const initialHistoryScan = phase === "首次历史扫描";
		if (initialHistoryScan) await writeFile(f.transcriptPath, f.metadata + f.start + oversizedBoundary + resumedTurn);
		else await appendFile(f.transcriptPath, oversizedBoundary + resumedTurn);
		let result = await readCodexCurrentNativeTurnToolActivity({
			summary: f.summary,
			execution: f.execution,
			cursor: initialHistoryScan ? null : (f.initial?.cursor ?? null),
			observedAtMs: NOW,
			maximumReadBytes: readBudgetBytes,
		});
		let reads = 1;
		while (result?.moreAppendedTranscriptBytesRemain && reads++ < 20) {
			expect(result.events).toEqual([]);
			const previousByteOffset = result.cursor.nextByteOffset;
			result = await f.read(result.cursor, readBudgetBytes);
			expect(result?.cursor.nextByteOffset).toBeGreaterThan(previousByteOffset);
			expect((result?.cursor.nextByteOffset ?? 0) - previousByteOffset).toBeLessThanOrEqual(readBudgetBytes);
		}
		expect(reads).toBeGreaterThan(2);
		expect(reads).toBeLessThan(20);
		expect(result?.events).toEqual([]);
		expect(result?.cursor.transcriptNativeTurnId).toBe("current");
		await appendFile(
			f.transcriptPath,
			jsonLine("response_item", { type: "function_call", call_id: "recovered", arguments: "{}" }),
		);
		expect((await f.read(result?.cursor ?? null))?.events).toHaveLength(1);
	});
	it("超长未完成行逐片前进，补齐换行前不采信片段，也不沿用旧回合", async () => {
		const f = await fixture();
		const readBudgetBytes = 256 * 1024;
		const oversizedBoundary = jsonLine("event_msg", {
			type: "task_complete",
			additional_details: "x".repeat(2 * readBudgetBytes),
		});
		await appendFile(f.transcriptPath, oversizedBoundary.slice(0, -1));
		let result = await f.read(f.initial?.cursor ?? null, readBudgetBytes);
		for (let reads = 1; result?.moreAppendedTranscriptBytesRemain && reads < 10; reads++) {
			const previousByteOffset = result.cursor.nextByteOffset;
			result = await f.read(result.cursor, readBudgetBytes);
			expect(result?.cursor.nextByteOffset).toBeGreaterThan(previousByteOffset);
		}
		expect(result?.events).toEqual([]);
		expect(result?.cursor.transcriptNativeTurnId).toBeNull();
		await appendFile(
			f.transcriptPath,
			"\n" +
				jsonLine("response_item", { type: "function_call", call_id: "no-boundary", arguments: "{}" }) +
				f.start +
				jsonLine("response_item", { type: "function_call", call_id: "after-boundary", arguments: "{}" }),
		);
		const recovered = await f.read(result?.cursor ?? null, readBudgetBytes);
		expect(recovered?.events).toHaveLength(1);
		expect(recovered?.events[0]?.eventId).toContain(":after-boundary:");
	});
});
