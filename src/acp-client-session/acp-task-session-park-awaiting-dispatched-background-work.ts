// dd2db 2x：ACP（omp）会话的 park 等价物（Cline 已停止维护，不做）。
// PTY 的 park 经 TerminalSessionManager 置 sidecar `awaitingDispatchedBackgroundWork`，靠 hook 的单一 to_review 闸
// 抑制「等你审查」；ACP 没有 hook，回合收束由 applyAcpPromptTurnCompletion 直接写 facet。这里写的是**同一个**
// sidecar，判据仍是唯一谓词 isParkedAwaitingDispatchedBackgroundWork——UI 徽标、通知、回收的 park 轨道、
// 排队投递的让位都按 summary 读它，与 transport 无关，不需要第二个谓词。
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../core/session-activity";
import { type AcpTaskSessionEntry, now, updateAcpSummary } from "./acp-session-state";

// 「会话不再停在 agent 回合里等后台工作」的写入随补丁清 park：新 prompt、取消 / 中止 / 停止 / 回收、清空、
// 连接断开、失败、拒答或取消收束。弹出权限 / 计划审批时**不**清——与 PTY 一致：显式人回合越过 to_review 闸，
// 但 park 保留，决策回给 agent 之后它仍在等自己派发的后台工作。未 parked 时这个补丁是 no-op。
export const ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK = {
	awaitingDispatchedBackgroundWork: null,
} satisfies Partial<RuntimeTaskSessionSummary>;

export type AcpTaskSessionParkAwaitingDispatchedBackgroundWorkResult =
	| { ok: true; summary: RuntimeTaskSessionSummary }
	| { ok: false; error: string };

// 与 PTY 同一套前置条件：有活连接、且处于 agent 回合。幂等：已 parked 时刷新 label、保留原 sinceMs。
// 只写 sidecar，不碰 facet——parked 的 agent 真相仍是普通 running 三元组。
export function parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork(input: {
	taskId: string;
	entry: AcpTaskSessionEntry | null;
	hasLiveAcpConnection: boolean;
	label?: string;
}): AcpTaskSessionParkAwaitingDispatchedBackgroundWorkResult {
	if (!input.entry || !input.hasLiveAcpConnection) {
		return { ok: false, error: `Task "${input.taskId}" has no active agent session to park.` };
	}
	if (resolveSessionFacets(input.entry.summary).turnOwner !== "agent") {
		return { ok: false, error: `Task "${input.taskId}" is not in an agent turn and cannot be parked.` };
	}
	const label = input.label?.trim() || undefined;
	const sinceMs = input.entry.summary.awaitingDispatchedBackgroundWork?.sinceMs ?? now();
	return {
		ok: true,
		summary: updateAcpSummary(input.entry, {
			awaitingDispatchedBackgroundWork: { sinceMs, ...(label ? { label } : {}) },
		}),
	};
}

// 显式清 park（编排方兜底、unpark procedure）。未 parked 返回 null，调用方据此不重复广播。
export function unparkAcpTaskSessionEntry(entry: AcpTaskSessionEntry): RuntimeTaskSessionSummary | null {
	if (!isParkedAwaitingDispatchedBackgroundWork(entry.summary)) {
		return null;
	}
	return updateAcpSummary(entry, ACP_SUMMARY_PATCH_CLEARING_PARK_AWAITING_DISPATCHED_BACKGROUND_WORK);
}

export function describeAcpTaskSessionAwaitingDispatchedBackgroundWork(entry: AcpTaskSessionEntry | null): {
	parked: boolean;
	label: string | null;
	sinceMs: number | null;
} {
	const sidecar = entry?.summary.awaitingDispatchedBackgroundWork ?? null;
	if (sidecar == null) {
		return { parked: false, label: null, sinceMs: null };
	}
	return { parked: true, label: sidecar.label ?? null, sinceMs: sidecar.sinceMs };
}
