// runtime 缺席期间被 agent session PTY host 孤儿回收的会话：新 runtime 接管（交付退出）之后补记账。
//
// 与 runtime 在线时调度器的一次成功回收记同样的三笔账，让 UI 与投递侧看到同样的结果：
// - 回收账本里那条 live 记录标成 reclaimed；
// - 该 task 的待答决策标上 reclaimedAt（「提问它的会话已经没了，答案要先恢复会话再投递」）；
// - summary 写上回收结果（卡片 / Focus View 显示「会话已被回收」，而不是一块让人以为只是没加载出来的空终端）。
// 必须在回收调度器第一次扫描之前跑：会话已退出、不再处于计时态，扫描会把那条记录当陈旧期限置 superseded，账就记丢了。

import type { HostedSessionReclaimedByHostWhileRuntimeWasAbsent } from "../agent-session-pty-host/runtime-client/agent-session-pty-host-runtime-facade";
import type { RuntimeAgentSessionReclamationOutcome, RuntimeTaskSessionSummary } from "../core/api-contract";
import { markAgentRaisedPendingUserDecisionsReclaimed } from "../state/agent-raised-pending-user-decision-store";
import {
	findLiveAgentSessionReclamationDeadlineRecord,
	readAgentSessionReclamationDeadlineRecords,
	updateAgentSessionReclamationProgress,
} from "../state/agent-session-reclamation-deadline-store";

export interface AgentSessionPtyHostOrphanReclamationBookkeepingDependencies {
	reclaimedHostedSessions: readonly HostedSessionReclaimedByHostWhileRuntimeWasAbsent[];
	applyAgentSessionReclamationOutcomeToTerminalSessionSummary: (
		workspaceId: string,
		taskId: string,
		outcome: RuntimeAgentSessionReclamationOutcome,
	) => RuntimeTaskSessionSummary | null;
	warn: (message: string) => void;
	readNowEpochMs?: () => number;
	readReclamationDeadlineRecords?: typeof readAgentSessionReclamationDeadlineRecords;
	updateReclamationProgress?: typeof updateAgentSessionReclamationProgress;
	markPendingUserDecisionsReclaimed?: typeof markAgentRaisedPendingUserDecisionsReclaimed;
}

export async function recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent(
	deps: AgentSessionPtyHostOrphanReclamationBookkeepingDependencies,
): Promise<number> {
	const readNowEpochMs = deps.readNowEpochMs ?? Date.now;
	const readReclamationDeadlineRecords =
		deps.readReclamationDeadlineRecords ?? readAgentSessionReclamationDeadlineRecords;
	const updateReclamationProgress = deps.updateReclamationProgress ?? updateAgentSessionReclamationProgress;
	const markPendingUserDecisionsReclaimed =
		deps.markPendingUserDecisionsReclaimed ?? markAgentRaisedPendingUserDecisionsReclaimed;
	let recordedReclamationCount = 0;
	for (const reclaimedHostedSession of deps.reclaimedHostedSessions) {
		const { workspaceId, taskId, exitedAtEpochMs } = reclaimedHostedSession;
		try {
			const liveDeadlineRecord = findLiveAgentSessionReclamationDeadlineRecord(
				await readReclamationDeadlineRecords(workspaceId),
				taskId,
			);
			if (liveDeadlineRecord === null) {
				deps.warn(
					`hosted agent session ${workspaceId}/${taskId} was reclaimed by the agent session pty host while the runtime was absent, but no live reclamation deadline record was found to mark as reclaimed`,
				);
				continue;
			}
			await markPendingUserDecisionsReclaimed(workspaceId, taskId, exitedAtEpochMs);
			await updateReclamationProgress(workspaceId, liveDeadlineRecord.recordId, {
				reclamationState: "reclaimed",
				updatedAt: readNowEpochMs(),
				incrementAttemptCount: true,
				nextReclaimRetryAt: null,
				lastReclaimFailureReason: null,
			});
			deps.applyAgentSessionReclamationOutcomeToTerminalSessionSummary(workspaceId, taskId, {
				runtimeSessionIncarnationId: liveDeadlineRecord.runtimeSessionIncarnationId,
				sessionTransport: liveDeadlineRecord.sessionTransport,
				reclamationTrigger:
					liveDeadlineRecord.retentionAnchorKind === "session_parked_awaiting_dispatched_background_work"
						? "park_abandoned"
						: "response_generation_grace_period_expired",
				attemptedAt: exitedAtEpochMs,
				completedAt: exitedAtEpochMs,
				// host 收到了根进程的退出事件；后代进程随进程组一起收到 SIGTERM / SIGKILL，但 host 不逐个复核。
				rootProcessExitConfirmed: true,
				descendantProcessesExitConfirmed: false,
				survivingDescendantPids: [],
				usedForcefulEscalation: false,
				releasedResources: ["pty"],
				failureReason: null,
				nextRetryAt: null,
			});
			recordedReclamationCount += 1;
		} catch (error) {
			deps.warn(
				`could not record the agent session pty host reclamation of ${workspaceId}/${taskId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return recordedReclamationCount;
}
