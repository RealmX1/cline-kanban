import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardCard,
	type RuntimeBoardColumnId,
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	runtimeAllProjectsTaskSearchIndexResponseSchema,
} from "../../../src/core/api-contract";
import {
	type AllProjectsTaskSearchIndexProjectInput,
	overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId,
	projectAllProjectsTaskSearchIndex,
} from "../../../src/server/all-projects-task-search-index-projection";

// 跨项目任务搜索索引的纯投影。不变量：board=null 的项目整体跳过；遍历全部列（含 trash/Done）逐卡输出
// 匹配字段（taskId / title / prompt / columnId）加结果行排序展示所需的卡片级持久事实
// （createdAt / updatedAt / agentId / mostRecentlyLaunchedAgentSessionAgentId）与按 taskId 查到的对话推进时刻；
// title 缺省归一空串、两个 agent 字段与查不到的推进时刻缺省归一 null。纯函数测试，不启动 SDK host。

const NO_AGENT_CONVERSATION_PROGRESS_OBSERVED_AT_BY_TASK_ID: ReadonlyMap<string, number> = new Map();

/** 不关心推进时刻的用例统一用它补上空表，让输入字面量只写各自真正在测的字段。 */
function projectWithoutAgentConversationProgress(
	projects: ReadonlyArray<Omit<AllProjectsTaskSearchIndexProjectInput, "agentConversationProgressObservedAtByTaskId">>,
) {
	return projectAllProjectsTaskSearchIndex(
		projects.map((project) => ({
			...project,
			agentConversationProgressObservedAtByTaskId: NO_AGENT_CONVERSATION_PROGRESS_OBSERVED_AT_BY_TASK_ID,
		})),
	);
}

