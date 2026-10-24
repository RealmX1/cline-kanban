// 排队 prompt 出队门控的真值表。这套断言里最该钉死的两条：
//   ① `review` 必须**放行**——它恰是本特性的目标态，把它算成「等用户」正是 2026-08-08 那 49 分钟的第二条根因；
//   ② 恢复守卫的**两个**枚举值都必须阻塞——只比较第一个值时，`--continue` 恢复重放自己那次 Stop hook
//      会落在第二个值上，于是「用户只是点开一张卡片」就足以把几小时前排的队全部引爆。
import { describe, expect, it } from "vitest";

import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../../../src/core/api-contract";
import {
	buildAgentResponseGenerationStopEdgeDedupeKey,
	buildAgentResponseGenerationStopEventIdentity,
	isQueuedTaskPromptDeliveryAwaitingDispatch,
	isQueuedTaskPromptDeliveryClaimStillCurrentForSession,
	QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
	resolveQueuedPromptDispatchBlockReason,
} from "../../../src/core/queued-task-prompt-delivery-dispatch-eligibility";

const NOW = 1_700_000_000_000;

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: null,
		pid: 4242,
		startedAt: NOW - 10_000,
		updatedAt: NOW,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		// facet 显式给全：resolveSessionFacets 在三者齐备时直接采信，于是这套表格不依赖 legacy 派生。
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 7,
		...overrides,
	};
}

function makeEntry(overrides: Partial<QueuedTaskPromptDeliveryEntry> = {}): QueuedTaskPromptDeliveryEntry {
	return {
		queueEntryId: "q1",
		taskId: "task-1",
		text: "跑一下测试",
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: NOW - 1_000,
		expiresAt: NOW + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		...overrides,
	};
}

function resolve(
	summaryOverrides: Partial<RuntimeTaskSessionSummary> | null = {},
	entryOverrides: Partial<QueuedTaskPromptDeliveryEntry> = {},
	hasPendingProgrammaticTaskChatInputDelivery = false,
) {
	return resolveQueuedPromptDispatchBlockReason({
		headEntry: makeEntry(entryOverrides),
		sessionSummary: summaryOverrides === null ? null : makeSummary(summaryOverrides),
		hasPendingProgrammaticTaskChatInputDelivery,
		nowEpochMs: NOW,
	});
}

describe("门控 — 放行", () => {
	// 本特性存在的全部意义就在这一条上。
	it("agent 自然完工停在 review 回合时**放行**（review 绝不算「等用户」）", () => {
		expect(resolve({ userTurnKind: "review" })).toBeNull();
	});

	it("会话 live、无任何模态待答、无在途投递、非重启跨越 → 放行", () => {
		expect(resolve()).toBeNull();
	});
});

describe("门控 — agent 还在干活", () => {
	it("turnOwner 为 agent → agent_still_generating", () => {
		expect(resolve({ turnOwner: "agent", userTurnKind: null, state: "running" })).toBe("agent_still_generating");
	});
});

describe("门控 — park 必须单列", () => {
	// isAgentSessionCurrentlyGeneratingResponse 对 parked 恒返回 false（park 走独立轨道），
	// 而 submitTaskChatInputWhenReady 一进门就 unpark。不在这里拦，队列就会把 RVF 派发的后台等待
	// 直接 unpark 掉、推着主 agent 在子任务还没回来时往下跑。
	it("parked（sidecar 存在）→ session_parked_awaiting_dispatched_background_work", () => {
		expect(
			resolve({
				turnOwner: "agent",
				userTurnKind: null,
				state: "running",
				awaitingDispatchedBackgroundWork: { sinceMs: NOW - 5_000 },
			}),
		).toBe("session_parked_awaiting_dispatched_background_work");
	});

	it("park 判据优先于 agent_still_generating（两者同时成立时报 park）", () => {
		const reason = resolve({
			turnOwner: "agent",
			userTurnKind: null,
			state: "running",
			awaitingDispatchedBackgroundWork: { sinceMs: NOW - 5_000 },
		});
		expect(reason).not.toBe("agent_still_generating");
	});
});

