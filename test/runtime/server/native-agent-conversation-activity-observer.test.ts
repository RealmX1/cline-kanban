import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import { readNativeAgentConversationActivity } from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { canReconcileCodexNeedsInputWithNativeDirectInputReadiness } from "../../../src/core/codex-native-direct-input-readiness";
import { applySessionFacets } from "../../../src/core/session-activity";
import { createNativeAgentConversationActivityObserver } from "../../../src/server/native-agent-conversation-activity-observer";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Codex 转录缺失与轮换后的自动补证恢复", { timeout: 60_000 }, () => {
	const observers: ReturnType<typeof createNativeAgentConversationActivityObserver>[] = [];
	afterEach(() => {
		for (const observer of observers.splice(0)) observer.dispose();
	});
	async function recoveryFixture(fileIsInitiallyMissing: boolean, parentDirectoryIsInitiallyMissing = false) {
		const { summary, transcriptPath: initialTranscriptPath } = await transcriptFixture();
		const transcriptPath = parentDirectoryIsInitiallyMissing
			? join(dirname(initialTranscriptPath), "sessions-created-after-retry-exhaustion", "main.jsonl")
			: initialTranscriptPath;
		const state = {
			nowMs: 10_000,
			summary: {
				...summary,
				agentId: "codex" as const,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex" as const,
					nativeSessionId: "main",
					transcriptPath,
					observedAt: 1,
				},
				agentConversationPromptSubmissionAcceptance: {
					status: "unconfirmed" as const,
					attemptedAtMs: 10_000,
					runtimeSessionIncarnationId: "incarnation-1",
				},
			} as RuntimeTaskSessionSummary,
		};
		const metadataLine = `${JSON.stringify({ type: "session_meta", payload: { id: "main", cwd: summary.workspacePath, source: "cli" } })}\n`;
		const acceptedLine = `${JSON.stringify({
			timestamp: new Date(10_100).toISOString(),
			type: "event_msg",
			payload: {
				type: "item_completed",
				thread_id: "main",
				turn_id: "turn",
				item: { type: "UserMessage", id: "accepted-input", content: [{ type: "text", text: "继续" }] },
			},
		})}\n`;
		if (fileIsInitiallyMissing) await rm(transcriptPath, { force: true });
		else await writeFile(transcriptPath, metadataLine);
		const readNativeActivity = vi.fn(readNativeAgentConversationActivity);
		const onAccepted = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			readNativeActivity,
			onAccepted,
			cooldownMs: 0,
			nowMs: () => state.nowMs,
			onPromptSubmissionAcceptanceReconciliation(_sessionId, _workspaceId, result) {
				const candidate = state.summary.agentConversationPromptSubmissionAcceptance;
				if (!candidate) throw new Error("恢复测试缺少持久候选");
				state.summary = {
					...state.summary,
					agentConversationPromptSubmissionAcceptance: {
						...candidate,
						verification: result.verification,
						...(result.accepted ? { status: "accepted", eventId: result.accepted.eventId } : {}),
					},
				};
			},
		});
		observers.push(observer);
		const observe = () => observer.observeTaskSessionSummary("workspace", state.summary, () => state.summary);
		const exhaustOrdinaryRetries = async () => {
			for (const elapsedMs of [0, 15_000, 30_000, 60_000]) {
				state.nowMs += elapsedMs;
				await observe();
			}
			expect(state.summary.agentConversationPromptSubmissionAcceptance?.verification?.nextCheckAtMs).toBeNull();
		};
		return {
			state,
			transcriptPath,
			metadataLine,
			acceptedLine,
			observer,
			observe,
			exhaustOrdinaryRetries,
			readNativeActivity,
			onAccepted,
		};
	}

	it("文件初始不存在且普通重试耗尽后，创建合法原生转录会自动补证", async () => {
		const target = await recoveryFixture(true);
		await target.exhaustOrdinaryRetries();
		expect(target.readNativeActivity).toHaveBeenCalledTimes(4);
		await writeFile(target.transcriptPath, target.metadataLine + target.acceptedLine);
		await vi.waitFor(
			() => expect(target.state.summary.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted"),
			{ timeout: 25_000, interval: 50 },
		);
		expect(target.state.summary.agentConversationPromptSubmissionAcceptance?.eventId).toBe(
			"codex:main:turn:accepted-input",
		);
		expect(target.onAccepted).not.toHaveBeenCalled();
	});
	it("父目录也缺失时，耗尽普通预算后由低频元数据观察恢复并重新挂载目录观察", async () => {
		const target = await recoveryFixture(true, true);
		await target.exhaustOrdinaryRetries();
		await mkdir(dirname(target.transcriptPath), { recursive: true });
		await writeFile(target.transcriptPath, target.metadataLine);
		const metadata = await stat(target.transcriptPath);
		await vi.waitFor(
			() =>
				expect(
					target.state.summary.agentConversationPromptSubmissionAcceptance?.verification?.transcriptCursor
						?.fileIdentity,
				).toBe(`${metadata.dev}:${metadata.ino}`),
			{ timeout: 25_000, interval: 50 },
		);
		target.state.nowMs += 10_000;
		await target.exhaustOrdinaryRetries();
		await appendFile(target.transcriptPath, target.acceptedLine);
		// 目录观察不可用时会由 15 秒元数据轮询恢复，测试等待须覆盖该既有回退周期。
		await vi.waitFor(
			() => expect(target.state.summary.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted"),
			{ timeout: 25_000, interval: 50 },
		);
		expect(target.onAccepted).not.toHaveBeenCalled();
	});

	it.each(["rename", "atomic_replace"])("%s 后普通重试再耗尽，新文件后续追加仍能自动唤醒", async (replacement) => {
		const target = await recoveryFixture(false);
		await target.exhaustOrdinaryRetries();
		if (replacement === "rename") {
			await rename(target.transcriptPath, `${target.transcriptPath}.rotated`);
			await writeFile(target.transcriptPath, target.metadataLine);
		} else {
			await writeFile(`${target.transcriptPath}.replacement`, target.metadataLine);
			await rename(`${target.transcriptPath}.replacement`, target.transcriptPath);
		}
		const metadata = await stat(target.transcriptPath);
		await vi.waitFor(
			() =>
				expect(
					target.state.summary.agentConversationPromptSubmissionAcceptance?.verification?.transcriptCursor
						?.fileIdentity,
				).toBe(`${metadata.dev}:${metadata.ino}`),
			{ timeout: 25_000, interval: 50 },
		);
		target.state.nowMs += 10_000;
		await target.exhaustOrdinaryRetries();
		await appendFile(target.transcriptPath, target.acceptedLine);
		await vi.waitFor(
			() => expect(target.state.summary.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted"),
			{ timeout: 25_000, interval: 50 },
		);
		expect(target.onAccepted).not.toHaveBeenCalled();
	});

	it("耗尽后静默不重扫，身份更换或 dispose 后旧文件变化不能再次读取旧会话", async () => {
		const target = await recoveryFixture(false);
		await target.exhaustOrdinaryRetries();
		target.state.nowMs += 10 * 60_000;
		const unchangedReadCount = target.readNativeActivity.mock.calls.length;
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		expect(target.readNativeActivity).toHaveBeenCalledTimes(unchangedReadCount);
		target.state.summary = {
			...target.state.summary,
			runtimeSessionIncarnationId: "replacement-incarnation",
			agentConversationPromptSubmissionAcceptance: null,
		};
		await target.observe();
		const replacedReadCount = target.readNativeActivity.mock.calls.length;
		await appendFile(target.transcriptPath, target.acceptedLine);
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		expect(target.readNativeActivity).toHaveBeenCalledTimes(replacedReadCount);
		target.observer.dispose();
		await appendFile(target.transcriptPath, target.acceptedLine);
		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		expect(target.readNativeActivity).toHaveBeenCalledTimes(replacedReadCount);
	});
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
		return { state, observer, observe, rewind, readNativeActivity, onAccepted, onActivity, onNativeReadiness };
	}

	it.each([true, false])("新输入边沿存在=%s 时，正常接受与历史补证只选择一个出口", async (hasLiveEvent) => {
		const target = fixture();
		target.state.summary = {
			...target.state.summary,
			userTurnKind: "review",
			agentConversationPromptSubmissionAcceptance: {
				status: "unconfirmed",
				attemptedAtMs: 1,
				runtimeSessionIncarnationId: "incarnation-1",
			},
		};
		const onAccepted = vi.fn();
		const onReconciliation = vi.fn();
		const observer = createNativeAgentConversationActivityObserver({
			onAccepted,
			onPromptSubmissionAcceptanceReconciliation: onReconciliation,
			readNativeActivity: async () => ({
				events: hasLiveEvent
					? [
							{
								observedAtMs: 200,
								eventId: "native-input",
								nativeSessionId: "main",
								activityKind: "accepted_user_input",
								evidenceKind: "native_user_prompt_acceptance",
							},
						]
					: [],
				cursor: null,
				promptSubmissionAcceptanceReconciliation: {
					attemptedAtMs: 1,
					runtimeSessionIncarnationId: "incarnation-1",
					nativeSessionId: "main",
					verification: {
						checkedAtMs: Date.now(),
						nextCheckAtMs: null,
						consecutiveUnchangedCheckCount: 0,
						reason: "native_acceptance_verified",
					},
					accepted: { eventId: "native-input", acceptedAtMs: 200 },
				},
			}),
		});
		observers.push(observer);
		await observer.observeTaskSessionSummary("workspace", target.state.summary, () => target.state.summary);
		expect(onAccepted).toHaveBeenCalledTimes(hasLiveEvent ? 1 : 0);
		expect(onReconciliation).toHaveBeenCalledTimes(hasLiveEvent ? 0 : 1);
	});

	it("空闲会话缺证按 15/30/60 秒自动重试，耗尽后停下并在重启时重验", async () => {
		const target = fixture();
		target.state.summary = {
			...target.state.summary,
			userTurnKind: "review",
			agentConversationPromptSubmissionAcceptance: {
				status: "unconfirmed",
				attemptedAtMs: 1,
				runtimeSessionIncarnationId: "incarnation-1",
			},
		};
		const read = vi.fn(async (): Promise<NativeAgentConversationActivityReadResult | null> => null);
		const onAccepted = vi.fn();
		const createObserver = () => {
			const observer = createNativeAgentConversationActivityObserver({
				readNativeActivity: read,
				onAccepted,
				onPromptSubmissionAcceptanceReconciliation(_sessionId, _workspaceId, result) {
					const candidate = target.state.summary.agentConversationPromptSubmissionAcceptance;
					if (candidate)
						target.state.summary = {
							...target.state.summary,
							agentConversationPromptSubmissionAcceptance: { ...candidate, verification: result.verification },
						};
				},
			});
			observers.push(observer);
			return observer;
		};
		const observer = createObserver();
		const observe = () =>
			observer.observeTaskSessionSummary("workspace", target.state.summary, () => target.state.summary);
		await observe();
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(read).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(read).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(4);
		expect(target.state.summary.agentConversationPromptSubmissionAcceptance?.verification?.nextCheckAtMs).toBeNull();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(read).toHaveBeenCalledTimes(4);
		observer.dispose();
		await createObserver().observeTaskSessionSummary("workspace", target.state.summary, () => target.state.summary);
		expect(read).toHaveBeenCalledTimes(5);
		expect(onAccepted).not.toHaveBeenCalled();
	});

	it("会话已 idle 且标记已 accepted 时，已知分页仍自动续读到结束", async () => {
		const target = fixture(0);
		target.state.summary = {
			...target.state.summary,
			userTurnKind: "review",
			agentConversationPromptSubmissionAcceptance: {
				status: "accepted",
				attemptedAtMs: 1,
				runtimeSessionIncarnationId: "incarnation-1",
			},
		};
		let readCount = 0;
		target.readNativeActivity.mockImplementation(async () => {
			readCount += 1;
			return {
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: `page-${readCount}`, seenEventIds: [] },
				...(readCount < 25
					? {
							codexFullMessageReadContinuation: { progressToken: String(readCount), madeProgress: true },
						}
					: {}),
			};
		});
		await target.observe();
		await vi.advanceTimersByTimeAsync(7_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(25);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(25);
		expect(target.onAccepted).not.toHaveBeenCalled();
		expect(target.onActivity).not.toHaveBeenCalled();
	});
	it("分页在同一位置失败时有界退避，恢复取得新进度后继续完成", async () => {
		const target = fixture(0);
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		let nativePageIsAvailable = false;
		let pageCount = 0;
		target.readNativeActivity.mockImplementation(async () => {
			if (nativePageIsAvailable) pageCount += 1;
			return {
				events: [],
				cursor: { transport: "codex_control", predecessorTurnId: "old", seenEventIds: [] },
				...(pageCount < 2
					? {
							codexFullMessageReadContinuation: {
								progressToken: String(pageCount),
								madeProgress: nativePageIsAvailable,
							},
						}
					: {}),
			};
		});
		await target.observe();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(2);
		nativePageIsAvailable = true;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(250);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(4);
	});
	it("分页重复声称同一进度时耗尽退避；新输入唤醒后可以继续补证", async () => {
		const target = fixture(0);
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		target.readNativeActivity.mockImplementation(async () => ({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: "old", seenEventIds: [] },
			codexFullMessageReadContinuation: { progressToken: "unchanged", madeProgress: true },
		}));
		await target.observe();
		await vi.advanceTimersByTimeAsync(250 + 15_000 + 30_000 + 60_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(5);
		target.readNativeActivity.mockImplementation(async () => ({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: "new", seenEventIds: [] },
		}));
		target.observer.wakeForPotentialUserPromptSubmission(
			"workspace",
			target.state.summary,
			() => target.state.summary,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(6);
	});
	it.each(["dispose", "identity"] as const)("待补分页在 %s 后取消旧会话的自动续读", async (change) => {
		const target = fixture(0);
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		target.readNativeActivity.mockImplementation(async (input) => ({
			events: [],
			cursor: { transport: "codex_control", predecessorTurnId: "old", seenEventIds: [] },
			...(input.summary.agentNativeConversationSessionIdentity?.nativeSessionId === "main"
				? {
						codexFullMessageReadContinuation: { progressToken: "next-page", madeProgress: true },
					}
				: {}),
		}));
		await target.observe();
		const firstSignal = target.readNativeActivity.mock.calls[0]?.[0].signal;
		if (change === "dispose") target.observer.dispose();
		else {
			const originalNativeIdentity = target.state.summary.agentNativeConversationSessionIdentity;
			if (!originalNativeIdentity) throw new Error("测试会话缺少原生身份");
			target.state.summary = {
				...target.state.summary,
				agentNativeConversationSessionIdentity: {
					...originalNativeIdentity,
					nativeSessionId: "replacement",
				},
			};
			await target.observe();
		}
		expect(firstSignal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(target.readNativeActivity).toHaveBeenCalledTimes(change === "dispose" ? 1 : 2);
		expect(target.onAccepted).not.toHaveBeenCalled();
	});
	it("新 Rewind 取消旧分支分页书签，保留已消费位置再核对当前分支", async () => {
		const target = fixture(0);
		target.state.summary = { ...target.state.summary, userTurnKind: "review" };
		target.readNativeActivity.mockImplementationOnce(async () => ({
			events: [],
			cursor: {
				transport: "codex_control",
				predecessorTurnId: "old",
				seenEventIds: [],
				acceptedSummaryUserInputEventIdsPendingFullRead: [],
				fullMessagePageReadRecovery: {
					phase: "locating_predecessor",
					nextSummaryPageCursor: "old-page",
					newerSummaryPages: [],
				},
			},
			codexFullMessageReadContinuation: { progressToken: "old-page", madeProgress: true },
		}));
		await target.observe();
		target.rewind();
		await target.observe();
		const cursorAfterRewind = target.readNativeActivity.mock.calls[1]?.[0].cursor;
		expect(cursorAfterRewind).toMatchObject({ predecessorTurnId: "old" });
		if (cursorAfterRewind?.transport === "codex_control")
			expect(cursorAfterRewind.fullMessagePageReadRecovery).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(target.onAccepted).not.toHaveBeenCalled();
	});
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
		expect(target.onNativeReadiness).toHaveBeenCalledTimes(change === "rewind" ? 0 : 1);
		expect(target.state.summary.userTurnKind).toBe("needs_input");
		target.state.nativeReadinessAvailable = true;
		await vi.advanceTimersByTimeAsync(250);
		expect(target.onNativeReadiness).toHaveBeenCalledTimes(change === "rewind" ? 1 : 2);
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
	it.each([false, true])(
		"读取期间已有候选=%s 时，新候选保留 live 接受并自动以最新提交身份重验",
		async (hadCandidate) => {
			vi.useFakeTimers();
			vi.setSystemTime(10_000);
			const { summary } = await transcriptFixture();
			let current: RuntimeTaskSessionSummary = {
				...summary,
				...(hadCandidate
					? {
							agentConversationPromptSubmissionAcceptance: {
								status: "pending" as const,
								attemptedAtMs: 9_000,
								submissionId: "previous-submission",
								runtimeSessionIncarnationId: "incarnation-1",
							},
						}
					: {}),
			};
			const baselineCursor = {
				transport: "codex_control" as const,
				predecessorTurnId: "baseline",
				seenEventIds: [],
			};
			const acceptedCursor = { ...baselineCursor, seenEventIds: ["native-input"] };
			let releaseRead: ((result: NativeAgentConversationActivityReadResult) => void) | undefined;
			const readNativeActivity = vi.fn(async (input: ReadNativeAgentConversationActivityInput) => {
				if (!input.cursor) return { events: [], cursor: baselineCursor };
				if (readNativeActivity.mock.calls.length === 2)
					return new Promise<NativeAgentConversationActivityReadResult>((resolve) => {
						releaseRead = resolve;
					});
				return {
					events: input.cursor.seenEventIds.includes("native-input")
						? []
						: [
								{
									observedAtMs: input.observedAtMs,
									activityKind: "accepted_user_input" as const,
									evidenceKind: "native_user_prompt_acceptance" as const,
									eventId: "native-input",
									nativeSessionId: "main",
								},
							],
					cursor: acceptedCursor,
				};
			});
			const liveEffects = vi.fn();
			const onAccepted = vi.fn((observation) => {
				const candidate = current.agentConversationPromptSubmissionAcceptance;
				if (!candidate) return false;
				if (
					candidate?.attemptedAtMs !== observation.observedSubmissionAttemptedAtMs ||
					candidate?.submissionId !== observation.observedSubmissionId
				)
					return false;
				liveEffects(observation);
				current = { ...current, agentConversationPromptSubmissionAcceptance: { ...candidate, status: "accepted" } };
				return true;
			});
			const onReconciliation = vi.fn();
			const observer = createNativeAgentConversationActivityObserver({
				onAccepted,
				onPromptSubmissionAcceptanceReconciliation: onReconciliation,
				readNativeActivity,
				cooldownMs: 0,
			});
			const observe = () => observer.observeTaskSessionSummary("workspace", current, () => current);
			try {
				await observe();
				const pendingRead = observe();
				await vi.advanceTimersByTimeAsync(0);
				const readStartedAtMs = readNativeActivity.mock.calls[1]?.[0].observedAtMs;
				await vi.advanceTimersByTimeAsync(10);
				const firstSubmitCarriageReturnAtMs = Date.now();
				current = {
					...current,
					agentConversationPromptSubmissionAcceptance: {
						status: "pending",
						attemptedAtMs: firstSubmitCarriageReturnAtMs,
						submissionId: "current-submission",
						runtimeSessionIncarnationId: "incarnation-1",
					},
				};
				observer.wakeForPotentialUserPromptSubmission("workspace", current, () => current);
				if (!releaseRead || readStartedAtMs === undefined) throw new Error("在途读取尚未启动");
				releaseRead({
					events: [
						{
							observedAtMs: readStartedAtMs,
							activityKind: "accepted_user_input",
							evidenceKind: "native_user_prompt_acceptance",
							eventId: "native-input",
							nativeSessionId: "main",
						},
					],
					cursor: acceptedCursor,
				});
				await pendingRead;
				expect(current.agentConversationPromptSubmissionAcceptance?.status).toBe("pending");
				await vi.advanceTimersByTimeAsync(250);
				expect(liveEffects).toHaveBeenCalledOnce();
				expect(liveEffects.mock.calls[0]?.[0]).toMatchObject({
					observedSubmissionId: "current-submission",
					observedSubmissionAttemptedAtMs: firstSubmitCarriageReturnAtMs,
				});
				expect(liveEffects.mock.calls[0]?.[0].observedAtMs).toBeGreaterThanOrEqual(firstSubmitCarriageReturnAtMs);
				expect(readNativeActivity.mock.calls[2]?.[0].cursor).toEqual(baselineCursor);
				expect(current.agentConversationPromptSubmissionAcceptance?.status).toBe("accepted");
				expect(onReconciliation).not.toHaveBeenCalled();
				await observe();
				expect(liveEffects).toHaveBeenCalledOnce();
			} finally {
				observer.dispose();
				vi.useRealTimers();
			}
		},
	);

	it("接受出口明确拒绝时保留游标，部分已成功事件不重复执行且不关闭后续候选的重试窗口", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(10_000);
		const { summary } = await transcriptFixture();
		let current = summary;
		const appliedEventIds: string[] = [];
		let rejectedOnce = false;
		const readNativeActivity = vi.fn(async (input: ReadNativeAgentConversationActivityInput) => ({
			events: ["first", "second"]
				.filter((eventId) => !input.cursor?.seenEventIds.includes(eventId))
				.map((eventId) => ({
					observedAtMs: input.observedAtMs,
					activityKind: "accepted_user_input" as const,
					evidenceKind: "native_user_prompt_acceptance" as const,
					eventId,
					nativeSessionId: "main",
				})),
			cursor: { transport: "codex_control" as const, predecessorTurnId: "turn", seenEventIds: ["first", "second"] },
		}));
		const observer = createNativeAgentConversationActivityObserver({
			readNativeActivity,
			cooldownMs: 0,
			onAccepted(observation) {
				if (observation.eventId === "second" && !rejectedOnce) {
					rejectedOnce = true;
					return false;
				}
				appliedEventIds.push(observation.eventId ?? "");
				if (observation.eventId === "second") {
					current = {
						...current,
						agentConversationPromptSubmissionAcceptance: {
							status: "pending",
							attemptedAtMs: Date.now(),
							submissionId: "later-submission",
							runtimeSessionIncarnationId: "incarnation-1",
						},
					};
					observer.wakeForPotentialUserPromptSubmission("workspace", current, () => current);
				}
				return true;
			},
		});
		try {
			observer.wakeForPotentialUserPromptSubmission("workspace", current, () => current);
			await vi.advanceTimersByTimeAsync(0);
			expect(appliedEventIds).toEqual(["first"]);
			await vi.advanceTimersByTimeAsync(250);
			expect(appliedEventIds).toEqual(["first", "second"]);
			expect(readNativeActivity.mock.calls[1]?.[0].cursor).toBeNull();
			expect(current.agentConversationPromptSubmissionAcceptance?.submissionId).toBe("later-submission");
			await vi.advanceTimersByTimeAsync(250);
			expect(readNativeActivity).toHaveBeenCalledTimes(3);
			expect(appliedEventIds).toEqual(["first", "second"]);
		} finally {
			observer.dispose();
			vi.useRealTimers();
		}
	});

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
