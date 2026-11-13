// runtime detach（handover / 信号停止）时，给每条留在 agent session PTY host 里的会话定孤儿回收期限：
// runtime 迟迟不回来时 host 按它终止会话（见 wire-protocol 的 hostedSessionOrphanReclamationEligibleAtEpochMs）。
//
// 期限不另立常量，直接取会话回收账本里当前那条 live 记录的 eligibleAt——与 runtime 在线时的回收调度器同一份期限、
// 同一套防护：记录必须仍对得上这个会话（同一活体、同一回合），且会话此刻处于计时态（不在 agent 回合中、运行时资源还在）。
// 任一不满足就不回收（null）：宁可让一个会话多活一阵，也绝不让 host 杀掉一个正在干活的 agent。
// 此处仅投影账本期限；TerminalSessionManager 在发布最终记录前复用在线原生执行门禁，再读本函数核对期限仍有效。

import { readAgentSessionUserTurnIdleProcessRetentionDurationMinutes } from "../config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isReclamationDeadlineStillCurrentForSession } from "../core/session-activity";
import {
	findLiveAgentSessionReclamationDeadlineRecord,
	isLiveAgentSessionReclamationState,
	type PersistedAgentSessionReclamationDeadlineRecord,
	readAgentSessionReclamationDeadlineRecords,
	refreshAgentSessionUserTurnIdleProcessRetentionDeadline,
} from "../state/agent-session-reclamation-deadline-store";
import { isAgentSessionRetentionDeadlineBearing } from "./agent-session-response-generation-stop-observer";

export function resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
	reclamationDeadlineRecords: readonly PersistedAgentSessionReclamationDeadlineRecord[],
	summary: RuntimeTaskSessionSummary,
): number | null {
	const liveDeadlineRecord = findLiveAgentSessionReclamationDeadlineRecord(reclamationDeadlineRecords, summary.taskId);
	if (
		liveDeadlineRecord === null ||
		!isReclamationDeadlineStillCurrentForSession(liveDeadlineRecord, summary) ||
		!isAgentSessionRetentionDeadlineBearing(summary)
	) {
		return null;
	}
	return liveDeadlineRecord.reclamationEligibleAt;
}

// 读不到账本（文件损坏、workspace 目录已移除）时一律不回收。
export async function loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace(
	workspaceId: string,
	warn: (message: string) => void,
): Promise<(summary: RuntimeTaskSessionSummary) => number | null> {
	let reclamationDeadlineRecords: PersistedAgentSessionReclamationDeadlineRecord[];
	try {
		reclamationDeadlineRecords = await readAgentSessionReclamationDeadlineRecords(workspaceId);
	} catch (error) {
		warn(
			`无法核实会话回收期限 workspaceId=${workspaceId}；已暂停独立 PTY host 的孤儿回收，恢复后由扫描器重试。 ${error instanceof Error ? error.message : String(error)}`,
		);
		return () => null;
	}
	let userTurnIdleProcessRetentionDurationMinutes: number | null = null;
	if (
		reclamationDeadlineRecords.some(
			(record) =>
				record.retentionAnchorKind === "agent_response_generation_stopped" &&
				isLiveAgentSessionReclamationState(record.reclamationState),
		)
	) {
		try {
			userTurnIdleProcessRetentionDurationMinutes =
				await readAgentSessionUserTurnIdleProcessRetentionDurationMinutes();
		} catch (error) {
			warn(
				`无法核实普通待命配置 workspaceId=${workspaceId}；仅暂停普通待命会话的宿主孤儿回收，恢复后由扫描器重试。 ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	reclamationDeadlineRecords = (
		await Promise.all(
			reclamationDeadlineRecords.map(async (record) => {
				if (
					record.retentionAnchorKind !== "agent_response_generation_stopped" ||
					!isLiveAgentSessionReclamationState(record.reclamationState)
				)
					return record;
				if (userTurnIdleProcessRetentionDurationMinutes === null) return null;
				try {
					return await refreshAgentSessionUserTurnIdleProcessRetentionDeadline(
						workspaceId,
						record.recordId,
						userTurnIdleProcessRetentionDurationMinutes,
						Date.now(),
					);
				} catch (error) {
					warn(
						`无法核实普通待命期限 workspaceId=${workspaceId} taskId=${record.taskId} recordId=${record.recordId}；仅暂停该会话的宿主孤儿回收，恢复后由扫描器重试。 ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
			}),
		)
	).filter((record): record is PersistedAgentSessionReclamationDeadlineRecord => record !== null);
	return (summary) =>
		resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
			reclamationDeadlineRecords,
			summary,
		);
}
