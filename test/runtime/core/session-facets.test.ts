import { describe, expect, it } from "vitest";
import { createTaskEntryFromPersistedSession } from "../../../src/cline-sdk/cline-message-repository";
import {
	type RuntimeAgentId,
	type RuntimeTaskConnectionRetry,
	type RuntimeTaskSessionReviewReason,
	type RuntimeTaskSessionState,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import {
	applySessionFacets,
	deriveSessionFacetsFromLegacyState,
	deriveUserTurnKind,
	isAwaitingUserReviewTurn,
	isNotifiableUserTurn,
	isSessionInActiveTurn,
	mergeSummaryWithFacets,
	projectLegacyState,
	resolveSessionFacets,
	SESSION_SUMMARY_SCHEMA_VERSION,
	type SessionFacets,
} from "../../../src/core/session-activity";
import { reduceSessionTransition } from "../../../src/terminal/session-state-machine";

// Stage 1 dual-write 的命门：facet ↔ legacy state 投影可逆、组合受护栏约束、写点零行为漂移。
// 本套件不启动任何 SDK host（见 AGENTS.md Node22 CI 挂起告警），全部走纯函数 + 真实终端 reducer。

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

const ACTIVE_RETRY: RuntimeTaskConnectionRetry = {
	status: "retrying",
	retryCount: 1,
	firstErrorAt: 1,
	lastAttemptAt: null,
	nextAttemptAt: null,
};

const ALL_STATES: readonly RuntimeTaskSessionState[] = ["idle", "running", "awaiting_review", "failed", "interrupted"];
const ALL_REVIEW_REASONS: readonly RuntimeTaskSessionReviewReason[] = [
	null,
	"attention",
	"exit",
	"error",
	"interrupted",
	"hook",
	"completion",
];
// harness 维度（distinction ② 解阻塞）：Cline SDK（in-process、无 pid 概念）vs 终端/PTY agent（有真实
// pid）vs 未知(null) 回退。awaiting_review 的 live↔exited 派生现依赖它，故黄金表把它纳入全表覆盖。
const ALL_AGENT_IDS: readonly (RuntimeAgentId | null)[] = [null, "cline", "claude"];

function facetsOf(summary: RuntimeTaskSessionSummary): SessionFacets {
	// 仅在 facet 三者皆已 stamp 时调用（applySessionFacets 之后必然成立）。
	return {
		turnOwner: summary.turnOwner ?? null,
		liveness: summary.liveness ?? "none",
		userTurnKind: summary.userTurnKind ?? null,
	};
}

describe("deriveUserTurnKind（reviewReason → 人轴种类）", () => {
	it.each([
		["error", "error"],
		["interrupted", "interrupted"],
		["exit", "review"],
		["completion", "review"],
		["hook", "review"],
		["attention", "needs_input"],
		[null, "needs_input"],
	] as const)("%s → %s", (reason, expected) => {
		expect(deriveUserTurnKind(reason)).toBe(expected);
	});
});

describe("deriveSessionFacetsFromLegacyState（old → new）", () => {
	it("idle → 无回合", () => {
		expect(
			deriveSessionFacetsFromLegacyState("idle", {
				reviewReason: null,
				pid: null,
				connectionRetryActive: false,
				agentId: null,
			}),
		).toEqual({ turnOwner: null, liveness: "none", userTurnKind: null });
	});

	it("running 无重试 → agent/live", () => {
		expect(
			deriveSessionFacetsFromLegacyState("running", {
				reviewReason: null,
				pid: 123,
				connectionRetryActive: false,
				agentId: "claude",
			}),
		).toEqual({ turnOwner: "agent", liveness: "live", userTurnKind: null });
	});

	it("running + 连接重试 → agent/retrying（仅由 connectionRetry 投影）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("running", {
				reviewReason: null,
				pid: 123,
				connectionRetryActive: true,
				agentId: "claude",
			}),
		).toEqual({ turnOwner: "agent", liveness: "retrying", userTurnKind: null });
	});

	it("awaiting_review 终端 agent 进程仍在(pid 非 null) → user/live", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "hook",
				pid: 123,
				connectionRetryActive: false,
				agentId: "claude",
			}),
		).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "review" });
	});

	it("awaiting_review 终端 agent 进程已退(pid null) → user/exited（legacy state 表达不了，本方向无损）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "exit",
				pid: null,
				connectionRetryActive: false,
				agentId: "claude",
			}),
		).toEqual({ turnOwner: "user", liveness: "exited", userTurnKind: "review" });
	});

	it("awaiting_review Cline SDK(pid null 但 in-process) → user/live（harness-aware：不误标 exited）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "completion",
				pid: null,
				connectionRetryActive: false,
				agentId: "cline",
			}),
		).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "review" });
	});

	it("awaiting_review Cline SDK + reviewReason error(pid null) → user/error 但 liveness=live（SDK 仍存活）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "error",
				pid: null,
				connectionRetryActive: false,
				agentId: "cline",
			}),
		).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "error" });
	});

	it("awaiting_review agentId 未知(null) + pid null → user/exited（保守回退旧 pid 规则）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "exit",
				pid: null,
				connectionRetryActive: false,
				agentId: null,
			}),
		).toEqual({ turnOwner: "user", liveness: "exited", userTurnKind: "review" });
	});

	it("awaiting_review + reviewReason error（终端进程已退）→ user/error（运行错，区别于 spawn failed）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "error",
				pid: null,
				connectionRetryActive: false,
				agentId: "claude",
			}),
		).toEqual({ turnOwner: "user", liveness: "exited", userTurnKind: "error" });
	});

	it("failed(spawn 失败) → user/failed/error", () => {
		expect(
			deriveSessionFacetsFromLegacyState("failed", {
				reviewReason: "error",
				pid: null,
				connectionRetryActive: false,
				agentId: null,
			}),
		).toEqual({ turnOwner: "user", liveness: "failed", userTurnKind: "error" });
	});

	it("interrupted → user/interrupted/interrupted", () => {
		expect(
			deriveSessionFacetsFromLegacyState("interrupted", {
				reviewReason: "interrupted",
				pid: null,
				connectionRetryActive: false,
				agentId: null,
			}),
		).toEqual({ turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" });
	});
});

