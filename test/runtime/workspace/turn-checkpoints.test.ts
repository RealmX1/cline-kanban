import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	captureTaskTurnCheckpoint,
	deleteAllTaskTurnCheckpointRefs,
	listTaskTurnCheckpointRefs,
	MAX_TASK_TURN_CHECKPOINT_REFS,
} from "../../../src/workspace/turn-checkpoints";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

// 落一次工作区改动再捕获：每个 turn 的 checkpoint commit 都有不同的 tree，也更贴近真实捕获时机
//（agent 做完一轮、工作区已变化）。
async function captureAfterWorkspaceChange(
	repositoryPath: string,
	taskId: string,
	turn: number,
	maxTaskTurnCheckpointRefs?: number,
) {
	writeFileSync(join(repositoryPath, "work.txt"), `turn ${turn}\n`, "utf8");
	return await captureTaskTurnCheckpoint({
		cwd: repositoryPath,
		taskId,
		turn,
		...(maxTaskTurnCheckpointRefs === undefined ? {} : { maxTaskTurnCheckpointRefs }),
	});
}

describe.sequential("turn checkpoints 保留策略（姊妹蓝图 §1.4）", () => {
	it("任务存续期全量保留全部 turn ref，不再轮换删除", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "retain-all-turn-refs" });
			repository.runGit(["commit", "--quiet", "--allow-empty", "-m", "init"]);

			await captureAfterWorkspaceChange(repository.repositoryPath, "task-alpha", 1);
			await captureAfterWorkspaceChange(repository.repositoryPath, "task-alpha", 2);
			const third = await captureAfterWorkspaceChange(repository.repositoryPath, "task-alpha", 3);

			const entries = await listTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-alpha" });
			expect(entries.map((entry) => entry.turn)).toEqual([1, 2, 3]);
			expect(entries[2]?.ref).toBe(third.ref);
			expect(entries[2]?.commit).toBe(third.commit);
		} finally {
			gitFixture.cleanup();
		}
	});

	it("deleteAllTaskTurnCheckpointRefs 按前缀批删该任务全部 ref，且不碰其他任务", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "delete-all-turn-refs" });
			repository.runGit(["commit", "--quiet", "--allow-empty", "-m", "init"]);
			for (const turn of [1, 2, 3]) {
				await captureAfterWorkspaceChange(repository.repositoryPath, "task-alpha", turn);
			}
			await captureAfterWorkspaceChange(repository.repositoryPath, "task-beta", 1);

			await deleteAllTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-alpha" });

			expect(await listTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-alpha" })).toEqual([]);
			expect(
				(await listTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-beta" })).map(
					(entry) => entry.turn,
				),
			).toEqual([1]);

			// 幂等：任务本无 ref 时是一次 no-op，不抛——任务删除路径会对从没捕获过 checkpoint 的任务也调它。
			await deleteAllTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-alpha" });
		} finally {
			gitFixture.cleanup();
		}
	});

	it("超过每任务上限时从最老 turn 滚动修剪（上限可注入，生产默认 200）", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		try {
			const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName: "cap-rolling-prune" });
			repository.runGit(["commit", "--quiet", "--allow-empty", "-m", "init"]);
			for (const turn of [1, 2, 3, 4]) {
				await captureAfterWorkspaceChange(repository.repositoryPath, "task-alpha", turn, 2);
			}

			const entries = await listTaskTurnCheckpointRefs({ cwd: repository.repositoryPath, taskId: "task-alpha" });
			expect(entries.map((entry) => entry.turn)).toEqual([3, 4]);
			expect(MAX_TASK_TURN_CHECKPOINT_REFS).toBe(200);
		} finally {
			gitFixture.cleanup();
		}
	});
});
