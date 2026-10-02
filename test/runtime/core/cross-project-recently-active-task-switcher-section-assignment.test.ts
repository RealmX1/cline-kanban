import { describe, expect, it } from "vitest";
import type { RuntimeCrossProjectTaskSwitcherEntry } from "../../../src/core/api-contract";
import {
	assignCrossProjectTaskSwitcherSections,
	buildCrossProjectTaskSwitcherEntryKey,
	CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
	CROSS_PROJECT_TASK_SWITCHER_RECENTLY_OPENED_BY_USER_SUBSECTION_MAXIMUM_ENTRY_COUNT,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
	estimatePromptCacheWarmthForTaskAwaitingUser,
	isCrossProjectTaskSwitcherEntryRunning,
} from "../../../src/core/cross-project-recently-active-task-switcher-section-assignment";

// 跨项目切换面板的区归属（docs/context-cross-project-recently-active-task-switcher.md）。核心不变量：
// Running / 缓存倒计时 / 剩余三区互斥（Running 优先），Pinned 可与它们重复；区归属不读 board 列（只排除 Done）。

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

describe("estimatePromptCacheWarmthForTaskAwaitingUser", () => {
	it("Claude 用户回合：stoppedAt + 55 分钟内仍热，到点即掉出", () => {
		const entry = makeEntry("a", { ...USER_REVIEW_EXITED, agentResponseGenerationStopped: stoppedAt(NOW_MS) });
		expect(estimatePromptCacheWarmthForTaskAwaitingUser(entry, NOW_MS + 54 * MINUTE_MS)).toEqual({
			promptCacheWarmthAnchorAt: NOW_MS,
			promptCacheExpectedExpiryAt: NOW_MS + 55 * MINUTE_MS,
		});
		expect(estimatePromptCacheWarmthForTaskAwaitingUser(entry, NOW_MS + 55 * MINUTE_MS)).toBeNull();
	});

	it("Claude 的缓存在服务端：agent 进程已退出（exited）照样算热", () => {
		const entry = makeEntry("a", { ...USER_REVIEW_EXITED, agentResponseGenerationStopped: stoppedAt(NOW_MS) });
		expect(estimatePromptCacheWarmthForTaskAwaitingUser(entry, NOW_MS + MINUTE_MS)).not.toBeNull();
	});

	it("Codex / Kimi 的缓存只在同一进程内有效：进程退出即不热", () => {
		for (const agentId of ["codex", "kimi"] as const) {
			const anchor = { agentResponseGenerationStopped: stoppedAt(NOW_MS) };
			expect(
				estimatePromptCacheWarmthForTaskAwaitingUser(
					makeEntry("a", { ...USER_REVIEW_EXITED, ...anchor, agentId }),
					NOW_MS + MINUTE_MS,
				),
			).toBeNull();
			expect(
				estimatePromptCacheWarmthForTaskAwaitingUser(
					makeEntry("a", { ...USER_REVIEW_LIVE, ...anchor, agentId }),
					NOW_MS + MINUTE_MS,
				),
			).not.toBeNull();
		}
	});

	it("runtime 重启清空 stoppedAt 后回落到对话上次推进的时刻", () => {
		const entry = makeEntry("a", {
			...USER_REVIEW_EXITED,
			lastConversationProgressObservation: progressAt(NOW_MS - 10 * MINUTE_MS),
		});
		expect(estimatePromptCacheWarmthForTaskAwaitingUser(entry, NOW_MS)?.promptCacheExpectedExpiryAt).toBe(
			NOW_MS + 45 * MINUTE_MS,
		);
	});

	it("没有任何计时锚点 / 没测过 TTL 的 agent / 被中断的用户回合 → 不进倒计时区", () => {
		expect(estimatePromptCacheWarmthForTaskAwaitingUser(makeEntry("a", USER_REVIEW_EXITED), NOW_MS)).toBeNull();
		expect(
			estimatePromptCacheWarmthForTaskAwaitingUser(
				makeEntry("a", {
					...USER_REVIEW_LIVE,
					agentId: "cline",
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
				}),
				NOW_MS,
			),
		).toBeNull();
		expect(
			estimatePromptCacheWarmthForTaskAwaitingUser(
				makeEntry("a", {
					turnOwner: "user",
					liveness: "interrupted",
					userTurnKind: "interrupted",
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
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
				makeEntry("warm", { ...USER_REVIEW_EXITED, agentResponseGenerationStopped: stoppedAt(NOW_MS - MINUTE_MS) }),
			),
			inProject(
				"ws-2",
				makeEntry("cold", {
					...USER_REVIEW_EXITED,
					agentResponseGenerationStopped: stoppedAt(NOW_MS - 2 * 60 * MINUTE_MS),
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
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
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

	it("缓存倒计时区按失效时刻升序（最快失效的在最前），跨 agent TTL 也比较失效时刻", () => {
		const sections = assign([
			inProject(
				"ws-1",
				makeEntry("codex-just-stopped", {
					...USER_REVIEW_LIVE,
					agentId: "codex",
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
				}),
			),
			inProject(
				"ws-1",
				makeEntry("claude-40m-ago", {
					...USER_REVIEW_EXITED,
					agentResponseGenerationStopped: stoppedAt(NOW_MS - 40 * MINUTE_MS),
				}),
			),
			inProject(
				"ws-2",
				makeEntry("kimi-just-stopped", {
					...USER_REVIEW_LIVE,
					agentId: "kimi",
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
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
				makeEntry("same-id", { ...USER_REVIEW_EXITED, agentResponseGenerationStopped: stoppedAt(NOW_MS) }),
			),
		]);
		expect(sections.runningEntries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-1"]);
		expect(sections.promptCacheWarmAwaitingUserEntries.map(({ workspaceId }) => workspaceId)).toEqual(["ws-2"]);
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
					agentResponseGenerationStopped: stoppedAt(NOW_MS),
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
