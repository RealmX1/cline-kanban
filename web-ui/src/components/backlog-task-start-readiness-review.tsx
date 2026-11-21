import { useState } from "react";
import { notifyError } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	assessBacklogTaskStartReadinessInWorkspace,
	readBacklogTaskStartReadinessReportInWorkspace,
} from "@/runtime/task-card-action-query";
import type { BacklogTaskStartReadinessReport, BacklogTaskStartReadinessReview } from "@/runtime/types";
import { startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import type { BoardCard } from "@/types";

export function BacklogTaskStartReadinessReviewNotice({
	card,
	workspaceId,
	canStart,
}: {
	card: BoardCard;
	workspaceId: string | null;
	canStart: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [report, setReport] = useState<BacklogTaskStartReadinessReport | null>(null);
	const [assessedReview, setAssessedReview] = useState<BacklogTaskStartReadinessReview | null>(null);
	const [overrideReason, setOverrideReason] = useState("");
	const review =
		assessedReview && assessedReview.updatedAtEpochMs > (card.backlogTaskStartReadinessReview?.updatedAtEpochMs ?? 0)
			? assessedReview
			: card.backlogTaskStartReadinessReview;
	const run = async (action: () => Promise<void>) => {
		if (busy || !workspaceId) return;
		setBusy(true);
		try {
			await action();
		} catch (error) {
			notifyError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="mt-2 space-y-2 text-xs text-text-secondary"
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => event.stopPropagation()}
		>
			{card.backlogTaskStartReadinessConditionsText && (
				<p className="whitespace-pre-wrap break-words">
					<span className="font-medium text-text-primary">适合开启的条件：</span>
					{card.backlogTaskStartReadinessConditionsText}
				</p>
			)}
			{review && (
				<p role="status" className="whitespace-pre-wrap break-words">
					<span className="font-medium text-text-primary">
						{review.phase === "reviewing" ? "启动前复核" : "开启复核"}：
					</span>
					{review.summary}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{canStart && (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || !workspaceId}
						onClick={() =>
							void run(async () => {
								if (!workspaceId) return;
								const result = await assessBacklogTaskStartReadinessInWorkspace(
									workspaceId,
									card.id,
									card.createdAt,
								);
								setAssessedReview(result.review);
								setReport(result.report);
							})
						}
					>
						{busy ? "复核中…" : "仅评估开启条件"}
					</Button>
				)}
				{review && (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || !workspaceId}
						onClick={() =>
							void run(async () => {
								if (!workspaceId) return;
								const result = await readBacklogTaskStartReadinessReportInWorkspace(
									workspaceId,
									card.id,
									card.createdAt,
								);
								setAssessedReview(result.review);
								setReport(result.report);
							})
						}
					>
						查看复核依据
					</Button>
				)}
			</div>
			{canStart && review?.phase === "conditions_not_met" && (
				<div className="space-y-2">
					<label className="block space-y-1">
						<span>覆盖开启条件的原因</span>
						<textarea
							aria-label="覆盖开启条件的原因"
							rows={2}
							maxLength={2000}
							value={overrideReason}
							onChange={(event) => setOverrideReason(event.target.value)}
							className="w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
						/>
					</label>
					<Button
						size="sm"
						disabled={busy || !workspaceId || !overrideReason.trim()}
						onClick={() =>
							void run(async () => {
								if (!workspaceId) return;
								const result = await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime({
									workspaceId,
									taskId: card.id,
									expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
									overrideUnmetBacklogTaskStartConditions: {
										operationId: review.operationId,
										reason: overrideReason.trim(),
									},
								});
								if (result.taskCardActionCommandExecutionOutcome === "command_failed")
									throw new Error(result.commandFailureMessage);
							})
						}
					>
						覆盖条件并开启
					</Button>
				</div>
			)}
			{report && (
				<details open className="space-y-1">
					<summary className="cursor-pointer text-text-primary">复核依据与剩余工作</summary>
					<p className="whitespace-pre-wrap break-words">{report.decision.summary}</p>
					<p>复核时间：{new Date(report.assessedAtEpochMs).toLocaleString()}</p>
					<ul className="list-inside list-disc break-words">
						{report.decision.evidenceReferences.map((reference) => (
							<li key={reference}>{reference}</li>
						))}
					</ul>
					{report.decision.remainingWorkRevision && (
						<p className="whitespace-pre-wrap break-words">
							{report.decision.remainingWorkRevision.currentExecutionInstructions}
						</p>
					)}
				</details>
			)}
		</div>
	);
}
