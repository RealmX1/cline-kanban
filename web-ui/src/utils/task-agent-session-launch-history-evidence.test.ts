import { describe, expect, it } from "vitest";

import { resolveTaskAgentSessionLaunchHistoryEvidence } from "@/utils/task-agent-session-launch-history-evidence";

describe("resolveTaskAgentSessionLaunchHistoryEvidence", () => {
	it("trusts the card's recorded launch over everything else", () => {
		expect(
			resolveTaskAgentSessionLaunchHistoryEvidence({
				mostRecentlyLaunchedAgentSessionAgentId: "claude",
				taskWorktreeExists: false,
			}),
		).toBe("launched_before");
	});

	it("treats a missing task worktree as positive evidence that no agent ever ran", () => {
		expect(
			resolveTaskAgentSessionLaunchHistoryEvidence({
				mostRecentlyLaunchedAgentSessionAgentId: undefined,
				taskWorktreeExists: false,
			}),
		).toBe("never_launched");
	});

	it.each([true, null, undefined])(
		"does not collapse a missing launch record into never-launched when worktree existence is %s",
		(taskWorktreeExists) => {
			// 字段 2026-08-13 才引入、写卡失败会被吞：缺失只表示不知道。
			expect(
				resolveTaskAgentSessionLaunchHistoryEvidence({
					mostRecentlyLaunchedAgentSessionAgentId: undefined,
					taskWorktreeExists,
				}),
			).toBe("launch_history_unknown");
		},
	);
});
