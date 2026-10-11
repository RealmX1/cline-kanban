import { randomUUID } from "node:crypto";
import packageJson from "../../package.json" with { type: "json" };
import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationInclusionReason,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationTaskDeploymentAttributionZone,
} from "../core/api-contract";
import { materializeAuthoredVerificationItemsForWorkspaceTasks } from "../deployment/authored-verification-definitions";
import { readDeployMarker } from "../deployment/deploy-marker";
import {
	assemblePostDeployVerificationTaskForDeploymentGroup,
	isPostDeployVerificationTaskAwaitingVerification,
} from "../deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	createDeploymentGroup,
	findActiveDeploymentGroupOfWorkspace,
} from "../deployment/post-deploy-verification-state";
import {
	computeTaskDeploymentAttributionsAgainstDeployment,
	type DeploymentForTaskDeploymentAttribution,
	findTaskIdsWhoseCommitsAreIncludedInDeploymentDelta,
} from "../deployment/task-deployment-attribution-from-commit-integration-provenance";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceBoardById, loadWorkspaceContext } from "../state/workspace-state";
import { runGit } from "../workspace/git-utils";

// `kanban deployment record`：写部署标记、建本次部署的 Post-Deploy Verification 组。
//
// 2026-10-11 起纳入规则（取代「Validation 列全量 + 每次清零」）：
//  - Validation 列的卡；
//  - 上一活跃组里仍在等核对、且还在看板（非 Done / backlog）上的任务——连同勾选进度一起延续（跨部署保留）；
//  - 其他列里提交命中本次部署区间的任务（review / in_progress 纳入核对；Done 只作「本次部署还包含」的只读展示）。
// 每个任务按提交来历算出归属三区（本次上线 / 早先已上线待核对 / 未上线或无从归属），面板据此分区。

type JsonRecord = Record<string, unknown>;

const KANBAN_PACKAGE_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

interface DeploymentGroupCandidateTask {
	taskId: string;
	columnIdAtMatch: RuntimeBoardColumnId;
	inclusionReason: RuntimePostDeployVerificationInclusionReason;
	unclosedTaskCarriedForwardFromPreviousActiveGroup: RuntimePostDeployVerificationTask | null;
	includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: boolean;
}

function listRetainedDeploymentGroupsOfWorkspaceInAscendingOrder(
	state: RuntimePostDeployVerificationState,
	workspaceId: string,
): RuntimePostDeployVerificationDeploymentGroup[] {
	return state.deploymentGroups
		.filter((group) => group.workspaceId === workspaceId)
		.sort((left, right) => Date.parse(left.deployedAtIso) - Date.parse(right.deployedAtIso));
}

