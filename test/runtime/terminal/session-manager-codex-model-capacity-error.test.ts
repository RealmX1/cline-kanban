import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../../../src/core/codex-native-agent-turn-execution-observation";
import { resolveSessionFacets } from "../../../src/core/session-activity";
import type * as AgentSessionAdapters from "../../../src/terminal/agent-session-adapters";
import { resolveAgentOutputTransitionDetectionForAgentId } from "../../../src/terminal/agent-session-adapters";
import { type StartTaskSessionRequest, TerminalSessionManager } from "../../../src/terminal/session-manager";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());
const nativeExecutionReadMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/terminal/agent-session-adapters", async (importOriginal) => ({
	...(await importOriginal<typeof AgentSessionAdapters>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));
vi.mock("../../../src/terminal/pty-session", () => ({ PtySession: { spawn: ptySessionSpawnMock } }));
vi.mock("../../../src/agent-session-history/codex-native-agent-turn-execution-reader", () => ({
	readCodexNativeAgentTurnExecution: nativeExecutionReadMock,
}));

const CAPACITY_ERROR = "■ Selected model is at capacity. Please try a different model.";
const managers: TerminalSessionManager[] = [];
interface MockSpawnRequest {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null }) => void;
}
function createMockPtySession(request: MockSpawnRequest) {
	let exited = false;
	return {
		pid: 1234,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(() => {
			exited = true;
			request.onExit?.({ exitCode: 0 });
		}),
		hasExited: () => exited,
		wasInterrupted: () => false,
		output: (text: string | Buffer) => request.onData?.(Buffer.isBuffer(text) ? text : Buffer.from(text)),
	};
}
async function startSession(
	overrides: Partial<StartTaskSessionRequest> = {},
	existingManager?: TerminalSessionManager,
) {
	const manager =
		existingManager ??
		new TerminalSessionManager({
			prepareCodexNativeSessionControlHostLaunch: async (request) => ({
				binary: request.binary ?? "codex",
				args: [...request.arguments],
				env: request.environment,
				endpoint: {
					socketPath: "/isolated/codex-capacity-error/control.sock",
					workspaceId: request.workspaceId,
					conversationSessionId: request.conversationSessionId,
					runtimeSessionIncarnationId: request.runtimeSessionIncarnationId,
				},
				cleanup: async () => {},
			}),
		});
	if (!existingManager) managers.push(manager);
	let session: ReturnType<typeof createMockPtySession> | undefined;
	ptySessionSpawnMock.mockImplementationOnce((request: MockSpawnRequest) => {
		session = createMockPtySession(request);
		return session;
	});
	await manager.startTaskSession({
		taskId: "capacity-error",
		agentId: "codex",
		binary: "codex",
		args: [],
		cwd: "/isolated/codex-capacity-error",
		prompt: "执行任务",
		codexModelCapacityErrorAutoContinuationEnabled: false,
		workspaceId: "isolated",
		...overrides,
	});
	if (!session) throw new Error("未创建测试终端");
	return { manager, session, taskId: overrides.taskId ?? "capacity-error" };
}
async function flushOutputAnalysis() {
	await vi.advanceTimersByTimeAsync(50);
}
function resolveTestSessionFacets(summary: RuntimeTaskSessionSummary | null) {
	if (!summary) throw new Error("测试会话不存在");
	return resolveSessionFacets(summary);
}
function expectLiveError(summary: RuntimeTaskSessionSummary | null) {
	expect(resolveTestSessionFacets(summary)).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "error" });
	expect(summary).toMatchObject({ reviewReason: "error", pid: 1234, connectionRetry: null });
}
function bindNativeIdentity(manager: TerminalSessionManager, taskId: string) {
	manager.applyAgentNativeConversationSessionIdentity(taskId, {
		sourceAgentId: "codex",
		nativeSessionId: "native-capacity",
		transcriptPath: "/isolated/codex-capacity-error/native.jsonl",
		observedAt: Date.now(),
	});
}
function execution(summary: RuntimeTaskSessionSummary): CodexNativeAgentTurnExecutionObservation {
	return {
		workspaceId: "isolated",
		conversationSessionId: summary.taskId,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? "",
		nativeSessionId: "native-capacity",
		nativeTurnId: "native-turn",
		nativeTurnStartedAtMs: Date.now(),
		observedAtMs: Date.now(),
		threadStatus: "active",
		nativeTurnStatus: "inProgress",
		activeFlags: [],
		canAcceptDirectInput: true,
		executionStatus: "running",
	};
}

