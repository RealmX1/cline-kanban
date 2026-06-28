import { describe, expect, it } from "vitest";
import type {
	RuntimeHookEvent,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import type { SessionFacets } from "../../../src/core/session-activity";
import { canTransitionTaskForHookEvent } from "../../../src/trpc/hook-event-task-transition-gate";

// Stage 3 余区：hooks-api 的 hook 事件转换闸从 legacy `state` 读 → 双轴 facet 真相源。
// 本套件锁定「迁移前可见行为基线」：
//   - to_review 旧 `state==="running"` ⟺ `turnOwner==="agent"`；
//   - to_in_progress 旧 `state==="awaiting_review"` ⟺ `isAwaitingUserReviewTurn(facets)`，
//     且下游 reviewReason∈{attention,hook,error} 门控原样保留；
//   - activity 永不转换。
// 含 live↔exited 折叠的反向证明（exited 待审仍可转 in_progress，不被偷渡区分）+ 显式 facet 采信。
// 纯函数测试，不启动 SDK host（见 AGENTS.md Node22 CI 挂起告警）。

const ALL_EVENTS: readonly RuntimeHookEvent[] = ["to_review", "to_in_progress", "activity"];
const ALL_STATES: readonly RuntimeTaskSessionState[] = ["idle", "running", "awaiting_review", "failed", "interrupted"];
// 故意不含 "manual_review"：它是 legacy `state` 时代之后才引入的 reviewReason（cd472d0），无对应
// 的 legacy state 行为可等价，且解锁后其 to_in_progress 放行是**有意的 post-legacy 漂移**
// （production=true vs legacyCanTransition=false）。把它加进本表会让下方「全表逐项等价旧 legacy 判据」
// 的扫描在 manual_review 行误判失败。manual_review 的放行由下方专门用例单独锁定。
const ALL_REVIEW_REASONS: readonly RuntimeTaskSessionReviewReason[] = [
	null,
	"attention",
	"exit",
	"error",
	"interrupted",
	"hook",
	"completion",
];

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

// 迁移前的 legacy 判据（逐字保留作黄金基线对照源）。
function legacyCanTransition(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

describe("canTransitionTaskForHookEvent (legacy state → facet 行为保持)", () => {
	it("activity 事件永不转换", () => {
		for (const state of ALL_STATES) {
			for (const reviewReason of ALL_REVIEW_REASONS) {
				expect(canTransitionTaskForHookEvent(makeSummary({ state, reviewReason }), "activity")).toBe(false);
			}
		}
	});

	it("to_review 仅在 running（=turnOwner agent）时放行", () => {
		expect(canTransitionTaskForHookEvent(makeSummary({ state: "running", pid: 1234 }), "to_review")).toBe(true);
		for (const state of ["idle", "awaiting_review", "failed", "interrupted"] as const) {
			expect(canTransitionTaskForHookEvent(makeSummary({ state }), "to_review")).toBe(false);
		}
	});

	it("to_in_progress 仅在 awaiting_review + reviewReason∈{attention,hook,error,manual_review} 时放行", () => {
		// manual_review（「移至 Review」手动钉住）现也放行——活跃 agent 的下一笔 to_in_progress 即可解锁回 In Progress。
		for (const reviewReason of ["attention", "hook", "error", "manual_review"] as const) {
			expect(
				canTransitionTaskForHookEvent(makeSummary({ state: "awaiting_review", reviewReason }), "to_in_progress"),
			).toBe(true);
		}
		for (const reviewReason of [null, "exit", "interrupted", "completion"] as const) {
			expect(
				canTransitionTaskForHookEvent(makeSummary({ state: "awaiting_review", reviewReason }), "to_in_progress"),
			).toBe(false);
		}
		// 非 awaiting_review 即便 reviewReason=attention 也不放行。
		expect(
			canTransitionTaskForHookEvent(makeSummary({ state: "running", reviewReason: "attention" }), "to_in_progress"),
		).toBe(false);
	});

	it("全表逐项等价旧 legacy 判据（全 event×state×reviewReason×pid×connectionRetry，零行为漂移）", () => {
		for (const event of ALL_EVENTS) {
			for (const state of ALL_STATES) {
				for (const reviewReason of ALL_REVIEW_REASONS) {
					for (const pid of [null, 1234]) {
						for (const connectionRetryActive of [false, true]) {
							const summary = makeSummary({
								state,
								reviewReason,
								pid,
								connectionRetry: connectionRetryActive
									? {
											status: "retrying",
											retryCount: 1,
											firstErrorAt: 1_000,
											lastAttemptAt: 1_500,
											nextAttemptAt: 2_000,
										}
									: null,
							});
							expect(canTransitionTaskForHookEvent(summary, event)).toBe(legacyCanTransition(summary, event));
						}
					}
				}
			}
		}
	});

	it("采信显式 facet：agent 回合（即便 legacy state 不一致）to_review 放行", () => {
		const explicitAgent: Partial<RuntimeTaskSessionSummary> & SessionFacets = {
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
		};
		expect(canTransitionTaskForHookEvent(makeSummary({ state: "idle", ...explicitAgent }), "to_review")).toBe(true);
	});

	it("live↔exited 折叠反证：exited（进程已退仍等人审）+ reviewReason=hook 仍可转 in_progress", () => {
		const exitedAwaiting: Partial<RuntimeTaskSessionSummary> & SessionFacets = {
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
		};
		const summary = makeSummary({
			state: "awaiting_review",
			pid: null,
			reviewReason: "hook",
			exitCode: 0,
			...exitedAwaiting,
		});
		expect(canTransitionTaskForHookEvent(summary, "to_in_progress")).toBe(true);
		// 同一 exited 会话不应被当成 agent 回合而误放 to_review。
		expect(canTransitionTaskForHookEvent(summary, "to_review")).toBe(false);
	});
});

// 非 native dispatch park：主 agent 以非 native 方式派发后台任务、结束本轮等其完成时发出的裸 Stop 不应被当成
// 「收尾等用户审查」。park 的唯一作用就是让这个单一 to_review 闸结构性抑制误发的 ready-for-review 通知。
describe("canTransitionTaskForHookEvent — parked（已派发后台工作）抑制 to_review", () => {
	const agentTurnSummary = (overrides: Partial<RuntimeTaskSessionSummary> = {}) =>
		makeSummary({ state: "running", pid: 1234, ...overrides });

	it("parked 的 agent 回合：to_review 被抑制（返回 false）", () => {
		const parked = agentTurnSummary({ awaitingDispatchedBackgroundWork: { sinceMs: 1_000 } });
		expect(canTransitionTaskForHookEvent(parked, "to_review")).toBe(false);
	});

	it("未 parked 的 agent 回合：to_review 照旧放行（回归保护）", () => {
		expect(canTransitionTaskForHookEvent(agentTurnSummary(), "to_review")).toBe(true);
		expect(
			canTransitionTaskForHookEvent(agentTurnSummary({ awaitingDispatchedBackgroundWork: null }), "to_review"),
		).toBe(true);
	});

	it("parked 带 label 同样抑制 to_review，且不改 activity（恒 false）", () => {
		const parked = agentTurnSummary({ awaitingDispatchedBackgroundWork: { sinceMs: 1_000, label: "child-x" } });
		expect(canTransitionTaskForHookEvent(parked, "to_review")).toBe(false);
		expect(canTransitionTaskForHookEvent(parked, "activity")).toBe(false);
	});
});
