import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runGit } from "./git-utils";

interface TaskWorktreeHeadReflogEntry {
	previousHeadCommit: string;
	nextHeadCommit: string;
	reflogMessage: string;
}

// 只认 git 自己写出的 fast-forward 形态：`merge <ref|sha>: Fast-forward`、`pull[ <args>]: Fast-forward`。
const FAST_FORWARD_REFLOG_MESSAGE_PATTERN = /^(?:merge [^\s:]+|pull(?: [^:]*)?): Fast-forward$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAXIMUM_TASK_HEAD_REFLOG_BYTES = 1024 * 1024;
const MAXIMUM_TASK_HEAD_REFLOG_ENTRIES = 1024;

export function readContinuousTaskHeadReflogFromCreation(input: {
	rawHeadReflog: string;
	initialBaseCommit: string;
	headCommit: string;
}): TaskWorktreeHeadReflogEntry[] | null {
	if (!input.rawHeadReflog.endsWith("\n")) return null;
	const entries: TaskWorktreeHeadReflogEntry[] = [];
	for (const line of input.rawHeadReflog.slice(0, -1).split("\n")) {
		const tabIndex = line.indexOf("\t");
		const header = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
		const reflogMessage = tabIndex >= 0 ? line.slice(tabIndex + 1).trim() : "";
		const [previousHeadCommit, nextHeadCommit] = header.split(" ");
		if (
			!previousHeadCommit ||
			!nextHeadCommit ||
			previousHeadCommit.length !== input.initialBaseCommit.length ||
			nextHeadCommit.length !== input.initialBaseCommit.length ||
			!GIT_OBJECT_ID_PATTERN.test(previousHeadCommit) ||
			!GIT_OBJECT_ID_PATTERN.test(nextHeadCommit)
		) {
			return null;
		}
		entries.push({ previousHeadCommit, nextHeadCommit, reflogMessage });
	}
	const creationEntry = entries.shift();
	if (
		!creationEntry ||
		!/^0+$/.test(creationEntry.previousHeadCommit) ||
		creationEntry.nextHeadCommit !== input.initialBaseCommit
	) {
		return null;
	}
	let currentHeadCommit = creationEntry.nextHeadCommit;
	for (const entry of entries) {
		if (entry.previousHeadCommit !== currentHeadCommit) return null;
		currentHeadCommit = entry.nextHeadCommit;
	}
	return currentHeadCommit === input.headCommit ? entries : null;
}

