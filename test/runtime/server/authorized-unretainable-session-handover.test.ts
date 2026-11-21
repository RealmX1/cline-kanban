import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerRuntimeCommand } from "../../../src/commands/runtime";
import {
	type AuthorizedUnretainableHandoverSession,
	runtimePlannedHandoverRestartRequestSchema,
} from "../../../src/core/api-contract";
import {
	canonicalizeInterruptedSessionsForHandover,
	resolveAuthorizedOwnerSessionFromBlockingInventory,
} from "../../../src/deployment/local-redeployment-standard-execution";
import {
	decideAuthorizedUnretainableSessionHandover,
	liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions,
	liveRuntimeEnforcesAuthorizedUnretainableSessionHandoverBinding,
	plannedHandoverInterruptionDecision,
	plannedRedeploymentHandoverDispatch,
} from "../../../src/server/authorized-unretainable-session-handover";

const { requestBoundHandover, requestLegacyHandover, printHandoverResult } = vi.hoisted(() => ({
	requestBoundHandover: vi.fn(),
	requestLegacyHandover: vi.fn(),
	printHandoverResult: vi.fn(),
}));
vi.mock("../../../src/commands/task", () => ({
	createRuntimeTrpcClient: () => ({
		runtime: {
			requestPlannedHandoverRestartWithAuthorizedUnretainableSessions: { mutate: requestBoundHandover },
			requestPlannedHandoverRestartPreservingHostedAgentSessions: { mutate: requestLegacyHandover },
		},
	}),
	printJson: printHandoverResult,
}));

const verifiedSession: AuthorizedUnretainableHandoverSession = {
	workspaceId: "workspace",
	conversationSessionId: "session",
	processId: 40,
	nativeConversationSessionId: "native",
	runtimeSessionIncarnationId: "generation",
	sessionKind: "acp_stdio_subprocess",
};

describe("授权交接只覆盖已核验代际和会话", () => {
	const binding = {
		runtimeProcessId: 10,
		runtimeProcessStartTimeText: "Fri Nov 13 12:05:00 2026",
		interruptedSessions: [verifiedSession],
	};

	it("代际和会话清单仍匹配时允许中断", () => {
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: "  Fri   Nov 13 12:05:00 2026 ",
				currentSessions: [verifiedSession],
			}),
		).toBe("allow");
	});

	it("已核验会话自然退出后仍允许，新会话或另一代 runtime 则拒绝", () => {
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [],
			}),
		).toBe("allow");
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [{ ...verifiedSession, conversationSessionId: "new-session" }],
			}),
		).toBe("refuse");
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding,
				currentProcessId: 11,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
			}),
		).toBe("refuse");
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: null,
				currentSessions: [],
			}),
		).toBe("refuse");
	});

	it("没有绑定时不把布尔授权解释成已核验清单", () => {
		expect(
			decideAuthorizedUnretainableSessionHandover({
				allowInterruption: true,
				binding: undefined,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
			}),
		).toBe("unbound");
	});
});

