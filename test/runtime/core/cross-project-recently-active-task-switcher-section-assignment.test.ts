import { describe, expect, it } from "vitest";
import type { RuntimeCrossProjectTaskSwitcherEntry } from "../../../src/core/api-contract";
import {
	assignCrossProjectTaskSwitcherSections,
	buildCrossProjectTaskSwitcherEntryKey,
	CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
	CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
	estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn,
	isCrossProjectTaskSwitcherEntryRunning,
} from "../../../src/core/cross-project-recently-active-task-switcher-section-assignment";

// 跨项目切换面板的区归属（docs/context-cross-project-recently-active-task-switcher.md）。核心不变量：
// Running / 缓存倒计时 / 剩余三区互斥（Running 优先），Pinned 可与它们重复；区归属不读 board 列（例外：排除 Done；
// Validation 不进缓存倒计时区）。

const NOW_MS = 10_000_000_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function makeEntry(
	taskId: string,
	overrides: Partial<RuntimeCrossProjectTaskSwitcherEntry> = {},
): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId,
		title: taskId,
		agentId: "claude",
		createdAt: 0,
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		turnOwner: null,
		liveness: "none",
		columnId: "review",
		userTurnKind: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		taskDescriptionLastUpdatedAt: 0,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		lastMainAgentConversationModelRequestDispatchObservation: null,
		agentProcessStartedAt: null,
		...overrides,
	};
}

function inProject(
	workspaceId: string,
	entry: RuntimeCrossProjectTaskSwitcherEntry,
): CrossProjectTaskSwitcherEntryInProject {
	return { workspaceId, projectName: workspaceId, entry };
}

const AGENT_RUNNING = { turnOwner: "agent", liveness: "live", userTurnKind: null } as const;
const USER_REVIEW_LIVE = { turnOwner: "user", liveness: "live", userTurnKind: "review" } as const;
const USER_REVIEW_EXITED = { turnOwner: "user", liveness: "exited", userTurnKind: "review" } as const;

function stoppedAt(stoppedAtMs: number): RuntimeCrossProjectTaskSwitcherEntry["agentResponseGenerationStopped"] {
	return { stoppedAt: stoppedAtMs, signalConfidence: "harness_turn_complete", turnSequence: 1 };
}

function progressAt(observedAtMs: number): RuntimeCrossProjectTaskSwitcherEntry["lastConversationProgressObservation"] {
	return { observedAtMs, evidenceKind: "agent_lifecycle_hook_event" };
}

function dispatchedAt(
	observedAtMs: number,
): RuntimeCrossProjectTaskSwitcherEntry["lastMainAgentConversationModelRequestDispatchObservation"] {
	return { observedAtMs, evidenceKind: "post_tool_use_hook_event" };
}

function turnStartedAt(
	startedAtMs: number,
): RuntimeCrossProjectTaskSwitcherEntry["agentResponseGenerationTurnStarted"] {
	return { startedAt: startedAtMs, turnSequence: 1 };
}

function assign(
	entriesInProjects: CrossProjectTaskSwitcherEntryInProject[],
	options: {
		mode?: CrossProjectTaskSwitcherRemainingSectionOrderingMode;
		unreadHandoffEntryKeys?: Set<string>;
		nowMs?: number;
	} = {},
) {
	return assignCrossProjectTaskSwitcherSections({
		entriesInProjects,
		nowMs: options.nowMs ?? NOW_MS,
		remainingSectionOrderingMode:
			options.mode ?? "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
		remainingSectionActivityHorizonMs: CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
		unreadHandoffEntryKeys: options.unreadHandoffEntryKeys ?? new Set(),
	});
}

function remainingTaskIds(sections: ReturnType<typeof assign>): string[] {
	const section = sections.remainingSection;
	if (section.orderingMode === "unread_handoffs_then_recently_opened_by_user") {
		return [...section.unreadHandoffEntries, ...section.recentlyOpenedByUserEntries].map(({ entry }) => entry.taskId);
	}
	return section.entries.map(({ entry }) => entry.taskId);
}