describe("门控 — 模态待答四种全阻塞", () => {
	const modalUserTurnKinds: RuntimeTaskSessionUserTurnKind[] = [
		"question",
		"plan_review",
		"permission",
		"needs_input",
	];
	for (const userTurnKind of modalUserTurnKinds) {
		it(`userTurnKind=${userTurnKind} → agent_awaiting_modal_user_decision`, () => {
			expect(resolve({ userTurnKind })).toBe("agent_awaiting_modal_user_decision");
		});
	}

	// error / interrupted 不是「等用户拍板」，它们是会话已经出事了——由 liveness 那条门控处理，
	// 不该被算进模态集合（算进去只会让阻塞原因显示成一句与现场不符的话）。
	it("error / interrupted 不落入模态集合", () => {
		expect(resolve({ userTurnKind: "error", liveness: "failed" })).not.toBe("agent_awaiting_modal_user_decision");
		expect(resolve({ userTurnKind: "interrupted", liveness: "interrupted" })).not.toBe(
			"agent_awaiting_modal_user_decision",
		);
	});
});

describe("门控 — 会话不在跑", () => {
	it("运行时压根没有这个会话 → session_not_live（保持 queued，不判失败）", () => {
		expect(resolve(null)).toBe("session_not_live");
	});

	for (const liveness of ["none", "exited", "failed", "interrupted"] as const) {
		it(`liveness=${liveness} → session_not_live`, () => {
			expect(resolve({ liveness, userTurnKind: liveness === "none" ? null : "review", turnOwner: "user" })).toBe(
				"session_not_live",
			);
		});
	}
});

