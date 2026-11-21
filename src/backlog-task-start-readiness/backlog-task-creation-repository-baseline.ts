import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeBoardData } from "../core/api-contract";
import type { BacklogTaskCreationRepositoryBaseline } from "../core/backlog-task-start-readiness-contract";
import { createGitProcessEnv } from "../core/git-process-env";
import { runGit } from "../workspace/git-utils";

export async function readBacklogTaskCreationRepositoryBaseline(
	workspaceId: string,
	repositoryPath: string,
	baseRef: string,
): Promise<BacklogTaskCreationRepositoryBaseline> {
	const options = { timeoutMs: 6000, env: createGitProcessEnv({ GIT_OPTIONAL_LOCKS: "0" }) };
	const [common, commit] = await Promise.all([
		runGit(repositoryPath, ["--no-optional-locks", "rev-parse", "--git-common-dir"], options),
		runGit(
			repositoryPath,
			["--no-optional-locks", "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
			options,
		),
	]);
	return {
		workspaceId,
		repositoryPath: await realpath(repositoryPath).catch(() => repositoryPath),
		baseRef,
		gitCommonDirectoryPath: common.ok
			? await realpath(resolve(repositoryPath, common.stdout)).catch(() => null)
			: null,
		commit: commit.ok ? commit.stdout : null,
		capturedAtEpochMs: Date.now(),
		unavailableReason: !common.ok || !commit.ok ? "创建时无法读取仓库身份或所选 baseRef，历史比较覆盖未知。" : null,
	};
}

// 所有建卡入口共享持久化漏斗；项目迁移保留原基线，历史任务不会在普通更新时伪造创建基线。
export async function captureRepositoryBaselinesForNewBacklogTaskCards(
	workspaceId: string,
	repositoryPath: string,
	previous: RuntimeBoardData,
	next: RuntimeBoardData,
): Promise<RuntimeBoardData> {
	const existingIds = new Set(previous.columns.flatMap((column) => column.cards.map((card) => card.id)));
	const byBaseRef = new Map<string, Promise<BacklogTaskCreationRepositoryBaseline>>();
	return {
		...next,
		columns: await Promise.all(
			next.columns.map(async (column) => ({
				...column,
				cards: await Promise.all(
					column.cards.map(async (card) => {
						if (column.id !== "backlog" || existingIds.has(card.id)) return card;
						let baseline = byBaseRef.get(card.baseRef);
						if (!baseline) {
							baseline = readBacklogTaskCreationRepositoryBaseline(workspaceId, repositoryPath, card.baseRef);
							byBaseRef.set(card.baseRef, baseline);
						}
						return {
							...card,
							backlogTaskCreationRepositoryBaseline: await baseline,
							backlogTaskStartReadinessReview: undefined,
							backlogTaskStartReadinessExecutionRevision: undefined,
						};
					}),
				),
			})),
		),
	};
}
