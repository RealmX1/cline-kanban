// 「agent 停止生成响应」归一化边沿观察器：计时态判据、四类置信度标签、边沿检测（起算 / 作废 /
// 不重复落库）、park 独立轨道、以及三种 transport 走同一段代码。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { mergeSummaryWithFacets } from "../../../src/core/session-activity";
import {
	createAgentSessionResponseGenerationStopObserver,
	deriveAgentResponseGenerationStopSignalConfidence,
	deriveAgentSessionRetentionDeadlineTransition,
	isAgentSessionRetentionDeadlineBearing,
} from "../../../src/server/agent-session-response-generation-stop-observer";
import type {
	PersistedAgentSessionReclamationDeadlineRecord,
	RecordAgentSessionRetentionDeadlineInput,
} from "../../../src/state/agent-session-reclamation-deadline-store";

const NOW = 1_700_000_000_000;
const ONE_HOUR_MS = 60 * 60_000;
const GRACE_PERIOD_MS = 2 * ONE_HOUR_MS;
const INCARNATION = "incarnation-1";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-a",
		state: "running",
		agentId: "claude",
		workspacePath: "/repo",
		pid: 4242,
		startedAt: NOW - 10_000,
		updatedAt: NOW,
		lastOutputAt: NOW,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: INCARNATION,
		agentResponseGenerationTurnSequence: 1,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		...overrides,
	};
}

// 「agent 完工、停在等人审查回合」——本机制最典型的计时目标。
function awaitingUserTurnSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return makeSummary({
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		reviewReason: "hook",
		...overrides,
	});
}

describe("isAgentSessionRetentionDeadlineBearing（计时态判据）", () => {
	it("agent 回合（球在 agent 手上）→ 不计时", () => {
		expect(isAgentSessionRetentionDeadlineBearing(makeSummary())).toBe(false);
	});

	it("等人回合 + 进程仍活着 → 计时", () => {
		expect(isAgentSessionRetentionDeadlineBearing(awaitingUserTurnSummary())).toBe(true);
	});

	it("等人回合但进程已退出 → 不计时（回收无事可做）", () => {
		expect(isAgentSessionRetentionDeadlineBearing(awaitingUserTurnSummary({ liveness: "exited", pid: null }))).toBe(
			false,
		);
	});

	it("无会话（turnOwner=null / liveness=none）→ 不计时", () => {
		expect(
			isAgentSessionRetentionDeadlineBearing(
				awaitingUserTurnSummary({ state: "idle", turnOwner: null, liveness: "none", userTurnKind: null }),
			),
		).toBe(false);
	});

	it("裸 shell 终端（agentId=null）→ 不计时", () => {
		expect(isAgentSessionRetentionDeadlineBearing(awaitingUserTurnSummary({ agentId: null }))).toBe(false);
	});

	it("缺 incarnation id（旧盘数据）→ 不计时（fail-safe，宁可漏回收）", () => {
		expect(
			isAgentSessionRetentionDeadlineBearing(awaitingUserTurnSummary({ runtimeSessionIncarnationId: undefined })),
		).toBe(false);
	});

	it("已 park 的 agent 回合 → 计时（走 park 独立轨道）", () => {
		expect(
			isAgentSessionRetentionDeadlineBearing(makeSummary({ awaitingDispatchedBackgroundWork: { sinceMs: NOW } })),
		).toBe(true);
	});
});

