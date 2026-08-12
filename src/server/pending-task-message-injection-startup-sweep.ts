// runtime 启动清扫：把所有 workspace 账本里**超期**仍处于 accepted_pending_submit_confirmation 的
// 注入记录判为 delivery_failed{runtime_restarted_before_confirmation}。
//
// 为什么必须有这一步：pending 的收敛完全依赖 runtime 内存里的那份投递登记（定时器 + 代际 + 确认链）。
// runtime 一重启，内存态全没了，那些记录就再也没有任何人会去改写——于是 RVF 会永远等一个不会到来的
// 终态，退回到 2026-08-08 事故的形态（只是这次是「永远 pending」而不是「假成功」）。
//
// 为什么判据是「超期」而不是「本进程刚起来」：账本落在全机共享的 workspaces 根下，一台机器上可以同时
// 跑多个 runtime 实例（并行 checkout 的 dev:full、dogfood、起真服务器的集成测试）。按「本进程刚起来」
// 全扫，第二个实例一启动就会把常驻实例此刻真正在途的投递写成失败，而终态写一次即定 ⇒ 不可纠正的假失败。
// 「超期」则是契约自带的判据：pending 必然在最坏预算内转终态，故岁数超过预算的 pending 无论归谁管
// 都不可能还在正常投递。契约 § 时序保证 2 的原文写的也正是「清扫**超期**仍 pending 的记录」。
//
// 两趟清扫，缺一不可：启动那一趟只处理已经超期的；启动时还「年轻」但属主进程其实已经死了的那些，
// 由延迟复扫在它们跨过预算之后补判——只做第一趟就会把这类记录留到下次重启，仍然是「永远 pending」。
//
// 契约：~/.rvf/cross-repo-coordination-with-cline-kanban/terminal-delivery-interface-contract.md
// § 时序保证 1（≤190s 必然收敛）与 § 时序保证 2（runtime 重启不会留下永久 pending）。

import {
	getTaskMessageInjectionLedgerPath,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
} from "../core/task-message-injection-ledger";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import { getWorkspaceDirectoryPath, listWorkspaceIndexEntries } from "../state/workspace-state";
import { TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS } from "../terminal/session-manager";

// 复扫排在「最早那条跨过预算」之后再加这点余量，吸收定时器抖动与账本时间戳的取整，
// 免得复扫恰好早到一拍、把刚好还在预算内的投递判失败。
const STALE_PENDING_SWEEP_FOLLOW_UP_MARGIN_MS = 5_000;

export async function sweepStalePendingTaskMessageInjectionsForAllWorkspaces(): Promise<{
	sweptCount: number;
	earliestSkippedPendingBecomesStaleAtEpochMs: number | null;
}> {
	let sweptCount = 0;
	let earliestSkippedPendingBecomesStaleAtEpochMs: number | null = null;
	let workspaceEntries: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>;
	try {
		workspaceEntries = await listWorkspaceIndexEntries();
	} catch (error) {
		// 索引读不出来不该拖垮启动：清扫是纠偏动作，不是启动前置条件。
		logTuiFreezeError("[tui-freeze] pending-injection-sweep-skipped reason=workspace_index_unreadable", error);
		return { sweptCount: 0, earliestSkippedPendingBecomesStaleAtEpochMs: null };
	}
	for (const workspaceEntry of workspaceEntries) {
		try {
			const result = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
				ledgerPath: getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(workspaceEntry.workspaceId)),
				nowIso: new Date().toISOString(),
				stalePendingThresholdMs: TASK_CHAT_INPUT_DELIVERY_WORST_CASE_SETTLEMENT_BUDGET_MS,
			});
			if (result.earliestSkippedPendingBecomesStaleAtEpochMs !== null) {
				earliestSkippedPendingBecomesStaleAtEpochMs =
					earliestSkippedPendingBecomesStaleAtEpochMs === null
						? result.earliestSkippedPendingBecomesStaleAtEpochMs
						: Math.min(
								earliestSkippedPendingBecomesStaleAtEpochMs,
								result.earliestSkippedPendingBecomesStaleAtEpochMs,
							);
			}
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
	return { sweptCount, earliestSkippedPendingBecomesStaleAtEpochMs };
}

// 启动入口：先扫已超期的，再给「本轮还年轻」的那些排一次复扫。
// 只排一趟就够：复扫时刻之后才建的 pending，其发起者按定义是当时还活着的某个 runtime 实例，
// 归它自己的内存登记收敛，不该由我们代判——继续链式复扫只会把手伸进别人的在途投递里。
export function scheduleStalePendingTaskMessageInjectionSweepsAfterRuntimeRestart(): void {
	void (async () => {
		const startupSweep = await sweepStalePendingTaskMessageInjectionsForAllWorkspaces();
		if (startupSweep.earliestSkippedPendingBecomesStaleAtEpochMs === null) {
			return;
		}
		const followUpDelayMs =
			Math.max(0, startupSweep.earliestSkippedPendingBecomesStaleAtEpochMs - Date.now()) +
			STALE_PENDING_SWEEP_FOLLOW_UP_MARGIN_MS;
		// unref：复扫是纠偏动作，不该把一个本该退出的进程按在事件循环里。
		setTimeout(() => {
			void sweepStalePendingTaskMessageInjectionsForAllWorkspaces();
		}, followUpDelayMs).unref();
	})();
}
