import { describe, expect, it } from "vitest";

import type { RuntimeTaskConnectionRetry, RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	deriveCardSessionActivity,
	isCardCreditLimitError,
	SESSION_ACTIVITY_COLOR,
} from "./board-card-session-activity";

// 本套件锁定 deriveCardSessionActivity / isCardCreditLimitError 的可见行为。Stage 3 首步抽出时为
// 「迁移前基线」，余区把真相源迁到 facet（零行为变更）。Channel C（人轴文案，普适四种）已落地：等人审
// 回合按 userTurnKind 细分 review（绿「Waiting for review」）/ needs_input（金「Needs your input」）/
// error（红「Encountered an error」），finalMessage 仍逐字显示、仅状态点颜色随人轴。其余断言（富活动
// 文案 / spawn-failed / Thinking 兜底 / exited 折叠）作为「不得回归」的护栏。

function makeHookActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName: null,
		notificationType: null,
		source: "cline-sdk",
		...overrides,
	};
}

function makeConnectionRetry(retryCount: number): RuntimeTaskConnectionRetry {
	return {
		status: "retrying",
		retryCount,
		firstErrorAt: 1,
		lastAttemptAt: null,
		nextAttemptAt: null,
	};
}

function makeSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("isCardCreditLimitError", () => {
	it("returns false for an undefined summary", () => {
		expect(isCardCreditLimitError(undefined)).toBe(false);
	});

	it("only treats settled states (awaiting_review / failed / interrupted) as credit-limit candidates", () => {
		const creditLimitHook = makeHookActivity({ notificationType: "credit_limit" });
		// running 仍在 agent 回合，不视为「额度耗尽待处理」。
		expect(isCardCreditLimitError(makeSummary("running", { latestHookActivity: creditLimitHook }))).toBe(false);
		expect(isCardCreditLimitError(makeSummary("awaiting_review", { latestHookActivity: creditLimitHook }))).toBe(
			true,
		);
		expect(isCardCreditLimitError(makeSummary("failed", { latestHookActivity: creditLimitHook }))).toBe(true);
		expect(isCardCreditLimitError(makeSummary("interrupted", { latestHookActivity: creditLimitHook }))).toBe(true);
	});

	it("requires the credit_limit notification type", () => {
		expect(isCardCreditLimitError(makeSummary("awaiting_review"))).toBe(false);
		expect(
			isCardCreditLimitError(
				makeSummary("awaiting_review", { latestHookActivity: makeHookActivity({ notificationType: "attention" }) }),
			),
		).toBe(false);
	});
});

