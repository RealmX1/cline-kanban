import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TaskLookupConversation } from "@/runtime/task-lookup-conversation-query";
import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";

type TaskLookupTurn = TaskLookupConversation["turns"][number];
export const TASK_LOOKUP_EXECUTION_PHASE_LABELS: Record<TaskLookupTurn["phase"], string> = {
	collecting_materials: "读取任务材料",
	preparing_context: "准备检索 Context",
	recalling_candidates: "召回候选任务",
	explaining_candidates: "解释候选任务",
	validating_candidates: "核验候选要求",
	saving_result: "保存查询结果",
	finished: "已结束",
};
const elapsedSeconds = (startedAt: number, now: number) => `${Math.max(0, Math.floor((now - startedAt) / 1000))} 秒`;

export function TaskLookupTurnExecutionDetails({
	conversation,
	turn,
	onRetry,
	isRetryDisabled,
}: {
	conversation: TaskLookupConversation;
	turn: TaskLookupTurn;
	onRetry: () => void;
	isRetryDisabled: boolean;
}) {
	const [now, setNow] = useState(Date.now);
	const [copyState, setCopyState] = useState<string | null>(null);
	const isRunning = turn.status === "running";
	useEffect(() => {
		if (!isRunning) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [isRunning]);
	const end = turn.finishedAt ?? now;
	const lastActivity = turn.lastExecutionActivityAt;
	const failure = turn.executionFailureDiagnostic;
	const copyDiagnostic = () => {
		const diagnostic = {
			conversationId: conversation.conversationId,
			contextWorkspaceId: conversation.contextWorkspaceId,
			turnId: turn.turnId,
			requestId: turn.requestId,
			scope: turn.scope,
			status: turn.status,
			phase: turn.phase,
			startedAt: turn.startedAt,
			finishedAt: turn.finishedAt,
			owningRuntimeProcessInstanceId: turn.owningRuntimeProcessInstanceId,
			phaseStartedAt: turn.phaseStartedAt,
			lastExecutionActivityAt: turn.lastExecutionActivityAt,
			executorSettings: turn.executorSettings,
			inputByteCount: turn.inputByteCount,
			modelExecutionTimeoutMs: turn.modelExecutionTimeoutMs,
			executionOwnershipWarning: turn.executionOwnershipWarning,
			executionFailureDiagnostic: failure,
			executionActivityTimeline: turn.executionActivityTimeline,
			omittedExecutionActivityCount: turn.omittedExecutionActivityCount,
			executions: turn.executions,
			errorMessage: turn.errorMessage,
		};
		void writeTextToSystemClipboardWithInsecureContextFallback(JSON.stringify(diagnostic, null, 2))
			.then(() => setCopyState("诊断已复制"))
			.catch(() => setCopyState("诊断复制失败，请重试"));
	};
	return (
		<div className="space-y-2" data-verification-anchor="task-lookup-turn-execution-details">
			{isRunning ? (
				<p role="status" className="text-sm text-text-primary">
					{TASK_LOOKUP_EXECUTION_PHASE_LABELS[turn.phase]}…
				</p>
			) : null}
			<p aria-live="off" className="text-xs text-text-secondary">
				总耗时 {elapsedSeconds(turn.startedAt, end)}
				{isRunning && turn.phaseStartedAt !== undefined
					? ` · 本阶段 ${elapsedSeconds(turn.phaseStartedAt, now)}`
					: ""}
				{lastActivity !== undefined
					? ` · 最近活动 ${new Date(lastActivity).toLocaleTimeString()}`
					: " · 历史未记录执行活动"}
			</p>
			{isRunning && now - (lastActivity ?? turn.startedAt) >= 60_000 ? (
				<p className="text-xs text-status-orange" aria-live="off">
					已超过 60 秒没有新的执行活动，仍在等待；可以取消本轮。
				</p>
			) : null}
			{turn.executionOwnershipWarning ? (
				<p className="text-xs text-status-orange">{turn.executionOwnershipWarning}</p>
			) : null}
			{failure ? (
				<p className="text-xs text-text-secondary">
					停止阶段：{TASK_LOOKUP_EXECUTION_PHASE_LABELS[failure.failedPhase]} · 原因：{failure.reasonCode}
				</p>
			) : null}
			<details className="text-xs text-text-secondary">
				<summary className="cursor-pointer">检索记录与诊断</summary>
				<div className="mt-2 space-y-2 break-words">
					<p>
						执行 Agent：{turn.executorSettings?.agentId ?? "历史未记录"} · 请求模型：
						{turn.executorSettings ? (turn.executorSettings.modelId ?? "Agent 默认模型") : "历史未记录"}
					</p>
					<p>
						最近模型输入：
						{turn.inputByteCount === undefined ? "未知" : `${turn.inputByteCount.toLocaleString()} 字节`} ·
						单次模型时限：
						{turn.modelExecutionTimeoutMs === undefined ? "未知" : `${turn.modelExecutionTimeoutMs / 1000} 秒`}
					</p>
					{turn.executions.map((execution) => (
						<p key={execution.phase}>
							{execution.phase === "recall" ? "候选召回" : "候选解释"} · {execution.elapsedMs}ms · 实际模型{" "}
							{execution.resolvedModelId ?? "未返回"} · 输入 {execution.inputTokens ?? "未知"} / 输出{" "}
							{execution.outputTokens ?? "未知"} tokens · 缓存读取 {execution.cacheReadTokens ?? "未知"}
						</p>
					))}
					{turn.executionActivityTimeline?.length ? (
						<ol className="space-y-1 border-t border-border pt-2">
							{turn.executionActivityTimeline.map((activity, index) => (
								<li key={`${activity.occurredAtEpochMs}-${index}`}>
									<time>{new Date(activity.occurredAtEpochMs).toLocaleTimeString()}</time> ·{" "}
									{TASK_LOOKUP_EXECUTION_PHASE_LABELS[activity.phase]} · {activity.message}
								</li>
							))}
						</ol>
					) : (
						<p>此历史轮次未保存详细执行时间线。</p>
					)}
					{turn.omittedExecutionActivityCount ? (
						<p>已省略 {turn.omittedExecutionActivityCount} 条较早活动，仅保留最近 200 条。</p>
					) : null}
					{failure ? (
						<div className="space-y-1">
							<p>
								退出码：{failure.exitCode ?? "未知"} · 退出信号：{failure.signal ?? "无"}
							</p>
							<pre className="whitespace-pre-wrap break-words font-sans">{failure.detail}</pre>
							{failure.stderrTail ? (
								<pre className="whitespace-pre-wrap break-words font-sans">{failure.stderrTail}</pre>
							) : null}
						</div>
					) : null}
					<p>
						会话 {conversation.conversationId} · 轮次 {turn.turnId} · 请求 {turn.requestId}
					</p>
					<p>执行归属：{turn.owningRuntimeProcessInstanceId ?? "历史未记录"}</p>
					<Button onClick={copyDiagnostic}>复制诊断</Button>
					{copyState ? <p role="status">{copyState}</p> : null}
				</div>
			</details>
			{["failed", "cancelled", "interrupted"].includes(turn.status) ? (
				<Button disabled={isRetryDisabled} onClick={onRetry}>
					重新查询
				</Button>
			) : null}
		</div>
	);
}
