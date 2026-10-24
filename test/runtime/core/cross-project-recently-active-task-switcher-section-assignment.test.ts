import { describe, expect, it } from "vitest";
import type { RuntimeCrossProjectTaskSwitcherEntry } from "../../../src/core/api-contract";
import {
	assignCrossProjectTaskSwitcherSections,
	CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRecentTaskStageFilter,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
	estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn,
	isCrossProjectTaskSwitcherEntryRunning,
} from "../../../src/core/cross-project-recently-active-task-switcher-section-assignment";

// 跨项目切换面板的区归属（docs/context-cross-project-recently-active-task-switcher.md）。核心不变量：
// Running / 缓存倒计时 / 剩余三区互斥（Running 优先），Pinned 可与它们重复；Running 不按列归属；缓存区只收 In progress / Review，Recent 阶段筛选按列读取。

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
		selectedRecentTaskStageFilters?: readonly CrossProjectTaskSwitcherRecentTaskStageFilter[];
		activityHorizonMs?: number;
		selectedRecentProjectWorkspaceIds?: readonly string[];
		nowMs?: number;
	} = {},
) {
	return assignCrossProjectTaskSwitcherSections({
		entriesInProjects,
		nowMs: options.nowMs ?? NOW_MS,
		remainingSectionOrderingMode:
			options.mode ?? "most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
		remainingSectionActivityHorizonMs:
			options.activityHorizonMs ?? CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
		selectedRecentTaskStageFilters: options.selectedRecentTaskStageFilters,
		selectedRecentProjectWorkspaceIds: options.selectedRecentProjectWorkspaceIds,
	});
}

function remainingTaskIds(sections: ReturnType<typeof assign>): string[] {
	const section = sections.remainingSection;
	return section.entries.map(({ entry }) => entry.taskId);
}

describe("Recent 的阶段多选与统一活动范围", () => {
	const stageEntries = [
		inProject("ws-a", makeEntry("progress", { columnId: "in_progress", lastOpenedByUserAt: NOW_MS })),
		inProject("ws-a", makeEntry("review", { columnId: "review", lastOpenedByUserAt: NOW_MS })),
		inProject("ws-a", makeEntry("backlog", { columnId: "backlog", taskDescriptionLastUpdatedAt: NOW_MS })),
		inProject("ws-a", makeEntry("validation", { columnId: "validation", lastOpenedByUserAt: NOW_MS })),
		inProject("ws-a", makeEntry("done", { columnId: "trash", lastOpenedByUserAt: NOW_MS })),
	];
	const stageOptions = ["in_progress_and_review", "backlog", "validation", "done"] as const;
	const expectedTaskIdsByOption = [["progress", "review"], ["backlog"], ["validation"], ["done"]];
	it.each(Array.from({ length: 16 }, (_, selectionMask) => selectionMask))(
		"阶段组合 %i 取并集，空选择为 All",
		(selectionMask) => {
			const selectedRecentTaskStageFilters = stageOptions.filter((_, index) => (selectionMask & (1 << index)) !== 0);
			const expectedTaskIds =
				selectionMask === 0
					? ["progress", "review", "backlog", "validation", "done"]
					: expectedTaskIdsByOption.flatMap((ids, index) => ((selectionMask & (1 << index)) !== 0 ? ids : []));
			expect(remainingTaskIds(assign(stageEntries, { selectedRecentTaskStageFilters }))).toEqual(
				expectedTaskIds.sort(),
			);
		},
	);

	it.each(["backlog", "in_progress", "review", "validation", "trash"] as const)(
		"%s 同用 7 / 30 天窗口，边界包含，停止生成不刷新范围",
		(columnId) => {
			const entries = [
				inProject("ws-a", makeEntry("boundary", { columnId, lastOpenedByUserAt: NOW_MS - 7 * DAY_MS })),
				inProject("ws-a", makeEntry("older", { columnId, lastOpenedByUserAt: NOW_MS - 20 * DAY_MS })),
				inProject(
					"ws-a",
					makeEntry("expired", {
						columnId,
						lastOpenedByUserAt: NOW_MS - 31 * DAY_MS,
						agentResponseGenerationStopped: stoppedAt(NOW_MS),
					}),
				),
			];
			expect(remainingTaskIds(assign(entries))).toEqual(["boundary"]);
			expect(remainingTaskIds(assign(entries, { activityHorizonMs: 30 * DAY_MS }))).toEqual(["boundary", "older"]);
		},
	);

	it("项目多选取并集，再与阶段筛选取交集；同号任务按 workspaceId 独立", () => {
		const entries = [
			inProject("ws-a", makeEntry("same", { columnId: "backlog", lastOpenedByUserAt: NOW_MS })),
			inProject("ws-b", makeEntry("same", { columnId: "validation", lastOpenedByUserAt: NOW_MS })),
			inProject("ws-c", makeEntry("same", { columnId: "backlog", lastOpenedByUserAt: NOW_MS })),
		];
		const selected = assign(entries, {
			selectedRecentTaskStageFilters: ["backlog"],
			selectedRecentProjectWorkspaceIds: ["ws-a", "ws-b"],
		});
		expect(selected.remainingSection.entries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-a"]);
		const allStages = assign(entries, { selectedRecentProjectWorkspaceIds: ["ws-a", "ws-b"] });
		expect(allStages.remainingSection.entries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-a", "ws-b"]);
		expect(assign(entries, { selectedRecentProjectWorkspaceIds: [] }).remainingSection.entries).toHaveLength(3);
	});

	it("Running 和 Cache warm 优先于阶段筛选，置顶副本保留且跨项目同号独立", () => {
		const sections = assign(
			[
				...stageEntries,
				inProject(
					"ws-b",
					makeEntry("backlog", { columnId: "backlog", lastOpenedByUserAt: NOW_MS, pinnedToTaskPinboardAt: 1 }),
				),
				inProject(
					"ws-a",
					makeEntry("running-validation", { columnId: "validation", ...AGENT_RUNNING, lastOutputAt: NOW_MS }),
				),
				inProject(
					"ws-a",
					makeEntry("running-backlog", { columnId: "backlog", ...AGENT_RUNNING, lastOutputAt: NOW_MS }),
				),
				inProject(
					"ws-a",
					makeEntry("warm-review", {
						...USER_REVIEW_EXITED,
						lastMainAgentConversationModelRequestDispatchObservation: dispatchedAt(NOW_MS),
					}),
				),
			],
			{ selectedRecentTaskStageFilters: ["backlog"] },
		);
		expect(sections.runningEntries.map(({ entry }) => entry.taskId).sort()).toEqual([
			"running-backlog",
			"running-validation",
		]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ entry }) => entry.taskId)).toEqual(["warm-review"]);
		expect(sections.pinnedEntries.map(({ entry }) => entry.taskId)).toEqual(["backlog"]);
		expect(sections.remainingSection.entries.map(({ workspaceId, entry }) => [workspaceId, entry.taskId])).toEqual([
			["ws-a", "backlog"],
			["ws-b", "backlog"],
		]);
	});
});