describe("deriveAgentResponseGenerationStopSignalConfidence（四类锚点标签）", () => {
	it("从未开始过任何 agent 回合 → session_ready_never_prompted", () => {
		expect(
			deriveAgentResponseGenerationStopSignalConfidence(
				awaitingUserTurnSummary({ agentResponseGenerationTurnSequence: 0 }),
			),
		).toBe("session_ready_never_prompted");
	});

	it("idle_stall 自愈 → prompt_ready_fallback", () => {
		expect(
			deriveAgentResponseGenerationStopSignalConfidence(awaitingUserTurnSummary({ reviewReason: "idle_stall" })),
		).toBe("prompt_ready_fallback");
	});

	it.each(["hook", "completion", "exit"] as const)("harness 宣告回合结束（%s）→ harness_turn_complete", (reason) => {
		expect(deriveAgentResponseGenerationStopSignalConfidence(awaitingUserTurnSummary({ reviewReason: reason }))).toBe(
			"harness_turn_complete",
		);
	});

	it("其余（error / attention / manual_review / null）→ structured_user_turn", () => {
		expect(
			deriveAgentResponseGenerationStopSignalConfidence(awaitingUserTurnSummary({ reviewReason: "error" })),
		).toBe("structured_user_turn");
		expect(deriveAgentResponseGenerationStopSignalConfidence(awaitingUserTurnSummary({ reviewReason: null }))).toBe(
			"structured_user_turn",
		);
	});
});

describe("deriveAgentSessionRetentionDeadlineTransition（边沿检测）", () => {
	const options = { nowMs: NOW };

	it("agent 回合 → 等人回合：起算，期限 = 停止时刻 + 2 小时", () => {
		const transition = deriveAgentSessionRetentionDeadlineTransition(
			makeSummary(),
			awaitingUserTurnSummary(),
			options,
		);
		expect(transition.kind).toBe("start_retention_deadline");
		if (transition.kind !== "start_retention_deadline") {
			return;
		}
		expect(transition.input.retentionAnchorKind).toBe("agent_response_generation_stopped");
		expect(transition.input.retentionAnchorAt).toBe(NOW);
		expect(transition.input.reclamationEligibleAt).toBe(NOW + GRACE_PERIOD_MS);
		expect(transition.input.responseGenerationStopSignalConfidence).toBe("harness_turn_complete");
		expect(transition.input.sessionTransport).toBe("pty_terminal");
	});

	it("停在同一个活体的同一轮 → 不重复落库", () => {
		const previous = awaitingUserTurnSummary();
		const next = awaitingUserTurnSummary({ updatedAt: NOW + 5_000, lastOutputAt: NOW + 5_000 });
		expect(deriveAgentSessionRetentionDeadlineTransition(previous, next, options).kind).toBe("none");
	});

	it("等人回合 → agent 回合（用户又发了一句）：作废期限", () => {
		expect(
			deriveAgentSessionRetentionDeadlineTransition(
				awaitingUserTurnSummary(),
				makeSummary({ agentResponseGenerationTurnSequence: 2 }),
				options,
			).kind,
		).toBe("supersede_retention_deadlines");
	});

	it("等人回合 → 进程退出：作废期限（没有可回收的东西了）", () => {
		expect(
			deriveAgentSessionRetentionDeadlineTransition(
				awaitingUserTurnSummary(),
				awaitingUserTurnSummary({ liveness: "exited", pid: null }),
				options,
			).kind,
		).toBe("supersede_retention_deadlines");
	});

	it("首次观测到一个本就不计时的会话 → 不动账本", () => {
		expect(deriveAgentSessionRetentionDeadlineTransition(null, makeSummary(), options).kind).toBe("none");
	});

	it("首次观测到一个已经停在等人回合的会话 → 起算（观察器晚于会话启动时也不漏）", () => {
		expect(deriveAgentSessionRetentionDeadlineTransition(null, awaitingUserTurnSummary(), options).kind).toBe(
			"start_retention_deadline",
		);
	});

	it("同一活体内换了一轮仍停在等人回合 → 重新起算（新 recordId 顶掉旧的）", () => {
		const transition = deriveAgentSessionRetentionDeadlineTransition(
			awaitingUserTurnSummary(),
			awaitingUserTurnSummary({ agentResponseGenerationTurnSequence: 2 }),
			options,
		);
		expect(transition.kind).toBe("start_retention_deadline");
	});

	it("锚点取 summary 写入时刻；写入时刻晚于观测时刻时钳到观测时刻（不产生未来锚点）", () => {
		const transition = deriveAgentSessionRetentionDeadlineTransition(
			makeSummary(),
			awaitingUserTurnSummary({ updatedAt: NOW + 999_999 }),
			options,
		);
		expect(transition.kind === "start_retention_deadline" && transition.input.retentionAnchorAt).toBe(NOW);
	});

	describe("park 独立轨道", () => {
		it("默认 24 小时兜底上限", () => {
			const parked = makeSummary({ awaitingDispatchedBackgroundWork: { sinceMs: NOW } });
			const transition = deriveAgentSessionRetentionDeadlineTransition(makeSummary(), parked, options);
			expect(transition.kind).toBe("start_retention_deadline");
			if (transition.kind !== "start_retention_deadline") {
				return;
			}
			expect(transition.input.retentionAnchorKind).toBe("session_parked_awaiting_dispatched_background_work");
			expect(transition.input.retentionAnchorAt).toBe(NOW);
			expect(transition.input.reclamationEligibleAt).toBe(NOW + 24 * ONE_HOUR_MS);
			expect(transition.input.responseGenerationStopSignalConfidence).toBeNull();
		});

		it("显式无期限（--no-expiry）→ 永不到期", () => {
			const parked = makeSummary({
				awaitingDispatchedBackgroundWork: { sinceMs: NOW, maxRetentionUntilMs: null },
			});
			const transition = deriveAgentSessionRetentionDeadlineTransition(makeSummary(), parked, options);
			expect(transition.kind === "start_retention_deadline" && transition.input.reclamationEligibleAt).toBeNull();
		});

		it("显式期限（--max-retention）按声明值", () => {
			const parked = makeSummary({
				awaitingDispatchedBackgroundWork: { sinceMs: NOW, maxRetentionUntilMs: NOW + 72 * ONE_HOUR_MS },
			});
			const transition = deriveAgentSessionRetentionDeadlineTransition(makeSummary(), parked, options);
			expect(transition.kind === "start_retention_deadline" && transition.input.reclamationEligibleAt).toBe(
				NOW + 72 * ONE_HOUR_MS,
			);
		});

		it("unpark（park → 普通 agent 回合）→ 作废 park 期限", () => {
			expect(
				deriveAgentSessionRetentionDeadlineTransition(
					makeSummary({ awaitingDispatchedBackgroundWork: { sinceMs: NOW } }),
					makeSummary(),
					options,
				).kind,
			).toBe("supersede_retention_deadlines");
		});
	});

	describe("三 transport 走同一段代码", () => {
		it.each([
			["claude", "pty_terminal"],
			["cline", "in_process_cline_sdk"],
			["omp", "acp_stdio_subprocess"],
		] as const)("%s → %s", (agentId, expectedTransport) => {
			// Cline SDK 在进程内跑、pid 恒 null，但 liveness=live 时同样是可回收的运行时资源。
			const previous = makeSummary({ agentId: agentId as RuntimeAgentId, pid: null });
			const next = awaitingUserTurnSummary({ agentId: agentId as RuntimeAgentId, pid: null });
			const transition = deriveAgentSessionRetentionDeadlineTransition(previous, next, options);
			expect(transition.kind === "start_retention_deadline" && transition.input.sessionTransport).toBe(
				expectedTransport,
			);
		});
	});
});