describe("旧 runtime 不能凭布尔值中断未绑定会话", () => {
	const binding = {
		runtimeProcessId: 10,
		runtimeProcessStartTimeText: "Fri Nov 13 12:05:00 2026",
		interruptedSessions: [verifiedSession],
	};

	it("旧实例不认识绑定交接入口时，CLI 保留失败，不尝试旧的布尔入口", async () => {
		requestBoundHandover.mockRejectedValueOnce(new Error("旧实例没有此 procedure"));
		const program = new Command();
		registerRuntimeCommand(program);
		const previousExitCode = process.exitCode;
		try {
			await program.parseAsync(
				["runtime", "handover-restart", "--authorized-unretainable-session-handover", JSON.stringify(binding)],
				{ from: "user" },
			);
			expect(requestBoundHandover).toHaveBeenCalledWith(binding);
			expect(requestLegacyHandover).not.toHaveBeenCalled();
			expect(printHandoverResult).toHaveBeenCalledWith({
				ok: false,
				error: expect.stringContaining("旧实例没有此 procedure"),
			});
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("诊断没有绑定能力时，调用方不得把缺省当成会执行绑定", () => {
		expect(liveRuntimeEnforcesAuthorizedUnretainableSessionHandoverBinding({})).toBe(false);
		expect(
			liveRuntimeEnforcesAuthorizedUnretainableSessionHandoverBinding({
				enforcesAuthorizedUnretainableSessionHandoverBinding: false,
			}),
		).toBe(false);
		expect(
			liveRuntimeEnforcesAuthorizedUnretainableSessionHandoverBinding({
				enforcesAuthorizedUnretainableSessionHandoverBinding: true,
			}),
		).toBe(true);
		expect(liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions({})).toBe(false);
		expect(
			liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions({
				enforcesAuthorizedUnretainableSessionHandoverBinding: true,
			}),
		).toBe(false);
		expect(
			liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions({
				acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions: true,
			}),
		).toBe(true);
	});

	it("旧入口保留随请求提交的预检绑定，代际不符时拒绝", () => {
		const parsed = runtimePlannedHandoverRestartRequestSchema.parse({
			allowInterruptingAgentSessionsNotPreservedByAgentSessionPtyHost: true,
			authorizedUnretainableSessionHandover: binding,
		});
		expect(parsed.authorizedUnretainableSessionHandover).toEqual(binding);
		expect(
			plannedHandoverInterruptionDecision({
				allowInterruption: true,
				binding: parsed.authorizedUnretainableSessionHandover,
				currentProcessId: 11,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
				countedSessionsThatWouldEnd: 1,
			}),
		).toEqual({ outcome: "refuse" });
	});

	it("旧绑定字段不能代替专用入口；无阻塞会话才走默认受保护交接", () => {
		expect(
			plannedRedeploymentHandoverDispatch({
				allowInterruption: true,
				receiverAcceptsDedicatedProcedure: false,
				blockingSessionCount: 1,
			}),
		).toBe("wait_for_unretainable_sessions");
		expect(
			plannedRedeploymentHandoverDispatch({
				allowInterruption: true,
				receiverAcceptsDedicatedProcedure: false,
				blockingSessionCount: 0,
			}),
		).toBe("send_default_protected_handover");
		expect(
			plannedRedeploymentHandoverDispatch({
				allowInterruption: true,
				receiverAcceptsDedicatedProcedure: true,
				blockingSessionCount: 0,
			}),
		).toBe("send_dedicated_binding");
		expect(
			plannedRedeploymentHandoverDispatch({
				allowInterruption: false,
				receiverAcceptsDedicatedProcedure: true,
				blockingSessionCount: 1,
			}),
		).toBe("send_default_protected_handover");
	});

	it("保留旧入口的显式布尔授权，缺省仍拒绝中断", () => {
		expect(
			plannedHandoverInterruptionDecision({
				allowInterruption: true,
				binding: undefined,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
				countedSessionsThatWouldEnd: 1,
			}),
		).toEqual({ outcome: "start" });
		expect(
			plannedHandoverInterruptionDecision({
				allowInterruption: false,
				binding: undefined,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
				countedSessionsThatWouldEnd: 1,
			}),
		).toEqual({ outcome: "refuse" });
	});

	it("带上匹配绑定才回传启动时刻，计数与清单不一致时拒绝", () => {
		expect(
			plannedHandoverInterruptionDecision({
				allowInterruption: false,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
				countedSessionsThatWouldEnd: 1,
			}),
		).toEqual({ outcome: "start_bound", runtimeProcessStartTimeText: binding.runtimeProcessStartTimeText });
		expect(
			plannedHandoverInterruptionDecision({
				allowInterruption: false,
				binding,
				currentProcessId: 10,
				currentProcessStartTimeText: binding.runtimeProcessStartTimeText,
				currentSessions: [verifiedSession],
				countedSessionsThatWouldEnd: 2,
			}),
		).toEqual({ outcome: "refuse" });
	});
});

describe("发起会话的中断回执能识别 ACP 诊断", () => {
	const owner = {
		conversationSessionId: "owner-session",
		nativeSessionId: "owner-native",
		runtimeSessionIncarnationId: "owner-generation",
	};

	it("诊断行带原生身份时直接匹配，身份不符则不回退", () => {
		expect(
			resolveAuthorizedOwnerSessionFromBlockingInventory({
				blockingSessions: [
					{
						workspaceId: "workspace",
						conversationSessionId: "owner-session",
						processId: 7,
						sessionTransport: "acp_stdio_subprocess",
						nativeConversationSessionId: "owner-native",
						runtimeSessionIncarnationId: "owner-generation",
					},
				],
				workspaceId: "workspace",
				owner,
				persistedOwnerSummary: null,
			}).status,
		).toBe("matched");
		expect(
			resolveAuthorizedOwnerSessionFromBlockingInventory({
				blockingSessions: [
					{
						workspaceId: "workspace",
						conversationSessionId: "owner-session",
						sessionTransport: "acp_stdio_subprocess",
						nativeConversationSessionId: "other-native",
						runtimeSessionIncarnationId: "owner-generation",
					},
				],
				workspaceId: "workspace",
				owner,
				persistedOwnerSummary: {
					nativeSessionId: "owner-native",
					runtimeSessionIncarnationId: "owner-generation",
				},
			}).status,
		).toBe("not_present");
	});

	it("旧 ACP 行缺少两项身份时，用交接前仍在的持久摘要核对", () => {
		expect(
			resolveAuthorizedOwnerSessionFromBlockingInventory({
				blockingSessions: [
					{
						workspaceId: "workspace",
						conversationSessionId: "owner-session",
						processId: 7,
						sessionTransport: "acp_stdio_subprocess",
					},
				],
				workspaceId: "workspace",
				owner,
				persistedOwnerSummary: {
					nativeSessionId: "owner-native",
					runtimeSessionIncarnationId: "owner-generation",
				},
			}).status,
		).toBe("matched");
		expect(
			resolveAuthorizedOwnerSessionFromBlockingInventory({
				blockingSessions: [
					{
						workspaceId: "workspace",
						conversationSessionId: "owner-session",
						processId: 7,
						sessionTransport: "acp_stdio_subprocess",
					},
				],
				workspaceId: "workspace",
				owner,
				persistedOwnerSummary: null,
			}).status,
		).toBe("unconfirmed");
	});

	it("只把可识别的不可保留会话放进交接绑定", () => {
		expect(
			canonicalizeInterruptedSessionsForHandover([
				{
					workspaceId: "workspace",
					conversationSessionId: "owner-session",
					processId: 7,
					sessionTransport: "acp_stdio_subprocess",
					nativeConversationSessionId: "owner-native",
					runtimeSessionIncarnationId: "owner-generation",
					recoveryCondition: "等待自然结束",
				},
			]),
		).toEqual({
			ok: true,
			interruptedSessions: [
				{
					workspaceId: "workspace",
					conversationSessionId: "owner-session",
					processId: 7,
					nativeConversationSessionId: "owner-native",
					runtimeSessionIncarnationId: "owner-generation",
					sessionKind: "acp_stdio_subprocess",
				},
			],
		});
		expect(canonicalizeInterruptedSessionsForHandover([{ processId: 7 }]).ok).toBe(false);
	});
});