describe("deriveCardSessionActivity", () => {
	it("returns null when there is no summary", () => {
		expect(deriveCardSessionActivity(undefined)).toBeNull();
	});

	it("returns null for an idle session with no activity", () => {
		expect(deriveCardSessionActivity(makeSummary("idle"))).toBeNull();
	});

	it("returns null for an interrupted session with no activity to preview", () => {
		expect(deriveCardSessionActivity(makeSummary("interrupted"))).toBeNull();
	});

	describe("credit limit (highest priority)", () => {
		it("shows the out-of-credits warning", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					latestHookActivity: makeHookActivity({ notificationType: "credit_limit" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.warning, text: "Out of credits" });
		});

		it("takes precedence over an active connection retry", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					latestHookActivity: makeHookActivity({ notificationType: "credit_limit" }),
					connectionRetry: makeConnectionRetry(3),
				}),
			);
			expect(result?.text).toBe("Out of credits");
		});
	});

	describe("connection retry (above hook activity)", () => {
		it("shows a plain reconnecting label before any auto-continue", () => {
			const result = deriveCardSessionActivity(makeSummary("running", { connectionRetry: makeConnectionRetry(0) }));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.warning, text: "重连中…" });
		});

		it("includes the auto-continue attempt count once it is non-zero", () => {
			const result = deriveCardSessionActivity(makeSummary("running", { connectionRetry: makeConnectionRetry(2) }));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.warning, text: "重连中…（已续跑 2 次）" });
		});

		it("takes precedence over a concurrent tool-call activity", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					connectionRetry: makeConnectionRetry(1),
					latestHookActivity: makeHookActivity({
						activityText: "Using Read",
						toolName: "Read",
						toolInputSummary: "src/index.ts",
					}),
				}),
			);
			expect(result?.text).toBe("重连中…（已续跑 1 次）");
		});
	});

	describe("awaiting-review final message", () => {
		it("shows the final message verbatim regardless of hook event name (review turn → success)", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					// reviewReason="hook" → userTurnKind=review（完成待审）：finalMessage 逐字 + 绿点。
					reviewReason: "hook",
					latestHookActivity: makeHookActivity({ finalMessage: "Done reviewing", hookEventName: "stop" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "Done reviewing" });
		});
	});

	describe("streaming final message (no tool, assistant_delta / agent_end / turn_start)", () => {
		it("renders running streams as thinking-colored previews", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({
						activityText: "Reviewing the final diff",
						finalMessage: "Reviewing the final diff",
						hookEventName: "assistant_delta",
					}),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Reviewing the final diff" });
		});

		it("renders non-running streams as success-colored previews", () => {
			const result = deriveCardSessionActivity(
				makeSummary("interrupted", {
					latestHookActivity: makeHookActivity({ finalMessage: "Wrapped up", hookEventName: "agent_end" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "Wrapped up" });
		});
	});

	describe("tool-call labels (compact format)", () => {
		it("formats an explicit cline tool name plus input summary", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({
						activityText: "Using Read",
						toolName: "Read",
						toolInputSummary: "src/index.ts",
					}),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Read(src/index.ts)" });
		});

		it("recovers the input summary from the activity text when not provided separately", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({ activityText: "Completed Read: src/index.ts", toolName: "Read" }),
				}),
			);
			expect(result?.text).toBe("Read(src/index.ts)");
		});

		it("parses a bare codex-style activity line with no explicit tool name", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({ activityText: "Calling Read: src/index.ts" }),
				}),
			);
			expect(result?.text).toBe("Read(src/index.ts)");
		});

		it("marks a failed tool call red and strips trailing failure detail from the summary", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({
						activityText: "Failed Read: boom: extra detail",
						toolName: "Read",
					}),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Read(boom)" });
		});

		it("prefers a tool label over a thinking fallback when a non-matching activity text carries a tool", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({
						activityText: "Agent active",
						toolName: "Read",
						toolInputSummary: "src/index.ts",
						finalMessage: "Looking at the file now",
						hookEventName: "assistant_delta",
					}),
				}),
			);
			expect(result?.text).toBe("Read(src/index.ts)");
		});
	});

	describe("activity-text prefixes (no tool label)", () => {
		it("treats a Final: prefix as a success message", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", { latestHookActivity: makeHookActivity({ activityText: "Final: All done" }) }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "All done" });
		});

		it("strips an Agent: prefix while keeping the thinking color for running sessions", () => {
			const result = deriveCardSessionActivity(
				makeSummary("running", {
					latestHookActivity: makeHookActivity({ activityText: "Agent: checking the next file" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "checking the next file" });
		});

		it("colors waiting-for-approval gold", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					latestHookActivity: makeHookActivity({ activityText: "Waiting for approval to proceed" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Waiting for approval to proceed" });
		});

		it("colors waiting-for-review green", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					latestHookActivity: makeHookActivity({ activityText: "Waiting for review of the diff" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review of the diff" });
		});

		it("collapses generic activity sentinels into a Thinking… placeholder", () => {
			for (const activityText of ["Agent active", "Working on task", "Resumed prior session"]) {
				const result = deriveCardSessionActivity(
					makeSummary("running", { latestHookActivity: makeHookActivity({ activityText }) }),
				);
				expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." });
			}
		});

		it("colors arbitrary activity text red when the session itself failed", () => {
			const result = deriveCardSessionActivity(
				makeSummary("failed", { latestHookActivity: makeHookActivity({ activityText: "Something broke" }) }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Something broke" });
		});
	});

	describe("state fallbacks when there is no activity text", () => {
		it("uses the failure final message for a failed session", () => {
			const result = deriveCardSessionActivity(
				makeSummary("failed", {
					latestHookActivity: makeHookActivity({ finalMessage: "spawn boom", hookEventName: "stop" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "spawn boom" });
		});

		it("falls back to a generic failed-to-start message when nothing else is available", () => {
			const result = deriveCardSessionActivity(makeSummary("failed"));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Task failed to start" });
		});

		it("shows a waiting-for-review placeholder for a review-kind awaiting_review session", () => {
			// reviewReason="hook" → userTurnKind=review（完成待审）。
			const result = deriveCardSessionActivity(makeSummary("awaiting_review", { reviewReason: "hook" }));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" });
		});

		it("shows a Thinking… placeholder for a bare running session", () => {
			const result = deriveCardSessionActivity(makeSummary("running"));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." });
		});
	});

	// Channel C（人轴文案，普适四种）：等人审回合按 userTurnKind 细分颜色 + 占位 CTA。
	describe("channel C — 等人审回合按 userTurnKind 细分（普适四种）", () => {
		it("needs_input（reviewReason=null 兜底）无内容 → 金点「Needs your input」", () => {
			const result = deriveCardSessionActivity(makeSummary("awaiting_review"));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Needs your input" });
		});

		it("needs_input 有 finalMessage → 逐字显示 + 金点（颜色随人轴，非 success）", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					latestHookActivity: makeHookActivity({
						finalMessage: "Which file should I edit?",
						hookEventName: "stop",
					}),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Which file should I edit?" });
		});

		it("error（运行错，reviewReason=error）无内容 → 红点「Encountered an error」", () => {
			const result = deriveCardSessionActivity(makeSummary("awaiting_review", { reviewReason: "error" }));
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Encountered an error" });
		});

		it("error 有 finalMessage → 逐字显示 + 红点（区别于 spawn-failed 占位）", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", {
					reviewReason: "error",
					latestHookActivity: makeHookActivity({ finalMessage: "Tool call failed", hookEventName: "stop" }),
				}),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Tool call failed" });
		});

		it("采信显式 facet：userTurnKind=needs_input（即便 legacy state=idle）→ 金点「Needs your input」", () => {
			const result = deriveCardSessionActivity(
				makeSummary("idle", { turnOwner: "user", liveness: "live", userTurnKind: "needs_input" }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Needs your input" });
		});

		it("采信显式 facet：userTurnKind=error（user/exited，非 failed）→ 红点「Encountered an error」", () => {
			const result = deriveCardSessionActivity(
				makeSummary("idle", { turnOwner: "user", liveness: "exited", userTurnKind: "error" }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Encountered an error" });
		});

		// Stage 4 采集增强：question / plan_review / permission 三类「阻塞等你」各有专属金 CTA 占位。
		it("question（Cline ask_followup_question）无内容 → 金点「Needs your answer」", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", { turnOwner: "user", liveness: "live", userTurnKind: "question" }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Needs your answer" });
		});

		it("plan_review（Cline plan_mode_respond）无内容 → 金点「Plan awaiting approval」", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", { turnOwner: "user", liveness: "live", userTurnKind: "plan_review" }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Plan awaiting approval" });
		});

		it("permission（Claude PermissionRequest）无内容 → 金点「Permission requested」", () => {
			const result = deriveCardSessionActivity(
				makeSummary("awaiting_review", { turnOwner: "user", liveness: "exited", userTurnKind: "permission" }),
			);
			expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.waiting, text: "Permission requested" });
		});
	});
});

