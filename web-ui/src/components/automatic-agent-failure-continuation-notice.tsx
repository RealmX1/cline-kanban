import {
	describeAutomaticAgentFailureContinuation,
	isAutomaticAgentFailureContinuationWaiting,
} from "@runtime-session-activity";
import { useState } from "react";
import { notifyError } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { useSharedFineClockTimestampMs } from "@/hooks/use-shared-fine-clock";
import { actOnAutomaticAgentFailureContinuation } from "@/runtime/automatic-agent-failure-continuation-query";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function AutomaticAgentFailureContinuationNotice({
	summary,
	workspaceId,
	executionForbidden,
}: {
	summary?: RuntimeTaskSessionSummary;
	workspaceId: string | null;
	executionForbidden: boolean;
}) {
	const [pending, setPending] = useState(false);
	const recovery = summary?.automaticAgentFailureContinuation;
	const nowMs = useSharedFineClockTimestampMs(isAutomaticAgentFailureContinuationWaiting(recovery));
	if (!recovery || recovery.phase === "recovered" || recovery.phase === "executing") return null;
	const perform = async (action: "retry_now" | "cancel") => {
		if (!workspaceId || !summary || executionForbidden) return;
		setPending(true);
		try {
			const result = await actOnAutomaticAgentFailureContinuation(
				workspaceId,
				summary.taskId,
				recovery.episodeId,
				action,
			);
			if (!result.ok) notifyError("恢复意图已变化，请查看最新状态。");
		} catch {
			notifyError("操作暂未完成，恢复意图仍以运行时状态为准。");
		} finally {
			setPending(false);
		}
	};
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary"
			data-automatic-agent-failure-continuation={recovery.phase}
		>
			<span className="min-w-0 break-words">{describeAutomaticAgentFailureContinuation(recovery, nowMs)}</span>
			<Button
				size="xs"
				variant="ghost"
				disabled={pending || !workspaceId || executionForbidden}
				onClick={() => void perform("retry_now")}
			>
				{isAutomaticAgentFailureContinuationWaiting(recovery) ? "立即重试或核对" : "重新开启恢复"}
			</Button>
			{isAutomaticAgentFailureContinuationWaiting(recovery) ? (
				<Button
					size="xs"
					variant="ghost"
					disabled={pending || !workspaceId || executionForbidden}
					onClick={() => void perform("cancel")}
				>
					停止重试
				</Button>
			) : null}
		</div>
	);
}
