import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const ensureInstructionsFileMock = vi.hoisted(() => vi.fn(async () => "/tmp/network-interruption-resume.md"));
const inspectCodexNativeRetryReadinessMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/codex-native-connection-retry-continuation-readiness", () => ({
	inspectCodexNativeConnectionRetryContinuationReadiness: inspectCodexNativeRetryReadinessMock,
}));

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
	// 分离写：框架与提交 CR 分两次发出（见 session-manager 的摄入门控）。这里给真实实现，
	// 保证注入体框定与提交字节都是真的。
	toBracketedPasteFramingWithoutTrailingSubmit: (command: string) => `\u001b[200~${command}\u001b[201~`,
	BRACKETED_PASTE_TRAILING_SUBMIT_CARRIAGE_RETURN: "\u000d",
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

// 避免向真实 home 目录写续跑指令文件，并固定注入路径便于断言。
vi.mock("../../../src/terminal/output-reactions/network-interruption-continuation-instructions.js", () => ({
	ensureNetworkInterruptionResumeInstructionsFile: ensureInstructionsFileMock,
	getNetworkInterruptionResumeInstructionsPath: () => "/tmp/network-interruption-resume.md",
	buildNetworkInterruptionContinuationLine: (path: string) => `继续：请先按 ${path} 自查并恢复，再继续。`,
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		hasExited: vi.fn(() => false),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

// 同时含连接错误行与 Claude 输入框（提示符就绪信号）。
const CLAUDE_ERROR_WITH_PROMPT =
	"[31m\r⏺ API Error: Connection closed mid-response. The response above may be incomplete.[0m\r\n" +
	"╭──────────────────────╮\n│ > │\n╰──────────────────────╯";

// 输出重分析(连接错误检测等)按 session-manager 的 OUTPUT_ANALYSIS_BATCH_WINDOW_MS(50ms)攒批;
// 喂完输出后先推进该窗口,让检测结果落地,再做断言/推进退避档位。
const OUTPUT_ANALYSIS_BATCH_WINDOW_MS = 50;
async function settleOutputAnalysisBatch(): Promise<void> {
	await vi.advanceTimersByTimeAsync(OUTPUT_ANALYSIS_BATCH_WINDOW_MS);
}

function spawnManagerWithSession(pid: number) {
	let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
	prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
		binary: input.binary,
		args: [...input.args],
		env: {},
		// 不产出 deferredStartupPromptText，避免与续跑注入混淆。
	}));
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		spawnedSession = createMockPtySession(pid, request);
		return spawnedSession;
	});
	return () => spawnedSession;
}

async function startCodexRetryPausedBeforeFirstSubmit() {
	const taskId = "codex-first-submit-validation";
	const getSession = spawnManagerWithSession(1203);
	const manager = new TerminalSessionManager();
	await manager.startTaskSession({
		taskId,
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: `/isolated/${taskId}`,
		prompt: "验证粘贴后的原生核验拒绝",
	});
	const readyForTerminalWrite = { outcome: "ready_for_terminal_write", nativeTurnId: "failed-turn" };
	let finishFirstSubmitReadinessCheck: (result: { outcome: string; nativeTurnId?: string }) => void = () => {};
	inspectCodexNativeRetryReadinessMock
		.mockResolvedValue(readyForTerminalWrite)
		.mockResolvedValueOnce(readyForTerminalWrite)
		.mockResolvedValueOnce(readyForTerminalWrite)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishFirstSubmitReadinessCheck = resolve;
				}),
		);
	vi.spyOn(manager, "resolveTaskTerminalInputBoxOccupancy").mockResolvedValue({
		hasUncommittedInput: false,
		inputSideByteTrackingSaysNonEmpty: false,
		inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
		screenReadingSaysNonEmpty: false,
		unrecoverablePasteCount: 0,
	});
	const session = getSession();
	if (!session) throw new Error("缺少隔离 PTY");
	let composerText = "";
	const submittedPrompts: string[] = [];
	session.write.mockImplementation((bytes: string | Buffer) => {
		const text = String(bytes);
		if (text.startsWith("\u001b[200~")) composerText += text.slice(6, -6);
		else if (text === "\u0015") composerText = "";
		else if (text === "\r") {
			submittedPrompts.push(composerText);
			composerText = "";
		} else composerText += text;
	});
	session.triggerData("Error: read ECONNRESET\n› ");
	await settleOutputAnalysisBatch();
	await vi.advanceTimersByTimeAsync(4_000);
	expect(session.write).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1_600);
	expect(inspectCodexNativeRetryReadinessMock).toHaveBeenCalledTimes(3);
	return {
		manager,
		taskId,
		session,
		finishFirstSubmitReadinessCheck,
		getComposerText: () => composerText,
		submittedPrompts,
	};
}

