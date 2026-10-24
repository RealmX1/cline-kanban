import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { canReconcileCodexNeedsInputWithNativeDirectInputReadiness } from "../../../src/core/codex-native-direct-input-readiness";
import { applySessionFacets } from "../../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Codex 原生待输入核验的有界重试", () => {
	const observers: ReturnType<typeof createNativeAgentConversationActivityObserver>[] = [];
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
	});
	afterEach(() => {
		for (const observer of observers.splice(0)) observer.dispose();
		vi.useRealTimers();
	});
	function fixture(cooldownMs = 1_000) {
		const state: {
			summary: RuntimeTaskSessionSummary;
			nativeReadinessAvailable: boolean;
			nativeReadIsUnknown: boolean;
		} = {
			summary: {
				taskId: "conversation-main",
				state: "awaiting_review",
				agentId: "codex",
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "needs_input",
				workspacePath: "/isolated",
				pid: 12,
				startedAt: 1,
				updatedAt: Date.now(),
				lastOutputAt: 1,
				reviewReason: "hook",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				runtimeSessionIncarnationId: "incarnation-1",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: "main",
					transcriptPath: "/isolated/main.jsonl",
					observedAt: 1,
				},
				codexNativeSessionControlEndpoint: {
					workspaceId: "workspace",
					conversationSessionId: "conversation-main",
					runtimeSessionIncarnationId: "incarnation-1",
					socketPath: "/isolated/control.sock",
				},
			},
			nativeReadinessAvailable: false,
			nativeReadIsUnknown: false,
		};
		const readNativeActivity = vi.fn(
			async (
				input: ReadNativeAgentConversationActivityInput,
			): Promise<NativeAgentConversationActivityReadResult | null> =>
				state.nativeReadIsUnknown
					? null
					: {
							events: [],
							cursor: { transport: "codex_control", predecessorTurnId: null, seenEventIds: [] },
							...(state.nativeReadinessAvailable
								? {
										codexNativeDirectInputReadiness: {
											nativeSessionId: "main",
											observedAtMs: input.observedAtMs,
										},
									}
								: {}),
						},
		);
		const onAccepted = vi.fn();
		const onActivity = vi.fn();
		const onNativeReadiness = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			onActivity,
			readNativeActivity,
			cooldownMs,
			onCodexNativeDirectInputReadiness(observation, before) {
				onNativeReadiness(observation, before);
				if (canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, state.summary, observation))
					state.summary = { ...state.summary, userTurnKind: "review" };
			},
		});
		observers.push(observer);
		const observe = () => observer.observeTaskSessionSummary("workspace", state.summary, () => state.summary);
		const rewind = () => {
			state.summary = {
				...state.summary,
				updatedAt: Date.now(),
				lastHookAt: Date.now(),
				latestHookActivity: {
					source: "codex",
					hookEventName: "thread_rolled_back",
					activityText: "Codex 对话已回退，等待原生状态核验",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					notificationType: null,
				},
			};
		};
		return { state, observe, rewind, readNativeActivity, onAccepted, onActivity, onNativeReadiness };
	}

	it.each(["active", "unknown"])("旧窗口过期后，新 rewind 的首次 %s 结果仍会在窗口内补读", async (mode) => {
		const target = fixture();
		target.state.nativeReadIsUnknown = mode === "unknown";
		await target.observe();
		await vi.advanceTimersByTimeAsync(6_000);
		const readsAfterExpiration = target.readNativeActivity.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(readsAfterExpiration);
		target.rewind();
		await target.observe();
		target.state.nativeReadIsUnknown = false;
		target.state.nativeReadinessAvailable = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(target.state.summary.userTurnKind).toBe("review");
		expect(target.onAccepted).not.toHaveBeenCalled();
		expect(target.onActivity).not.toHaveBeenCalled();
	});

	it("cooldown 内进入待输入并发生 rewind 时，仍自动补读而无需新摘要", async () => {
		const target = fixture();
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		await target.observe();
		await vi.advanceTimersByTimeAsync(1);
		target.state.summary = { ...target.state.summary, userTurnKind: "needs_input" };
		target.rewind();
		await target.observe();
		expect(target.readNativeActivity).toHaveBeenCalledTimes(1);
		target.state.nativeReadinessAvailable = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(target.state.summary.userTurnKind).toBe("review");
		expect(target.onAccepted).not.toHaveBeenCalled();
		expect(target.onActivity).not.toHaveBeenCalled();
	});

	it.each(["rewind", "redraw"])("新窗口的在途读取因并发 %s 摘要失效后，继续读取最新摘要", async (change) => {
		const target = fixture();
		await target.observe();
		await vi.advanceTimersByTimeAsync(6_000);
		target.rewind();
		let release: ((result: NativeAgentConversationActivityReadResult) => void) | undefined;
		target.readNativeActivity.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const pending = target.observe();
		await vi.advanceTimersByTimeAsync(0);
		const readsBeforeConcurrentSummary = target.readNativeActivity.mock.calls.length;
		await vi.advanceTimersByTimeAsync(50);
		if (change === "rewind") target.rewind();
		else target.state.summary = { ...target.state.summary, updatedAt: Date.now(), lastOutputAt: Date.now() };
		const concurrent = target.observe();
		release?.({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: null, seenEventIds: [] },
			codexNativeDirectInputReadiness: { nativeSessionId: "main", observedAtMs: Date.now() },
		});
		await Promise.all([pending, concurrent]);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(readsBeforeConcurrentSummary);
		expect(target.onNativeReadiness).toHaveBeenCalledTimes(1);
		expect(target.state.summary.userTurnKind).toBe("needs_input");
		target.state.nativeReadinessAvailable = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(target.onNativeReadiness).toHaveBeenCalledTimes(2);
		expect(target.state.summary.userTurnKind).toBe("review");
	});

	it("重绘、重复 rewind 摘要和窗口自身重试都不能延长期限或重新武装同一触发", async () => {
		const target = fixture();
		target.rewind();
		await target.observe();
		await vi.advanceTimersByTimeAsync(4_500);
		target.state.summary = {
			...target.state.summary,
			updatedAt: Date.now(),
			lastOutputAt: Date.now(),
			latestHookActivity: target.state.summary.latestHookActivity && { ...target.state.summary.latestHookActivity },
		};
		await target.observe();
		await vi.advanceTimersByTimeAsync(499);
		const readsBeforeExpiration = target.readNativeActivity.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_501);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(readsBeforeExpiration);
		await target.observe();
		expect(target.readNativeActivity).toHaveBeenCalledTimes(readsBeforeExpiration + 1);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(readsBeforeExpiration + 1);
	});

	it("旧窗口过期后离开再进入 needs_input 会创建新窗口", async () => {
		const target = fixture(0);
		await target.observe();
		await vi.advanceTimersByTimeAsync(6_000);
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		await target.observe();
		target.state.summary = { ...target.state.summary, userTurnKind: "needs_input" };
		await target.observe();
		target.state.nativeReadinessAvailable = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(target.state.summary.userTurnKind).toBe("review");
	});
});

