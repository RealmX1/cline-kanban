import { describe, expect, it } from "vitest";
import { createTaskEntryFromPersistedSession } from "../../../src/cline-sdk/cline-message-repository";
import {
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
	projectLegacyState,
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
			deriveSessionFacetsFromLegacyState("idle", { reviewReason: null, pid: null, connectionRetryActive: false }),
		).toEqual({ turnOwner: null, liveness: "none", userTurnKind: null });
	});

	it("running 无重试 → agent/live", () => {
		expect(
			deriveSessionFacetsFromLegacyState("running", { reviewReason: null, pid: 123, connectionRetryActive: false }),
		).toEqual({ turnOwner: "agent", liveness: "live", userTurnKind: null });
	});

	it("running + 连接重试 → agent/retrying（仅由 connectionRetry 投影）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("running", { reviewReason: null, pid: 123, connectionRetryActive: true }),
		).toEqual({ turnOwner: "agent", liveness: "retrying", userTurnKind: null });
	});

	it("awaiting_review 进程仍在(pid 非 null) → user/live", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "hook",
				pid: 123,
				connectionRetryActive: false,
			}),
		).toEqual({ turnOwner: "user", liveness: "live", userTurnKind: "review" });
	});

	it("awaiting_review 进程已退(pid null) → user/exited（legacy state 表达不了，本方向无损）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "exit",
				pid: null,
				connectionRetryActive: false,
			}),
		).toEqual({ turnOwner: "user", liveness: "exited", userTurnKind: "review" });
	});

	it("awaiting_review + reviewReason error → user/error（运行错，区别于 spawn failed）", () => {
		expect(
			deriveSessionFacetsFromLegacyState("awaiting_review", {
				reviewReason: "error",
				pid: null,
				connectionRetryActive: false,
			}),
		).toEqual({ turnOwner: "user", liveness: "exited", userTurnKind: "error" });
	});

	it("failed(spawn 失败) → user/failed/error", () => {
		expect(
			deriveSessionFacetsFromLegacyState("failed", {
				reviewReason: "error",
				pid: null,
				connectionRetryActive: false,
			}),
		).toEqual({ turnOwner: "user", liveness: "failed", userTurnKind: "error" });
	});

	it("interrupted → user/interrupted/interrupted", () => {
		expect(
			deriveSessionFacetsFromLegacyState("interrupted", {
				reviewReason: "interrupted",
				pid: null,
				connectionRetryActive: false,
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
	it("全 legacy state × 全上下文：projectLegacyState(derive(state, ctx)) === state，且 facet 过护栏", () => {
		for (const state of ALL_STATES) {
			for (const pid of [null, 123] as const) {
				for (const connectionRetryActive of [false, true] as const) {
					for (const reviewReason of ALL_REVIEW_REASONS) {
						const facets = deriveSessionFacetsFromLegacyState(state, {
							reviewReason,
							pid,
							connectionRetryActive,
						});
						// 1) 投影回得到原 legacy state（迁移期 state 仍可由 facet 无损投影）
						expect(projectLegacyState(facets)).toBe(state);
						// 2) 派生出的 facet 组合必然通过 superRefine 护栏
						const parsed = runtimeTaskSessionSummarySchema.safeParse(
							makeSummary({
								state,
								pid,
								reviewReason,
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

	it("awaiting_review 且 pid=null → exited", () => {
		const stamped = applySessionFacets(makeSummary({ state: "awaiting_review", pid: null, reviewReason: "exit" }));
		expect(stamped.liveness).toBe("exited");
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

describe("黄金转移（经真实终端 reducer reduceSessionTransition）", () => {
	const running = applySessionFacets(makeSummary({ state: "running", pid: 123, lastOutputAt: 1_000 }));

	function applyPatch(
		base: RuntimeTaskSessionSummary,
		event: Parameters<typeof reduceSessionTransition>[1],
		updatedAt: number,
	): RuntimeTaskSessionSummary {
		const result = reduceSessionTransition(base, event);
		return applySessionFacets({ ...base, ...result.patch, updatedAt });
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
