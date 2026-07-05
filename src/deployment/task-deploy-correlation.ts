import type { RuntimeBoardColumnId, RuntimeTaskWorktreeMode } from "../core/api-contract";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { computeStablePatchId, runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

// 关联匹配置信度：exact_hash = deploy delta 与 task commit 同 hash；patch_id_equivalent = cherry-pick 改 hash 但 patch-id 等价。
// weak tree-overlap 降级本 MVP 不做（plan 1b「MVP 建议」），弱匹配直接判为 unmatched（不产出候选）。
export type DeploymentVerificationMatchConfidence = "exact_hash" | "patch_id_equivalent";

export interface DeploymentCorrelationTaskInput {
	taskId: string;
	columnId: RuntimeBoardColumnId;
	// 任务所属 project 仓库根（worktree base repo），交给 getTaskWorkspacePathInfo 解析 worktree 路径。
	cwd: string;
	baseRef: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
}

export interface DeploymentVerificationCandidate {
	taskId: string;
	columnId: RuntimeBoardColumnId;
	// deploy delta 侧被命中的 commit（即运行 build 里的 sha），供面板展示 matched commits。
	matchedCommits: string[];
	matchConfidence: DeploymentVerificationMatchConfidence;
}

export interface CorrelateTasksInput {
	// kanban 源 checkout（通常即 main 所在目录），deploy delta 在此计算。
	sourceCheckoutPath: string;
	// 上次部署到的源 commit；首次部署为 null（退化为仅 newSha 单 commit 作为 delta）。
	oldSha: string | null;
	newSha: string;
	tasks: DeploymentCorrelationTaskInput[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function splitGitLines(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

// deploy delta = sourceCheckoutPath 上 `git log oldSha..newSha`；oldSha 为 null 时退化为 newSha 单 commit。
// 同 commit 重部署（old === new）→ 区间为空 → []（面板显示「没有 commit 关联任务」）。
async function resolveDeployDeltaCommits(
	sourceCheckoutPath: string,
	oldSha: string | null,
	newSha: string,
): Promise<string[]> {
	const args =
		oldSha === null ? ["log", "--format=%H", "-n", "1", newSha] : ["log", "--format=%H", `${oldSha}..${newSha}`];
	const result = await runGit(sourceCheckoutPath, args);
	if (!result.ok) {
		throw new Error(
			`无法读取 deploy delta（${oldSha ?? "∅"}..${newSha}）@ ${sourceCheckoutPath}：${result.error ?? result.stderr}`,
		);
	}
	return splitGitLines(result.stdout);
}

// task commit = 任务 worktree 上 `git rev-list <merge-base(baseRef, HEAD)>..HEAD`；任一步失败降级为空（跳过该任务）。
async function resolveTaskCommits(taskWorktreePath: string, baseRef: string): Promise<string[]> {
	const mergeBase = await runGit(taskWorktreePath, ["merge-base", baseRef, "HEAD"]);
	if (!mergeBase.ok || mergeBase.stdout.trim() === "") {
		logDeploymentDiagnosticWarning(
			`[task-deploy-correlation] 无法计算 merge-base(${baseRef}, HEAD) @ ${taskWorktreePath}：${mergeBase.error ?? mergeBase.stderr}`,
		);
		return [];
	}
	const revList = await runGit(taskWorktreePath, ["rev-list", `${mergeBase.stdout.trim()}..HEAD`]);
	if (!revList.ok) {
		logDeploymentDiagnosticWarning(
			`[task-deploy-correlation] 无法 rev-list @ ${taskWorktreePath}：${revList.error ?? revList.stderr}`,
		);
		return [];
	}
	return splitGitLines(revList.stdout);
}

async function correlateSingleTask(
	task: DeploymentCorrelationTaskInput,
	deployShaSet: ReadonlySet<string>,
	ensureDeployPatchIdMap: () => Promise<ReadonlyMap<string, string>>,
): Promise<DeploymentVerificationCandidate | null> {
	let workspacePathInfo: Awaited<ReturnType<typeof getTaskWorkspacePathInfo>>;
	try {
		workspacePathInfo = await getTaskWorkspacePathInfo({
			cwd: task.cwd,
			taskId: task.taskId,
			baseRef: task.baseRef,
			worktreeMode: task.worktreeMode,
		});
	} catch (error) {
		logDeploymentDiagnosticWarning(
			`[task-deploy-correlation] 跳过任务 ${task.taskId}：无法解析 worktree 路径：${errorMessage(error)}`,
		);
		return null;
	}
	if (!workspacePathInfo.exists) {
		return null;
	}

	const taskCommits = await resolveTaskCommits(workspacePathInfo.path, task.baseRef);
	if (taskCommits.length === 0) {
		return null;
	}

	const matchedDeployShas = new Set<string>();
	let sawExactHash = false;
	const unmatchedTaskCommits: string[] = [];
	for (const taskCommit of taskCommits) {
		if (deployShaSet.has(taskCommit)) {
			matchedDeployShas.add(taskCommit);
			sawExactHash = true;
		} else {
			unmatchedTaskCommits.push(taskCommit);
		}
	}

	// 仅在存在未命中提交时才计算 patch-id（cherry-pick 改 hash 场景）。
	if (unmatchedTaskCommits.length > 0) {
		const deployPatchIdToSha = await ensureDeployPatchIdMap();
		if (deployPatchIdToSha.size > 0) {
			for (const taskCommit of unmatchedTaskCommits) {
				const patchId = await computeStablePatchId(workspacePathInfo.path, taskCommit);
				if (patchId === null) {
					continue;
				}
				const deploySha = deployPatchIdToSha.get(patchId);
				if (deploySha !== undefined) {
					matchedDeployShas.add(deploySha);
				}
			}
		}
	}

	if (matchedDeployShas.size === 0) {
		return null;
	}
	return {
		taskId: task.taskId,
		columnId: task.columnId,
		matchedCommits: [...matchedDeployShas],
		matchConfidence: sawExactHash ? "exact_hash" : "patch_id_equivalent",
	};
}

/**
 * 把本次 deploy delta 与各活跃任务的 work commit 关联，产出验证候选。
 * 匹配优先级：先直接 hash 相等，再 patch-id 等价（plan 1b）。任一任务的 git 步骤失败只跳过该任务，不整体 throw。
 * deploy delta 读取失败（源 checkout 无效）则 throw —— 关联无法继续。
 */
export async function correlateTasksWithDeployDelta(
	input: CorrelateTasksInput,
): Promise<DeploymentVerificationCandidate[]> {
	const deployCommits = await resolveDeployDeltaCommits(input.sourceCheckoutPath, input.oldSha, input.newSha);
	if (deployCommits.length === 0) {
		return [];
	}
	const deployShaSet = new Set(deployCommits);

	// deploy 侧 patch-id 惰性计算：无任务需要 patch-id 匹配时完全不跑（N 次 git show 较贵）。
	let cachedDeployPatchIdToSha: Map<string, string> | null = null;
	const ensureDeployPatchIdMap = async (): Promise<ReadonlyMap<string, string>> => {
		if (cachedDeployPatchIdToSha !== null) {
			return cachedDeployPatchIdToSha;
		}
		const map = new Map<string, string>();
		for (const sha of deployCommits) {
			const patchId = await computeStablePatchId(input.sourceCheckoutPath, sha);
			if (patchId !== null && !map.has(patchId)) {
				map.set(patchId, sha);
			}
		}
		cachedDeployPatchIdToSha = map;
		return map;
	};

	const candidates: DeploymentVerificationCandidate[] = [];
	for (const task of input.tasks) {
		const candidate = await correlateSingleTask(task, deployShaSet, ensureDeployPatchIdMap);
		if (candidate !== null) {
			candidates.push(candidate);
		}
	}
	return candidates;
}