async function transcriptFixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-native-accepted-observer-"));
	directories.push(directory);
	const transcriptPath = join(directory, "main.jsonl");
	await writeFile(transcriptPath, "");
	const summary = applySessionFacets({
		taskId: "conversation-main",
		state: "idle",
		agentId: "claude",
		workspacePath: directory,
		pid: 12,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation-1",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId: "main",
			transcriptPath,
			observedAt: 1,
		},
	});
	return { transcriptPath, summary };
}

function userRecord(uuid: string) {
	return {
		type: "user",
		promptSource: "typed",
		sessionId: "main",
		uuid,
		timestamp: "2026-10-22T10:00:00Z",
		message: { role: "user", content: "相同正文" },
	};
}

describe("原生会话的可靠输入接受边沿", () => {
	it("首次读取无新增消息仍交付独立的原生就绪观测，且不调用接受或活动出口", async () => {
		const { summary } = await transcriptFixture();
		const target = {
			...summary,
			agentId: "codex" as const,
			turnOwner: "user" as const,
			liveness: "live" as const,
			userTurnKind: "needs_input" as const,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex" as const,
				nativeSessionId: "main",
				transcriptPath: "/isolated/main.jsonl",
				observedAt: 1,
			},
		};
		const onAccepted = vi.fn();
		const onActivity = vi.fn();
		const onCodexNativeDirectInputReadiness = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			onActivity,
			onCodexNativeDirectInputReadiness,
			readNativeActivity: async () => ({
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: null, seenEventIds: [] },
				codexNativeDirectInputReadiness: { nativeSessionId: "main", observedAtMs: 2 },
			}),
		});
		await observer.observeTaskSessionSummary("workspace", target, () => target);
		expect(onCodexNativeDirectInputReadiness).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationSessionId: target.taskId,
				runtimeSessionIncarnationId: "incarnation-1",
				nativeSessionId: "main",
			}),
			target,
		);
		expect(onAccepted).not.toHaveBeenCalled();
		expect(onActivity).not.toHaveBeenCalled();
		observer.dispose();
	});
	it("初始化只建基线；新增真实用户记录立即确认，重复正文按原生消息身份区分", async () => {
		const { transcriptPath, summary } = await transcriptFixture();
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("old"))}\n`);
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			cooldownMs: 0,
			nowMs: () => Date.parse("2026-10-22T09:00:00Z"),
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).not.toHaveBeenCalled();
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("new-1"))}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(1);
		expect(onAccepted.mock.calls[0]?.[0]).toMatchObject({
			conversationSessionId: "conversation-main",
			nativeSessionId: "main",
			evidenceKind: "native_user_prompt_acceptance",
			eventId: "claude:main:new-1",
		});
		await appendFile(transcriptPath, `${JSON.stringify(userRecord("new-2"))}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(2);
		observer.dispose();
	});

	it("工具结果、侧链、系统通知、压缩摘要和 synthetic 输入不能确认用户提交", async () => {
		const { transcriptPath, summary } = await transcriptFixture();
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			cooldownMs: 0,
			nowMs: () => Date.parse("2026-10-22T09:00:00Z"),
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		const records = [
			{ ...userRecord("tool"), message: { role: "user", content: [{ type: "tool_result", content: "done" }] } },
			{ ...userRecord("sidechain"), isSidechain: true },
			{ ...userRecord("synthetic"), synthetic: true },
			{ ...userRecord("summary"), isCompactSummary: true },
			{ ...userRecord("notice"), message: { role: "user", content: "<task-notification>完成</task-notification>" } },
			{
				...userRecord("notice-with-image"),
				message: {
					role: "user",
					content: [
						{ type: "text", text: "<task-notification>完成</task-notification>" },
						{ type: "image", source: { type: "base64", data: "fixture" } },
					],
				},
			},
		];
		await appendFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).not.toHaveBeenCalled();
		observer.dispose();
	});

	it.each(["incarnation", "native_session", "transcript_path"])(
		"原生查询期间 %s 已替换时丢弃旧结果",
		async (change) => {
			const { summary } = await transcriptFixture();
			const onAccepted = vi.fn();
			let current: RuntimeTaskSessionSummary = summary;
			let release: ((value: NativeAgentConversationActivityReadResult) => void) | undefined;
			const readNativeActivity = vi.fn(
				() =>
					new Promise<NativeAgentConversationActivityReadResult>((resolve) => {
						release = resolve;
					}),
			);
			const observer = createNativeAgentConversationActivityObserver({ onAccepted, readNativeActivity });
			const pending = observer.observeTaskSessionSummary("workspace", summary, () => current);
			await vi.waitFor(() => expect(readNativeActivity).toHaveBeenCalledTimes(1));
			current =
				change === "incarnation"
					? { ...summary, runtimeSessionIncarnationId: "incarnation-replaced" }
					: {
							...summary,
							agentNativeConversationSessionIdentity: {
								sourceAgentId: "claude",
								nativeSessionId: change === "native_session" ? "replacement" : "main",
								transcriptPath:
									change === "transcript_path" ? "/isolated/replacement.jsonl" : "/isolated/main.jsonl",
								observedAt: 1,
							},
						};
			release?.({
				events: [
					{
						activityKind: "accepted_user_input",
						observedAtMs: 2,
						evidenceKind: "native_user_prompt_acceptance",
						eventId: "old-query",
						nativeSessionId: "main",
					},
				],
				cursor: { transport: "codex_control", predecessorTurnId: "turn", seenEventIds: [] },
			});
			await pending;
			expect(onAccepted).not.toHaveBeenCalled();
			observer.dispose();
		},
	);

	it("下游接受处理失败时不提交游标，下一次核验可重试同一原生事件", async () => {
		const { summary } = await transcriptFixture();
		const onAccepted = vi.fn().mockRejectedValueOnce(new Error("暂时无法保存卡片")).mockResolvedValue(undefined);
		const onReadFailed = vi.fn();
		const readNativeActivity = vi.fn(
			async (
				_input: ReadNativeAgentConversationActivityInput,
			): Promise<NativeAgentConversationActivityReadResult> => ({
				events: [
					{
						observedAtMs: 2,
						activityKind: "accepted_user_input",
						evidenceKind: "native_user_prompt_acceptance",
						eventId: "same-event",
						nativeSessionId: "main",
					},
				],
				cursor: { transport: "codex_control", predecessorTurnId: "turn", seenEventIds: ["same-event"] },
			}),
		);
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			onReadFailed,
			readNativeActivity,
			cooldownMs: 0,
		});
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		await observer.observeTaskSessionSummary("workspace", summary, () => summary);
		expect(onAccepted).toHaveBeenCalledTimes(2);
		expect(onReadFailed).toHaveBeenCalledTimes(1);
		expect(readNativeActivity.mock.calls.map(([input]) => input.cursor)).toEqual([null, null]);
		observer.dispose();
	});
});
