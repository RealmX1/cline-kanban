import { describe, expect, it } from "vitest";
import { buildAllProjectsTaskGroupQueryResult } from "../../../src/core/all-projects-task-group-query";
import type {
	RuntimeAllProjectsTaskGroupQuerySnapshot,
	RuntimeCrossProjectTaskSwitcherEntry,
} from "../../../src/core/api-contract";

const observedAtMs = 10_000_000_000;
const dayMs = 24 * 60 * 60_000;

function entry(
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
		turnOwner: null,
		liveness: "none",
		userTurnKind: null,
		columnId: "review",
		isParkedAwaitingDispatchedBackgroundWork: false,
		taskDescriptionLastUpdatedAt: observedAtMs,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		...overrides,
	};
}

function snapshot(entries: RuntimeCrossProjectTaskSwitcherEntry[]): RuntimeAllProjectsTaskGroupQuerySnapshot {
	return {
		observedAtMs,
		recentDays: 7,
		projects: [
			{
				workspaceId: "project-a",
				projectName: "项目甲",
				projectPath: "/project-a",
				taskEntriesReadStatus: "complete",
				crossProjectTaskSwitcherEntries: entries,
			},
		],
	};
}

describe("全项目分组查询", () => {
	it("复用 Running 的回合、retrying 与 park 判据，不按看板列推测；排序不跟随输出", () => {
		const input = snapshot([
			entry("later", {
				turnOwner: "agent",
				liveness: "live",
				columnId: "validation",
				agentProcessStartedAt: 20,
				lastOutputAt: observedAtMs,
			}),
			entry("retrying", { turnOwner: "agent", liveness: "retrying", agentProcessStartedAt: 10 }),
			entry("parked", {
				turnOwner: "agent",
				isParkedAwaitingDispatchedBackgroundWork: true,
				agentProcessStartedAt: 5,
			}),
			entry("question", { turnOwner: "user", liveness: "live", userTurnKind: "question", columnId: "in_progress" }),
		]);
		expect(
			buildAllProjectsTaskGroupQueryResult(input, { group: "running" }).groups[0].tasks.map((row) => row.taskId),
		).toEqual(["parked", "retrying", "later"]);
	});

	it("Pinned 可重复归组，去重计数保留跨项目同号身份", () => {
		const input = snapshot([entry("same", { turnOwner: "agent", liveness: "live", pinnedToTaskPinboardAt: 1 })]);
		input.projects.push({ ...input.projects[0], workspaceId: "project-b", projectPath: "/project-b" });
		const result = buildAllProjectsTaskGroupQueryResult(input, {});
		expect(result.groups.map((group) => group.tasks.length)).toEqual([2, 2, 0, 0, 0]);
		expect(result.count).toBe(2);
		expect(result.groups[1].tasks.map((row) => row.workspaceId)).toEqual(["project-a", "project-b"]);
	});

	it("按 ID 与标题做字面匹配；Recent 含 Done，7/30 天范围与共享排序一致", () => {
		const input = snapshot([
			entry("name-id", { title: "测试 [CLI]", columnId: "trash" }),
			entry("older", { taskDescriptionLastUpdatedAt: observedAtMs - 8 * dayMs }),
		]);
		expect(buildAllProjectsTaskGroupQueryResult(input, { query: "[cli]", column: "trash" }).count).toBe(1);
		expect(buildAllProjectsTaskGroupQueryResult(input, { query: "NAME-ID" }).count).toBe(1);
		expect(buildAllProjectsTaskGroupQueryResult(input, { group: "recent" }).count).toBe(1);
		expect(
			buildAllProjectsTaskGroupQueryResult({ ...input, recentDays: 30 }, { group: "recent" }).groups[0].tasks.map(
				(row) => row.taskId,
			),
		).toEqual(["name-id", "older"]);
	});

	it("缓存到期进入 Recent；部分项目不可读时保留可读结果但不得宣告完整", () => {
		const input = snapshot([
			entry("warm", {
				turnOwner: "user",
				liveness: "live",
				userTurnKind: "review",
				lastMainAgentConversationModelRequestDispatchObservation: {
					observedAtMs: observedAtMs - 1_000,
					evidenceKind: "post_tool_use_hook_event",
				},
			}),
		]);
		expect(buildAllProjectsTaskGroupQueryResult(input, { group: "cache_warm_awaiting_user" }).count).toBe(1);
		expect(
			buildAllProjectsTaskGroupQueryResult(
				{ ...input, observedAtMs: observedAtMs + dayMs },
				{ group: "cache_warm_awaiting_user" },
			).count,
		).toBe(0);
		input.projects.push({
			workspaceId: "unreadable",
			projectName: "不可读",
			projectPath: "/unreadable",
			taskEntriesReadStatus: "unavailable",
			unavailableReason: "读取失败",
			crossProjectTaskSwitcherEntries: [],
		});
		const result = buildAllProjectsTaskGroupQueryResult(input, {});
		expect(result.ok).toBe(false);
		expect(result.coverage.status).toBe("incomplete");
		expect(result.count).toBe(1);
	});
});
