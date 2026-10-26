import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodexPromptSubmissionAcceptanceReconciliation,
	reconcileCodexPromptSubmissionAcceptance,
	submittedPromptSha256,
} from "../../../src/agent-session-history/codex-prompt-submission-acceptance-reconciliation";
import {
	type RuntimeTaskSessionSummary,
	runtimeAgentConversationPromptSubmissionAcceptanceSchema,
} from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const attemptedAtMs = Date.parse("2026-10-25T10:00:00Z");
function nativeUser(id: string, delta = 200, text = "继续") {
	return {
		timestamp: new Date(attemptedAtMs + delta).toISOString(),
		type: "event_msg",
		payload: {
			type: "item_completed",
			thread_id: "native",
			turn_id: "turn",
			item: { type: "UserMessage", id, content: [{ type: "text", text }] },
		},
	};
}
async function fixture(records: unknown[]) {
	const directory = await mkdtemp(join(tmpdir(), "kanban-acceptance-reconciliation-"));
	directories.push(directory);
	const path = join(directory, "native.jsonl");
	await writeFile(
		path,
		`${[{ type: "session_meta", payload: { id: "native", cwd: "/isolated", source: "cli" } }, ...records]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	);
	const summary: RuntimeTaskSessionSummary = applySessionFacets({
		taskId: "task",
		agentId: "codex",
		state: "awaiting_review",
		workspacePath: "/isolated",
		pid: 12,
		startedAt: attemptedAtMs - 1000,
		updatedAt: attemptedAtMs,
		lastOutputAt: attemptedAtMs,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: path,
			observedAt: attemptedAtMs,
		},
		agentConversationPromptSubmissionAcceptance: {
			status: "unconfirmed",
			attemptedAtMs,
			runtimeSessionIncarnationId: "incarnation",
		},
	});
	return { summary, path };
}

function persistVerificationThroughSchema(
	summary: RuntimeTaskSessionSummary,
	verification: CodexPromptSubmissionAcceptanceReconciliation["verification"],
) {
	summary.agentConversationPromptSubmissionAcceptance = runtimeAgentConversationPromptSubmissionAcceptanceSchema.parse(
		JSON.parse(JSON.stringify({ ...summary.agentConversationPromptSubmissionAcceptance, verification })),
	);
}

describe("Codex 持久提交标记的只读接受补证", () => {
	it("原生接受保留事件时间；旧标记仅有唯一且紧邻提交的记录才补证", async () => {
		const { summary } = await fixture([nativeUser("old", -1), nativeUser("input")]);
		const result = await reconcileCodexPromptSubmissionAcceptance({
			summary,
			observedAtMs: attemptedAtMs + 60_000,
		});
		expect(result?.accepted).toEqual({ eventId: "codex:native:turn:input", acceptedAtMs: attemptedAtMs + 200 });
	});
	it("观察起点之后落盘的接受记录跨 schema 往返后到时核验，不被 EOF 或耗尽的缺证重试吞掉", async () => {
		const { summary, path } = await fixture([]);
		const observedAtMs = attemptedAtMs + 100;
		await appendFile(path, `${JSON.stringify(nativeUser("input"))}\n`);
		if (summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.verification = {
				checkedAtMs: attemptedAtMs,
				nextCheckAtMs: null,
				consecutiveUnchangedCheckCount: 4,
				reason: "no_matching_native_message",
			};
		const first = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs });
		if (!first) throw new Error("首轮核验没有返回进度");
		expect(first.accepted).toBeUndefined();
		expect(first.verification.matchingNativeMessages?.[0]).toMatchObject({
			eventId: "codex:native:turn:input",
			acceptedAtMs: attemptedAtMs + 200,
		});
		expect(first.verification.nextCheckAtMs).toBe(attemptedAtMs + 200);
		expect(first.verification.consecutiveUnchangedCheckCount).toBe(0);
		persistVerificationThroughSchema(summary, first.verification);
		expect(await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 199 })).toBeNull();
		expect(
			(await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 200 }))?.accepted,
		).toEqual({ eventId: "codex:native:turn:input", acceptedAtMs: attemptedAtMs + 200 });
	});
	it("已有未来事件等待原始时刻，单次重验延迟不超过 Node 定时器上限", async () => {
		const acceptedDeltaMs = 2_147_483_647 + 60_000;
		const { summary } = await fixture([nativeUser("input", acceptedDeltaMs)]);
		if (summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.submittedPromptSha256 = submittedPromptSha256("继续");
		const observedAtMs = attemptedAtMs + 100;
		const first = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs });
		if (!first) throw new Error("未来事件没有返回重验条件");
		expect(first.accepted).toBeUndefined();
		expect(first.verification.nextCheckAtMs).toBe(observedAtMs + 2_147_483_647);
		persistVerificationThroughSchema(summary, first.verification);
		const second = await reconcileCodexPromptSubmissionAcceptance({
			summary,
			observedAtMs: first.verification.nextCheckAtMs ?? 0,
		});
		if (!second) throw new Error("到达持久重验条件后未继续");
		expect(second.accepted).toBeUndefined();
		expect(second.verification.consecutiveUnchangedCheckCount).toBe(0);
		expect(second.verification.nextCheckAtMs).toBe(attemptedAtMs + acceptedDeltaMs);
		persistVerificationThroughSchema(summary, second.verification);
		expect(
			(
				await reconcileCodexPromptSubmissionAcceptance({
					summary,
					observedAtMs: attemptedAtMs + acceptedDeltaMs,
				})
			)?.accepted?.acceptedAtMs,
		).toBe(attemptedAtMs + acceptedDeltaMs);
	});
	it("未来候选仍受工具类型、正文与唯一性门禁约束", async () => {
		const tool = nativeUser("tool");
		Object.assign(tool.payload.item, { type: "function_call_output" });
		const { summary } = await fixture([
			tool,
			nativeUser("different", 200, "其他正文"),
			nativeUser("first"),
			nativeUser("second", 300),
		]);
		if (summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.submittedPromptSha256 = submittedPromptSha256("继续");
		const first = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 100 });
		if (!first) throw new Error("未来候选没有返回核验结果");
		expect(first.accepted).toBeUndefined();
		expect(first.verification.matchingNativeMessages?.map((message) => message.nativeItemId)).toEqual([
			"first",
			"second",
		]);
		persistVerificationThroughSchema(summary, first.verification);
		const second = await reconcileCodexPromptSubmissionAcceptance({
			summary,
			observedAtMs: first.verification.nextCheckAtMs ?? attemptedAtMs + 60_000,
		});
		expect(second?.accepted).toBeUndefined();
		expect(second?.verification.reason).toBe("ambiguous_native_messages");
	});
	it("尚未到时刻的候选不能跨文件替换继承", async () => {
		const { summary, path } = await fixture([nativeUser("input")]);
		const first = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 100 });
		if (!first) throw new Error("未来候选没有返回核验结果");
		persistVerificationThroughSchema(summary, first.verification);
		const replacementPath = `${path}.replacement`;
		await writeFile(
			replacementPath,
			`${JSON.stringify({ type: "session_meta", payload: { id: "native", cwd: "/isolated", source: "cli" } })}\n`,
		);
		await rename(replacementPath, path);
		const second = await reconcileCodexPromptSubmissionAcceptance({
			summary,
			observedAtMs: attemptedAtMs + 60_000,
		});
		expect(second?.accepted).toBeUndefined();
		expect(second?.verification.matchingNativeMessages).toEqual([]);
	});
	it("重启后的 observer 无需新摘要或追加记录即可按持久时刻自动重验", async () => {
		const { summary } = await fixture([nativeUser("input")]);
		const first = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 100 });
		if (!first) throw new Error("未来候选没有返回核验结果");
		persistVerificationThroughSchema(summary, first.verification);
		vi.useFakeTimers();
		vi.setSystemTime(attemptedAtMs + 100);
		let finishReconciliation: (result: CodexPromptSubmissionAcceptanceReconciliation) => void = () => {};
		const accepted = new Promise<CodexPromptSubmissionAcceptanceReconciliation>((resolve) => {
			finishReconciliation = resolve;
		});
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			readNativeActivity: async (input) => ({
				events: [],
				cursor: null,
				promptSubmissionAcceptanceReconciliation: await reconcileCodexPromptSubmissionAcceptance({
					summary: input.summary,
					observedAtMs: input.observedAtMs,
					force: input.forcePromptSubmissionAcceptanceReconciliation,
				}),
			}),
			onPromptSubmissionAcceptanceReconciliation(_sessionId, _workspaceId, result) {
				persistVerificationThroughSchema(summary, result.verification);
				if (result.accepted) {
					if (summary.agentConversationPromptSubmissionAcceptance)
						summary.agentConversationPromptSubmissionAcceptance.status = "accepted";
					finishReconciliation(result);
				}
			},
		});
		try {
			await observer.observeTaskSessionSummary("workspace", summary, () => summary);
			expect(summary.agentConversationPromptSubmissionAcceptance?.status).toBe("unconfirmed");
			await vi.advanceTimersByTimeAsync(250);
			expect((await accepted).accepted).toEqual({
				eventId: "codex:native:turn:input",
				acceptedAtMs: attemptedAtMs + 200,
			});
			expect(summary.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted");
			expect(onAccepted).not.toHaveBeenCalled();
		} finally {
			observer.dispose();
			vi.useRealTimers();
		}
	});
	it("后续 Rewind 保留原先有效的接受事实，不据此恢复执行", async () => {
		const { summary } = await fixture([
			nativeUser("input"),
			{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
		]);
		expect(
			(await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 60_000 }))?.accepted
				?.eventId,
		).toBe("codex:native:turn:input");
	});

	it.each(["no_input", "older_input", "late_unrelated_input", "ambiguous", "wrong_thread"])(
		"%s 保留未知，不从活动或旧消息推导接受",
		async (scenario) => {
			const records =
				scenario === "no_input"
					? [{ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }]
					: scenario === "older_input"
						? [nativeUser("input", -1)]
						: scenario === "late_unrelated_input"
							? [nativeUser("input", 16_000)]
							: scenario === "ambiguous"
								? [nativeUser("input"), nativeUser("second", 300)]
								: [nativeUser("input")];
			if (scenario === "wrong_thread")
				Object.assign(records[0], { payload: { ...nativeUser("input").payload, thread_id: "other" } });
			const { summary } = await fixture(records);
			expect(
				(await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 60_000 }))
					?.accepted,
			).toBeUndefined();
		},
	);
	it("Compact 期间延后的正文按摘要关联，同回合 steering 由独立原生接受记录核验", async () => {
		const { summary } = await fixture([nativeUser("input", 90_000)]);
		if (summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.submittedPromptSha256 = submittedPromptSha256("继续");

		expect(
			(await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 100_000 }))?.accepted,
		).toBeDefined();
	});
	it("超长工具行与多段历史可持续前进，schema 往返后续扫，不重读整个文件", async () => {
		const { summary } = await fixture([
			{ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(4000) } },
			nativeUser("input"),
		]);
		let result = null;
		let previousOffset = -1;
		for (let attempt = 0; attempt < 30; attempt += 1) {
			result = await reconcileCodexPromptSubmissionAcceptance({
				summary,
				observedAtMs: attemptedAtMs + 60_000 + attempt * 1000,
				maximumReadBytes: 512,
			});
			if (!result) throw new Error("补证未返回扫描进度");
			const offset = result.verification.transcriptCursor?.nextByteOffset ?? 0;
			expect(offset).toBeGreaterThan(previousOffset);
			previousOffset = offset;
			if (result.accepted) break;
			summary.agentConversationPromptSubmissionAcceptance =
				runtimeAgentConversationPromptSubmissionAcceptanceSchema.parse(
					JSON.parse(
						JSON.stringify({
							...summary.agentConversationPromptSubmissionAcceptance,
							verification: result.verification,
						}),
					),
				);
		}
		expect(result?.accepted?.eventId).toBe("codex:native:turn:input");
	});
	it("转录被替换或截断后重新核对归属，旧匹配不能带入新文件", async () => {
		const { summary, path } = await fixture([nativeUser("input"), { type: "noise", text: "x".repeat(2000) }]);
		const first = await reconcileCodexPromptSubmissionAcceptance({
			summary,
			observedAtMs: attemptedAtMs + 60_000,
			maximumReadBytes: 1024,
		});
		if (summary.agentConversationPromptSubmissionAcceptance)
			summary.agentConversationPromptSubmissionAcceptance.verification = first?.verification;
		await writeFile(
			path,
			`${JSON.stringify({ type: "session_meta", payload: { id: "different", cwd: "/isolated", source: "cli" } })}\n`,
		);
		const second = await reconcileCodexPromptSubmissionAcceptance({ summary, observedAtMs: attemptedAtMs + 61_000 });
		expect(second?.accepted).toBeUndefined();
		expect(second?.verification.reason).toBe("native_identity_changed");
	});

	it("无变化三次后取消定时重试，新的证据可显式唤醒", async () => {
		const { summary } = await fixture([]);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const result = await reconcileCodexPromptSubmissionAcceptance({
				summary,
				observedAtMs: attemptedAtMs + (attempt + 1) * 120_000,
			});
			if (summary.agentConversationPromptSubmissionAcceptance)
				summary.agentConversationPromptSubmissionAcceptance.verification = result?.verification;
		}
		expect(summary.agentConversationPromptSubmissionAcceptance?.verification?.nextCheckAtMs).toBeNull();
	});
});