// Stage 3 余区：派生真相源从 legacy `state` → 双轴 facet。锁定「采信显式 facet」与「live↔exited 折叠」
// 两条不变量——后者证明 exited（进程已退仍等人审）不被偷渡为不同于 live 的呈现（不偷渡 distinction ②）。
describe("facet 真相源（行为保持 + exited 折叠反证）", () => {
	it("反证：exited 的 awaiting_review 与 live 同样回落「Waiting for review」（不区分 live↔exited）", () => {
		const result = deriveCardSessionActivity(
			makeSummary("awaiting_review", {
				pid: null,
				exitCode: 0,
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
			}),
		);
		expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" });
	});

	it("采信显式 facet：turnOwner=agent（即便 legacy state=idle）→ Thinking… 占位", () => {
		const result = deriveCardSessionActivity(
			makeSummary("idle", { turnOwner: "agent", liveness: "live", userTurnKind: null }),
		);
		expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." });
	});

	it("采信显式 facet：turnOwner=user/liveness=failed（即便 legacy state=idle）→ 失败占位", () => {
		const result = deriveCardSessionActivity(
			makeSummary("idle", { turnOwner: "user", liveness: "failed", userTurnKind: "error" }),
		);
		expect(result).toEqual({ dotColor: SESSION_ACTIVITY_COLOR.error, text: "Task failed to start" });
	});

	it("isCardCreditLimitError：exited 的 awaiting_review（user 回合）+ credit_limit 仍判 true", () => {
		expect(
			isCardCreditLimitError(
				makeSummary("awaiting_review", {
					pid: null,
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					latestHookActivity: makeHookActivity({ notificationType: "credit_limit" }),
				}),
			),
		).toBe(true);
	});

	it("isCardCreditLimitError：agent 回合（非 user）+ credit_limit 判 false（保留 user 回合门控）", () => {
		expect(
			isCardCreditLimitError(
				makeSummary("running", {
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
					latestHookActivity: makeHookActivity({ notificationType: "credit_limit" }),
				}),
			),
		).toBe(false);
	});
});
