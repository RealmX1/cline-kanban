import { isLowConfidenceLastConversationProgressEvidence } from "@runtime-last-conversation-progress-observation";
import { Activity, Clock, MessagesSquare } from "lucide-react";
import type { RuntimeInProgressTaskDetail } from "@/runtime/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

/**
 * 跨项目视图（Board Overview 的 In-Progress 行、跨项目切换面板的行）共用的时长药丸，与主看板卡片头部逐字同源、同语义：
 *   Clock          = 自创建至今；
 *   Activity       = 本轮停止生成至今（agent 回合 / park 期间无值 ⇒ 不显）；
 *   MessagesSquare = 对话上次推进至今（低置信来源加 `~` 前缀）。
 * 后两颗刻意不合并成一颗：前者是 per-incarnation 的离散状态转移（会话重开时刷新是**对**的），
 * 后者是跨 incarnation 的历史事实（会话重开时**不该**动）。历史上用一个 lastSubstantiveOutputAt
 * 冒充两者，正是「重开旧会话后时间被刷成 now」的成因。
 * 绝对本地时间走原生 title——避免把 Radix Tooltip 嵌进行按钮产生嵌套交互元素。
 */
export function TaskActivityElapsedTimePills({
	task,
	nowMs,
}: {
	task: Pick<
		RuntimeInProgressTaskDetail,
		"createdAt" | "agentResponseGenerationStopped" | "lastConversationProgressObservation"
	>;
	nowMs: number;
}): React.ReactElement {
	return (
		<span className="ml-1 flex shrink-0 items-center gap-1.5 text-[10px] leading-none text-text-tertiary">
			<span
				className="inline-flex items-center gap-0.5"
				title={`Created · ${new Date(task.createdAt).toLocaleString()}`}
			>
				<Clock size={10} className="shrink-0" />
				{formatCompactElapsedSince(task.createdAt, nowMs)}
			</span>
			{task.agentResponseGenerationStopped != null ? (
				<span
					className="inline-flex items-center gap-0.5"
					title={`Stopped generating · ${new Date(task.agentResponseGenerationStopped.stoppedAt).toLocaleString()}`}
				>
					<Activity size={10} className="shrink-0" />
					{formatCompactElapsedSince(task.agentResponseGenerationStopped.stoppedAt, nowMs)}
				</span>
			) : null}
			{task.lastConversationProgressObservation != null ? (
				<span
					className="inline-flex items-center gap-0.5"
					title={`Conversation last advanced · ${new Date(
						task.lastConversationProgressObservation.observedAtMs,
					).toLocaleString()} · source: ${task.lastConversationProgressObservation.evidenceKind}`}
				>
					<MessagesSquare size={10} className="shrink-0" />
					{isLowConfidenceLastConversationProgressEvidence(task.lastConversationProgressObservation.evidenceKind)
						? "~"
						: ""}
					{formatCompactElapsedSince(task.lastConversationProgressObservation.observedAtMs, nowMs)}
				</span>
			) : null}
		</span>
	);
}