describe("projectLegacyState（new → old 唯一 reducer）", () => {
	it("全表逐项", () => {
		expect(projectLegacyState({ turnOwner: null, liveness: "none", userTurnKind: null })).toBe("idle");
		expect(projectLegacyState({ turnOwner: "agent", liveness: "live", userTurnKind: null })).toBe("running");
		expect(projectLegacyState({ turnOwner: "agent", liveness: "starting", userTurnKind: null })).toBe("running");
		expect(projectLegacyState({ turnOwner: "agent", liveness: "retrying", userTurnKind: null })).toBe("running");
		expect(projectLegacyState({ turnOwner: "user", liveness: "live", userTurnKind: "review" })).toBe(
			"awaiting_review",
		);
		expect(projectLegacyState({ turnOwner: "user", liveness: "exited", userTurnKind: "review" })).toBe(
			"awaiting_review",
		);
		expect(projectLegacyState({ turnOwner: "user", liveness: "failed", userTurnKind: "error" })).toBe("failed");
		expect(projectLegacyState({ turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" })).toBe(
			"interrupted",
		);
	});
});

describe("投影可逆性（零行为漂移命门）", () => {
	it("全 legacy state × 全上下文（含 agentId）：projectLegacyState(derive(state, ctx)) === state，且 facet 过护栏", () => {
		for (const state of ALL_STATES) {
			for (const pid of [null, 123] as const) {
				for (const connectionRetryActive of [false, true] as const) {
					for (const reviewReason of ALL_REVIEW_REASONS) {
						for (const agentId of ALL_AGENT_IDS) {
							const facets = deriveSessionFacetsFromLegacyState(state, {
								reviewReason,
								pid,
								connectionRetryActive,
								agentId,
							});
							// 1) 投影回得到原 legacy state（迁移期 state 仍可由 facet 无损投影）。
							// 关键：harness-aware 后 awaiting 的 live↔exited 仍同投影回 awaiting_review，可逆不变。
							expect(projectLegacyState(facets)).toBe(state);
							// 2) 派生出的 facet 组合必然通过 superRefine 护栏
							const parsed = runtimeTaskSessionSummarySchema.safeParse(
								makeSummary({
									state,
									pid,
									reviewReason,
									agentId,
									connectionRetry: connectionRetryActive ? ACTIVE_RETRY : null,
									turnOwner: facets.turnOwner,
									liveness: facets.liveness,
									userTurnKind: facets.userTurnKind,
									schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
								}),
							);
							expect(parsed.success).toBe(true);
						}
					}
				}
			}
		}
	});
});

describe("applySessionFacets（单一构造漏斗）", () => {
	it("stamp 三 facet + schemaVersion，且与 legacy state 投影可逆", () => {
		const stamped = applySessionFacets(makeSummary({ state: "running", pid: 7, lastOutputAt: 1_000 }));
		expect(stamped.turnOwner).toBe("agent");
		expect(stamped.liveness).toBe("live");
		expect(stamped.userTurnKind).toBe(null);
		expect(stamped.schemaVersion).toBe(SESSION_SUMMARY_SCHEMA_VERSION);
		expect(projectLegacyState(facetsOf(stamped))).toBe(stamped.state);
	});

	it("connectionRetry 存在时 running → retrying（不另存第二份）", () => {
		const stamped = applySessionFacets(makeSummary({ state: "running", pid: 7, connectionRetry: ACTIVE_RETRY }));
		expect(stamped.liveness).toBe("retrying");
	});

	it("终端 agent awaiting_review 且 pid=null → exited", () => {
		const stamped = applySessionFacets(
			makeSummary({ state: "awaiting_review", agentId: "claude", pid: null, reviewReason: "exit" }),
		);
		expect(stamped.liveness).toBe("exited");
		expect(stamped.userTurnKind).toBe("review");
	});

	it("Cline SDK awaiting_review 且 pid=null → live（harness-aware 经漏斗 stamp，不误标 exited）", () => {
		const stamped = applySessionFacets(
			makeSummary({ state: "awaiting_review", agentId: "cline", pid: null, reviewReason: "completion" }),
		);
		expect(stamped.liveness).toBe("live");
		expect(stamped.userTurnKind).toBe("review");
	});

	it("幂等：二次 apply 不改变 facet", () => {
		const once = applySessionFacets(makeSummary({ state: "awaiting_review", pid: 5, reviewReason: "error" }));
		const twice = applySessionFacets(once);
		expect(twice.turnOwner).toBe(once.turnOwner);
		expect(twice.liveness).toBe(once.liveness);
		expect(twice.userTurnKind).toBe(once.userTurnKind);
		expect(twice.schemaVersion).toBe(once.schemaVersion);
	});
});

describe("mergeSummaryWithFacets（Stage 4 写侧主真相源派发器）", () => {
	function runningBase(agentId: RuntimeAgentId | null = "cline"): RuntimeTaskSessionSummary {
		return applySessionFacets(
			makeSummary({ state: "running", agentId, pid: agentId === "cline" ? null : 7, lastOutputAt: 1_000 }),
		);
	}

	it("facet-only patch（无 state）→ facet 权威，state 由 projectLegacyState 投影回填", () => {
		const next = mergeSummaryWithFacets(runningBase(), {
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "question",
		});
		expect(next.turnOwner).toBe("user");
		expect(next.liveness).toBe("live");
		expect(next.userTurnKind).toBe("question");
		expect(next.state).toBe("awaiting_review");
		expect(projectLegacyState(facetsOf(next))).toBe(next.state);
	});

	it("state-only patch（无 facet）→ legacy 向，与今日 applySessionFacets 逐字一致", () => {
		const base = runningBase("claude");
		const next = mergeSummaryWithFacets(base, { state: "awaiting_review", reviewReason: "error", pid: null });
		expect(next).toEqual(applySessionFacets({ ...base, state: "awaiting_review", reviewReason: "error", pid: null }));
	});

	// 评审修正 #1（两腿同判最致命缺陷）回归：采集到的 question 不被高频 metadata-only bump 经 reviewReason
	// 重派生冲回 review。**A1 阻塞门控**。
	it("metadata-only patch preserve 已采集 userTurnKind（question 经 lastOutputAt bump 后仍是 question）", () => {
		const question = mergeSummaryWithFacets(runningBase(), {
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "question",
		});
		expect(question.userTurnKind).toBe("question");
		const afterBump = mergeSummaryWithFacets(question, { lastOutputAt: 2_000 });
		expect(afterBump.userTurnKind).toBe("question");
		expect(afterBump.turnOwner).toBe("user");
		expect(afterBump.state).toBe("awaiting_review");
	});

	// metadata-only 仍重派生 agent 轴：connectionRetry 驱动 live↔retrying，不被 preserve 冻住（A1 零漂移要件）。
	it("metadata-only connectionRetry patch 驱动 running 的 live→retrying", () => {
		const running = applySessionFacets(makeSummary({ state: "running", agentId: "claude", pid: 1 }));
		expect(running.liveness).toBe("live");
		const retrying = mergeSummaryWithFacets(running, { connectionRetry: ACTIVE_RETRY });
		expect(retrying.liveness).toBe("retrying");
		const backLive = mergeSummaryWithFacets(retrying, { connectionRetry: null });
		expect(backLive.liveness).toBe("live");
	});

	// A1 parity（迁移前零行为漂移命门）：全格上「facet-only 写 ≡ legacy state-only 写」，
	// 在非平凡 prior（running）上验证（评审要求 merge 到非空白 summary）。
	it("parity：facet-only 写与 legacy state-only 写在全 state×reviewReason×agentId 上四 facet+state 一致", () => {
		for (const state of ALL_STATES) {
			for (const reviewReason of ALL_REVIEW_REASONS) {
				for (const agentId of ALL_AGENT_IDS) {
					const pid = agentId === "cline" ? null : 7;
					const prior = runningBase(agentId);
					const facets = deriveSessionFacetsFromLegacyState(state, {
						reviewReason,
						pid,
						connectionRetryActive: false,
						agentId,
					});
					const viaFacet = mergeSummaryWithFacets(prior, {
						reviewReason,
						pid,
						turnOwner: facets.turnOwner,
						liveness: facets.liveness,
						userTurnKind: facets.userTurnKind,
					});
					const viaState = mergeSummaryWithFacets(prior, { reviewReason, pid, state });
					expect(viaFacet.state).toBe(viaState.state);
					expect(viaFacet.turnOwner).toBe(viaState.turnOwner);
					expect(viaFacet.liveness).toBe(viaState.liveness);
					expect(viaFacet.userTurnKind).toBe(viaState.userTurnKind);
				}
			}
		}
	});
});

describe("黄金转移（经真实终端 reducer reduceSessionTransition）", () => {
	// process.exit 是终端/PTY agent 专属事件（Cline SDK 无进程退出概念），故 base 显式为终端 agent：
	// 其 pid 123 退出后 → pid null → exited（harness-aware 规则在 agentId="claude" 下仍走 pid 判定）。
	const running = applySessionFacets(
		makeSummary({ state: "running", agentId: "claude", pid: 123, lastOutputAt: 1_000 }),
	);

	function applyPatch(
		base: RuntimeTaskSessionSummary,
		event: Parameters<typeof reduceSessionTransition>[1],
		updatedAt: number,
	): RuntimeTaskSessionSummary {
		// Stage 4 反转后 reducer 产 facet-only patch（无 state）；须经 mergeSummaryWithFacets 派发（与真实
		// session-manager.applySessionEvent → updateSummary 漏斗一致），而非 applySessionFacets（后者会从
		// base 的 stale state 反推、忽略 patch 携带的 facet）。
		const result = reduceSessionTransition(base, event);
		return mergeSummaryWithFacets(base, { ...result.patch, updatedAt });
	}

	it("hook.to_review：running → awaiting_review，进程仍在 → live/review", () => {
		const next = applyPatch(running, { type: "hook.to_review" }, 2_000);
		expect(next.state).toBe("awaiting_review");
		expect(next.turnOwner).toBe("user");
		expect(next.liveness).toBe("live");
		expect(next.userTurnKind).toBe("review");
		expect(projectLegacyState(facetsOf(next))).toBe(next.state);
	});

	it("process.exit code 0：awaiting_review + pid:null → exited/review", () => {
		const next = applyPatch(running, { type: "process.exit", exitCode: 0, interrupted: false }, 3_000);
		expect(next.state).toBe("awaiting_review");
		expect(next.liveness).toBe("exited");
		expect(next.userTurnKind).toBe("review");
		expect(next.pid).toBe(null);
	});

	it("process.exit code 1：运行错 → exited/error（非 liveness=failed）", () => {
		const next = applyPatch(running, { type: "process.exit", exitCode: 1, interrupted: false }, 4_000);
		expect(next.state).toBe("awaiting_review");
		expect(next.liveness).toBe("exited");
		expect(next.userTurnKind).toBe("error");
	});

	it("process.exit interrupted → interrupted/interrupted", () => {
		const next = applyPatch(running, { type: "process.exit", exitCode: null, interrupted: true }, 5_000);
		expect(next.state).toBe("interrupted");
		expect(next.turnOwner).toBe("user");
		expect(next.liveness).toBe("interrupted");
		expect(next.userTurnKind).toBe("interrupted");
	});

	it("agent.prompt-ready：awaiting_review(hook) → running，回 agent/live", () => {
		const review = applyPatch(running, { type: "hook.to_review" }, 2_000);
		const back = applyPatch(review, { type: "agent.prompt-ready" }, 6_000);
		expect(back.state).toBe("running");
		expect(back.turnOwner).toBe("agent");
		expect(back.liveness).toBe("live");
		expect(back.userTurnKind).toBe(null);
	});

	// 评审修正 #5 / 风险 #1：A2 反转后 reducer 的 process.exit 必须传 pid:null（后退出）+ agentId 进派生。
	// 锁 patch.liveness（非只锁 state）—— exited↔live 区分是本重构存在意义，误用 summary.pid 会让
	// state/test 全过却悄毁该区分。交叉 agentId∈{claude,cline,null}：
	it("process.exit × agentId=cline：harness-aware → awaiting/live（无 pid 概念，绝不误标 exited）", () => {
		const clineRunning = applySessionFacets(
			makeSummary({ state: "running", agentId: "cline", pid: null, lastOutputAt: 1_000 }),
		);
		const next = applyPatch(clineRunning, { type: "process.exit", exitCode: 0, interrupted: false }, 7_000);
		expect(next.state).toBe("awaiting_review");
		expect(next.liveness).toBe("live");
		expect(next.userTurnKind).toBe("review");
	});

	it("process.exit × agentId=null：保守回退 pid 规则 → exited（pid 退出后为 null）", () => {
		const nullRunning = applySessionFacets(
			makeSummary({ state: "running", agentId: null, pid: 7, lastOutputAt: 1_000 }),
		);
		const next = applyPatch(nullRunning, { type: "process.exit", exitCode: 0, interrupted: false }, 8_000);
		expect(next.state).toBe("awaiting_review");
		expect(next.liveness).toBe("exited");
	});
});

describe("spawn 失败写点（state:failed）", () => {
	it("→ user/failed/error，投影回 failed", () => {
		const failed = applySessionFacets(makeSummary({ state: "failed", reviewReason: "error" }));
		expect(failed.turnOwner).toBe("user");
		expect(failed.liveness).toBe("failed");
		expect(failed.userTurnKind).toBe("error");
		expect(projectLegacyState(facetsOf(failed))).toBe("failed");
	});
});

// 回归：createTaskEntryFromPersistedSession（resume/rebind 共享构造点）此前 spread
// createDefaultSummary 的 idle facet 后只覆写 state/reviewReason，未重 stamp，导致「非 idle state
// + idle facet」不一致 summary 经 emitSummary(entry.summary) 广播/落盘。现经 applySessionFacets 修复。
describe("构造点回归：createTaskEntryFromPersistedSession 重 stamp facet 与 state 自洽", () => {
	it("resume 覆写 state=awaiting_review/reviewReason=attention → user/needs_input，投影回 awaiting_review", () => {
		const entry = createTaskEntryFromPersistedSession("task-resume", [], {
			state: "awaiting_review",
			reviewReason: "attention",
		});
		expect(entry.summary.turnOwner).toBe("user");
		expect(entry.summary.liveness).not.toBe("none");
		expect(entry.summary.userTurnKind).not.toBe(null);
		expect(projectLegacyState(facetsOf(entry.summary))).toBe("awaiting_review");
	});

	it("rebind 覆写 state=failed/reviewReason=error → user/failed/error，投影回 failed", () => {
		const entry = createTaskEntryFromPersistedSession("task-rebind", [], {
			state: "failed",
			reviewReason: "error",
		});
		expect(entry.summary.turnOwner).toBe("user");
		expect(entry.summary.liveness).toBe("failed");
		expect(entry.summary.userTurnKind).toBe("error");
		expect(projectLegacyState(facetsOf(entry.summary))).toBe("failed");
	});

	it("未覆写 state（默认 idle）→ idle facet 自洽", () => {
		const entry = createTaskEntryFromPersistedSession("task-idle", []);
		expect(projectLegacyState(facetsOf(entry.summary))).toBe("idle");
	});
});

describe("superRefine 不变量护栏", () => {
	function parses(overrides: Partial<RuntimeTaskSessionSummary>): boolean {
		return runtimeTaskSessionSummarySchema.safeParse(makeSummary(overrides)).success;
	}

	it("放行未迁移旧盘数据（三 facet 全缺）", () => {
		expect(parses({ state: "running" })).toBe(true);
	});

	it("放行合法 agent 组合", () => {
		expect(parses({ state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null })).toBe(true);
	});

	it("放行合法 user 组合（exited）", () => {
		expect(parses({ state: "awaiting_review", turnOwner: "user", liveness: "exited", userTurnKind: "review" })).toBe(
			true,
		);
	});

	it("拒绝 facet 不共生（仅置 turnOwner）", () => {
		expect(parses({ state: "running", turnOwner: "agent" })).toBe(false);
	});

	it("拒绝 agent 回合 + 非 null userTurnKind", () => {
		expect(parses({ state: "running", turnOwner: "agent", liveness: "live", userTurnKind: "review" })).toBe(false);
	});

	it("拒绝 agent 回合非法 liveness（exited）", () => {
		expect(parses({ state: "running", turnOwner: "agent", liveness: "exited", userTurnKind: null })).toBe(false);
	});

	it("拒绝 user 回合 + null userTurnKind", () => {
		expect(parses({ state: "awaiting_review", turnOwner: "user", liveness: "live", userTurnKind: null })).toBe(false);
	});

	it("拒绝 null 回合 + 非 none liveness", () => {
		expect(parses({ state: "idle", turnOwner: null, liveness: "live", userTurnKind: null })).toBe(false);
	});

	it("拒绝 null 回合 + 非 null userTurnKind", () => {
		expect(parses({ state: "idle", turnOwner: null, liveness: "none", userTurnKind: "review" })).toBe(false);
	});
});

// Stage 4 schema 反转：`state` 输入可选 + 末位 transform 从 facet 投影回填，使输出型 state 仍 required。
describe("schema state.optional() + transform（Stage 4 全写侧反转）", () => {
	const baseRawFields = {
		taskId: "t",
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
	};

	it("旧形（state 有、facet 无）→ 保留 state、放行（未迁移旧盘）", () => {
		const result = runtimeTaskSessionSummarySchema.safeParse({ ...baseRawFields, state: "running" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.state).toBe("running");
		}
	});

	it("新形（facet 有、state 无）→ transform 从三 facet 投影出 state", () => {
		const result = runtimeTaskSessionSummarySchema.safeParse({
			...baseRawFields,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.state).toBe("awaiting_review");
		}
	});

	it("既无 state 又 facet 不全 → 拒绝（transform 无从投影）", () => {
		expect(runtimeTaskSessionSummarySchema.safeParse({ ...baseRawFields, turnOwner: "user" }).success).toBe(false);
		expect(runtimeTaskSessionSummarySchema.safeParse({ ...baseRawFields }).success).toBe(false);
	});

	it("既有 state 又有完整合法 facet → 保留 state（不被 transform 覆盖）", () => {
		const result = runtimeTaskSessionSummarySchema.safeParse({
			...baseRawFields,
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.state).toBe("running");
		}
	});
});

// Stage 2 读侧 facet 权威：决策型消费者经 resolveSessionFacets 读 facet（不再读 legacy state），
// isSessionInActiveTurn 是 facet 版「活跃回合」判据，须与旧 state∈{running,awaiting_review} 全表等价。
describe("resolveSessionFacets（在则采信、缺则即时派生）", () => {
	it("已带三 facet → 原样采信（即使与 legacy state 在线派生结果不同，也信 present 值）", () => {
		// awaiting_review + pid 非 null：在线派生本会得 live；present 显式 exited 必须被采信、不被覆盖。
		const summary = makeSummary({
			state: "awaiting_review",
			pid: 123,
			reviewReason: "exit",
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
		});
		expect(resolveSessionFacets(summary)).toEqual({
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
		});
	});

	it("facet 全缺（旧盘残留）→ 即时派生，与 deriveSessionFacetsFromLegacyState 恒一致", () => {
		const summary = makeSummary({ state: "running", pid: 123, connectionRetry: ACTIVE_RETRY });
		expect(resolveSessionFacets(summary)).toEqual(
			deriveSessionFacetsFromLegacyState("running", {
				reviewReason: null,
				pid: 123,
				connectionRetryActive: true,
				agentId: null,
			}),
		);
		expect(resolveSessionFacets(summary)).toEqual({ turnOwner: "agent", liveness: "retrying", userTurnKind: null });
	});

	it("facet 全缺的 Cline awaiting(pid null) → 即时派生 harness-aware live（读路径也透传 summary.agentId）", () => {
		const summary = makeSummary({
			state: "awaiting_review",
			agentId: "cline",
			pid: null,
			reviewReason: "completion",
		});
		expect(resolveSessionFacets(summary)).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "review" });
	});
});