describe("isCrossProjectTaskSwitcherEntryRunning", () => {
	it("agent 回合 + 5 分钟内有输出 → Running", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(
				makeEntry("a", { ...AGENT_RUNNING, lastOutputAt: NOW_MS - 4 * MINUTE_MS }),
				NOW_MS,
			),
		).toBe(true);
	});

	it("agent 回合但 5 分钟无输出、未 park → 不算 Running", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(
				makeEntry("a", { ...AGENT_RUNNING, lastOutputAt: NOW_MS - 5 * MINUTE_MS }),
				NOW_MS,
			),
		).toBe(false);
	});

	it("park 在等自己派发的后台工作 → 即使久无输出也算 Running", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(
				makeEntry("a", { ...AGENT_RUNNING, lastOutputAt: null, isParkedAwaitingDispatchedBackgroundWork: true }),
				NOW_MS,
			),
		).toBe(true);
	});

	it("用户回合即使刚有输出也不算 Running（回合一交出就翻转）", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(makeEntry("a", { ...USER_REVIEW_LIVE, lastOutputAt: NOW_MS }), NOW_MS),
		).toBe(false);
	});
});

describe("estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn", () => {
	const estimate = estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn;

	it("Claude：主对话最后一次发请求 + 55 分钟内仍热，到点即掉出", () => {
		const entry = makeEntry("a", {
			...USER_REVIEW_EXITED,
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
		});
		expect(estimate(entry, NOW_MS + 54 * MINUTE_MS)).toEqual({
			promptCacheWarmthAnchorAt: NOW_MS,
			promptCacheWarmthAnchorSource: "main_agent_conversation_model_request_dispatch_observation",
			promptCacheExpectedExpiryAt: NOW_MS + 55 * MINUTE_MS,
		});
		expect(estimate(entry, NOW_MS + 55 * MINUTE_MS)).toBeNull();
	});

	it("会话恢复把 stoppedAt 刷成恢复时刻：起点不读它，仍按真实最后一次请求算（2026-10-03 实测场景）", () => {
		const entry = makeEntry("a", {
			...USER_REVIEW_LIVE,
			agentResponseGenerationStopped: stoppedAt(NOW_MS - 18 * MINUTE_MS),
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - 697 * MINUTE_MS),
			lastConversationProgressObservation: progressAt(NOW_MS - 694 * MINUTE_MS),
		});
		expect(estimate(entry, NOW_MS)).toBeNull();
	});

	// ca0af 回归（2026-10-04 用户反馈「只是 visit 了那个 task 就进了 Cache warm」）：部署版读 stoppedAt，而终端
	// 重启、从 Done 恢复的自动续跑都会把它刷成续跑时刻；续跑只带来 SessionStart，没发任何模型请求。
	// 还没有 dispatch sidecar 的存量会话回落到对话推进观测，它停在真实最后一次请求附近，不受续跑影响。
	it("没有 dispatch sidecar + 续跑把 stoppedAt 刷成刚才：不进倒计时区", () => {
		const entry = makeEntry("ca0af", {
			...USER_REVIEW_LIVE,
			agentResponseGenerationStopped: stoppedAt(NOW_MS - MINUTE_MS),
			lastConversationProgressObservation: progressAt(NOW_MS - 43 * 60 * MINUTE_MS),
		});
		expect(estimate(entry, NOW_MS)).toBeNull();
	});

	describe("手动压缩完成（用户拍板 B′：留区，但不显示倒计时）", () => {
		const manualCompactionAt = (observedAtMs: number, contextTokenCount?: number) =>
			({
				observedAtMs,
				evidenceKind:
					"manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request",
				...(contextTokenCount !== undefined
					? { mainAgentConversationContextTokenCountAfterCompactionReportedByHarness: contextTokenCount }
					: {}),
			}) as const;

		it("按 TTL 下界留区，起点来源标成手动压缩；harness 报了上下文大小就带上", () => {
			expect(
				estimate(
					makeEntry("a", {
						...USER_REVIEW_LIVE,
						lastMainAgentConversationModelRequestDispatchObservation: manualCompactionAt(NOW_MS - MINUTE_MS),
					}),
					NOW_MS,
				),
			).toEqual({
				promptCacheWarmthAnchorAt: NOW_MS - MINUTE_MS,
				promptCacheWarmthAnchorSource: "manual_compaction_replaced_main_conversation_without_follow_up_request",
				promptCacheExpectedExpiryAt: NOW_MS + 54 * MINUTE_MS,
			});
			expect(
				estimate(
					makeEntry("a", {
						...USER_REVIEW_LIVE,
						lastMainAgentConversationModelRequestDispatchObservation: manualCompactionAt(
							NOW_MS - MINUTE_MS,
							42_000,
						),
					}),
					NOW_MS,
				)?.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness,
			).toBe(42_000);
		});

		it("不落入对话推进兜底：压缩 fork 的 SubagentStop 刚推进的高置信观测不会把来源改回普通倒计时", () => {
			expect(
				estimate(
					makeEntry("a", {
						...USER_REVIEW_LIVE,
						lastMainAgentConversationModelRequestDispatchObservation: manualCompactionAt(NOW_MS - 2 * MINUTE_MS),
						lastConversationProgressObservation: progressAt(NOW_MS - MINUTE_MS),
					}),
					NOW_MS,
				)?.promptCacheWarmthAnchorSource,
			).toBe("manual_compaction_replaced_main_conversation_without_follow_up_request");
		});

		it("压缩之后再来一次真实请求：恢复普通倒计时", () => {
			expect(
				estimate(
					makeEntry("a", {
						...USER_REVIEW_LIVE,
						lastMainAgentConversationModelRequestDispatchObservation: {
							observedAtMs: NOW_MS - MINUTE_MS,
							evidenceKind: "user_prompt_submit_hook_event_accepted",
						},
					}),
					NOW_MS,
				)?.promptCacheWarmthAnchorSource,
			).toBe("main_agent_conversation_model_request_dispatch_observation");
		});

		it("同进程缓存（Codex）：仍受同进程门约束", () => {
			const compacted = {
				...USER_REVIEW_LIVE,
				agentId: "codex" as const,
				lastMainAgentConversationModelRequestDispatchObservation: manualCompactionAt(NOW_MS - MINUTE_MS),
			};
			expect(
				estimate(makeEntry("a", { ...compacted, agentProcessStartedAt: NOW_MS - 60 * MINUTE_MS }), NOW_MS),
			).not.toBeNull();
			expect(estimate(makeEntry("a", { ...compacted, agentProcessStartedAt: NOW_MS }), NOW_MS)).toBeNull();
		});
	});

	it("服务端缓存（Claude）：runtime 重启后 facet 归零（none）照样在区内", () => {
		const entry = makeEntry("a", {
			turnOwner: null,
			liveness: "none",
			userTurnKind: null,
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - 10 * MINUTE_MS),
		});
		expect(estimate(entry, NOW_MS)?.promptCacheExpectedExpiryAt).toBe(NOW_MS + 45 * MINUTE_MS);
	});

	it("agent 正持有回合时不估算（由 Running / 剩余区处理）", () => {
		const entry = makeEntry("a", {
			...AGENT_RUNNING,
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
		});
		expect(estimate(entry, NOW_MS)).toBeNull();
	});

	it("同进程缓存（Codex / Kimi）：进程退出即不热；恢复成新进程后，早于进程启动的请求不算", () => {
		for (const agentId of ["codex", "kimi"] as const) {
			const anchor = {
				agentId,
				lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - 5 * MINUTE_MS),
			};
			expect(
				estimate(
					makeEntry("a", { ...USER_REVIEW_EXITED, ...anchor, agentProcessStartedAt: NOW_MS - 60 * MINUTE_MS }),
					NOW_MS,
				),
			).toBeNull();
			expect(
				estimate(
					makeEntry("a", { ...USER_REVIEW_LIVE, ...anchor, agentProcessStartedAt: NOW_MS - 60 * MINUTE_MS }),
					NOW_MS,
				),
			).not.toBeNull();
			expect(
				estimate(
					makeEntry("a", { ...USER_REVIEW_LIVE, ...anchor, agentProcessStartedAt: NOW_MS - MINUTE_MS }),
					NOW_MS,
				),
			).toBeNull();
			expect(
				estimate(makeEntry("a", { ...USER_REVIEW_LIVE, ...anchor, agentProcessStartedAt: null }), NOW_MS),
			).toBeNull();
		}
	});

	it("Cursor 没有回合类 hook：起点读最近一次实质输出", () => {
		const entry = makeEntry("a", {
			...USER_REVIEW_LIVE,
			agentId: "cursor",
			lastSubstantiveOutputAt: NOW_MS - 5 * MINUTE_MS,
			lastConversationProgressObservation: progressAt(NOW_MS - MINUTE_MS),
		});
		expect(estimate(entry, NOW_MS)).toEqual({
			promptCacheWarmthAnchorAt: NOW_MS - 5 * MINUTE_MS,
			promptCacheWarmthAnchorSource: "last_substantive_agent_terminal_output",
			promptCacheExpectedExpiryAt: NOW_MS + 15 * MINUTE_MS,
		});
	});

	it("没有发请求观测的会话：高置信对话推进也不作为 Cache warm 起点", () => {
		expect(
			estimate(
				makeEntry("a", {
					...USER_REVIEW_EXITED,
					lastConversationProgressObservation: progressAt(NOW_MS - 10 * MINUTE_MS),
				}),
				NOW_MS,
			),
		).toBeNull();
		expect(
			estimate(
				makeEntry("a", {
					...USER_REVIEW_EXITED,
					lastConversationProgressObservation: {
						observedAtMs: NOW_MS,
						evidenceKind: "terminal_output_heuristic_classification",
					},
				}),
				NOW_MS,
			),
		).toBeNull();
	});

	it("没有任何起点 / 没测过 TTL 的 agent → 不进倒计时区", () => {
		expect(
			estimate(makeEntry("a", { ...USER_REVIEW_EXITED, agentResponseGenerationStopped: stoppedAt(NOW_MS) }), NOW_MS),
		).toBeNull();
		expect(
			estimate(
				makeEntry("a", {
					...USER_REVIEW_LIVE,
					agentId: "cline",
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
				}),
				NOW_MS,
			),
		).toBeNull();
	});
});