describe("Codex 模型容量不足后的会话交棒", () => {
	it("确认停止等待原PTY退出，不把已发信号当作退出", async () => {
		const { manager, session, taskId } = await startSession();
		const exitProcess = session.stop.getMockImplementation();
		session.stop.mockImplementation(() => {
			setTimeout(() => exitProcess?.(), 100);
		});
		let receiptReceived = false;
		const stopping = manager.stopTaskSessionAndConfirmExit(taskId).then((receipt) => {
			receiptReceived = true;
			return receipt;
		});
		await vi.advanceTimersByTimeAsync(50);
		expect(receiptReceived).toBe(false);
		await vi.advanceTimersByTimeAsync(100);
		expect(await stopping).toMatchObject({ processExitConfirmed: true });
	});
	it("SIGKILL后仍无退出事件时，释放注册表也不冒充退出确认", async () => {
		const { manager, session, taskId } = await startSession();
		session.stop.mockImplementation(() => undefined);
		const stopping = manager.stopTaskSessionAndConfirmExit(taskId);
		await vi.advanceTimersByTimeAsync(2_600);
		expect(await stopping).toMatchObject({ processExitConfirmed: false });
		expect(session.stop).toHaveBeenCalledTimes(2);
	});
	it("任务 ID 复用后，新进程的新故障绑定当前任务 incarnation", async () => {
		let incarnation = 1;
		const manager = new TerminalSessionManager({
			readAutomaticFailureContinuationEligibility: async () => ({
				eligible: true,
				taskIncarnationCreatedAtEpochMs: incarnation,
				connectionEnabled: true,
				capacityEnabled: true,
			}),
		});
		managers.push(manager);
		const first = await startSession({ codexModelCapacityErrorAutoContinuationEnabled: true }, manager);
		first.session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		const originalEpisode = manager.getSummary(first.taskId)?.automaticAgentFailureContinuation;
		expect(originalEpisode?.taskIncarnationCreatedAtEpochMs).toBe(1);
		await manager.forceStopTaskSession(first.taskId);
		incarnation = 2;
		const second = await startSession({ codexModelCapacityErrorAutoContinuationEnabled: true }, manager);
		second.session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(second.taskId)?.automaticAgentFailureContinuation).toMatchObject({
			taskIncarnationCreatedAtEpochMs: 2,
			phase: "waiting_backoff",
		});
		expect(manager.getSummary(second.taskId)?.automaticAgentFailureContinuation?.episodeId).not.toBe(
			originalEpisode?.episodeId,
		);
	});
	it.each([true, false])("默认开启的容量恢复不受网络开关 %s 影响", async (autoContinueOnConnectionDropEnabled) => {
		const { manager, session, taskId } = await startSession({
			autoContinueOnConnectionDropEnabled,
			codexModelCapacityErrorAutoContinuationEnabled: undefined,
		});
		session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation).toMatchObject({
			reason: "model_capacity",
			phase: "waiting_backoff",
		});
		const recovery = manager.getSummary(taskId)?.automaticAgentFailureContinuation;
		if (!recovery) throw new Error("缺少容量恢复记录");
		expect(recovery.deadlineAtMs).toBe(recovery.firstErrorAtMs + 30 * 60_000);
		expect(manager.getSummary(taskId)?.liveness).toBe("retrying");
		manager.reconcileAutomaticFailureContinuationSettings(true, false);
		expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation?.phase).toBe("cancelled");
		manager.reconcileAutomaticFailureContinuationSettings(true, true);
		session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation?.phase).toBe("cancelled");
	});
	it("关闭容量开关本身保留网络恢复，新容量故障则必须交棒而不能借用网络策略", async () => {
		const { manager, session, taskId } = await startSession({ autoContinueOnConnectionDropEnabled: true });
		session.output("Error: read ECONNRESET\n› ");
		await flushOutputAnalysis();
		const original = manager.getSummary(taskId)?.automaticAgentFailureContinuation;
		expect(original).toMatchObject({ reason: "connection", phase: "waiting_backoff" });
		manager.reconcileAutomaticFailureContinuationSettings(true, false);
		expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation).toMatchObject({
			episodeId: original?.episodeId,
			reason: "connection",
			phase: "waiting_backoff",
		});
		session.output(`\n${CAPACITY_ERROR}\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.automaticAgentFailureContinuation).toMatchObject({
			reason: "model_capacity",
			phase: "cancelled",
		});
		expectLiveError(manager.getSummary(taskId));
	});
	it("读取失败时使用刚更新的关闭设置，不能退回启动时的开启快照", async () => {
		const manager = new TerminalSessionManager({
			readAutomaticFailureContinuationEligibility: async () => {
				throw new Error("配置暂时不可读");
			},
		});
		managers.push(manager);
		const session = await startSession({ codexModelCapacityErrorAutoContinuationEnabled: true }, manager);
		manager.reconcileAutomaticFailureContinuationSettings(true, false);
		session.session.output(`${CAPACITY_ERROR}\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(session.taskId)?.automaticAgentFailureContinuation ?? null).toBeNull();
		expectLiveError(manager.getSummary(session.taskId));
	});

	it("资格查询失败时仍遵守已经关闭的容量开关", async () => {
		const manager = new TerminalSessionManager({
			readAutomaticFailureContinuationEligibility: async () => {
				throw new Error("看板暂时不可读");
			},
		});
		managers.push(manager);
		const disabled = await startSession({ codexModelCapacityErrorAutoContinuationEnabled: false }, manager);
		disabled.session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expect(disabled.manager.getSummary(disabled.taskId)?.automaticAgentFailureContinuation ?? null).toBeNull();
		expectLiveError(disabled.manager.getSummary(disabled.taskId));
		const enabled = await startSession(
			{ taskId: "capacity-eligibility-open", codexModelCapacityErrorAutoContinuationEnabled: true },
			manager,
		);
		enabled.session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expect(manager.getSummary(enabled.taskId)?.automaticAgentFailureContinuation).toMatchObject({
			reason: "model_capacity",
			phase: "waiting_backoff",
		});
	});
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_790_000_000_000);
		prepareAgentLaunchMock.mockReset().mockImplementation(async (request: StartTaskSessionRequest) => ({
			binary: request.binary,
			args: request.args,
			env: {},
			...resolveAgentOutputTransitionDetectionForAgentId(request.agentId),
		}));
		ptySessionSpawnMock.mockReset();
		nativeExecutionReadMock.mockReset().mockResolvedValue(null);
	});
	afterEach(() => {
		for (const manager of managers.splice(0)) manager.dispose();
		vi.useRealTimers();
	});

	it.each([true, false])("自动连接重试为 %s 时均识别错误并保留进程", async (autoContinueOnConnectionDropEnabled) => {
		const { manager, session, taskId } = await startSession({ autoContinueOnConnectionDropEnabled });
		session.output(`${CAPACITY_ERROR}\r\n› `);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
		expect(session.stop).not.toHaveBeenCalled();
	});

	it.each([
		["\u001b[31m■ Selected model is at capacity.\u001b[0m\r\n  Please try a different model.\r\n"],
		["\r\n■ Selected model is at ", "capacity. Please try a ", "different model.\r\n"],
		["\u001b[3", "1m■ Selected model is at capacity. Please try a different model.\u001b[0m\n"],
	])("识别 ANSI、折行和跨分析批次分片：%j", async (...chunks) => {
		const { manager, session, taskId } = await startSession({ autoContinueOnConnectionDropEnabled: false });
		for (const chunk of chunks) {
			session.output(chunk);
			await flushOutputAnalysis();
		}
		expectLiveError(manager.getSummary(taskId));
	});

	it("错误符号的 UTF-8 字节跨 PTY chunk 时仍能识别", async () => {
		const { manager, session, taskId } = await startSession();
		const bytes = Buffer.from(`${CAPACITY_ERROR}\n`);
		session.output(bytes.subarray(0, 1));
		await flushOutputAnalysis();
		session.output(bytes.subarray(1));
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("结束连接重试与定时器，重复重绘不制造新交棒或恢复 Running", async () => {
		const { manager, session, taskId } = await startSession();
		session.output("stream disconnected before completion\n› ");
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.connectionRetry).not.toBeNull();
		session.output(`\n${CAPACITY_ERROR}\n› `);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
		const handoff = manager.getSummary(taskId)?.lastAgentConversationUserHandoffObservation;
		for (let redraw = 0; redraw < 3; redraw += 1) {
			session.output(`\r\n${CAPACITY_ERROR}\n› `);
			await flushOutputAnalysis();
		}
		await vi.advanceTimersByTimeAsync(20_000);
		expectLiveError(manager.getSummary(taskId));
		expect(manager.getSummary(taskId)?.lastAgentConversationUserHandoffObservation).toEqual(handoff);
		expect(session.write).not.toHaveBeenCalled();
	});

	it.each([
		`用户引用：“${CAPACITY_ERROR}”\n`,
		`> ${CAPACITY_ERROR}\n`,
		`\`\`\`text\n${CAPACITY_ERROR}\n\`\`\`\n`,
		"■ Another error.\n",
		"Selected model is at capacity. Please try a different model.\n",
	])("普通引用和其他错误不误报：%s", async (output) => {
		const { manager, session, taskId } = await startSession();
		session.output(output);
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it("恢复会话的历史重播不触发错误交棒", async () => {
		const { manager, session, taskId } = await startSession({ resumeFromTrash: true });
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it("历史批次在用户输入解除恢复守卫后才 flush 也不当成新错误", async () => {
		const { manager, session, taskId } = await startSession({ resumeFromTrash: true });
		session.output(`${CAPACITY_ERROR}\n`);
		manager.writeInput(taskId, Buffer.from("编辑草稿"));
		await flushOutputAnalysis();
		expect(manager.getSummary(taskId)?.reviewReason).not.toBe("error");
	});

	it("旧回合残片与新回合正文不拼成错误", async () => {
		const { manager, session, taskId } = await startSession();
		session.output("■ Selected model is at capacity. ");
		await flushOutputAnalysis();
		manager.transitionToReview(taskId, "hook");
		manager.transitionToRunning(taskId, { userInitiatedResume: true });
		session.output("Please try a different model.\n");
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it("缓存有界，滚出窗口的残片不再拼接，后续完整错误仍可识别", async () => {
		const { manager, session, taskId } = await startSession();
		session.output("■ Selected model is at capacity. ");
		await flushOutputAnalysis();
		session.output(`${"x".repeat(16_384)}\nPlease try a different model.\n`);
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("同一任务替换进程后不继承前代错误残片", async () => {
		const { manager, session, taskId } = await startSession();
		session.output("■ Selected model is at capacity. ");
		await flushOutputAnalysis();
		manager.stopTaskSession(taskId);
		let replacement: ReturnType<typeof createMockPtySession> | undefined;
		ptySessionSpawnMock.mockImplementationOnce((request: MockSpawnRequest) => {
			replacement = createMockPtySession(request);
			return replacement;
		});
		await manager.startTaskSession({
			taskId,
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/isolated/codex-capacity-error",
			prompt: "启动新进程",
		});
		if (!replacement) throw new Error("未创建后继终端");
		replacement.output("Please try a different model.\n");
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it.each(["running", "waiting_for_user"] as const)(
		"原生当前回合为 %s 时旧错误重绘不交棒",
		async (executionStatus) => {
			const { manager, session, taskId } = await startSession();
			bindNativeIdentity(manager, taskId);
			nativeExecutionReadMock.mockImplementation(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				executionStatus,
			}));
			session.output(`${CAPACITY_ERROR}\n`);
			await flushOutputAnalysis();
			expect(nativeExecutionReadMock).toHaveBeenCalledOnce();
			expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
			// 后续同回合真实失败仍能被识别，不永久锁死相同文案。
			nativeExecutionReadMock.mockImplementation(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				threadStatus: "idle",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
			}));
			session.output(`${CAPACITY_ERROR}\n`);
			await flushOutputAnalysis();
			expectLiveError(manager.getSummary(taskId));
		},
	);

	it("原生查询不可用时以完整终端错误为替代证据", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		nativeExecutionReadMock.mockRejectedValue(new Error("隔离控制端点不可用"));
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("共享在途查询的旧完成结果须重新读取，不能覆盖当前仍在执行的回合", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		nativeExecutionReadMock
			.mockImplementationOnce(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				observedAtMs: Date.now() - 1_000,
				nativeTurnId: "previous-turn",
				threadStatus: "idle",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
			}))
			.mockImplementationOnce(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => execution(summary));
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledTimes(2);
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it("原生查询等待期间已接受新回合，旧错误结果不能交棒", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		let resolveRead: (value: null) => void = () => {};
		nativeExecutionReadMock.mockReturnValue(
			new Promise<null>((resolve) => {
				resolveRead = resolve;
			}),
		);
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledOnce();
		manager.confirmAcceptedAgentConversationInput(taskId, {
			observedAtMs: Date.now(),
			eventId: "codex:native-capacity:next-turn:user",
			nativeSessionId: "native-capacity",
			runtimeSessionIncarnationId: manager.getSummary(taskId)?.runtimeSessionIncarnationId ?? "",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		resolveRead(null);
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it("用户回合的旧错误批次不能在新输入已接受后触发", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		manager.transitionToReview(taskId, "hook");
		session.output(`${CAPACITY_ERROR}\n`);
		await vi.advanceTimersByTimeAsync(1);
		manager.confirmAcceptedAgentConversationInput(taskId, {
			observedAtMs: Date.now(),
			eventId: "codex:native-capacity:new-turn:user",
			nativeSessionId: "native-capacity",
			runtimeSessionIncarnationId: manager.getSummary(taskId)?.runtimeSessionIncarnationId ?? "",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		expect(nativeExecutionReadMock).not.toHaveBeenCalled();
	});

	it("其他 agent 与并行 Codex 会话不共享错误或分片缓存", async () => {
		const first = await startSession({ taskId: "first-capacity" });
		const second = await startSession({ taskId: "second-capacity" }, first.manager);
		const claude = await startSession({ taskId: "claude-capacity", agentId: "claude" }, first.manager);
		first.session.output("■ Selected model is at capacity. ");
		second.session.output("Please try a different model.\n");
		claude.session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		for (const current of [first, second, claude])
			expect(resolveTestSessionFacets(current.manager.getSummary(current.taskId)).turnOwner).toBe("agent");
		first.session.output("Please try a different model.\n");
		await flushOutputAnalysis();
		expectLiveError(first.manager.getSummary(first.taskId));
		expect(resolveTestSessionFacets(second.manager.getSummary(second.taskId)).turnOwner).toBe("agent");
	});

	it("识别 CSI 回行并清行后重绘的完整错误", async () => {
		const { manager, session, taskId } = await startSession({ autoContinueOnConnectionDropEnabled: false });
		session.output("Working...");
		await flushOutputAnalysis();
		session.output(`\u001b[1G\u001b[2K\u001b[31m${CAPACITY_ERROR}\u001b[0m`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("扫描截断保留代码围栏状态，围栏后的真实错误仍可识别", async () => {
		const { manager, session, taskId } = await startSession();
		session.output(`\`\`\`text\n${"ordinary log line\n".repeat(600)}${CAPACITY_ERROR}\n\`\`\`\n`);
		await flushOutputAnalysis();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("跨批长代码引用不误报，闭围栏后的真实错误可识别", async () => {
		const { manager, session, taskId } = await startSession();
		for (const output of ["```text\n", "示例行\n".repeat(2_500), `${CAPACITY_ERROR}\n\`\`\`\n`]) {
			session.output(output);
			await flushOutputAnalysis();
			expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		}
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it.each(["\u001b[K", "\u001b[0K", "\u001b[2G", "\u001b[10G"])(
		"保留引用前缀的 ANSI 控制不能伪造行首：%j",
		async (controlSequence) => {
			const { manager, session, taskId } = await startSession();
			session.output(`引用文字${controlSequence}${CAPACITY_ERROR}\n`);
			await flushOutputAnalysis();
			expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		},
	);

	it("完整错误入批后补到原生身份仍属于同回合", async () => {
		const { manager, session, taskId } = await startSession();
		session.output(`${CAPACITY_ERROR}\n`);
		bindNativeIdentity(manager, taskId);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("完整错误入批后补到已结束的初始输入接受仍属于同回合", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		session.output(`${CAPACITY_ERROR}\n`);
		manager.confirmAcceptedAgentConversationInput(taskId, {
			observedAtMs: Date.now(),
			eventId: "codex:native-capacity:initial-turn:user",
			nativeSessionId: "native-capacity",
			runtimeSessionIncarnationId: manager.getSummary(taskId)?.runtimeSessionIncarnationId ?? "",
			acceptedNativeAgentTurnIsInProgress: false,
		});
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it("原生查询等待期间补到初始输入接受不丢弃当前错误", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		let resolveRead: (value: null) => void = () => {};
		nativeExecutionReadMock.mockReturnValue(
			new Promise<null>((resolve) => {
				resolveRead = resolve;
			}),
		);
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		manager.confirmAcceptedAgentConversationInput(taskId, {
			observedAtMs: Date.now(),
			eventId: "codex:native-capacity:initial-turn:user",
			nativeSessionId: "native-capacity",
			runtimeSessionIncarnationId: manager.getSummary(taskId)?.runtimeSessionIncarnationId ?? "",
			acceptedNativeAgentTurnIsInProgress: false,
		});
		resolveRead(null);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
	});

	it.each(["running", "finished"] as const)("查询期间首次补到身份后重验当前原生 %s 状态", async (executionStatus) => {
		const { manager, session, taskId } = await startSession();
		let resolveRead: (value: null) => void = () => {};
		nativeExecutionReadMock
			.mockReturnValueOnce(
				new Promise<null>((resolve) => {
					resolveRead = resolve;
				}),
			)
			.mockImplementationOnce(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				executionStatus,
			}));
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		bindNativeIdentity(manager, taskId);
		resolveRead(null);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledTimes(2);
		if (executionStatus === "finished") expectLiveError(manager.getSummary(taskId));
		else expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it.each([CAPACITY_ERROR, "■ Selected model is at capacity. "])(
		"已绑定身份切换后不继承旧身份的容量错误或残片：%s",
		async (oldOutput) => {
			const { manager, session, taskId } = await startSession();
			bindNativeIdentity(manager, taskId);
			session.output(oldOutput);
			manager.applyAgentNativeConversationSessionIdentity(taskId, {
				sourceAgentId: "codex",
				nativeSessionId: "replacement-native-capacity",
				transcriptPath: "/isolated/codex-capacity-error/replacement-native.jsonl",
				observedAt: Date.now(),
			});
			session.output("Please try a different model.\n");
			await flushOutputAnalysis();
			expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
		},
	);

	it("原生查询在途期间的新错误会在当前查询结束后重新核验", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		let resolveRead: (value: CodexNativeAgentTurnExecutionObservation) => void = () => {};
		nativeExecutionReadMock
			.mockImplementationOnce(
				async ({ summary }: { summary: RuntimeTaskSessionSummary }) =>
					new Promise<CodexNativeAgentTurnExecutionObservation>((resolve) => {
						resolveRead = resolve;
						void summary;
					}),
			)
			.mockImplementationOnce(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				threadStatus: "idle",
				nativeTurnStatus: "failed",
				executionStatus: "finished",
			}));
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledOnce();
		resolveRead(execution(manager.getSummary(taskId) as RuntimeTaskSessionSummary));
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledTimes(2);
		expectLiveError(manager.getSummary(taskId));
	});

	it("原生身份切换后不把旧身份排队的错误重验交给新身份", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		let resolveRead: (value: null) => void = () => {};
		nativeExecutionReadMock.mockReturnValueOnce(
			new Promise<null>((resolve) => {
				resolveRead = resolve;
			}),
		);
		for (let redraw = 0; redraw < 2; redraw += 1) {
			session.output(`${CAPACITY_ERROR}\n`);
			await flushOutputAnalysis();
		}
		manager.applyAgentNativeConversationSessionIdentity(taskId, {
			sourceAgentId: "codex",
			nativeSessionId: "replacement-native-capacity",
			transcriptPath: "/isolated/codex-capacity-error/replacement-native.jsonl",
			observedAt: Date.now(),
		});
		resolveRead(null);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledOnce();
		expect(resolveTestSessionFacets(manager.getSummary(taskId)).turnOwner).toBe("agent");
	});

	it("补读失败时清除错误发生前的 running 快照", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		await vi.advanceTimersByTimeAsync(2_000);
		nativeExecutionReadMock
			.mockImplementationOnce(async ({ summary }: { summary: RuntimeTaskSessionSummary }) => ({
				...execution(summary),
				observedAtMs: Date.now() - 1_000,
			}))
			.mockRejectedValueOnce(new Error("隔离控制端点不可用"));
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expect(nativeExecutionReadMock).toHaveBeenCalledTimes(2);
		expectLiveError(manager.getSummary(taskId));
	});

	it("提示符与原始 Enter 不恢复 Running，真实新输入接受后才恢复", async () => {
		const { manager, session, taskId } = await startSession();
		bindNativeIdentity(manager, taskId);
		session.output(`${CAPACITY_ERROR}\n`);
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
		manager.writeInput(taskId, Buffer.from("重新执行\r"));
		session.output("\n› \n");
		await flushOutputAnalysis();
		expectLiveError(manager.getSummary(taskId));
		manager.confirmAcceptedAgentConversationInput(taskId, {
			observedAtMs: Date.now(),
			eventId: "codex:native-capacity:new-turn:user",
			nativeSessionId: "native-capacity",
			runtimeSessionIncarnationId: manager.getSummary(taskId)?.runtimeSessionIncarnationId ?? "",
			acceptedNativeAgentTurnIsInProgress: true,
		});
		expect(resolveTestSessionFacets(manager.getSummary(taskId))).toEqual({
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
		});
		expect(manager.getSummary(taskId)?.reviewReason).toBeNull();
	});
});