describe("isSessionInActiveTurn（facet 版活跃判据，零行为漂移）", () => {
	it("全 state×pid×retry×reviewReason×agentId：与旧 state∈{running,awaiting_review} 逐项等价", () => {
		for (const state of ALL_STATES) {
			for (const pid of [null, 123] as const) {
				for (const connectionRetryActive of [false, true] as const) {
					for (const reviewReason of ALL_REVIEW_REASONS) {
						for (const agentId of ALL_AGENT_IDS) {
							const facets = deriveSessionFacetsFromLegacyState(state, {
								reviewReason,
								pid,
								connectionRetryActive,
								agentId,
							});
							const legacyActive = state === "running" || state === "awaiting_review";
							// harness-aware 后 awaiting 的 live↔exited 仍同判活跃，故活跃判据对 agentId 不变。
							expect(isSessionInActiveTurn(facets)).toBe(legacyActive);
						}
					}
				}
			}
		}
	});

	it("exited（终端进程已退仍等人审）仍判活跃——legacy 投影压扁、facet 保真的区分点", () => {
		const exited = deriveSessionFacetsFromLegacyState("awaiting_review", {
			reviewReason: "exit",
			pid: null,
			connectionRetryActive: false,
			agentId: "claude",
		});
		expect(exited.liveness).toBe("exited");
		expect(isSessionInActiveTurn(exited)).toBe(true);
	});

	it("idle / failed / interrupted → 非活跃", () => {
		expect(isSessionInActiveTurn({ turnOwner: null, liveness: "none", userTurnKind: null })).toBe(false);
		expect(isSessionInActiveTurn({ turnOwner: "user", liveness: "failed", userTurnKind: "error" })).toBe(false);
		expect(isSessionInActiveTurn({ turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" })).toBe(
			false,
		);
	});
});

describe("isAwaitingUserReviewTurn（facet 版等人审判据，零行为漂移）", () => {
	it("全 state×pid×retry×reviewReason×agentId：与旧 state==='awaiting_review' 逐项等价", () => {
		for (const state of ALL_STATES) {
			for (const pid of [null, 123] as const) {
				for (const connectionRetryActive of [false, true] as const) {
					for (const reviewReason of ALL_REVIEW_REASONS) {
						for (const agentId of ALL_AGENT_IDS) {
							const facets = deriveSessionFacetsFromLegacyState(state, {
								reviewReason,
								pid,
								connectionRetryActive,
								agentId,
							});
							expect(isAwaitingUserReviewTurn(facets)).toBe(state === "awaiting_review");
							// 等价于 projectLegacyState 反投影（单一 reducer 自洽）。
							expect(isAwaitingUserReviewTurn(facets)).toBe(projectLegacyState(facets) === "awaiting_review");
						}
					}
				}
			}
		}
	});

	it("user+live 与 user+exited 同判 true（live↔exited 折叠，无 distinction ② 偷渡）", () => {
		expect(isAwaitingUserReviewTurn({ turnOwner: "user", liveness: "live", userTurnKind: "review" })).toBe(true);
		expect(isAwaitingUserReviewTurn({ turnOwner: "user", liveness: "exited", userTurnKind: "review" })).toBe(true);
	});

	it("agent 回合 / idle / failed / interrupted → 非等人审", () => {
		expect(isAwaitingUserReviewTurn({ turnOwner: "agent", liveness: "live", userTurnKind: null })).toBe(false);
		expect(isAwaitingUserReviewTurn({ turnOwner: null, liveness: "none", userTurnKind: null })).toBe(false);
		expect(isAwaitingUserReviewTurn({ turnOwner: "user", liveness: "failed", userTurnKind: "error" })).toBe(false);
		expect(
			isAwaitingUserReviewTurn({ turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" }),
		).toBe(false);
	});
});

// 通知触发轴从 reviewReason 白名单切到 userTurnKind「广·阻塞即提醒」（决策 B，runtime-state-hub 用）。
// 旧 Cline 路径白名单：reviewReason∈{hook,attention,error} 才 broadcastTaskReadyForReview。
const LEGACY_NOTIFY_REVIEW_REASONS: ReadonlySet<RuntimeTaskSessionReviewReason> = new Set([
	"hook",
	"attention",
	"error",
]);
describe("isNotifiableUserTurn（通知触发判据，决策 B 广·阻塞即提醒）", () => {
	it("全 state×pid×retry×reviewReason×agentId：等价『等人审回合 ∧ userTurnKind≠interrupted』且自洽于 legacy 投影", () => {
		for (const state of ALL_STATES) {
			for (const pid of [null, 123] as const) {
				for (const connectionRetryActive of [false, true] as const) {
					for (const reviewReason of ALL_REVIEW_REASONS) {
						for (const agentId of ALL_AGENT_IDS) {
							const facets = deriveSessionFacetsFromLegacyState(state, {
								reviewReason,
								pid,
								connectionRetryActive,
								agentId,
							});
							const expected = isAwaitingUserReviewTurn(facets) && facets.userTurnKind !== "interrupted";
							expect(isNotifiableUserTurn(facets)).toBe(expected);
							// 自洽于唯一 reducer：仅 awaiting_review 投影且人轴非 interrupted（对 agentId 不变）。
							expect(isNotifiableUserTurn(facets)).toBe(
								projectLegacyState(facets) === "awaiting_review" && facets.userTurnKind !== "interrupted",
							);
						}
					}
				}
			}
		}
	});

	it("相对旧 reviewReason 白名单是严格超集（零通知回归）+ 标出新增触发", () => {
		const newlyNotifying: RuntimeTaskSessionReviewReason[] = [];
		for (const pid of [null, 123] as const) {
			for (const reviewReason of ALL_REVIEW_REASONS) {
				// 终端 agent：pid null→exited、pid 123→live；通知判据对 live↔exited 不变，故超集逻辑只随 pid/reason 走。
				const facets = deriveSessionFacetsFromLegacyState("awaiting_review", {
					reviewReason,
					pid,
					connectionRetryActive: false,
					agentId: "claude",
				});
				const wasNotifying = LEGACY_NOTIFY_REVIEW_REASONS.has(reviewReason);
				// 超集：旧会通知的，现仍通知（保活，绝不回归）。
				if (wasNotifying) {
					expect(isNotifiableUserTurn(facets)).toBe(true);
				}
				if (!wasNotifying && isNotifiableUserTurn(facets) && pid === null) {
					newlyNotifying.push(reviewReason);
				}
			}
		}
		// 新增触发（属决策 B 的有意修正、非回归）：exit/completion(→review) 与 null(→needs_input) 的等人回合。
		expect(new Set(newlyNotifying)).toEqual(new Set<RuntimeTaskSessionReviewReason>([null, "exit", "completion"]));
	});

	it("awaiting_review 的 live↔exited 同判 true（pid 有无不改通知，不偷渡 distinction ②）", () => {
		const live = deriveSessionFacetsFromLegacyState("awaiting_review", {
			reviewReason: "hook",
			pid: 123,
			connectionRetryActive: false,
			agentId: "claude",
		});
		const exited = deriveSessionFacetsFromLegacyState("awaiting_review", {
			reviewReason: "hook",
			pid: null,
			connectionRetryActive: false,
			agentId: "claude",
		});
		expect(live.liveness).toBe("live");
		expect(exited.liveness).toBe("exited");
		expect(isNotifiableUserTurn(live)).toBe(true);
		expect(isNotifiableUserTurn(exited)).toBe(true);
	});

	it("review/error/needs_input → 通知；interrupted（被中断/终止）→ 不通知", () => {
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "live", userTurnKind: "review" })).toBe(true);
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "exited", userTurnKind: "error" })).toBe(true);
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "live", userTurnKind: "needs_input" })).toBe(true);
		// 病态组合（awaiting_review 但人轴 interrupted）显式排除。
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "live", userTurnKind: "interrupted" })).toBe(false);
		// 真·interrupted 态（liveness=interrupted）本就非等人审 → 不通知。
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" })).toBe(
			false,
		);
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "failed", userTurnKind: "error" })).toBe(false);
		expect(isNotifiableUserTurn({ turnOwner: "agent", liveness: "live", userTurnKind: null })).toBe(false);
		expect(isNotifiableUserTurn({ turnOwner: null, liveness: "none", userTurnKind: null })).toBe(false);
	});

	it("前向兼容：未来采集增强产出的 question/plan_review/permission 均触发通知（broad 含全部阻塞类）", () => {
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "live", userTurnKind: "question" })).toBe(true);
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "live", userTurnKind: "plan_review" })).toBe(true);
		expect(isNotifiableUserTurn({ turnOwner: "user", liveness: "exited", userTurnKind: "permission" })).toBe(true);
	});
});
