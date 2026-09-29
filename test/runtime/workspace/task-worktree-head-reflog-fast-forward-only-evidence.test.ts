import { describe, expect, it } from "vitest";

import { extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog } from "../../../src/workspace/task-worktree-head-reflog-fast-forward-only-evidence";

const ZERO = "0".repeat(40);
const CREATION = "a".repeat(40);
const BASE_ONE = "b".repeat(40);
const BASE_TWO = "c".repeat(40);
const TASK_COMMIT = "d".repeat(40);
const IDENTITY = "Test <test@example.com> 1790000000 +0800";

function reflogLine(previous: string, next: string, message?: string): string {
	return message === undefined ? `${previous} ${next} ${IDENTITY}` : `${previous} ${next} ${IDENTITY}\t${message}`;
}

describe("extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog", () => {
	it("创建后只有 fast-forward（merge <sha> / merge main / pull）时返回全部步骤", () => {
		const rawHeadReflog = [
			reflogLine(ZERO, CREATION),
			reflogLine(CREATION, BASE_ONE, `merge ${BASE_ONE}: Fast-forward`),
			reflogLine(BASE_ONE, BASE_TWO, "merge main: Fast-forward"),
			"",
		].join("\n");
		expect(
			extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog({
				rawHeadReflog,
				initialBaseCommit: CREATION,
				headCommit: BASE_TWO,
			}),
		).toEqual([
			{ previousHeadCommit: CREATION, nextHeadCommit: BASE_ONE },
			{ previousHeadCommit: BASE_ONE, nextHeadCommit: BASE_TWO },
		]);
		expect(
			extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog({
				rawHeadReflog: [reflogLine(ZERO, CREATION), reflogLine(CREATION, BASE_ONE, "pull: Fast-forward")].join(
					"\n",
				),
				initialBaseCommit: CREATION,
				headCommit: BASE_ONE,
			}),
		).toHaveLength(1);
	});

	it.each([
		[
			"出现过 task commit（即便随后被 handback 再 FF）",
			[
				reflogLine(ZERO, CREATION),
				reflogLine(CREATION, TASK_COMMIT, "commit: task change"),
				reflogLine(TASK_COMMIT, BASE_ONE, `merge ${BASE_ONE}: Fast-forward`),
			],
		],
		[
			"出现非 fast-forward 的 merge",
			[reflogLine(ZERO, CREATION), reflogLine(CREATION, BASE_ONE, "merge main: Merge made by the 'ort' strategy.")],
		],
		["出现 reset / checkout", [reflogLine(ZERO, CREATION), reflogLine(CREATION, BASE_ONE, "reset: moving to main")]],
		["reflog 被截断（首条不是从零对象创建）", [reflogLine(CREATION, BASE_ONE, "merge main: Fast-forward")]],
		["链条断开", [reflogLine(ZERO, CREATION), reflogLine(BASE_TWO, BASE_ONE, "merge main: Fast-forward")]],
		[
			"创建点与 provenance 锚点不一致（例如恢复 patch 时从旧 task HEAD 起步）",
			[reflogLine(ZERO, TASK_COMMIT), reflogLine(TASK_COMMIT, BASE_ONE, "merge main: Fast-forward")],
		],
		[
			"终点不是本次探测到的 HEAD（探测后 HEAD 并发变化）",
			[reflogLine(ZERO, CREATION), reflogLine(CREATION, BASE_TWO, "merge main: Fast-forward")],
		],
		["reflog 为空", []],
	])("%s 时不成立", (_caseName, lines) => {
		expect(
			extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog({
				rawHeadReflog: lines.join("\n"),
				initialBaseCommit: CREATION,
				headCommit: BASE_ONE,
			}),
		).toBeNull();
	});
});