describe("isCrossProjectTaskSwitcherEntryRunning", () => {
	it("自动重连仍属于当前 Agent 回合，保留 Running 且不刷新排序起点", () => {
		const entry = makeEntry("retrying", {
			...AGENT_RUNNING,
			liveness: "retrying",
			agentResponseGenerationTurnStarted: turnStartedAt(NOW_MS - MINUTE_MS),
			lastOpenedByUserAt: NOW_MS,
		});
		expect(isCrossProjectTaskSwitcherEntryRunning(entry, NOW_MS)).toBe(true);
		const sections = assign([inProject("ws-a", entry)]);
		expect(sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["retrying"]);
		expect(sections.remainingSection.entries).toEqual([]);
		expect(sections.promptCacheWarmAwaitingUserEntries).toEqual([]);
		expect(sections.runningEntries[0]?.entry.agentResponseGenerationTurnStarted).toEqual(
			turnStartedAt(NOW_MS - MINUTE_MS),
		);
	});

	it("agent 回合 + 5 分钟内有输出 → Running", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(
				makeEntry("a", { ...AGENT_RUNNING, lastOutputAt: NOW_MS - 4 * MINUTE_MS }),
				NOW_MS,
			),
		).toBe(true);
	});

	it("已确认的存活 agent 回合即使长时间静默仍是 Running", () => {
		expect(
			isCrossProjectTaskSwitcherEntryRunning(
				makeEntry("a", { ...AGENT_RUNNING, lastOutputAt: NOW_MS - 5 * MINUTE_MS }),
				NOW_MS,
			),
		).toBe(true);
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

	it("真实处理推导的请求时间保留专用估计来源，沿用 measured TTL 和同进程门", () => {
		const reference = {
			observedAtMs: NOW_MS - MINUTE_MS,
			evidenceKind: "main_agent_conversation_request_processing_cache_reference_estimate" as const,
		};
		const entry = makeEntry("processed", {
			...USER_REVIEW_LIVE,
			lastAgentConversationPromptCacheReferenceObservation: reference,
		});
		expect(estimate(entry, NOW_MS)).toEqual({
			promptCacheWarmthAnchorAt: NOW_MS - MINUTE_MS,
			promptCacheWarmthAnchorSource: reference.evidenceKind,
			promptCacheExpectedExpiryAt: NOW_MS + 54 * MINUTE_MS,
		});
		expect(estimate({ ...entry, agentId: "codex", agentProcessStartedAt: NOW_MS }, NOW_MS)).toBeNull();
		expect(estimate({ ...entry, agentId: "codex", liveness: "exited" }, NOW_MS)).toBeNull();
	});

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

	it("Cursor 新输出只通过缓存专用估计投影提供参考，不使用通用活动", () => {
		const entry = makeEntry("a", {
			...USER_REVIEW_LIVE,
			agentId: "cursor",
			lastSubstantiveOutputAt: NOW_MS,
			lastAgentConversationPromptCacheReferenceObservation: {
				observedAtMs: NOW_MS - 5 * MINUTE_MS,
				evidenceKind: "cursor_agent_output_cache_reference_estimate",
			},
			lastConversationProgressObservation: progressAt(NOW_MS - MINUTE_MS),
		});
		expect(estimate(entry, NOW_MS)).toEqual({
			promptCacheWarmthAnchorAt: NOW_MS - 5 * MINUTE_MS,
			promptCacheWarmthAnchorSource: "cursor_agent_output_cache_reference_estimate",
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

	it("Done 列的 agent 回合仍优先进入 Running，并保留 Pinned 副本", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("done", { ...AGENT_RUNNING, columnId: "trash", lastOutputAt: NOW_MS, pinnedToTaskPinboardAt: 1 }),
			),
		]);
		expect(sections.pinnedEntries).toHaveLength(1);
		expect(sections.runningEntries.map(({ entry }) => entry.taskId)).toEqual(["done"]);
		expect(remainingTaskIds(sections)).toEqual([]);
	});

	// 2026-10-04 用户反馈：移入 Validation / Done 的任务即使缓存仍热，也不该留在 Cache warm，而是下放到 Recent
	// 由它的规则决定显不显示。Done 与 Validation 同样可进入 Recent；这里钉 Validation 的缓存资格。
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
						// 专用缓存参考可更新；通用活动明确保留旧值，不从兼容旧请求倒推新活动。
						lastEffectiveAgentConversationActivityObservation: {
							observedAtMs: NOW_MS - 8 * DAY_MS,
							evidenceKind: "persisted_agent_transcript",
							activityKind: "agent_output",
						},
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

	it("Conversation progress 只改变排序，没有推进记录的任务保留在末尾", () => {
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
		expect(remainingTaskIds(sections)).toEqual(["progressed", "only-opened"]);
	});

	it.each([
		["Backlog 单选", ["backlog"]],
		["阶段混选", ["backlog", "validation"]],
		["All", []],
	] as const)("%s 的无对话记录任务按 Description 更新时间倒序，不按项目或任务 ID", (_, stageFilters) => {
		const entries = [
			inProject(
				"ws-a",
				makeEntry("a-older", {
					columnId: "backlog",
					createdAt: NOW_MS,
					lastOpenedByUserAt: NOW_MS,
					taskDescriptionLastUpdatedAt: NOW_MS - 2 * DAY_MS,
				}),
			),
			inProject(
				"ws-z",
				makeEntry("z-newer", { columnId: "backlog", taskDescriptionLastUpdatedAt: NOW_MS - MINUTE_MS }),
			),
			inProject(
				"ws-a",
				makeEntry("validation", { columnId: "validation", taskDescriptionLastUpdatedAt: NOW_MS - DAY_MS }),
			),
		];
		const sections = assign(entries, {
			mode: "most_recent_conversation_progress_only",
			selectedRecentTaskStageFilters: stageFilters,
		});
		expect(remainingTaskIds(sections)).toEqual(
			stageFilters.length === 1 ? ["z-newer", "a-older"] : ["z-newer", "validation", "a-older"],
		);
	});

	it("Description 兜底不越过有对话记录的任务，也不改变相同对话时间的稳定顺序", () => {
		const sections = assign(
			[
				inProject("ws-a", makeEntry("no-progress", { taskDescriptionLastUpdatedAt: NOW_MS })),
				inProject(
					"ws-z",
					makeEntry("same-progress-newer-description", {
						lastConversationProgressObservation: progressAt(NOW_MS - DAY_MS),
						taskDescriptionLastUpdatedAt: NOW_MS,
					}),
				),
				inProject(
					"ws-a",
					makeEntry("same-progress-older-description", {
						lastConversationProgressObservation: progressAt(NOW_MS - DAY_MS),
						taskDescriptionLastUpdatedAt: NOW_MS - 2 * DAY_MS,
					}),
				),
				inProject(
					"ws-z",
					makeEntry("newest-progress", {
						lastConversationProgressObservation: progressAt(NOW_MS - MINUTE_MS),
					}),
				),
			],
			{ mode: "most_recent_conversation_progress_only" },
		);
		expect(remainingTaskIds(sections)).toEqual([
			"newest-progress",
			"same-progress-older-description",
			"same-progress-newer-description",
			"no-progress",
		]);
	});

	it("无对话记录且 Description 同时更新时，按 workspaceId 和 taskId 稳定排序", () => {
		const sameDescriptionTimestamp = { columnId: "backlog", taskDescriptionLastUpdatedAt: NOW_MS } as const;
		const sections = assign(
			[
				inProject("ws-z", makeEntry("a", sameDescriptionTimestamp)),
				inProject("ws-a", makeEntry("z", sameDescriptionTimestamp)),
				inProject("ws-a", makeEntry("a", sameDescriptionTimestamp)),
			],
			{ mode: "most_recent_conversation_progress_only", selectedRecentTaskStageFilters: ["backlog"] },
		);
		expect(
			sections.remainingSection.entries.map(({ workspaceId, entry }) => `${workspaceId}:${entry.taskId}`),
		).toEqual(["ws-a:a", "ws-a:z", "ws-z:a"]);
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