describe("session-manager · connection-drop auto-continue", () => {
	it.each(["inProgress", "unknown", "native_turn_replaced"] as const)(
		"续跑 paste 后首个 Enter 核验为 %s，仅撤回本次正文且不声明原生接受",
		async (nativeState) => {
			const { manager, taskId, session, finishFirstSubmitReadinessCheck, getComposerText, submittedPrompts } =
				await startCodexRetryPausedBeforeFirstSubmit();
			expect(getComposerText()).toContain("network-interruption-resume.md");
			expect(manager.getSummary(taskId)?.connectionRetry?.retryCount).toBe(1);
			finishFirstSubmitReadinessCheck({
				outcome: nativeState === "native_turn_replaced" ? "target_invalidated" : "deferred_before_terminal_write",
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(getComposerText()).toBe("");
			expect(session.write.mock.calls.filter(([text]) => text === "\u0015")).toHaveLength(1);
			expect(submittedPrompts).toEqual([]);
			expect(manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance?.status).not.toBe("accepted");
			await vi.advanceTimersByTimeAsync(nativeState === "native_turn_replaced" ? 20_000 : 10_000);
			expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(1);
			expect(submittedPrompts).toEqual([]);
			if (nativeState === "native_turn_replaced") expect(manager.getSummary(taskId)?.connectionRetry).toBeNull();
			manager.stopTaskSession(taskId);
		},
	);

	it("unknown 拒绝首个 Enter 后重新读到 failed，继续退避重试而不把撤回的 paste 当成恢复", async () => {
		const { manager, taskId, session, finishFirstSubmitReadinessCheck, getComposerText, submittedPrompts } =
			await startCodexRetryPausedBeforeFirstSubmit();
		finishFirstSubmitReadinessCheck({ outcome: "deferred_before_terminal_write" });
		await vi.advanceTimersByTimeAsync(0);
		expect(getComposerText()).toBe("");
		await vi.advanceTimersByTimeAsync(14_000);
		expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(2);
		expect(manager.getSummary(taskId)?.connectionRetry?.retryCount).toBe(2);
		expect(submittedPrompts).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_600);
		expect(submittedPrompts).toHaveLength(1);
		expect(submittedPrompts[0]).toContain("network-interruption-resume.md");
		expect(session.write.mock.calls.filter(([text]) => text === "\u0015")).toHaveLength(1);
		expect(manager.getSummary(taskId)?.agentConversationPromptSubmissionAcceptance?.status).not.toBe("accepted");
		manager.stopTaskSession(taskId);
	});

	it("首个 Enter 的原生核验跨过退避窗口仍未返回，保持重试且不重 paste 或提前判恢复", async () => {
		const { manager, taskId, session, finishFirstSubmitReadinessCheck, submittedPrompts } =
			await startCodexRetryPausedBeforeFirstSubmit();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(manager.getSummary(taskId)?.connectionRetry?.retryCount).toBe(1);
		expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(1);
		expect(submittedPrompts).toEqual([]);
		finishFirstSubmitReadinessCheck({ outcome: "deferred_before_terminal_write" });
		await vi.advanceTimersByTimeAsync(0);
		manager.stopTaskSession(taskId);
	});

	it("首个 Enter 已写入后，后续原生核验失效只停补发，不再撤回 composer", async () => {
		const { manager, taskId, session, finishFirstSubmitReadinessCheck, submittedPrompts } =
			await startCodexRetryPausedBeforeFirstSubmit();
		finishFirstSubmitReadinessCheck({ outcome: "ready_for_terminal_write", nativeTurnId: "failed-turn" });
		await vi.advanceTimersByTimeAsync(0);
		expect(submittedPrompts).toHaveLength(1);
		inspectCodexNativeRetryReadinessMock.mockResolvedValue({ outcome: "target_invalidated" });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(session.write.mock.calls.filter(([text]) => text === "\u0015")).toHaveLength(0);
		expect(submittedPrompts).toHaveLength(1);
		manager.stopTaskSession(taskId);
	});

	it.each(["question", "plan_review", "permission", "needs_input", "park"] as const)(
		"首个 Enter 核验等待期间真实进入 %s，旧续跑不再向终端写任何自动按键",
		async (targetInteractionState) => {
			const { manager, taskId, session, finishFirstSubmitReadinessCheck, getComposerText, submittedPrompts } =
				await startCodexRetryPausedBeforeFirstSubmit();
			const originalComposerText = getComposerText();
			if (targetInteractionState === "park") {
				const parkResult = manager.parkTaskSessionAwaitingDispatchedBackgroundWork(taskId, {
					label: "等待独立后台作业",
				});
				expect(parkResult.ok).toBe(true);
				expect(manager.getSummary(taskId)?.awaitingDispatchedBackgroundWork?.label).toBe("等待独立后台作业");
			} else {
				const modalSummary = manager.transitionToReview(taskId, "hook", targetInteractionState);
				expect(modalSummary?.turnOwner).toBe("user");
				expect(modalSummary?.userTurnKind).toBe(targetInteractionState);
			}
			expect(manager.getSummary(taskId)?.connectionRetry).toBeNull();
			finishFirstSubmitReadinessCheck({ outcome: "ready_for_terminal_write", nativeTurnId: "failed-turn" });
			await vi.advanceTimersByTimeAsync(20_000);
			expect(session.write).toHaveBeenCalledTimes(1);
			expect(getComposerText()).toBe(originalComposerText);
			expect(submittedPrompts).toEqual([]);
			manager.stopTaskSession(taskId);
		},
	);

	it.each(["human_input", "programmatic_delivery", "native_identity", "session_ended"] as const)(
		"首个 Enter 核验等待期间 %s，旧续跑既不清框也不提交新所有者的正文",
		async (ownershipChange) => {
			const { manager, taskId, session, finishFirstSubmitReadinessCheck, getComposerText, submittedPrompts } =
				await startCodexRetryPausedBeforeFirstSubmit();
			if (ownershipChange === "human_input") manager.writeInput(taskId, Buffer.from("人的新输入"));
			else if (ownershipChange === "programmatic_delivery") {
				manager.submitTaskChatInputWhenReady(taskId, "更新的程序化投递", {
					onDeliveryOutcome: () => {},
				});
				await vi.advanceTimersByTimeAsync(1_000);
				expect(getComposerText()).toContain("更新的程序化投递");
				expect(manager.hasPendingProgrammaticTaskChatInputDelivery(taskId)).toBe(true);
			} else if (ownershipChange === "native_identity")
				manager.applyAgentNativeConversationSessionIdentity(taskId, {
					sourceAgentId: "codex",
					nativeSessionId: "rebound-native-session",
					transcriptPath: "/isolated/rebound-native-session.jsonl",
					observedAt: Date.now(),
				});
			else manager.stopTaskSession(taskId);
			const composerTextAfterOwnershipChange = getComposerText();
			// 人已停手超过抑制窗，旧核验仍不能借这个时间窗夺回清框权。
			if (ownershipChange === "human_input") await vi.advanceTimersByTimeAsync(9_000);
			finishFirstSubmitReadinessCheck({ outcome: "deferred_before_terminal_write" });
			await vi.advanceTimersByTimeAsync(0);
			expect(getComposerText()).toBe(composerTextAfterOwnershipChange);
			expect(session.write.mock.calls.filter(([text]) => text === "\u0015")).toHaveLength(0);
			expect(submittedPrompts).toEqual([]);
			if (ownershipChange === "programmatic_delivery")
				expect(manager.hasPendingProgrammaticTaskChatInputDelivery(taskId)).toBe(true);
			manager.stopTaskSession(taskId);
		},
	);

	it("原生核验期间人工输入，即使抑制窗已经过去也不得写入旧续跑正文", async () => {
		const getSession = spawnManagerWithSession(1202);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "codex-human-input-race",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/isolated/codex-human-input-race",
			prompt: "验证异步写入让位",
		});
		let completeReadinessCheck: (result: { outcome: string; nativeTurnId: string }) => void = () => {};
		inspectCodexNativeRetryReadinessMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					completeReadinessCheck = resolve;
				}),
		);
		const session = getSession();
		if (!session) throw new Error("缺少隔离 PTY");
		session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(inspectCodexNativeRetryReadinessMock).toHaveBeenCalledOnce();
		manager.writeInput("codex-human-input-race", Buffer.from("尚未提交的人类草稿"));
		await vi.advanceTimersByTimeAsync(9_000);
		completeReadinessCheck({ outcome: "ready_for_terminal_write", nativeTurnId: "failed-turn" });
		await vi.advanceTimersByTimeAsync(0);
		expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(0);
		manager.stopTaskSession("codex-human-input-race");
	});

	it.each([
		["deferred_before_terminal_write", false],
		["target_invalidated", false],
		["ready_for_terminal_write", true],
	] as const)("Codex 原生核验 %s 时，实际 PTY 写入与重试计数一致", async (outcome, writes) => {
		const getSession = spawnManagerWithSession(1201);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "codex-native-guard",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/isolated/codex-native-guard",
			prompt: "验证写前保护",
		});
		inspectCodexNativeRetryReadinessMock.mockResolvedValue({ outcome, nativeTurnId: "failed-turn" });
		vi.spyOn(manager, "resolveTaskTerminalInputBoxOccupancy").mockResolvedValue({
			hasUncommittedInput: false,
			inputSideByteTrackingSaysNonEmpty: false,
			inputSideByteTrackingHasKnownEmptyBaselineForCurrentComposition: true,
			screenReadingSaysNonEmpty: false,
			unrecoverablePasteCount: 0,
		});
		const session = getSession();
		if (!session) throw new Error("缺少隔离 PTY");
		session.triggerData("Error: read ECONNRESET\n› ");
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(inspectCodexNativeRetryReadinessMock).toHaveBeenCalled();
		expect(session.write.mock.calls.filter(([text]) => String(text).includes("[200~"))).toHaveLength(writes ? 1 : 0);
		expect(manager.getSummary("codex-native-guard")?.connectionRetry?.retryCount ?? 0).toBe(writes ? 1 : 0);
		manager.stopTaskSession("codex-native-guard");
	});

	it.each(["tool_activity", "agent_output", "context_compaction"] as const)(
		"错误之后的可信 %s 清理重连状态，即使终端没有空闲提示符",
		async (activityKind) => {
			const getSession = spawnManagerWithSession(1101);
			const manager = new TerminalSessionManager();
			await manager.startTaskSession({
				taskId: "semantic-recovery",
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: "/isolated/semantic-recovery",
				prompt: "验证恢复",
			});
			const session = getSession();
			if (!session) throw new Error("缺少隔离 PTY");
			session.triggerData("Error: read ECONNRESET\n");
			await settleOutputAnalysisBatch();
			const errorAt = manager.getSummary("semantic-recovery")?.connectionRetry?.firstErrorAt;
			if (!errorAt) throw new Error("缺少重试 episode");
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt - 1,
				evidenceKind: "agent_lifecycle_hook_event",
				activityKind,
			});
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			manager.recordEffectiveAgentConversationActivity(
				"semantic-recovery",
				{
					observedAtMs: errorAt + 60_001,
					evidenceKind: "agent_lifecycle_hook_event",
					activityKind,
				},
				{
					nativeAgentResponsePromptCacheReferenceObservation: {
						observedAtMs: errorAt,
						evidenceKind: "post_tool_use_hook_event",
					},
				},
			);
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			await vi.advanceTimersByTimeAsync(1);
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt + 1,
				evidenceKind: "native_user_prompt_acceptance",
				activityKind: "accepted_user_input",
			});
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("retrying");
			await vi.advanceTimersByTimeAsync(1);
			manager.recordEffectiveAgentConversationActivity("semantic-recovery", {
				observedAtMs: errorAt + 2,
				evidenceKind: "agent_lifecycle_hook_event",
				activityKind,
			});
			expect(manager.getSummary("semantic-recovery")?.connectionRetry).toBeNull();
			expect(manager.getSummary("semantic-recovery")?.liveness).toBe("live");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(session.write).not.toHaveBeenCalled();
			manager.stopTaskSession("semantic-recovery");
		},
	);

	beforeEach(() => {
		inspectCodexNativeRetryReadinessMock.mockReset();
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		ensureInstructionsFileMock.mockClear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("injects a continuation referencing the instructions file after a transient connection error", async () => {
		const getSession = spawnManagerWithSession(1001);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		expect(session).not.toBeNull();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		// 检测到错误即进入重试状态，但不立即注入。
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop")?.connectionRetry?.status).toBe("retrying");

		// 推进过首个退避档位 → 注入一次续跑（引用指令文件路径）。
		await vi.advanceTimersByTimeAsync(4_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("/tmp/network-interruption-resume.md");
		expect(write.mock.calls[0]?.[0]).toContain("[200~");

		manager.stopTaskSession("task-conn-drop");
	});

	it("续跑注入末尾 CR 被吞（输出仍静默）→ 写后确认补发裸 `\\r`，绝不重发整段 paste（防文本翻倍回归）", async () => {
		// 连接中断路径旧病：CR 被吞 → 退避重试重新整段 paste → 输入框文本叠两份。写后确认闭环改为补发裸回车：
		// 注入续跑 paste 后保持输出静默（模拟 CR 被吞、框卡 idle），过 SUBMIT_CONFIRM_DELAY_MS 应只补发一个 `"\r"`，
		// 而非又一段 `[200~…[201~`。
		const SUBMIT_CONFIRM_DELAY_MS = 2_500;
		const getSession = spawnManagerWithSession(1009);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-resend-cr",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-resend-cr",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000); // 首档退避 → 注入续跑 paste。
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("[200~");

		// 不再喂任何输出（CR 被吞、框静止）→ 过确认延时应补发裸回车。
		await vi.advanceTimersByTimeAsync(SUBMIT_CONFIRM_DELAY_MS);
		expect(write).toHaveBeenCalledTimes(2);
		expect(write.mock.calls[1]?.[0]).toBe("\r");
		// 关键回归断言：补发的不是又一段 bracketed paste（绝不重发整段续跑文本 → 不翻倍）。
		expect(write.mock.calls[1]?.[0]).not.toContain("[200~");

		manager.stopTaskSession("task-conn-drop-resend-cr");
	});

	it("bridges an error line split across two flush windows via the carryover tail", async () => {
		// 错误行跨 flush 边界被切断:前半批 flush 后留 slice(-256) carryover,后半批与之拼接
		// 后正则仍命中 → episode 照常开启(与旧 per-chunk 语义下的跨 chunk 桥接同构)。
		const getSession = spawnManagerWithSession(1011);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-split-flush",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-split-flush",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: true,
		});
		const session = getSession();
		expect(session).not.toBeNull();

		// 前半段(错误短语「connection closed」被拦腰切断)→ 独立 flush 为第一批。
		(session as NonNullable<typeof session>).triggerData("\r⏺ API Error: Conn");
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-split-flush")?.connectionRetry ?? null).toBeNull();

		// 后半段 + 提示符框 → 第二批;与 carryover 拼接后命中 transient 正则。
		(session as NonNullable<typeof session>).triggerData(
			"ection closed mid-response. The response above may be incomplete.\r\n╭──────────────────────╮\n│ > │\n╰──────────────────────╯",
		);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-split-flush")?.connectionRetry?.status).toBe("retrying");

		manager.stopTaskSession("task-conn-drop-split-flush");
	});

	it("does not inject when the auto-continue flag is disabled", async () => {
		const getSession = spawnManagerWithSession(1002);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-off",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-off",
			prompt: "Do the task",
			autoContinueOnConnectionDropEnabled: false,
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(write).not.toHaveBeenCalled();
		expect(manager.getSummary("task-conn-drop-off")?.connectionRetry ?? null).toBeNull();

		manager.stopTaskSession("task-conn-drop-off");
	});

	it("clears the retry state once the agent recovers (no further error before the next attempt)", async () => {
		const getSession = spawnManagerWithSession(1003);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-recover",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-recover",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		await vi.advanceTimersByTimeAsync(4_000); // first injection
		expect(write).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-conn-drop-recover")?.connectionRetry?.status).toBe("retrying");

		// 没有再出现连接错误 → 下一次退避触发时判定已恢复，清除重试状态、不再注入续跑。
		await vi.advanceTimersByTimeAsync(20_000);
		// 只数「续跑 paste 注入」（含 bracketed-paste 框 `[200~`）：写后确认闭环在 mock 始终静默（无后续输出回流）下
		// 会补发裸 `\r`，那是另一条安全层、非续跑注入；恢复后续跑注入数应恒为 1。
		const continuationInjections = write.mock.calls.filter((call) => String(call[0]).includes("[200~"));
		expect(continuationInjections).toHaveLength(1);
		expect(manager.getSummary("task-conn-drop-recover")?.connectionRetry ?? null).toBeNull();

		manager.stopTaskSession("task-conn-drop-recover");
	});

	it("stops the retry timer after the session is stopped", async () => {
		const getSession = spawnManagerWithSession(1004);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-stop",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-stop",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		manager.stopTaskSession("task-conn-drop-stop");
		await vi.advanceTimersByTimeAsync(30_000);
		// 计时器已清理：永远不会注入。
		expect(write).not.toHaveBeenCalled();
	});

	it("manual continue-now triggers a single injection for a retrying session", async () => {
		const getSession = spawnManagerWithSession(1005);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-manual",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-manual",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		const triggered = manager.continueConnectionRetrySessions(["task-conn-drop-manual"]);
		expect(triggered).toEqual(["task-conn-drop-manual"]);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]?.[0]).toContain("/tmp/network-interruption-resume.md");

		// 不在重试列表里的任务 id 不应被触发。
		const none = manager.continueConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-manual");
	});

	it("stands down (clears retry state, no injection) when the turn flips to the user mid-episode", async () => {
		// 竞态：PTY 输出先于 hook 落地 → episode 已起（retrying）；随后 agent 向用户提问，
		// hook 经 transitionToReview 把回合翻成 user → 检测器即时让位、清「重连中」、绝不注入。
		const getSession = spawnManagerWithSession(1007);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-standdown",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-standdown",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-standdown")?.connectionRetry?.status).toBe("retrying");

		// agent 向用户提问 → hook 翻入 user 回合（question）。
		manager.transitionToReview("task-conn-drop-standdown", "hook", "question");
		expect(manager.getSummary("task-conn-drop-standdown")?.connectionRetry ?? null).toBeNull();

		// 退避定时器到点也不会注入（episode 已让位结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-standdown");
	});

	it("does not enter retry when a transient pattern arrives after the turn already flipped to the user", async () => {
		// 常见路径：hook 先于问题 UI 文本落地 → turnOwner 已是 user。问题 / 选项文本里命中瞬时
		// 正则（如 agent 在讨论 econnreset）也不起 episode、不置「重连中」、不注入。
		const getSession = spawnManagerWithSession(1008);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-user-first",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-user-first",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		// 先翻入 user 回合（提问），再让带连接错误措辞的「问题文本」流过检测器。
		manager.transitionToReview("task-conn-drop-user-first", "hook", "question");
		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();

		expect(manager.getSummary("task-conn-drop-user-first")?.connectionRetry ?? null).toBeNull();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		manager.stopTaskSession("task-conn-drop-user-first");
	});

	it("manual dismiss removes a retrying session from the list without injecting", async () => {
		const getSession = spawnManagerWithSession(1006);
		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-conn-drop-dismiss",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-conn-drop-dismiss",
			prompt: "Do the task",
		});
		const session = getSession();
		const write = (session as NonNullable<typeof session>).write;

		(session as NonNullable<typeof session>).triggerData(CLAUDE_ERROR_WITH_PROMPT);
		await settleOutputAnalysisBatch();
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry?.status).toBe("retrying");

		// 手动移出列表：结束 episode、清重连状态、不注入。
		const dismissed = manager.dismissConnectionRetrySessions(["task-conn-drop-dismiss"]);
		expect(dismissed).toEqual(["task-conn-drop-dismiss"]);
		expect(manager.getSummary("task-conn-drop-dismiss")?.connectionRetry ?? null).toBeNull();

		// 移出后退避定时器再触发也不应注入（episode 已结束、定时器已清）。
		await vi.advanceTimersByTimeAsync(30_000);
		expect(write).not.toHaveBeenCalled();

		// 不在重试列表里的任务 id 不应被移出。
		const none = manager.dismissConnectionRetrySessions(["nonexistent-task"]);
		expect(none).toEqual([]);

		manager.stopTaskSession("task-conn-drop-dismiss");
	});
});
