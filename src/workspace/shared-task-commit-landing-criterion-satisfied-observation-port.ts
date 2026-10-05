import type { TaskCommitIntegratedIntoBaseRefMatch } from "./shared-task-commit-landing-criterion-against-local-base";

// 落地探测（task-commit-integration-provenance.ts）与工作单元间关系账本之间的端口。
// 为什么是注册制而不是直接 import 账本：provenance 模块经 task-worktree 也被 CLI 进程加载，而账本只允许在
// runtime 进程的 worker 线程内打开（dd2db §R3 Y-EVENT-1）。runtime 激活 live 捕获时注册实现；
// 未注册的进程（CLI、单测）照常探测、只是不记账——判据的求值本身与是否记账无关。

export type LastKnownTaskHeadObservationSourceForSharedLandingCriterion =
	// 本次探测就在 task worktree 上读到的 HEAD。
	| "live_task_worktree_probe"
	// worktree 已不在（Done 清理、删卡）：用最后一份 live 快照里的 HEAD 与自有提交集合，对照当前本地 base 重新求值。
	| "persisted_last_task_worktree_snapshot_after_worktree_removal";

export interface SharedTaskCommitLandingCriterionSatisfiedObservation {
	workspaceId: string;
	taskId: string;
	// provenance 里 task 最新一世（worktree 创建 / 回填锚点）的 id：判据只看这一世的自有提交。
	taskCommitProvenanceIncarnationId: string;
	localBaseRef: string;
	localBaseRefTipCommitAtObservation: string;
	lastKnownTaskHeadCommit: string;
	// live 探测时就是 HEAD 的读取时刻；worktree 消失后，持久快照的时间也会随 base tip 的再求值前移，只是 HEAD 时刻的上界。
	lastTaskWorktreeGitSnapshotObservedAt: number;
	lastKnownTaskHeadObservationSource: LastKnownTaskHeadObservationSourceForSharedLandingCriterion;
	// 即 S：全部一对一匹配进了本地 base（判据满足才会上报，所以没有「未匹配」组）。
	taskOwnedNonMergeCommitsIntegratedIntoLocalBase: TaskCommitIntegratedIntoBaseRefMatch[];
}

export interface SharedTaskCommitLandingCriterionSatisfiedObservationSink {
	// 不阻塞探测；同一观测重复上报由实现方去重（每次探测都会上报当时满足判据的状态）。
	recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking(
		observation: SharedTaskCommitLandingCriterionSatisfiedObservation,
	): void;
}

let registeredSharedTaskCommitLandingCriterionSatisfiedObservationSink: SharedTaskCommitLandingCriterionSatisfiedObservationSink | null =
	null;

export function registerSharedTaskCommitLandingCriterionSatisfiedObservationSink(
	sink: SharedTaskCommitLandingCriterionSatisfiedObservationSink | null,
): void {
	registeredSharedTaskCommitLandingCriterionSatisfiedObservationSink = sink;
}

export function getRegisteredSharedTaskCommitLandingCriterionSatisfiedObservationSink(): SharedTaskCommitLandingCriterionSatisfiedObservationSink | null {
	return registeredSharedTaskCommitLandingCriterionSatisfiedObservationSink;
}

export function reportSharedTaskCommitLandingCriterionSatisfiedObservation(
	observation: SharedTaskCommitLandingCriterionSatisfiedObservation,
): void {
	registeredSharedTaskCommitLandingCriterionSatisfiedObservationSink?.recordSharedTaskCommitLandingCriterionSatisfiedObservationWithoutBlocking(
		observation,
	);
}