// reflog 的动作描述必须与 Git 对象的拓扑吻合，否则不能用它补证。
export async function recoverTaskCreatedCommitShasFromHeadReflog(input: {
	worktreePath: string;
	initialBaseCommit: string;
	headCommit: string;
	baseTipCommit: string;
	isDetached: boolean;
}): Promise<Set<string> | null> {
	const headReflogPathResult = await runGit(input.worktreePath, ["rev-parse", "--git-path", "logs/HEAD"]);
	if (!headReflogPathResult.ok || !headReflogPathResult.stdout) {
		return null;
	}
	const headReflogPath = resolve(input.worktreePath, headReflogPathResult.stdout);
	let rawHeadReflog: string;
	try {
		const headReflogFile = await open(headReflogPath, "r");
		try {
			const headReflogSize = (await headReflogFile.stat()).size;
			if (headReflogSize > MAXIMUM_TASK_HEAD_REFLOG_BYTES) return null;
			const buffer = Buffer.alloc(headReflogSize + 1);
			const { bytesRead } = await headReflogFile.read(buffer);
			if (bytesRead !== headReflogSize) return null;
			rawHeadReflog = buffer.toString("utf8", 0, bytesRead);
		} finally {
			await headReflogFile.close();
		}
	} catch {
		return null;
	}

	const entries = readContinuousTaskHeadReflogFromCreation({ ...input, rawHeadReflog });
	if (entries === null || entries.length > MAXIMUM_TASK_HEAD_REFLOG_ENTRIES) return null;
	if (entries.length === 0) return new Set();
	const commitShas = [...new Set([input.initialBaseCommit, ...entries.map((entry) => entry.nextHeadCommit)])];
	const topology = await runGit(input.worktreePath, ["rev-list", "--no-walk", "--parents", ...commitShas, "--"]);
	if (!topology.ok) return null;
	const parentShasByCommitSha = new Map(
		topology.stdout.split("\n").map((line) => {
			const [commitSha, ...parentShas] = line.split(" ");
			return [commitSha, parentShas] as const;
		}),
	);
	if (commitShas.some((commitSha) => !parentShasByCommitSha.has(commitSha))) return null;

	const taskCreatedCommitShas = new Set<string>();
	let headBeforeRebase: string | null = null;
	for (const { previousHeadCommit, nextHeadCommit, reflogMessage } of entries) {
		const nextParents = parentShasByCommitSha.get(nextHeadCommit) ?? [];
		const isRebasing = headBeforeRebase !== null;
		if (FAST_FORWARD_REFLOG_MESSAGE_PATTERN.test(reflogMessage)) {
			if (nextHeadCommit === previousHeadCommit || nextParents.includes(previousHeadCommit)) continue;
			const ancestry = await runGit(input.worktreePath, [
				"merge-base",
				"--is-ancestor",
				previousHeadCommit,
				nextHeadCommit,
			]);
			if (!ancestry.ok) return null;
		} else if (/^rebase \(start\): checkout /.test(reflogMessage) && !isRebasing) {
			// rebase 的起点只能是可证明属于 base 的提交。
			const ancestry = await runGit(input.worktreePath, [
				"merge-base",
				"--is-ancestor",
				nextHeadCommit,
				input.baseTipCommit,
			]);
			if (!ancestry.ok) return null;
			headBeforeRebase = previousHeadCommit;
		} else if (
			/^rebase \(finish\): returning to /.test(reflogMessage) &&
			isRebasing &&
			previousHeadCommit === nextHeadCommit
		) {
			headBeforeRebase = null;
		} else if (isRebasing && /^rebase \(abort\): /.test(reflogMessage) && nextHeadCommit === headBeforeRebase) {
			headBeforeRebase = null;
		} else if (/^(?:commit \(merge\)|merge [^:]+|pull[^:]*): /.test(reflogMessage)) {
			if (nextParents.length < 2 || nextParents[0] !== previousHeadCommit) return null;
		} else if (
			/^commit \(amend\): /.test(reflogMessage) ||
			(isRebasing && /^rebase \((?:reword|squash|fixup)\): /.test(reflogMessage))
		) {
			const previousParents = parentShasByCommitSha.get(previousHeadCommit);
			if (!previousParents || nextParents.join(" ") !== previousParents.join(" ")) return null;
			if (nextParents.length === 1) taskCreatedCommitShas.add(nextHeadCommit);
		} else if (
			/^(?:commit|cherry-pick|commit \(cherry-pick\)|revert): /.test(reflogMessage) ||
			(isRebasing && /^rebase \((?:pick|continue)\): /.test(reflogMessage))
		) {
			if (nextParents.length !== 1 || nextParents[0] !== previousHeadCommit) return null;
			taskCreatedCommitShas.add(nextHeadCommit);
		} else if (
			/^reset: moving to /.test(reflogMessage) ||
			(previousHeadCommit === nextHeadCommit && /^checkout: moving from /.test(reflogMessage))
		) {
			// 这些动作只移动引用，不产生提交。
		} else {
			return null;
		}
	}
	// detached rebase 成功退出时可能省略 finish，仍在运行的 rebase 有自己的工作树状态目录。
	if (headBeforeRebase !== null) {
		if (!input.isDetached) return null;
		const worktreeGitDirectory = dirname(dirname(headReflogPath));
		const rebaseStateMissing = await Promise.all(
			["rebase-merge", "rebase-apply"].map((directory) =>
				lstat(resolve(worktreeGitDirectory, directory)).then(
					() => false,
					(error: NodeJS.ErrnoException) => error.code === "ENOENT",
				),
			),
		);
		if (!rebaseStateMissing.every(Boolean)) return null;
	}
	const currentHead = await runGit(input.worktreePath, ["rev-parse", "--verify", "HEAD"]);
	return currentHead.ok && currentHead.stdout === input.headCommit ? taskCreatedCommitShas : null;
}