describe("assignCrossProjectTaskSwitcherSections", () => {
	it("三区互斥、优先级 Running > 缓存倒计时 > 剩余；Pinned 可与它们重复", () => {
		const sections = assign([
			inProject("ws-1", makeEntry("running", { ...AGENT_RUNNING, lastOutputAt: NOW_MS, pinnedToTaskPinboardAt: 5 })),
			inProject(
				"ws-1",
				makeEntry("warm", {
					...USER_REVIEW_EXITED,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - MINUTE_MS),
				}),
			),
			inProject(
				"ws-2",
				makeEntry("cold", {
					...USER_REVIEW_EXITED,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - 2 * 60 * MINUTE_MS),
					lastConversationProgressObservation: progressAt(NOW_MS - 2 * 60 * MINUTE_MS),
					pinnedToTaskPinboardAt: 9,
				}),
			),
		]);
		expect(sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["running"]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId)).toEqual(["warm"]);
		expect(remainingTaskIds(sections)).toEqual(["cold"]);
		// Pinned 按置顶时刻倒序，且与下面的区重复出现。
		expect(sections.pinnedEntries.map(({ entry }) => entry.taskId)).toEqual(["cold", "running"]);
	});

	it("区归属不读 board 列：review 列里正在跑的任务进 Running，in_progress 列里刚交出回合的进倒计时区", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("misfiled-running", { ...AGENT_RUNNING, columnId: "review", lastOutputAt: NOW_MS }),
			),
			inProject(
				"ws-1",
				makeEntry("lagging-column", {
					...USER_REVIEW_EXITED,
					columnId: "in_progress",
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
				}),
			),
		]);
		expect(sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["misfiled-running"]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId)).toEqual(["lagging-column"]);
	});

	it("Done 列只进 Pinned，不进下面三区", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("done", { ...AGENT_RUNNING, columnId: "trash", lastOutputAt: NOW_MS, pinnedToTaskPinboardAt: 1 }),
			),
		]);
		expect(sections.pinnedEntries).toHaveLength(1);
		expect(sections.runningEntries).toEqual([]);
		expect(remainingTaskIds(sections)).toEqual([]);
	});

	// 2026-10-04 用户反馈：移入 Validation / Done 的任务即使缓存仍热，也不该留在 Cache warm，而是下放到 Recent
	// 由它的规则决定显不显示。Done 本来就在分区前排除（上一条用例）；这里钉 Validation。
	describe("Validation 列不进缓存倒计时区，下放到剩余区", () => {
		const warmAnchor = {
			...USER_REVIEW_EXITED,
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - MINUTE_MS),
			lastConversationProgressObservation: progressAt(NOW_MS - MINUTE_MS),
		};

		it("缓存仍热的 Validation 条目进 Recent；同样数据的 Review / In progress 条目进 Cache warm", () => {
			const sections = assign([
				inProject("ws-1", makeEntry("validation", { ...warmAnchor, columnId: "validation" })),
				inProject("ws-1", makeEntry("review", { ...warmAnchor, columnId: "review" })),
				inProject("ws-1", makeEntry("in-progress", { ...warmAnchor, columnId: "in_progress" })),
			]);
			expect(sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId).sort()).toEqual([
				"in-progress",
				"review",
			]);
			expect(remainingTaskIds(sections)).toEqual(["validation"]);
		});

		it("超出剩余区时间窗的 Validation 条目两区都不出现", () => {
			const sections = assign([
				inProject(
					"ws-1",
					makeEntry("validation-old", {
						...USER_REVIEW_EXITED,
						columnId: "validation",
						lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - MINUTE_MS),
						lastConversationProgressObservation: progressAt(NOW_MS - 8 * DAY_MS),
					}),
				),
			]);
			expect(sections.promptCacheWarmAwaitingUserEntries).toEqual([]);
			expect(remainingTaskIds(sections)).toEqual([]);
		});

		it("Validation 列里 agent 正在干活的任务照常进 Running", () => {
			const sections = assign([
				inProject(
					"ws-1",
					makeEntry("validating", { ...AGENT_RUNNING, columnId: "validation", lastOutputAt: NOW_MS }),
				),
			]);
			expect(sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["validating"]);
		});

		it("已置顶的 Validation 条目照常在 Pinned，但不进 Cache warm", () => {
			const sections = assign([
				inProject(
					"ws-1",
					makeEntry("pinned-validation", { ...warmAnchor, columnId: "validation", pinnedToTaskPinboardAt: 3 }),
				),
			]);
			expect(sections.pinnedEntries.map(({ entry }) => entry.taskId)).toEqual(["pinned-validation"]);
			expect(sections.promptCacheWarmAwaitingUserEntries).toEqual([]);
			expect(remainingTaskIds(sections)).toEqual(["pinned-validation"]);
		});
	});

	it("缓存倒计时区按失效时刻升序（最快失效的在最前），跨 agent TTL 也比较失效时刻", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("codex-just-stopped", {
					...USER_REVIEW_LIVE,
					agentId: "codex",
					agentProcessStartedAt: NOW_MS - 60 * MINUTE_MS,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
				}),
			),
			inProject(
				"ws-1",
				makeEntry("claude-40m-ago", {
					...USER_REVIEW_EXITED,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - 40 * MINUTE_MS),
				}),
			),
			inProject(
				"ws-2",
				makeEntry("kimi-just-stopped", {
					...USER_REVIEW_LIVE,
					agentId: "kimi",
					agentProcessStartedAt: NOW_MS - 60 * MINUTE_MS,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
				}),
			),
		]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId)).toEqual([
			"claude-40m-ago",
			"kimi-just-stopped",
			"codex-just-stopped",
		]);
	});

	it("跨项目同号 taskId 各自独立归区", () => {
		const sections = assign([
			inProject("ws-1", makeEntry("same-id", { ...AGENT_RUNNING, lastOutputAt: NOW_MS })),
			inProject(
				"ws-2",
				makeEntry("same-id", {
					...USER_REVIEW_EXITED,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
				}),
			),
		]);
		expect(sections.runningEntries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-1"]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-2"]);
	});

	// 2026-10-04 用户反馈：Running 区随 agent 动作不断重排闪烁。根因是按 lastOutputAt 倒序，而 spinner 每次
	// 重绘都推进它。现在按本轮 agent 回合开始时刻升序：先进入的在前、后进入的在后。
	describe("Running 区排序：按本轮 agent 回合开始时刻升序，不随输出抖动", () => {
		function runningEntry(
			workspaceId: string,
			taskId: string,
			overrides: Partial<RuntimeCrossProjectTaskSwitcherEntry>,
		): CrossProjectTaskSwitcherEntryInProject {
			return inProject(workspaceId, makeEntry(taskId, { ...AGENT_RUNNING, lastOutputAt: NOW_MS, ...overrides }));
		}
		function runningTaskIds(entriesInProjects: CrossProjectTaskSwitcherEntryInProject[]): string[] {
			return assign(entriesInProjects).runningEntries.map(({ entry }) => entry.taskId);
		}

		it("先进入 agent 回合的在前", () => {
			expect(
				runningTaskIds([
					runningEntry("ws-1", "late", { agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - MINUTE_MS) }),
					runningEntry("ws-1", "early", {
						agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - 3 * MINUTE_MS),
					}),
					runningEntry("ws-2", "middle", {
						agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - 2 * MINUTE_MS),
					}),
				]),
			).toEqual(["early", "middle", "late"]);
		});

		it("只打乱 lastOutputAt（spinner 重绘）时顺序不变", () => {
			const turnStarts = { a: NOW_MS - 3 * MINUTE_MS, b: NOW_MS - 2 * MINUTE_MS, c: NOW_MS - MINUTE_MS };
			const lastOutputAtPermutations = [
				{ a: NOW_MS, b: NOW_MS - 1_000, c: NOW_MS - 2_000 },
				{ a: NOW_MS - 2_000, b: NOW_MS, c: NOW_MS - 1_000 },
				{ a: NOW_MS - 1_000, b: NOW_MS - 2_000, c: NOW_MS },
			];
			for (const lastOutputAtByTaskId of lastOutputAtPermutations) {
				expect(
					runningTaskIds(
						(["c", "a", "b"] as const).map((taskId) =>
							runningEntry("ws-1", taskId, {
								lastOutputAt: lastOutputAtByTaskId[taskId],
								agentResponseGenerationTurnStarted: turnStartedAt(turnStarts[taskId]),
							}),
						),
					),
				).toEqual(["a", "b", "c"]);
			}
		});

		it("开始时刻相同按 (workspaceId, taskId) 兜底", () => {
			const sameStart = { agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - MINUTE_MS) };
			expect(
				assign([
					runningEntry("ws-2", "x", sameStart),
					runningEntry("ws-1", "y", sameStart),
					runningEntry("ws-1", "x", sameStart),
				]).runningEntries.map(({ workspaceId, entry }) => `${workspaceId}:${entry.taskId}`),
			).toEqual(["ws-1:x", "ws-1:y", "ws-2:x"]);
		});

		it("旧 runtime 没有回合开始事件：回落到 agent 进程启动时刻，两者都没有的排末尾", () => {
			expect(
				runningTaskIds([
					runningEntry("ws-1", "no-timestamps", {}),
					runningEntry("ws-1", "process-started", { agentProcessStartedAt: NOW_MS - 5 * MINUTE_MS }),
					runningEntry("ws-1", "turn-started", {
						agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - MINUTE_MS),
					}),
				]),
			).toEqual(["process-started", "turn-started", "no-timestamps"]);
		});

		it("两个项目里同号的任务都在 Running：各按自己的开始时刻排", () => {
			expect(
				assign([
					runningEntry("ws-1", "same-id", {
						agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - MINUTE_MS),
					}),
					runningEntry("ws-2", "same-id", {
						agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - 2 * MINUTE_MS),
					}),
				]).runningEntries.map(({ workspaceId }) => workspaceId),
			).toEqual(["ws-2", "ws-1"]);
		});
	});

	it("缓存倒计时区同一失效时刻按 (workspaceId, taskId) 兜底", () => {
		const sameAnchor = {
			...USER_REVIEW_EXITED,
			lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS - MINUTE_MS),
		};
		expect(
			assign([
				inProject("ws-2", makeEntry("a", sameAnchor)),
				inProject("ws-1", makeEntry("b", sameAnchor)),
				inProject("ws-1", makeEntry("a", sameAnchor)),
			]).promptCacheWarmAwaitingUserEntries.map(({ workspaceId, entry }) => `${workspaceId}:${entry.taskId}`),
		).toEqual(["ws-1:a", "ws-1:b", "ws-2:a"]);
	});

	it("剩余区模式 ①：max(对话推进, 我最后打开, Description 编辑) 倒序，时间窗外的不显示", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("progressed", { lastConversationProgressObservation: progressAt(NOW_MS - 3 * DAY_MS) }),
			),
			inProject("ws-1", makeEntry("opened", { lastOpenedByUserAt: NOW_MS - DAY_MS })),
			inProject("ws-1", makeEntry("edited", { taskDescriptionLastUpdatedAt: NOW_MS - 2 * DAY_MS })),
			inProject("ws-1", makeEntry("stale", { taskDescriptionLastUpdatedAt: NOW_MS - 8 * DAY_MS })),
		]);
		expect(remainingTaskIds(sections)).toEqual(["opened", "edited", "progressed"]);
	});

	it("剩余区模式 ③：只按对话推进排序，没有推进记录的不进", () => {
		const sections = assign(
			[
				inProject(
					"ws-1",
					makeEntry("progressed", { lastConversationProgressObservation: progressAt(NOW_MS - DAY_MS) }),
				),
				inProject("ws-1", makeEntry("only-opened", { lastOpenedByUserAt: NOW_MS })),
			],
			{ mode: "most_recent_conversation_progress_only" },
		);
		expect(remainingTaskIds(sections)).toEqual(["progressed"]);
	});

	it("剩余区模式 ②：未读交接在前、我最近打开在后且有条数上限，同一任务不重复", () => {
		const opened = Array.from(
			{ length: CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT + 2 },
			(_, index) =>
				inProject("ws-1", makeEntry(`opened-${index}`, { lastOpenedByUserAt: NOW_MS - (index + 1) * MINUTE_MS })),
		);
		const sections = assign([...opened, inProject("ws-2", makeEntry("unread", { lastOpenedByUserAt: NOW_MS }))], {
			mode: "unread_handoffs_then_recently_opened_by_user",
			unreadHandoffEntryKeys: new Set([
				buildCrossProjectTaskSwitcherEntryKey("ws-2", "unread"),
				buildCrossProjectTaskSwitcherEntryKey("ws-1", "opened-0"),
			]),
		});
		if (sections.remainingSection.orderingMode !== "unread_handoffs_then_recently_opened_by_user") {
			throw new Error("unexpected mode");
		}
		expect(sections.remainingSection.unreadHandoffEntries.map(({ entry }) => entry.taskId)).toEqual([
			"unread",
			"opened-0",
		]);
		expect(sections.remainingSection.recentlyOpenedByUserEntries).toHaveLength(
			CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT,
		);
		expect(sections.remainingSection.recentlyOpenedByUserEntries[0]?.entry.taskId).toBe("opened-1");
	});

	it("缓存到期后同一任务从倒计时区掉进剩余区（区归属随 now 现算）", () => {
		const entries = [
			inProject(
				"ws-1",
				makeEntry("a", {
					...USER_REVIEW_EXITED,
					lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
					lastConversationProgressObservation: progressAt(NOW_MS),
				}),
			),
		];
		expect(assign(entries, { nowMs: NOW_MS + MINUTE_MS }).promptCacheWarmAwaitingUserEntries).toHaveLength(1);
		const expired = assign(entries, { nowMs: NOW_MS + 56 * MINUTE_MS });
		expect(expired.promptCacheWarmAwaitingUserEntries).toEqual([]);
		expect(remainingTaskIds(expired)).toEqual(["a"]);
	});
});
