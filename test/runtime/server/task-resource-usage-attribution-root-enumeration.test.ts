import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	enumerateTaskResourceUsageAttributionRoots,
	type TaskResourceUsageAttributionSessionSource,
} from "../../../src/server/task-resource-usage-attribution-root-enumeration";

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "ab12c",
		state: "running",
		agentId: "claude",
		workspacePath: "/Users/u/.cline/worktrees/ab12c/repo",
		pid: 1000,
		startedAt: 1_790_000_000_000,
		updatedAt: 1_790_000_000_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function source(
	workspaceId: string,
	summaries: RuntimeTaskSessionSummary[],
): TaskResourceUsageAttributionSessionSource {
	return { workspaceId, workspacePath: `/Users/u/${workspaceId}`, listSummaries: () => summaries };
}

describe("enumerateTaskResourceUsageAttributionRoots", () => {
	it("turns every live terminal session into an attribution root with its category and owning card", () => {
		const { roots } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [
				source("repo", [
					makeSummary({ taskId: "ab12c", pid: 1000, runtimeSessionIncarnationId: "inc-1" }),
					makeSummary({ taskId: "__home_agent__:repo:claude", pid: 1001, workspacePath: "/Users/u/repo" }),
					makeSummary({ taskId: "__detail_terminal__:ab12c", pid: 1002, agentId: null }),
					makeSummary({ taskId: "__home_terminal__", pid: 1003, agentId: null, workspacePath: "/Users/u/repo" }),
				]),
			],
			listClineSessionSources: () => [],
			listAcpSessionSources: () => [],
		});

		expect(
			roots.map((root) => [
				root.rootProcessId,
				root.sessionCategory,
				root.attributedTaskCardId,
				root.rootProcessRole,
			]),
		).toEqual([
			[1000, "task_card_main_agent_session", "ab12c", "agent_harness_root"],
			[1001, "workspace_home_sidebar_agent_session", null, "agent_harness_root"],
			[1002, "task_card_detail_user_shell_terminal_session", "ab12c", "user_shell_terminal_root"],
			[1003, "workspace_home_user_shell_terminal_session", null, "user_shell_terminal_root"],
		]);
		expect(roots[0]).toMatchObject({
			workspaceId: "repo",
			sessionTaskId: "ab12c",
			sessionTransport: "pty_terminal",
			agentId: "claude",
			runtimeSessionIncarnationId: "inc-1",
			rootSessionStartedAtEpochMs: 1_790_000_000_000,
		});
	});

	it("attributes a by-the-way side conversation to the card it hangs off, not to its own session id", () => {
		const { roots } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [
				source("repo", [
					makeSummary({
						taskId: "btw-77",
						pid: 2000,
						taskConversationSessionMetadata: {
							workspaceTaskId: "ab12c",
							taskConversationSessionRole: "by_the_way",
							taskConversationSessionContextSource: "started_from_scratch",
							parentTaskConversationSessionId: null,
							mainSessionOriginTurnNumber: null,
							mainSessionOriginUserMessagePreview: null,
							latestUserMessagePreview: null,
						},
					}),
				]),
			],
			listClineSessionSources: () => [],
			listAcpSessionSources: () => [],
		});

		expect(roots[0]).toMatchObject({
			sessionCategory: "task_card_side_conversation_agent_session",
			attributedTaskCardId: "ab12c",
		});
	});

	it("skips sessions without a live pid, which covers every in-process Cline SDK session", () => {
		const { roots } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [source("repo", [makeSummary({ pid: null })])],
			listClineSessionSources: () => [
				source("repo", [makeSummary({ taskId: "cc111", pid: null, agentId: "cline" })]),
			],
			listAcpSessionSources: () => [],
		});

		expect(roots).toEqual([]);
	});

	it("keeps both roots when the same task id shows up under two transports instead of letting one swallow the other", () => {
		// listProjectRuntimeSessionSummaries 按 taskId 合并时后写覆盖先写，会把 PTY 的 pid 吞掉。
		const { roots } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [
				source("repo", [makeSummary({ taskId: "om001", pid: 3000, agentId: "omp" })]),
			],
			listClineSessionSources: () => [],
			listAcpSessionSources: () => [
				source("repo", [
					makeSummary({ taskId: "om001", pid: 3001, agentId: "omp", sessionTransport: "acp_stdio_subprocess" }),
				]),
			],
		});

		expect(roots.map((root) => [root.rootProcessId, root.sessionTransport])).toEqual([
			[3000, "pty_terminal"],
			[3001, "acp_stdio_subprocess"],
		]);
	});

	it("maps each task working directory to its card so Kanban-spawned processes can be attributed by cwd", () => {
		const { taskWorkingDirectoryAttributions } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [],
			listClineSessionSources: () => [
				source("repo", [
					makeSummary({
						taskId: "cc111",
						pid: null,
						agentId: "cline",
						workspacePath: "/Users/u/.cline/worktrees/cc111/repo",
					}),
				]),
			],
			listAcpSessionSources: () => [],
		});

		expect(taskWorkingDirectoryAttributions).toEqual([
			{
				workspaceId: "repo",
				workingDirectoryPath: "/Users/u/.cline/worktrees/cc111/repo",
				attributedTaskCardId: "cc111",
				latestSessionUpdatedAtEpochMs: 1_790_000_000_000,
			},
		]);
	});

	it("refuses to pick a card for a working directory that several inplace tasks share", () => {
		const { taskWorkingDirectoryAttributions } = enumerateTaskResourceUsageAttributionRoots({
			listTerminalSessionSources: () => [
				source("repo", [
					makeSummary({ taskId: "aa111", workspacePath: "/Users/u/repo" }),
					makeSummary({ taskId: "bb222", workspacePath: "/Users/u/repo" }),
				]),
			],
			listClineSessionSources: () => [],
			listAcpSessionSources: () => [],
		});

		expect(taskWorkingDirectoryAttributions).toEqual([
			{
				workspaceId: "repo",
				workingDirectoryPath: "/Users/u/repo",
				attributedTaskCardId: null,
				latestSessionUpdatedAtEpochMs: 1_790_000_000_000,
			},
		]);
	});
});
