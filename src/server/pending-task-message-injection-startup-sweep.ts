// runtime 启动清扫：把所有 workspace 账本里仍处于 accepted_pending_submit_confirmation 的注入记录
// 判为 delivery_failed{runtime_restarted_before_confirmation}。
//
// 为什么必须有这一步：pending 的收敛完全依赖 runtime 内存里的那份投递登记（定时器 + 代际 + 确认链）。
// runtime 一重启，内存态全没了，那些记录就再也没有任何人会去改写——于是 RVF 会永远等一个不会到来的
// 终态，退回到 2026-08-08 事故的形态（只是这次是「永远 pending」而不是「假成功」）。
//
// 判据不是「超期多久」而是「runtime 刚起来」：启动那一刻按定义不存在任何合法的在途投递，
// 所以全扫是精确的，不需要挑一个必然会挑错的时间阈值。语义等同「不知道有没有送到」。
//
// 契约：~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md
// § 时序保证 2「runtime 重启不会留下永久 pending」。

import {
	getTaskMessageInjectionLedgerPath,
	sweepPendingTaskMessageInjectionsAfterRuntimeRestart,
} from "../core/task-message-injection-ledger";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { getWorkspaceDirectoryPath, listWorkspaceIndexEntries } from "../state/workspace-state";

export async function sweepPendingTaskMessageInjectionsForAllWorkspaces(): Promise<{ sweptCount: number }> {
	let sweptCount = 0;
	let workspaceEntries: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>;
	try {
		workspaceEntries = await listWorkspaceIndexEntries();
	} catch (error) {
		// 索引读不出来不该拖垮启动：清扫是纠偏动作，不是启动前置条件。
		logTuiFreezeError("[tui-freeze] pending-injection-sweep-skipped reason=workspace_index_unreadable", error);
		return { sweptCount: 0 };
	}
	for (const workspaceEntry of workspaceEntries) {
		try {
			const result = await sweepPendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath: getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceEntry.workspaceId)),
				nowIso: new Date().toISOString(),
			});
			if (result.sweptCount > 0) {
				sweptCount += result.sweptCount;
				logTuiFreezeWarning(
					`[tui-freeze] pending-injection-swept workspaceId=${workspaceEntry.workspaceId} ` +
						`count=${result.sweptCount} reason=runtime_restarted_before_confirmation`,
				);
			}
		} catch (error) {
			// 单个 workspace 的账本损坏不应阻断其余 workspace 的清扫。
			logTuiFreezeError(
				`[tui-freeze] pending-injection-sweep-failed workspaceId=${workspaceEntry.workspaceId}`,
				error,
			);
		}
	}
	return { sweptCount };
}