export async function recordDeploymentWithTaskDeploymentAttribution(input: {
	cwd: string;
	sourceCheckoutPath?: string;
	newCommit?: string;
	projectPath?: string;
	readPostDeployVerificationStateReadOnly: () => Promise<RuntimePostDeployVerificationState>;
}): Promise<JsonRecord> {
	const sourceCheckoutPath = input.sourceCheckoutPath
		? resolveProjectInputPath(input.sourceCheckoutPath, input.cwd)
		: input.cwd;
	// 关联任务的 workspace：显式 --project-path 优先，否则按 sourceCheckoutPath 定位（0 匹配即未注册 → 报错提示 --project-path）。
	const workspaceResolutionPath = input.projectPath
		? resolveProjectInputPath(input.projectPath, input.cwd)
		: sourceCheckoutPath;
	let workspace: Awaited<ReturnType<typeof loadWorkspaceContext>>;
	try {
		workspace = await loadWorkspaceContext(workspaceResolutionPath, { autoCreateIfMissing: false });
	} catch (error) {
		throw new Error(
			`Could not resolve a Kanban workspace for ${workspaceResolutionPath}: ${error instanceof Error ? error.message : String(error)}. Pass --project-path to select a registered project.`,
		);
	}

	const revParse = await runGit(sourceCheckoutPath, ["rev-parse", input.newCommit ?? "HEAD"]);
	if (!revParse.ok || revParse.stdout.trim().length === 0) {
		throw new Error(
			`Could not resolve deploy commit "${input.newCommit ?? "HEAD"}" in ${sourceCheckoutPath}: ${revParse.error ?? revParse.stderr}`,
		);
	}
	const newSha = revParse.stdout.trim();
	const previousMarker = await readDeployMarker();
	const oldSha = previousMarker?.deployedSourceCommit ?? null;
	const deploymentId = randomUUID();
	const nowIso = new Date().toISOString();

	// 先读 PDV 状态、再读看板（RVF-002）：两次读之间若有任务经门禁结案移入 Done，看板读到的是 Done、不会再按「等核对」延续；
	// 反过来先读看板，就会拿已结案的旧状态配上过期的列，把它当新任务重新纳入。读之后才发生的结案由 createDeploymentGroup 锁内协调。
	const state = await input.readPostDeployVerificationStateReadOnly();
	const board = await loadWorkspaceBoardById(workspace.workspaceId);
	const columnIdByTaskId = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			columnIdByTaskId.set(card.id, column.id);
		}
	}
	const previousActiveGroup = findActiveDeploymentGroupOfWorkspace(state, workspace.workspaceId);
	const targetDeployment: DeploymentForTaskDeploymentAttribution = {
		deploymentId,
		deployedSourceCommit: newSha,
		previousDeployedSourceCommit: oldSha,
		deployedAtIso: nowIso,
	};

	const candidatesByTaskId = new Map<string, DeploymentGroupCandidateTask>();
	for (const [taskId, columnId] of columnIdByTaskId) {
		if (columnId === "validation") {
			candidatesByTaskId.set(taskId, {
				taskId,
				columnIdAtMatch: columnId,
				inclusionReason: "validation_column",
				unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
				includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
			});
		}
	}
	for (const previousTask of previousActiveGroup?.tasks ?? []) {
		const currentColumnId = columnIdByTaskId.get(previousTask.taskId);
		if (
			!isPostDeployVerificationTaskAwaitingVerification(previousTask) ||
			currentColumnId === undefined ||
			currentColumnId === "trash" ||
			currentColumnId === "backlog"
		) {
			continue;
		}
		candidatesByTaskId.set(previousTask.taskId, {
			taskId: previousTask.taskId,
			columnIdAtMatch: currentColumnId,
			inclusionReason: candidatesByTaskId.get(previousTask.taskId)?.inclusionReason ?? previousTask.inclusionReason,
			unclosedTaskCarriedForwardFromPreviousActiveGroup: previousTask,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		});
	}
	const taskIdsOutsideValidationAndCarriedForward = [...columnIdByTaskId.keys()].filter(
		(taskId) => !candidatesByTaskId.has(taskId) && columnIdByTaskId.get(taskId) !== "backlog",
	);
	const matchedDeployedCommitsByTaskIdOutsideValidation =
		(await findTaskIdsWhoseCommitsAreIncludedInDeploymentDelta({
			workspaceId: workspace.workspaceId,
			repositoryPath: sourceCheckoutPath,
			targetDeployment,
			taskIds: taskIdsOutsideValidationAndCarriedForward,
		})) ?? new Map();
	for (const taskId of matchedDeployedCommitsByTaskIdOutsideValidation.keys()) {
		const columnId = columnIdByTaskId.get(taskId);
		if (!columnId) {
			continue;
		}
		candidatesByTaskId.set(taskId, {
			taskId,
			columnIdAtMatch: columnId,
			inclusionReason: "commit_correlation",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: columnId === "trash",
		});
	}

	const candidates = [...candidatesByTaskId.values()];
	const attributionComputationsByTaskId = await computeTaskDeploymentAttributionsAgainstDeployment({
		workspaceId: workspace.workspaceId,
		repositoryPath: sourceCheckoutPath,
		targetDeployment,
		retainedEarlierDeploymentsInAscendingOrder: listRetainedDeploymentGroupsOfWorkspaceInAscendingOrder(
			state,
			workspace.workspaceId,
		),
		taskIds: candidates.map((candidate) => candidate.taskId),
		nowIso,
	});
	// 只读展示的 Done 任务不 materialize authored 项：它们已结案，不再核对，也不该把定义 seed 进新组（会阻止 automatic 清理判断）。
	const authoredItemsByTaskId = await materializeAuthoredVerificationItemsForWorkspaceTasks(
		workspace.workspaceId,
		candidates
			.filter((candidate) => !candidate.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded)
			.map((candidate) => candidate.taskId),
		nowIso,
	);

	let authoredItemCount = 0;
	const groupTasks: RuntimePostDeployVerificationTask[] = candidates.map((candidate) => {
		const assembled = assemblePostDeployVerificationTaskForDeploymentGroup({
			...candidate,
			deploymentId,
			authoredChecklistItems: authoredItemsByTaskId.get(candidate.taskId) ?? [],
			taskDeploymentAttributionComputation: attributionComputationsByTaskId.get(candidate.taskId) ?? null,
		});
		authoredItemCount += assembled.appendedAuthoredItemCount;
		return assembled.task;
	});

	// 上面全程无锁：延续来的任务交给 createDeploymentGroup 在 state 锁内按旧副本的当前状态重新落定（RVF-002）。
	const previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId = new Map<string, string>();
	if (previousActiveGroup) {
		for (const candidate of candidates) {
			if (candidate.unclosedTaskCarriedForwardFromPreviousActiveGroup !== null) {
				previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId.set(
					candidate.taskId,
					previousActiveGroup.deploymentId,
				);
			}
		}
	}
	const { group, marker } = await createDeploymentGroup(
		{
			deploymentId,
			workspaceId: workspace.workspaceId,
			deployedSourceCommit: newSha,
			previousDeployedSourceCommit: oldSha,
			sourceCheckoutPath,
			packageVersion: KANBAN_PACKAGE_VERSION,
			tasks: groupTasks,
			previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId,
		},
		nowIso,
	);
	// 以锁内落盘的组为准汇报（延续任务可能在锁内改成只读展示或不再纳入）。
	const persistedGroupTasks = group.tasks;

	// 三区计数与「本次上线」明细共用同一过滤，保证明细长度恒等于计数：建组时已在 Done 的只读条目不归任何一区，
	// 只计入 tasksAlreadyInDoneShownReadOnlyCount（面板同样把它们单列为「本次部署还包含（已在 Done）」）。
	// 以锁内落盘的组为准（延续任务可能在锁内改成只读展示或不再纳入）。
	const listGroupTasksInZoneExcludingTasksAlreadyInDoneShownReadOnly = (
		zone: RuntimePostDeployVerificationTaskDeploymentAttributionZone,
	): RuntimePostDeployVerificationTask[] =>
		persistedGroupTasks.filter(
			(task) =>
				!task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded &&
				(task.taskDeploymentAttribution?.taskDeploymentAttributionZone ??
					"task_commits_not_yet_deployed_or_task_unattributable") === zone,
		);
	const tasksShippedInThisDeployment = listGroupTasksInZoneExcludingTasksAlreadyInDoneShownReadOnly(
		"task_commits_included_in_this_deployment_delta",
	);
	return {
		ok: true,
		deploymentId: group.deploymentId,
		workspaceId: group.workspaceId,
		workspacePath: workspace.repoPath,
		sourceCheckoutPath,
		deployedSourceCommit: group.deployedSourceCommit,
		previousDeployedSourceCommit: group.previousDeployedSourceCommit,
		deployedAtIso: group.deployedAtIso,
		packageVersion: marker.packageVersion,
		totalVerificationTaskCount: persistedGroupTasks.length,
		tasksShippedInThisDeploymentCount: tasksShippedInThisDeployment.length,
		tasksDeployedOnlyInEarlierDeploymentsAwaitingVerificationCount:
			listGroupTasksInZoneExcludingTasksAlreadyInDoneShownReadOnly(
				"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
			).length,
		tasksNotYetDeployedOrUnattributableCount: listGroupTasksInZoneExcludingTasksAlreadyInDoneShownReadOnly(
			"task_commits_not_yet_deployed_or_task_unattributable",
		).length,
		tasksCarriedForwardWithVerificationProgressCount: persistedGroupTasks.filter(
			(task) =>
				previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId.has(task.taskId) &&
				!task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded,
		).length,
		tasksAlreadyInDoneShownReadOnlyCount: persistedGroupTasks.filter(
			(task) => task.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded,
		).length,
		authoredVerificationItemCount: authoredItemCount,
		tasksShippedInThisDeployment: tasksShippedInThisDeployment.map((task) => ({
			taskId: task.taskId,
			columnIdAtMatch: task.columnIdAtMatch,
			matchedCommits: task.matchedCommits,
			checklistItemCount: task.checklist.length,
		})),
	};
}
