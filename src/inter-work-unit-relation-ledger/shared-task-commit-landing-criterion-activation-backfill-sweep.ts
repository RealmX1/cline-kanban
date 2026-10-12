import { listWorkspaceIndexEntries } from "../state/workspace-state";
import {
	listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation,
	probeAndRefreshTaskCommitIntegrationProvenance,
} from "../workspace/task-commit-integration-provenance";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";

// §R3 Y-PHASE-3「对 1a–1c 期间的快照补发判定」：live 检测器挂在落地探测上，只有被探测的 task 才会得到观测——
// 已删的卡不再上任何 board，没在浏览器里打开的 workspace 也没有元数据轮询。所以激活后对 1a 起被探测过的每份
// provenance 补探一次：worktree 还在就 live 探测，不在就用最后快照对照当前本地 base 求值。判据满足的经端口记账，
// 账本按幂等键去重，所以每次启动都扫也只会补记缺的。
// 逐条串行：探测内的 git 子进程不与启动期其它工作抢并发；停用开始后在下一条之前退出。
export async function sweepTaskCommitIntegrationProvenanceProbedSinceLandingDataPreservationForSharedLandingCriterion(input: {
	isLiveCaptureStillActive: () => boolean;
}): Promise<void> {
	let indexedWorkspaces: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>;
	try {
		indexedWorkspaces = await listWorkspaceIndexEntries();
	} catch (error) {
		logInterWorkUnitRelationLedgerDiagnosticWarning(
			`could not list indexed workspaces for the shared task commit landing criterion backfill sweep: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	for (const indexedWorkspace of indexedWorkspaces) {
		let provenanceEntries: Awaited<
			ReturnType<typeof listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation>
		>;
		try {
			provenanceEntries = await listTaskCommitIntegrationProvenanceEntriesProbedSinceLandingDataPreservation(
				indexedWorkspace.workspaceId,
			);
		} catch (error) {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`skipped the shared task commit landing criterion backfill sweep for workspace ${indexedWorkspace.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		for (const provenanceEntry of provenanceEntries) {
			if (!input.isLiveCaptureStillActive()) {
				return;
			}
			try {
				// 已删卡没有 card 可读 worktreeMode；有 provenance 的 task 都是 worktree 模式（inplace 从不建条目）。
				const pathInfo = await getTaskWorkspacePathInfo({
					cwd: indexedWorkspace.repoPath,
					taskId: provenanceEntry.taskId,
					baseRef: provenanceEntry.baseRef,
				});
				await probeAndRefreshTaskCommitIntegrationProvenance({
					workspaceId: indexedWorkspace.workspaceId,
					taskId: provenanceEntry.taskId,
					repoPath: indexedWorkspace.repoPath,
					worktreePath: pathInfo.path,
					baseRef: provenanceEntry.baseRef,
					worktreeExists: pathInfo.exists,
				});
			} catch (error) {
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`shared task commit landing criterion backfill sweep could not probe task ${provenanceEntry.taskId} in workspace ${indexedWorkspace.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}
