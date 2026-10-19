import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeTaskTurnCheckpoint } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { getGitStdout, type RunGitOptions } from "./git-utils";

const CHECKPOINT_AUTHOR_NAME = "kanban-checkpoint";
const CHECKPOINT_AUTHOR_EMAIL = "kanban-checkpoint@local";

// 每任务 turn checkpoint ref 上限（姊妹蓝图 §1.4）：任务存续期全量保留 turn ref，超限时从最老
// turn 滚动删除；被滚掉的更早 turn 锚点由投影层 turnCheckpointAlignmentConfidence=unaligned 如实
// 降级覆盖，不在这里做标记。任务删除 / trash 清空时由 deleteAllTaskTurnCheckpointRefs 按前缀批删。
export const MAX_TASK_TURN_CHECKPOINT_REFS = 200;

function runGit(cwd: string, args: string[], options: RunGitOptions = {}) {
	return getGitStdout(args, cwd, options);
}

async function tryRunGit(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string | null> {
	try {
		return await getGitStdout(args, cwd, options);
	} catch {
		return null;
	}
}

function encodeRefSegment(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function buildCheckpointRef(taskId: string, turn: number): string {
	return `refs/kanban/checkpoints/${encodeRefSegment(taskId)}/turn/${turn}`;
}

async function createWorkingTreeCheckpointCommit(
	repoRoot: string,
	turn: number,
	taskId: string,
	boundMessage?: string,
): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "kanban-checkpoint-"));
	const tempIndexPath = join(tempDir, "index");

	const gitEnv: NodeJS.ProcessEnv = {
		...createGitProcessEnv(),
		GIT_INDEX_FILE: tempIndexPath,
		GIT_AUTHOR_NAME: CHECKPOINT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: CHECKPOINT_AUTHOR_EMAIL,
		GIT_COMMITTER_NAME: CHECKPOINT_AUTHOR_NAME,
		GIT_COMMITTER_EMAIL: CHECKPOINT_AUTHOR_EMAIL,
	};

	const safeArguments = (arguments_: string[]) =>
		boundMessage ? ["-c", "core.hooksPath=/dev/null", ...arguments_] : arguments_;
	try {
		const headCommit = await tryRunGit(repoRoot, safeArguments(["rev-parse", "--verify", "HEAD"]), {
			env: gitEnv,
		});
		if (headCommit) {
			await runGit(repoRoot, safeArguments(["read-tree", headCommit]), { env: gitEnv });
		} else {
			await runGit(repoRoot, safeArguments(["read-tree", "--empty"]), { env: gitEnv });
		}

		await runGit(repoRoot, safeArguments(["add", "-A", "--", "."]), { env: gitEnv });
		const treeOid = await runGit(repoRoot, safeArguments(["write-tree"]), { env: gitEnv });

		const commitMessage = boundMessage ?? `kanban checkpoint task:${taskId} turn:${turn}`;
		const commitArgs = ["commit-tree", treeOid, "-m", commitMessage];
		if (headCommit) {
			commitArgs.push("-p", headCommit);
		}

		return await runGit(repoRoot, safeArguments(commitArgs), {
			env: gitEnv,
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

// RVF 分界另有不可变引用；不推进普通 turn 序数，也不覆盖 latest checkpoint。
export async function captureRvfReviewStartBoundaryCheckpoint(input: {
	cwd: string;
	taskId: string;
	decisionToken: string;
	binding: Record<string, string | null>;
}): Promise<{ commit: string; tree: string }> {
	if (!/^[a-f0-9]{16}$/u.test(input.decisionToken)) throw new Error("非法 RVF 决策 token。");
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	const message = `kanban RVF review start task:${input.taskId}\n\nRVF_REVIEW_START_BOUNDARY_BINDING=${JSON.stringify(input.binding)}`;
	const commit = await createWorkingTreeCheckpointCommit(repoRoot, 0, input.taskId, message);
	await runGit(repoRoot, [
		"-c",
		"core.hooksPath=/dev/null",
		"update-ref",
		`refs/kanban/rvf-review-start-boundaries/${encodeRefSegment(input.taskId)}/${input.decisionToken}`,
		commit,
	]);
	return { commit, tree: await runGit(repoRoot, ["rev-parse", `${commit}^{tree}`]) };
}

export async function captureTaskTurnCheckpoint(input: {
	cwd: string;
	taskId: string;
	turn: number;
	// 每任务 ref 上限，默认 MAX_TASK_TURN_CHECKPOINT_REFS；测试注入小值，避免真造 200+ ref。
	maxTaskTurnCheckpointRefs?: number;
}): Promise<RuntimeTaskTurnCheckpoint> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	const commit = await createWorkingTreeCheckpointCommit(repoRoot, input.turn, input.taskId);
	const ref = buildCheckpointRef(input.taskId, input.turn);
	await runGit(repoRoot, ["update-ref", ref, commit]);
	await pruneTaskTurnCheckpointRefsToCap(
		repoRoot,
		input.taskId,
		input.maxTaskTurnCheckpointRefs ?? MAX_TASK_TURN_CHECKPOINT_REFS,
	);
	return {
		turn: input.turn,
		ref,
		commit,
		createdAt: Date.now(),
	};
}

// 上限修剪：落定新 ref 后枚举该任务全部 turn ref，超限就从最老 turn 滚动删到不超上限。
// best-effort——修剪失败不拖累已落定的 checkpoint（ref 只是多留几个，任务删除时仍会批删）。
async function pruneTaskTurnCheckpointRefsToCap(repoRoot: string, taskId: string, maxRefs: number): Promise<void> {
	try {
		const entries = await listTaskTurnCheckpointRefsAtRepoRoot(repoRoot, taskId);
		// entries 按 turn 升序；slice 上界必须钳到非负，负数会让 slice 从尾部反向截取。
		for (const entry of entries.slice(0, Math.max(0, entries.length - maxRefs))) {
			await tryRunGit(repoRoot, ["update-ref", "-d", entry.ref]);
		}
	} catch {
		// 上限修剪只是 housekeeping，绝不反过来炸掉捕获。
	}
}

export interface TaskTurnCheckpointRefEntry {
	turn: number;
	ref: string;
	commit: string;
}

// 枚举该任务现存的全部 turn checkpoint ref（git for-each-ref；refs/kanban/* 是 worktree 间共享的
// ref 命名空间，从 workspace 主仓枚举即可看到任务 worktree 里捕获的 checkpoint）。
// 保留策略（姊妹蓝图 §1.4）：任务存续期全量保留，仅受 MAX_TASK_TURN_CHECKPOINT_REFS 上限滚动修剪；
// 更早 turn 被滚掉 / 从未捕获时锚点解析不到——投影层以 turnCheckpointAlignmentConfidence 如实降级；
// 任务删除 / trash 清空时由 deleteAllTaskTurnCheckpointRefs 按前缀批删。
export async function listTaskTurnCheckpointRefs(input: {
	cwd: string;
	taskId: string;
}): Promise<TaskTurnCheckpointRefEntry[]> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	return await listTaskTurnCheckpointRefsAtRepoRoot(repoRoot, input.taskId);
}

// 按前缀批删该任务的全部 turn checkpoint ref。只挂「任务资产被永久抹除」的路径（CLI task delete、
// 浏览器整板保存的差集清理）；仅移入回收站（可恢复）不调它。cwd 不在 git 仓内时会抛——调用方
// 都是「删除已成之后的收尾」，自行 catch（失败只是残留几个无人认领的 ref）。
export async function deleteAllTaskTurnCheckpointRefs(input: { cwd: string; taskId: string }): Promise<void> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	const entries = await listTaskTurnCheckpointRefsAtRepoRoot(repoRoot, input.taskId);
	for (const entry of entries) {
		await tryRunGit(repoRoot, ["update-ref", "-d", entry.ref]);
	}
}

async function listTaskTurnCheckpointRefsAtRepoRoot(
	repoRoot: string,
	taskId: string,
): Promise<TaskTurnCheckpointRefEntry[]> {
	const prefix = `refs/kanban/checkpoints/${encodeRefSegment(taskId)}/turn/`;
	const output = await tryRunGit(repoRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]);
	if (!output) {
		return [];
	}
	const entries: TaskTurnCheckpointRefEntry[] = [];
	for (const line of output.split("\n")) {
		if (!line) {
			continue;
		}
		const [ref, commit] = line.split("\0");
		if (!ref || !commit || !ref.startsWith(prefix)) {
			continue;
		}
		const turnText = ref.slice(prefix.length);
		const turn = Number.parseInt(turnText, 10);
		// 严格解析：拒绝非纯数字后缀（防意外匹配到未来嵌套路径）。
		if (!Number.isSafeInteger(turn) || turn <= 0 || String(turn) !== turnText) {
			continue;
		}
		entries.push({ turn, ref, commit });
	}
	entries.sort((left, right) => left.turn - right.turn);
	return entries;
}
