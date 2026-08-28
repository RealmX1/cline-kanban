import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeTaskTurnCheckpoint } from "../core/api-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { getGitStdout, type RunGitOptions } from "./git-utils";

const CHECKPOINT_AUTHOR_NAME = "kanban-checkpoint";
const CHECKPOINT_AUTHOR_EMAIL = "kanban-checkpoint@local";

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

async function createWorkingTreeCheckpointCommit(repoRoot: string, turn: number, taskId: string): Promise<string> {
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

	try {
		const headCommit = await tryRunGit(repoRoot, ["rev-parse", "--verify", "HEAD"], {
			env: gitEnv,
		});
		if (headCommit) {
			await runGit(repoRoot, ["read-tree", headCommit], { env: gitEnv });
		} else {
			await runGit(repoRoot, ["read-tree", "--empty"], { env: gitEnv });
		}

		await runGit(repoRoot, ["add", "-A", "--", "."], { env: gitEnv });
		const treeOid = await runGit(repoRoot, ["write-tree"], { env: gitEnv });

		const commitMessage = `kanban checkpoint task:${taskId} turn:${turn}`;
		const commitArgs = ["commit-tree", treeOid, "-m", commitMessage];
		if (headCommit) {
			commitArgs.push("-p", headCommit);
		}

		return await runGit(repoRoot, commitArgs, {
			env: gitEnv,
		});
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export async function captureTaskTurnCheckpoint(input: {
	cwd: string;
	taskId: string;
	turn: number;
}): Promise<RuntimeTaskTurnCheckpoint> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	const commit = await createWorkingTreeCheckpointCommit(repoRoot, input.turn, input.taskId);
	const ref = buildCheckpointRef(input.taskId, input.turn);
	await runGit(repoRoot, ["update-ref", ref, commit]);
	return {
		turn: input.turn,
		ref,
		commit,
		createdAt: Date.now(),
	};
}

export async function deleteTaskTurnCheckpointRef(input: { cwd: string; ref: string }): Promise<void> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	await tryRunGit(repoRoot, ["update-ref", "-d", input.ref]);
}

export interface TaskTurnCheckpointRefEntry {
	turn: number;
	ref: string;
	commit: string;
}

// 枚举该任务现存的全部 turn checkpoint ref（git for-each-ref；refs/kanban/* 是 worktree 间共享的
// ref 命名空间，从 workspace 主仓枚举即可看到任务 worktree 里捕获的 checkpoint）。
// 注意：保留策略目前仍是「只留最近两个」（轮换删除，见 hooks-api / cline-task-session-service 的
// 删除点），故更早 turn 的锚点解析不到——投影层以 turnCheckpointAlignmentConfidence 如实降级；
// 任务存续期全量保留属姊妹蓝图 §1.4 步骤 3（exploratory 蓝图 M1 依赖）。
export async function listTaskTurnCheckpointRefs(input: {
	cwd: string;
	taskId: string;
}): Promise<TaskTurnCheckpointRefEntry[]> {
	const repoRoot = await runGit(input.cwd, ["rev-parse", "--show-toplevel"]);
	const prefix = `refs/kanban/checkpoints/${encodeRefSegment(input.taskId)}/turn/`;
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