describe("门控 — 恢复守卫（两个枚举值都必须阻塞）", () => {
	it("restoring_agent_conversation_without_starting_new_turn → session_restoring_conversation", () => {
		expect(
			resolve({ restorationContinuationGuardState: "restoring_agent_conversation_without_starting_new_turn" }),
		).toBe("session_restoring_conversation");
	});

	// 这一条是「点开卡片就引爆整个队列」那个缺陷的回归钉子：`--continue` 恢复重放跑完之后、
	// harness 打出 Stop hook 的那一刻，守卫恰好停在这第二个值上。
	it("restored_agent_conversation_waiting_for_explicit_user_input 同样阻塞", () => {
		expect(
			resolve({ restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input" }),
		).toBe("session_restoring_conversation");
	});

	it("inactive 不阻塞", () => {
		expect(resolve({ restorationContinuationGuardState: "inactive" })).toBeNull();
	});

	// 守卫的 30 分钟兜底过期是为「别永久吞掉 harness 唤醒通知」设的；对排队投递而言放行 = 用户从没继续过对话，
	// 旧 prompt 就在恢复半小时后自动发出（面板文案却说「你继续之后才发」）。排队门控读声明态、不看兜底过期。
	it("守卫已武装超过 30 分钟兜底期限也照样阻塞", () => {
		expect(
			resolve({
				restorationContinuationGuardState: "restored_agent_conversation_waiting_for_explicit_user_input",
				startedAt: NOW - 6 * 60 * 60 * 1000,
			}),
		).toBe("session_restoring_conversation");
	});
});

describe("门控 — PTY 单飞槽在途", () => {
	it("有在途程序化投递 → another_programmatic_delivery_in_flight", () => {
		expect(resolve({}, {}, true)).toBe("another_programmatic_delivery_in_flight");
	});
});

describe("门控 — 重启跨越后待人确认", () => {
	it("盖了 restart-crossing 章但还没确认 → awaiting_human_reconfirmation_after_runtime_restart", () => {
		expect(resolve({}, { survivedRuntimeRestartAtEpochMs: NOW - 60_000 })).toBe(
			"awaiting_human_reconfirmation_after_runtime_restart",
		);
	});

	// 用户要的是「确认，然后在**下一次** stop hook 注入」。确认那一刻 agent 往往已经闲着、停止事件是重启前留下的；
	// 这里放行 = 5 秒高亮还没播完，旧 prompt 已经发出去了。
	it("确认之后、agent 还没再停下过一次 → 继续等下一次停止", () => {
		const reconfirmedAt = NOW - 1_000;
		const confirmedEntry = {
			survivedRuntimeRestartAtEpochMs: NOW - 60_000,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: reconfirmedAt,
		};
		expect(resolve({}, confirmedEntry)).toBe("awaiting_first_agent_turn_end_after_restart_reconfirmation");
		expect(
			resolve(
				{
					lastAgentConversationUserHandoffObservation: {
						observedAtMs: reconfirmedAt - 30_000,
						signalConfidence: "harness_turn_complete",
						turnSequence: 7,
					},
				},
				confirmedEntry,
			),
		).toBe("awaiting_first_agent_turn_end_after_restart_reconfirmation");
	});

	it("确认之后 agent 又停下过一次 → 放行", () => {
		const reconfirmedAt = NOW - 1_000;
		expect(
			resolve(
				{
					lastAgentConversationUserHandoffObservation: {
						observedAtMs: reconfirmedAt + 500,
						signalConfidence: "harness_turn_complete",
						turnSequence: 8,
					},
				},
				{
					survivedRuntimeRestartAtEpochMs: NOW - 60_000,
					humanReconfirmedAfterRuntimeRestartAtEpochMs: reconfirmedAt,
				},
			),
		).toBeNull();
	});

	it("确认之后 agent 在干活时，报更具体的 agent_still_generating", () => {
		expect(
			resolve(
				{ state: "running", turnOwner: "agent", userTurnKind: null, reviewReason: null },
				{ survivedRuntimeRestartAtEpochMs: NOW - 60_000, humanReconfirmedAfterRuntimeRestartAtEpochMs: NOW },
			),
		).toBe("agent_still_generating");
	});

	// 排最前不是随意的：重启后此刻 agent 必然不在生成（会话刚被水合成 idle），其余门控都不会命中；
	// 而它是唯一一条不会自行解除的阻塞，被别的原因盖住就等于永远显示不出来、用户无从下手。
	it("与其他阻塞同时成立时排最前（会话不在跑也照样报待确认）", () => {
		expect(resolve(null, { survivedRuntimeRestartAtEpochMs: NOW - 60_000 })).toBe(
			"awaiting_human_reconfirmation_after_runtime_restart",
		);
	});
});

describe("门控 — 托管者", () => {
	function resolveAsInstance(
		thisRuntimeProcessInstanceId: string | null,
		custodianRuntimeProcessInstanceId: string | null | undefined,
	) {
		return resolveQueuedPromptDispatchBlockReason({
			headEntry: makeEntry({ custodianRuntimeProcessInstanceId }),
			sessionSummary: makeSummary(),
			hasPendingProgrammaticTaskChatInputDelivery: false,
			nowEpochMs: NOW,
			thisRuntimeProcessInstanceId,
		});
	}

	// 同机多实例共享 workspaces 根：两个实例各自在自己的会话边沿上认领同一条队列，就会发两遍。
	it("由另一个（此刻活着的）实例托管 → 本实例不发", () => {
		expect(resolveAsInstance("instance-me", "instance-other")).toBe(
			"queued_under_another_live_kanban_runtime_instance",
		);
	});

	it("由本实例托管 → 放行", () => {
		expect(resolveAsInstance("instance-me", "instance-me")).toBeNull();
	});

	it("旧条目没有托管者 / 调用方不给进程身份 → 不启用这道门", () => {
		expect(resolveAsInstance("instance-me", null)).toBeNull();
		expect(resolveAsInstance("instance-me", undefined)).toBeNull();
		expect(resolveAsInstance(null, "instance-other")).toBeNull();
	});
});

describe("isQueuedTaskPromptDeliveryAwaitingDispatch", () => {
	it("queued 且未过期 → true", () => {
		expect(isQueuedTaskPromptDeliveryAwaitingDispatch(makeEntry(), NOW)).toBe(true);
	});

	// 过期由读侧就地算而不是等定时器改状态：那样就不存在「定时器还没跑到、于是一条早该过期的条目
	// 被发了出去」这种窗口。
	it("已过期 → false（即便状态字段仍是 queued）", () => {
		expect(isQueuedTaskPromptDeliveryAwaitingDispatch(makeEntry({ expiresAt: NOW - 1 }), NOW)).toBe(false);
	});

	for (const deliveryState of [
		"claimed_for_dispatch",
		"handed_to_transport",
		"settled_delivered",
		"cancelled",
	] as const) {
		it(`deliveryState=${deliveryState} → false`, () => {
			expect(isQueuedTaskPromptDeliveryAwaitingDispatch(makeEntry({ deliveryState }), NOW)).toBe(false);
		});
	}
});

describe("边沿去重键", () => {
	it("由 incarnation + turnSequence 构成", () => {
		expect(buildAgentResponseGenerationStopEdgeDedupeKey(makeSummary())).toBe("incarnation-1:7");
	});

	it("turnSequence 缺失时按 0 计", () => {
		expect(
			buildAgentResponseGenerationStopEdgeDedupeKey(makeSummary({ agentResponseGenerationTurnSequence: undefined })),
		).toBe("incarnation-1:0");
	});

	// 编一个键出来会让「不同活体」被去重成同一条边沿。宁可跳过这一帧。
	it("没有 incarnation 时返回 null 而不是编一个键", () => {
		expect(
			buildAgentResponseGenerationStopEdgeDedupeKey(makeSummary({ runtimeSessionIncarnationId: null })),
		).toBeNull();
		expect(buildAgentResponseGenerationStopEdgeDedupeKey(null)).toBeNull();
	});
});

describe("停止事件身份（出队边沿）", () => {
	it("同一真实交棒在恢复新进程后身份不变，待命新锚点不能制造出队边沿", () => {
		const handoff = { observedAtMs: NOW - 500, signalConfidence: "harness_turn_complete" as const, turnSequence: 7 };
		const first = makeSummary({ lastAgentConversationUserHandoffObservation: handoff });
		const restored = makeSummary({
			lastAgentConversationUserHandoffObservation: handoff,
			runtimeSessionIncarnationId: "new-incarnation",
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt: NOW,
				signalConfidence: "session_ready_never_prompted",
				turnSequence: 7,
			},
		});
		expect(buildAgentResponseGenerationStopEventIdentity(first)).toBe(`7:${NOW - 500}`);
		expect(buildAgentResponseGenerationStopEventIdentity(restored)).toBe(
			buildAgentResponseGenerationStopEventIdentity(first),
		);
	});

	it("确认后恢复出的进程待命和旧停止值不算新的真实交棒", () => {
		expect(
			resolve(
				{
					agentResponseGenerationStopped: {
						stoppedAt: NOW,
						signalConfidence: "harness_turn_complete",
						turnSequence: 7,
					},
					currentAgentProcessUserTurnIdleRetentionStarted: {
						stoppedAt: NOW,
						signalConfidence: "structured_user_turn",
						turnSequence: 7,
					},
				},
				{
					survivedRuntimeRestartAtEpochMs: NOW - 60_000,
					humanReconfirmedAfterRuntimeRestartAtEpochMs: NOW - 1_000,
				},
			),
		).toBe("awaiting_first_agent_turn_end_after_restart_reconfirmation");
	});
	const stopped = { observedAtMs: NOW - 500, signalConfidence: "harness_turn_complete" as const, turnSequence: 7 };
	it("历史交棒仍在摘要中时，Agent 回合、park 和无回合状态均不触发出队", () => {
		for (const override of [
			{ turnOwner: "agent", liveness: "live", userTurnKind: null },
			{ awaitingDispatchedBackgroundWork: { sinceMs: NOW } },
			{ turnOwner: null, liveness: "none", userTurnKind: null },
		] as const)
			expect(
				buildAgentResponseGenerationStopEventIdentity(
					makeSummary({ lastAgentConversationUserHandoffObservation: stopped, ...override }),
				),
			).toBeNull();
	});

	it("没有停止事件（agent 回合中 / park / idle）时返回 null——此刻不构成出队时机", () => {
		expect(
			buildAgentResponseGenerationStopEventIdentity(
				makeSummary({ lastAgentConversationUserHandoffObservation: null }),
			),
		).toBeNull();
		expect(buildAgentResponseGenerationStopEventIdentity(makeSummary())).toBeNull();
		expect(buildAgentResponseGenerationStopEventIdentity(null)).toBeNull();
	});

	// 本条是为什么不能拿「轮次键」当边沿：序号在回合**开始**时递增，停止那一刻序号不变。
	// 只有停止事件对象本身的变化才是停止边沿。
	it("同一轮次键下，停止事件换了（新的 observedAtMs）就是新边沿", () => {
		const first = makeSummary({ lastAgentConversationUserHandoffObservation: stopped });
		const second = makeSummary({ lastAgentConversationUserHandoffObservation: { ...stopped, observedAtMs: NOW } });
		expect(buildAgentResponseGenerationStopEdgeDedupeKey(first)).toBe(
			buildAgentResponseGenerationStopEdgeDedupeKey(second),
		);
		expect(buildAgentResponseGenerationStopEventIdentity(first)).not.toBe(
			buildAgentResponseGenerationStopEventIdentity(second),
		);
	});

	it("换活体不制造新的历史交棒边沿", () => {
		const first = makeSummary({ lastAgentConversationUserHandoffObservation: stopped });
		const second = makeSummary({
			lastAgentConversationUserHandoffObservation: stopped,
			runtimeSessionIncarnationId: "incarnation-2",
		});
		expect(buildAgentResponseGenerationStopEventIdentity(first)).toBe(
			buildAgentResponseGenerationStopEventIdentity(second),
		);
	});

	// agent 回合期间 summary 以 50ms 攒批刷新，同一次停止之后的每一条 metadata 写都不该再触发一次。
	it("同一次停止之后的后续写（事件被冻结）身份不变", () => {
		expect(
			buildAgentResponseGenerationStopEventIdentity(
				makeSummary({ lastAgentConversationUserHandoffObservation: stopped }),
			),
		).toBe(
			buildAgentResponseGenerationStopEventIdentity(
				makeSummary({
					lastAgentConversationUserHandoffObservation: stopped,
					updatedAt: NOW + 5_000,
					lastOutputAt: NOW + 4_000,
				}),
			),
		);
	});
});

describe("认领陈旧复核（双判据）", () => {
	const claimed = makeEntry({
		deliveryState: "claimed_for_dispatch",
		claimedForSessionIncarnationId: "incarnation-1",
		claimedAtTurnSequence: 7,
	});

	it("两个判据都对 → 仍然当前", () => {
		expect(isQueuedTaskPromptDeliveryClaimStillCurrentForSession(claimed, makeSummary())).toBe(true);
	});

	it("换了活体 → 陈旧", () => {
		expect(
			isQueuedTaskPromptDeliveryClaimStillCurrentForSession(
				claimed,
				makeSummary({ runtimeSessionIncarnationId: "incarnation-2" }),
			),
		).toBe(false);
	});

	// 同一活体内用户又发了一句、agent 已经跑过下一轮：这次认领说的那一轮已经过去了。
	it("同活体但回合序号前进了 → 陈旧", () => {
		expect(
			isQueuedTaskPromptDeliveryClaimStillCurrentForSession(
				claimed,
				makeSummary({ agentResponseGenerationTurnSequence: 8 }),
			),
		).toBe(false);
	});

	it("会话没了 / 条目根本没被认领过 → 陈旧", () => {
		expect(isQueuedTaskPromptDeliveryClaimStillCurrentForSession(claimed, null)).toBe(false);
		expect(isQueuedTaskPromptDeliveryClaimStillCurrentForSession(makeEntry(), makeSummary())).toBe(false);
	});
});
