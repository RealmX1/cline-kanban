import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRecoverableForegroundRead } from "@/expanded-foreground-view/use-recoverable-foreground-read";
import {
	readTaskEditorCreationSubmissionsForTask,
	retryTaskEditorCreationSubmission,
} from "@/runtime/task-editor-creation-submission-query";
import { collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent } from "@/runtime/work-unit-relation-assertion-write-query";

const phaseLabels = {
	saving_card: "正在保存任务",
	saving_relations: "任务已保存，正在保存关联关系",
	starting_agent: "任务已保存，正在启动 Agent",
	waiting_for_dependency: "任务已保存，后续步骤等待恢复",
	waiting_for_evidence: "任务已保存，正在核验原启动结果",
	waiting_for_authorization: "已恢复原任务的关系草稿，等待确认",
	stopped: "后续创建步骤已停止",
	identity_conflict: "任务身份已变化，旧创建提交已停止",
	completed: "创建步骤已完成",
};
export function TaskEditorCreationProgressNotice({
	workspaceId,
	taskId,
	taskIncarnationCreatedAtEpochMs,
	readOnly = false,
}: {
	workspaceId: string;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
	readOnly?: boolean;
}) {
	const read = useCallback(
		(signal: AbortSignal) =>
			readTaskEditorCreationSubmissionsForTask(workspaceId, taskId, taskIncarnationCreatedAtEpochMs, signal),
		[workspaceId, taskId, taskIncarnationCreatedAtEpochMs],
	);
	const progress = useRecoverableForegroundRead({
		identity: `${workspaceId}:${taskId}:${taskIncarnationCreatedAtEpochMs}`,
		read,
		refreshIntervalMs: 5_000,
	});
	const [retryingSubmissionId, setRetryingSubmissionId] = useState<string | null>(null);
	const [retryError, setRetryError] = useState<string | null>(null);
	const incomplete = progress.value?.filter((record) => record.phase !== "completed") ?? [];
	if (!incomplete.length) return null;
	return (
		<div
			className="shrink-0 border-b border-border-subtle bg-surface-1 px-3 py-2 text-xs"
			role="status"
			data-verification-anchor={`task-editor-creation-progress:${taskId}`}
		>
			{incomplete.map((record) => (
				<div key={record.submissionId} className="flex flex-wrap items-center gap-2">
					<span>{phaseLabels[record.phase]}</span>
					{record.lastError ? <span className="text-status-orange">{record.lastError}</span> : null}
					{record.recoveryCondition ? (
						<span className="text-text-secondary">{record.recoveryCondition}</span>
					) : null}
					{!readOnly &&
					["waiting_for_dependency", "waiting_for_evidence", "waiting_for_authorization"].includes(
						record.phase,
					) ? (
						<Button
							size="xs"
							variant="ghost"
							disabled={retryingSubmissionId !== null}
							onClick={async (event) => {
								const characteristics =
									collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(event);
								setRetryingSubmissionId(record.submissionId);
								setRetryError(null);
								try {
									await retryTaskEditorCreationSubmission(
										record.workspaceId,
										record.submissionId,
										characteristics,
									);
									progress.refresh();
								} catch (error) {
									setRetryError(error instanceof Error ? error.message : String(error));
								} finally {
									setRetryingSubmissionId(null);
								}
							}}
						>
							{record.phase === "waiting_for_authorization" ? "确认并保存原关系" : "重试未完成步骤"}
						</Button>
					) : null}
				</div>
			))}
			{retryError ? (
				<p role="alert" className="text-status-red">
					{retryError}
				</p>
			) : null}
		</div>
	);
}
