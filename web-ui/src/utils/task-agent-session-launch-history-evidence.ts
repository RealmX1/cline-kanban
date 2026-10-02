// 「这张卡的主 agent 会话以前有没有真正启动过」的三值证据。
//
// 为什么不是 boolean：卡片上的 mostRecentlyLaunchedAgentSessionAgentId 是运行时在启动**成功**那一刻写的，
// 但「字段缺失」不等于「从没启动过」——
//   - 该字段 2026-08-13（a86d28ca）才引入，更早启动过的存量卡没有它；
//   - 写卡失败会被吞掉（启动本身已成功，不能因为记账失败让启动失败），高负载下锁争用就可能漏写。
// 这两类卡的 summary 一旦退化成占位（硬中断 / 运行时重启），和「真的从没启动过」长得一模一样。
// 把「未知」压成「从没启动过」，恢复动作就会变成「以原 prompt 起一段全新对话」，丢掉本可续跑的旧对话；
// 压成「启动过」，从没启动过的卡又只拿到续跑式重启（空 prompt + --continue，原 prompt 永不送达）。
// 所以「从没启动过」必须有**正面证据**：任务 worktree 根本不存在——agent 不可能在一个不存在的目录里跑过。
// 拿不到正面证据就老实说不知道，由界面把两种出路都摆给人选。
export type TaskAgentSessionLaunchHistoryEvidence = "launched_before" | "never_launched" | "launch_history_unknown";

export function resolveTaskAgentSessionLaunchHistoryEvidence({
	mostRecentlyLaunchedAgentSessionAgentId,
	taskWorktreeExists,
}: {
	mostRecentlyLaunchedAgentSessionAgentId: string | null | undefined;
	// 来自 workspace metadata 的 exists；null/undefined = 还没拿到这张卡的 worktree 信息。
	// inplace 模式的任务跑在主仓库里，exists 恒为 true，于是只能落到「不知道」——这是有意的保守。
	taskWorktreeExists: boolean | null | undefined;
}): TaskAgentSessionLaunchHistoryEvidence {
	if (mostRecentlyLaunchedAgentSessionAgentId != null) {
		return "launched_before";
	}
	if (taskWorktreeExists === false) {
		return "never_launched";
	}
	return "launch_history_unknown";
}