describe("createAgentSessionResponseGenerationStopObserver（落库编排）", () => {
	let recorded: (RecordAgentSessionRetentionDeadlineInput & { workspaceId: string })[];
	let superseded: { workspaceId: string; taskId: string; supersededAt: number }[];

	const makeObserver = () =>
		createAgentSessionResponseGenerationStopObserver({
			now: () => NOW,
			recordRetentionDeadline: async (workspaceId, input) => {
				recorded.push({ ...input, workspaceId });
				return {} as PersistedAgentSessionReclamationDeadlineRecord;
			},
			supersedeRetentionDeadlines: async (workspaceId, taskId, supersededAt) => {
				superseded.push({ workspaceId, taskId, supersededAt });
				return 1;
			},
		});

	beforeEach(() => {
		recorded = [];
		superseded = [];
	});

	it("停止 → 落一条期限；继续跑 → 作废", async () => {
		const observer = makeObserver();
		observer.observeTaskSessionSummary("ws-1", makeSummary());
		observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary());
		observer.observeTaskSessionSummary("ws-1", makeSummary({ agentResponseGenerationTurnSequence: 2 }));
		await observer.whenSettled();

		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.workspaceId).toBe("ws-1");
		expect(recorded[0]?.recordedAt).toBe(NOW);
		expect(superseded).toEqual([{ workspaceId: "ws-1", taskId: "task-a", supersededAt: NOW }]);
	});

	it("agent 回合期间的高频 summary 不触发任何账本写入（防 IO 风暴）", async () => {
		const observer = makeObserver();
		for (let index = 0; index < 200; index += 1) {
			observer.observeTaskSessionSummary("ws-1", makeSummary({ updatedAt: NOW + index, lastOutputAt: NOW + index }));
		}
		await observer.whenSettled();
		expect(recorded).toEqual([]);
		expect(superseded).toEqual([]);
	});

	it("停在等人回合期间的重复 summary 不重复落库", async () => {
		const observer = makeObserver();
		observer.observeTaskSessionSummary("ws-1", makeSummary());
		for (let index = 0; index < 50; index += 1) {
			observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary({ updatedAt: NOW + index }));
		}
		await observer.whenSettled();
		expect(recorded).toHaveLength(1);
	});

	it("不同 workspace 的同名 task 互不串扰", async () => {
		const observer = makeObserver();
		observer.observeTaskSessionSummary("ws-1", makeSummary());
		observer.observeTaskSessionSummary("ws-2", makeSummary());
		observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary());
		await observer.whenSettled();
		expect(recorded.map((entry) => entry.workspaceId)).toEqual(["ws-1"]);
	});

	it("forgetWorkspace 后重新观测同一状态会重新起算（项目被移除再加回）", async () => {
		const observer = makeObserver();
		observer.observeTaskSessionSummary("ws-1", makeSummary());
		observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary());
		observer.forgetWorkspace("ws-1");
		observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary());
		await observer.whenSettled();
		expect(recorded).toHaveLength(2);
	});

	it("落库失败不掀翻广播链路，经 onPersistError 上报", async () => {
		const onPersistError = vi.fn();
		const observer = createAgentSessionResponseGenerationStopObserver({
			now: () => NOW,
			recordRetentionDeadline: async () => {
				throw new Error("磁盘满");
			},
			supersedeRetentionDeadlines: async () => 0,
			onPersistError,
		});
		observer.observeTaskSessionSummary("ws-1", makeSummary());
		expect(() => observer.observeTaskSessionSummary("ws-1", awaitingUserTurnSummary())).not.toThrow();
		await observer.whenSettled();
		expect(onPersistError).toHaveBeenCalledTimes(1);
		expect(onPersistError.mock.calls[0]?.[1]).toEqual({ workspaceId: "ws-1", taskId: "task-a" });
	});
});

