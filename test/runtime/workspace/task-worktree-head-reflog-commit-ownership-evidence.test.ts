import { describe, expect, it } from "vitest";

import { readContinuousTaskHeadReflogFromCreation } from "../../../src/workspace/task-worktree-head-reflog-commit-ownership-evidence";

const ZERO = "0".repeat(40);
const CREATION = "a".repeat(40);
const BASE_ONE = "b".repeat(40);
const BASE_TWO = "c".repeat(40);
const TASK_COMMIT = "d".repeat(40);
const IDENTITY = "Test <test@example.com> 1790000000 +0800";

function reflogLine(previous: string, next: string, message?: string): string {
	return message === undefined ? `${previous} ${next} ${IDENTITY}` : `${previous} ${next} ${IDENTITY}\t${message}`;
}

describe("readContinuousTaskHeadReflogFromCreation", () => {
	it("读取与任务创建锚点和观测 HEAD 一致的连续记录", () => {
		const rawHeadReflog = [
			reflogLine(ZERO, CREATION),
			reflogLine(CREATION, BASE_ONE, "commit: 任务提交"),
			reflogLine(BASE_ONE, BASE_TWO, "merge main: Fast-forward"),
			"",
		].join("\n");
		expect(
			readContinuousTaskHeadReflogFromCreation({
				rawHeadReflog,
				initialBaseCommit: CREATION,
				headCommit: BASE_TWO,
			}),
		).toEqual([
			{ previousHeadCommit: CREATION, nextHeadCommit: BASE_ONE, reflogMessage: "commit: 任务提交" },
			{ previousHeadCommit: BASE_ONE, nextHeadCommit: BASE_TWO, reflogMessage: "merge main: Fast-forward" },
		]);
	});

	it.each([
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
			readContinuousTaskHeadReflogFromCreation({
				rawHeadReflog: [...lines, ""].join("\n"),
				initialBaseCommit: CREATION,
				headCommit: BASE_ONE,
			}),
		).toBeNull();
	});
});
