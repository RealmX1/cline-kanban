import type { RuntimeProjectSummary } from "@/runtime/types";

/**
 * 「有 live main agent 的任务数」——顶栏 trigger 与表格 Live 列共用的唯一来源。
 *
 * `turnOwner === "agent"` 是仓库 canonical 的「agent 正持有回合」判据（同 hook-event-task-transition-gate.ts、
 * session-manager.ts、workspace-api.ts），且 api-contract.ts 的 legal-combo `superRefine` 已保证它蕴含
 * `liveness ∈ {starting, live, retrying}`，所以这里不需要再叠时间窗口，也不需要本地 tick 重算。
 *
 * `inProgressTaskDetails` 只覆盖 in_progress 列（见 src/server/in-progress-task-detail-projection.ts），
 * 这对「live agent」正是要的取景。未被本运行时连接过的项目读 0 —— agent 子进程只能由本运行时 spawn，
 * 所以 0 是语义正确的答案，不是缺数据。
 */
export function deriveLiveAgentTaskCount(project: RuntimeProjectSummary): number {
	return project.inProgressTaskDetails.filter((taskDetail) => taskDetail.turnOwner === "agent").length;
}

/**
 * 「等你处理的任务数」。
 *
 * 用 `taskCounts.review` 而非从 `inProgressTaskDetails` 里数 `turnOwner === "user"`：`taskCounts` 在
 * summarizeProject 里已套过 `applyLiveSessionStateToProjectTaskCounts` 的 in_progress→review overlay，
 * 且 TerminalSessionManager 未加载时会退化为原始列计数，因此对**全部**项目都可信。
 *
 * 注意它与任务分布徽章里的 `R` 是同一个数字——两列同时开启会重复展示，故默认二选一
 * （见 project-switcher-table-column-definitions.ts 的默认可见性）。
 */
export function deriveAwaitingUserTaskCount(project: RuntimeProjectSummary): number {
	return project.taskCounts.review;
}
