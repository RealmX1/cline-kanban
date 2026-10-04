import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runGit } from "./git-utils";

// 「从未观察到 task commit、baseRef..HEAD 为空、HEAD 已离开创建点」时，单凭拓扑分不清
// 「task commits 已 handback 进 base」与「worktree 只是 fast-forward 吸收了 base」。
// worktree 自己的 HEAD reflog 是唯一能区分二者的持久证据：只要从创建那一刻起 HEAD 的每一步
// 都是 fast-forward 合并，就证明这个 worktree 从未产生过自己的提交，回流计数可以如实为 0。
// 证据有任何缺口（reflog 缺失/截断/断链、出现 commit/reset/checkout/rebase/非 FF merge）一律不成立。

interface TaskWorktreeHeadReflogEntry {
	previousHeadCommit: string;
	nextHeadCommit: string;
	reflogMessage: string;
}

// 只认 git 自己写出的 fast-forward 形态：`merge <ref|sha>: Fast-forward`、`pull[ <args>]: Fast-forward`。
const FAST_FORWARD_REFLOG_MESSAGE_PATTERN = /^(?:merge [^\s:]+|pull(?: [^:]*)?): Fast-forward$/;
const ALL_ZERO_OBJECT_ID_PATTERN = /^0+$/;

function parseTaskWorktreeHeadReflogEntries(rawHeadReflog: string): TaskWorktreeHeadReflogEntry[] | null {
	const entries: TaskWorktreeHeadReflogEntry[] = [];
	for (const line of rawHeadReflog.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		const tabIndex = line.indexOf("\t");
		const header = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
		const reflogMessage = tabIndex >= 0 ? line.slice(tabIndex + 1).trim() : "";
		const [previousHeadCommit, nextHeadCommit] = header.split(" ");
		if (!previousHeadCommit || !nextHeadCommit) {
			return null;
		}
		entries.push({ previousHeadCommit, nextHeadCommit, reflogMessage });
	}
	return entries;
}

/**
 * 纯函数部分：按时间正序的原始 reflog 必须满足
 * 首条 = 从零对象创建到 `initialBaseCommit`；其后每条首尾相接且都是 fast-forward；终点 = `headCommit`。
 * 返回需要再做祖先校验的 (previous, next) 步骤；不成立返回 null。
 */
export function extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog(input: {
	rawHeadReflog: string;
	initialBaseCommit: string;
	headCommit: string;
}): Array<{ previousHeadCommit: string; nextHeadCommit: string }> | null {
	const entries = parseTaskWorktreeHeadReflogEntries(input.rawHeadReflog);
	const creationEntry = entries?.[0];
	if (
		!entries ||
		!creationEntry ||
		!ALL_ZERO_OBJECT_ID_PATTERN.test(creationEntry.previousHeadCommit) ||
		creationEntry.nextHeadCommit !== input.initialBaseCommit
	) {
		return null;
	}
	const fastForwardSteps: Array<{ previousHeadCommit: string; nextHeadCommit: string }> = [];
	let currentHeadCommit = creationEntry.nextHeadCommit;
	for (const entry of entries.slice(1)) {
		if (
			entry.previousHeadCommit !== currentHeadCommit ||
			!FAST_FORWARD_REFLOG_MESSAGE_PATTERN.test(entry.reflogMessage)
		) {
			return null;
		}
		fastForwardSteps.push({ previousHeadCommit: entry.previousHeadCommit, nextHeadCommit: entry.nextHeadCommit });
		currentHeadCommit = entry.nextHeadCommit;
	}
	return currentHeadCommit === input.headCommit ? fastForwardSteps : null;
}

/**
 * 证明 task worktree 自创建以来 HEAD 只被 fast-forward 吸收推进过（从未有过自己的提交）。
 * 终点必须等于本次探测到的 HEAD，因此探测后 HEAD 并发变化会自然判为不成立。
 */
export async function proveTaskWorktreeHeadMovedOnlyByFastForwardSinceCreation(input: {
	worktreePath: string;
	initialBaseCommit: string;
	headCommit: string;
}): Promise<boolean> {
	const headReflogPathResult = await runGit(input.worktreePath, ["rev-parse", "--git-path", "logs/HEAD"]);
	if (!headReflogPathResult.ok || !headReflogPathResult.stdout) {
		return false;
	}
	let rawHeadReflog: string;
	try {
		rawHeadReflog = await readFile(resolve(input.worktreePath, headReflogPathResult.stdout), "utf8");
	} catch {
		return false;
	}
	const fastForwardSteps = extractFastForwardOnlyStepsFromTaskWorktreeHeadReflog({
		rawHeadReflog,
		initialBaseCommit: input.initialBaseCommit,
		headCommit: input.headCommit,
	});
	if (fastForwardSteps === null) {
		return false;
	}
	// reflog message 可被 `update-ref -m` 伪造；逐步复核祖先关系，保证每一步确实只是前进。
	for (const step of fastForwardSteps) {
		const ancestryResult = await runGit(input.worktreePath, [
			"merge-base",
			"--is-ancestor",
			step.previousHeadCommit,
			step.nextHeadCommit,
		]);
		if (!ancestryResult.ok) {
			return false;
		}
	}
	return true;
}