describe("回合序号在三 transport 共用的写漏斗里推进", () => {
	it("非 agent 回合 → agent 回合时 +1；停在 agent 回合不重复推进", () => {
		const idle = makeSummary({ state: "idle", turnOwner: null, liveness: "none", userTurnKind: null });
		const running = mergeSummaryWithFacets(idle, { turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(running.agentResponseGenerationTurnSequence).toBe(2);

		const stillRunning = mergeSummaryWithFacets(running, { lastOutputAt: NOW + 1 });
		expect(stillRunning.agentResponseGenerationTurnSequence).toBe(2);

		const awaiting = mergeSummaryWithFacets(running, {
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		});
		expect(awaiting.agentResponseGenerationTurnSequence).toBe(2);

		const resumed = mergeSummaryWithFacets(awaiting, { turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(resumed.agentResponseGenerationTurnSequence).toBe(3);
	});

	it("显式覆写（磁盘水合）按原值采信，不再推算", () => {
		const idle = makeSummary({ state: "idle", turnOwner: null, liveness: "none", userTurnKind: null });
		const hydrated = mergeSummaryWithFacets(idle, {
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			agentResponseGenerationTurnSequence: 41,
		});
		expect(hydrated.agentResponseGenerationTurnSequence).toBe(41);
	});
});