function makeCard(overrides: Partial<RuntimeBoardCard> & { id: string }): RuntimeBoardCard {
	return {
		title: overrides.id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeBoard(columnToCards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const allColumns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: allColumns.map((id) => ({ id, title: id, cards: columnToCards[id] ?? [] })),
		dependencies: [],
	};
}

describe("projectAllProjectsTaskSearchIndex", () => {
	it("flattens tasks across projects, preserving project identity and column ownership", () => {
		const response = projectWithoutAgentConversationProgress([
			{
				projectId: "p1",
				projectName: "One",
				board: makeBoard({
					backlog: [makeCard({ id: "a", title: "Alpha", prompt: "first" })],
					review: [makeCard({ id: "b", title: "Beta", prompt: "second" })],
				}),
			},
			{
				projectId: "p2",
				projectName: "Two",
				board: makeBoard({ backlog: [makeCard({ id: "c", title: "Gamma", prompt: "third" })] }),
			},
		]);

		expect(response.projects).toHaveLength(2);
		expect(response.projects[0]).toEqual({
			projectId: "p1",
			projectName: "One",
			tasks: [
				{
					taskId: "a",
					title: "Alpha",
					prompt: "first",
					columnId: "backlog",
					createdAt: 0,
					updatedAt: 0,
					agentId: null,
					mostRecentlyLaunchedAgentSessionAgentId: null,
					agentConversationProgressObservedAt: null,
				},
				{
					taskId: "b",
					title: "Beta",
					prompt: "second",
					columnId: "review",
					createdAt: 0,
					updatedAt: 0,
					agentId: null,
					mostRecentlyLaunchedAgentSessionAgentId: null,
					agentConversationProgressObservedAt: null,
				},
			],
		});
		expect(response.projects[1]?.tasks.map((task) => task.taskId)).toEqual(["c"]);
	});

	it("skips projects whose board failed to load (null)", () => {
		const response = projectWithoutAgentConversationProgress([
			{ projectId: "ok", projectName: "OK", board: makeBoard({ backlog: [makeCard({ id: "a" })] }) },
			{ projectId: "broken", projectName: "Broken", board: null },
		]);

		expect(response.projects.map((project) => project.projectId)).toEqual(["ok"]);
	});

	it("includes tasks from the trash (Done) column", () => {
		const response = projectWithoutAgentConversationProgress([
			{
				projectId: "p",
				projectName: "P",
				board: makeBoard({ trash: [makeCard({ id: "d", title: "Done task", prompt: "archived" })] }),
			},
		]);

		expect(response.projects[0]?.tasks).toEqual([
			{
				taskId: "d",
				title: "Done task",
				prompt: "archived",
				columnId: "trash",
				createdAt: 0,
				updatedAt: 0,
				agentId: null,
				mostRecentlyLaunchedAgentSessionAgentId: null,
				agentConversationProgressObservedAt: null,
			},
		]);
	});

	it("defaults a missing title to an empty string", () => {
		const response = projectWithoutAgentConversationProgress([
			{
				projectId: "p",
				projectName: "P",
				board: makeBoard({ backlog: [makeCard({ id: "a", title: undefined, prompt: "body" })] }),
			},
		]);

		expect(response.projects[0]?.tasks[0]?.title).toBe("");
	});

	it("carries the card-level timestamps and both agent attribution fields verbatim", () => {
		const response = projectWithoutAgentConversationProgress([
			{
				projectId: "p",
				projectName: "P",
				board: makeBoard({
					in_progress: [
						makeCard({
							id: "a",
							createdAt: 1_000,
							updatedAt: 2_000,
							agentId: "codex",
							mostRecentlyLaunchedAgentSessionAgentId: "claude",
						}),
					],
				}),
			},
		]);

		expect(response.projects[0]?.tasks[0]).toMatchObject({
			createdAt: 1_000,
			updatedAt: 2_000,
			agentId: "codex",
			mostRecentlyLaunchedAgentSessionAgentId: "claude",
		});
	});

	// 契约把两个 agent 字段声明为 nullable 而非 optional：卡片上缺省时必须归一为 null，
	// 否则 zod 校验会在「字段不存在」上直接拒掉整个响应。
	it("normalizes both absent agent attribution fields to null", () => {
		const response = projectWithoutAgentConversationProgress([
			{ projectId: "p", projectName: "P", board: makeBoard({ backlog: [makeCard({ id: "a" })] }) },
		]);

		expect(response.projects[0]?.tasks[0]?.agentId).toBeNull();
		expect(response.projects[0]?.tasks[0]?.mostRecentlyLaunchedAgentSessionAgentId).toBeNull();
	});

	it("looks up each card's agent conversation progress by task id within its own project", () => {
		// taskId 只在单个 board 内唯一：同一个 id 在两个项目里必须各取各的推进时刻。
		const response = projectAllProjectsTaskSearchIndex([
			{
				projectId: "p1",
				projectName: "One",
				board: makeBoard({ backlog: [makeCard({ id: "same" }), makeCard({ id: "never-ran" })] }),
				agentConversationProgressObservedAtByTaskId: new Map([["same", 1_111]]),
			},
			{
				projectId: "p2",
				projectName: "Two",
				board: makeBoard({ backlog: [makeCard({ id: "same" })] }),
				agentConversationProgressObservedAtByTaskId: new Map([["same", 2_222]]),
			},
		]);

		expect(
			response.projects.map((project) =>
				project.tasks.map((task) => [task.taskId, task.agentConversationProgressObservedAt]),
			),
		).toEqual([
			[
				["same", 1_111],
				["never-ran", null],
			],
			[["same", 2_222]],
		]);
	});
});

describe("overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId", () => {
	/** 已启动过的真实摘要（带 agentId / startedAt，不会被当成未启动空壳）；只填本测试关心的字段。 */
	function startedLiveSummary(taskId: string, observedAtMs: number | null): RuntimeTaskSessionSummary {
		return {
			taskId,
			state: "awaiting_review",
			agentId: "claude",
			startedAt: 1,
			lastConversationProgressObservation:
				observedAtMs === null ? null : { observedAtMs, evidenceKind: "agent_lifecycle_hook_event" },
		} as unknown as RuntimeTaskSessionSummary;
	}

	/** 前端聚焦卡片时 `ensureEntry` 就地造出的全 null 占位（createDefaultSummary 的形状）。 */
	function neverStartedPlaceholderLiveSummary(taskId: string): RuntimeTaskSessionSummary {
		return {
			taskId,
			state: "idle",
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			lastHookAt: null,
			exitCode: null,
			latestTurnCheckpoint: null,
			lastConversationProgressObservation: null,
		} as unknown as RuntimeTaskSessionSummary;
	}

	it("lets the live summary win over the persisted instant even when the live one is earlier", () => {
		// 非 agent 回合里持久转录会把低置信 TUI 猜测往回纠；落盘前盘上仍是纠偏前的更晚值，取 max 会把它捡回来。
		const overlaid = overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId({
			persistedAgentConversationProgressObservedAtByTaskId: new Map([
				["live-is-newer", 100],
				["live-corrected-earlier", 2_000],
				["persisted-only", 500],
			]),
			liveRuntimeSessionSummaries: [
				startedLiveSummary("live-is-newer", 300),
				startedLiveSummary("live-corrected-earlier", 1_000),
				startedLiveSummary("live-only", 700),
			],
		});

		expect(Object.fromEntries(overlaid)).toEqual({
			"live-is-newer": 300,
			"live-corrected-earlier": 1_000,
			"persisted-only": 500,
			"live-only": 700,
		});
	});

	it("drops the persisted instant once the live summary no longer carries one", () => {
		// Cline / ACP 重建摘要、清空会话都是整条替换且不带该字段：下一次落盘后盘上也会是无值，这里提前一致。
		const overlaid = overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId({
			persistedAgentConversationProgressObservedAtByTaskId: new Map([["cleared-in-memory", 900]]),
			liveRuntimeSessionSummaries: [startedLiveSummary("cleared-in-memory", null)],
		});

		expect(overlaid.has("cleared-in-memory")).toBe(false);
	});

	it("keeps the persisted instant when the live summary is only a never-started placeholder", () => {
		// 占位携带的信息严格少于任何真实记录，与看板快照 / 落盘两处守卫同一口径：不得让它抹掉盘上的真实值。
		const overlaid = overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId({
			persistedAgentConversationProgressObservedAtByTaskId: new Map([["focused-but-never-started", 900]]),
			liveRuntimeSessionSummaries: [
				neverStartedPlaceholderLiveSummary("focused-but-never-started"),
				neverStartedPlaceholderLiveSummary("placeholder-without-persisted-value"),
			],
		});

		expect(Object.fromEntries(overlaid)).toEqual({ "focused-but-never-started": 900 });
	});

	it("does not mutate the persisted map it was given", () => {
		const persisted = new Map([
			["overwritten", 100],
			["cleared", 200],
		]);

		overlayLiveRuntimeSessionSummariesOntoPersistedAgentConversationProgressObservedAtByTaskId({
			persistedAgentConversationProgressObservedAtByTaskId: persisted,
			liveRuntimeSessionSummaries: [startedLiveSummary("overwritten", 300), startedLiveSummary("cleared", null)],
		});

		expect(Object.fromEntries(persisted)).toEqual({ overwritten: 100, cleared: 200 });
	});
});

describe("runtimeAllProjectsTaskSearchIndexResponseSchema", () => {
	it("accepts a valid response and normalizes the legacy 'done' column id to 'trash'", () => {
		const parsed = runtimeAllProjectsTaskSearchIndexResponseSchema.parse({
			projects: [
				{
					projectId: "p",
					projectName: "P",
					tasks: [
						{
							taskId: "a",
							title: "Alpha",
							prompt: "body",
							columnId: "done",
							createdAt: 0,
							updatedAt: 0,
							agentId: null,
							mostRecentlyLaunchedAgentSessionAgentId: null,
							agentConversationProgressObservedAt: null,
						},
					],
				},
			],
		});

		expect(parsed.projects[0]?.tasks[0]?.columnId).toBe("trash");
	});
});
