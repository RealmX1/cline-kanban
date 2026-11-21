import {
	resolveTaskClosureOutcomeForBoardColumn,
	TASK_CLOSURE_OUTCOME_LABELS,
	type TaskClosureRecord,
} from "@runtime-task-closure-contract";
import { useCallback, useEffect, useState } from "react";
import { useNonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";
import {
	createTaskClosureFormDraft,
	resolveTaskClosureFormDetails,
	TaskClosureFormFields,
} from "@/components/task-closure-form-fields";
import { TaskClosureOutcomeCorrectionForm } from "@/components/task-closure-outcome-correction-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	cancelTaskClosureOperationInWorkspace,
	correctTaskClosureOutcomeInWorkspace,
	readTaskClosureHistoryInWorkspace,
} from "@/runtime/task-card-action-query";
import type { BoardCard } from "@/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export function TaskClosureSummaryAndHistory({
	card,
	workspaceId,
	isClosed,
}: {
	card: BoardCard;
	workspaceId: string | null;
	isClosed: boolean;
}) {
	const floatingFormHost = useNonModalFloatingFormWindowHost();
	const [open, setOpen] = useState(false);
	const [history, setHistory] = useState<Awaited<ReturnType<typeof readTaskClosureHistoryInWorkspace>> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [draft, setDraft] = useState(() => createTaskClosureFormDraft(card.taskClosureSummary?.details));
	const refresh = useCallback(async () => {
		if (!workspaceId) return;
		try {
			setHistory(await readTaskClosureHistoryInWorkspace(workspaceId, card.id, card.createdAt));
			setError(null);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, [workspaceId, card.id, card.createdAt]);
	useEffect(() => {
		if (open) void refresh();
	}, [open, refresh]);
	const pendingReopenings =
		history?.reopeningOperations?.filter((operation) => !["completed", "cancelled"].includes(operation.phase)) ?? [];
	const progress = card.taskClosureOperationProgress;
	const pending = progress && !["completed", "cancelled"].includes(progress.phase);
	const reclamation = progress?.unverifiedCandidateReclamation;
	const reclamationPending = reclamation && reclamation.phase !== "completed";
	if (!isClosed && !card.taskClosureSummary && !progress) return null;
	const label = reclamationPending
		? "失败载荷待回收"
		: pending
			? progress.phase === "closed_cleanup_pending"
				? "清理待恢复"
				: progress.phase === "preservation_waiting_for_recovery"
					? "保全待恢复"
					: "正在保全成果"
			: isClosed
				? TASK_CLOSURE_OUTCOME_LABELS[
						resolveTaskClosureOutcomeForBoardColumn("trash", card.taskClosureSummary) ??
							"closure_outcome_unspecified"
					]
				: card.taskClosureSummary?.eventKind === "reopened"
					? "已重新打开"
					: "已取消结案";
	const records = history?.records.length ? history.records : card.taskClosureSummary ? [card.taskClosureSummary] : [];
	const latestClosed = [...records].reverse().find((record) => record.isCurrentlyClosed);
	const saveCorrection = async () => {
		if (!workspaceId) return;
		setSubmitting(true);
		try {
			const details = await resolveTaskClosureFormDetails(draft, workspaceId);
			await correctTaskClosureOutcomeInWorkspace(workspaceId, {
				taskId: card.id,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				expectedPreviousClosureRequestId:
					history?.records.at(-1)?.closureRequestId ?? card.taskClosureSummary?.closureRequestId ?? null,
				closure: {
					closureRequestId: createRandomUuidV4WithInsecureContextFallback(),
					details,
					selectedArtifactRelativePaths: [],
				},
			});
			setEditing(false);
			await refresh();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSubmitting(false);
		}
	};
	return (
		<>
			<button
				type="button"
				className="max-w-full truncate text-left text-xs text-text-secondary underline-offset-2 hover:underline"
				onMouseDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					setOpen(true);
				}}
				aria-label={`查看结案历史：${label}`}
			>
				{label}
			</button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!submitting) setOpen(next);
				}}
			>
				<DialogHeader title="结案结果与成果保全" />
				<DialogBody className="flex flex-col gap-4">
					<p className="break-words text-sm text-text-primary">{card.title}</p>
					{error ? (
						<p role="alert" className="text-sm text-status-red">
							{error}
						</p>
					) : null}
					{pending ? (
						<div className="text-sm text-text-secondary">
							<p>
								{label}：{progress.lastError ?? "正在停止会话并验证可恢复归档"}
							</p>
							<p>{progress.recoveryCondition}</p>
							{progress.automaticRecovery ? (
								<p>
									自动尝试已用 {progress.automaticRecovery.automaticAttemptCount} 次，上限{" "}
									{progress.automaticRecovery.maximumAutomaticAttemptCount} 次。
									{progress.automaticRecovery.repairSupplementConsumed
										? "相关修复后的唯一补试已使用。"
										: "重启和普通空间波动不会增加次数。"}
								</p>
							) : null}
						</div>
					) : null}
					{reclamationPending ? (
						<p className="text-sm text-text-secondary">
							失败载荷待回收：{reclamation.lastError ?? "正在核验归属、引用与替代恢复来源"}。 回收已执行{" "}
							{reclamation.automaticAttemptCount} 次，最多三次；源工作树与成功归档继续保留。
						</p>
					) : null}
					{pendingReopenings.map((operation) => (
						<p key={operation.closureRequestId} className="text-sm text-status-orange">
							重开待恢复：{operation.lastError ?? operation.phase}
							。原归档继续保留，仅在相关恢复条件满足且总次数允许时接续。
							{operation.automaticRecovery
								? `自动尝试已用 ${operation.automaticRecovery.automaticAttemptCount} 次，上限 ${operation.automaticRecovery.maximumAutomaticAttemptCount} 次。`
								: null}
						</p>
					))}
					{pending || pendingReopenings.length > 0 ? (
						<Button
							disabled={submitting || !workspaceId}
							onClick={() => {
								if (workspaceId) {
									setSubmitting(true);
									void cancelTaskClosureOperationInWorkspace(workspaceId, card.id, card.createdAt)
										.then(() => refresh())
										.catch((failure: unknown) => setError(String(failure)))
										.finally(() => setSubmitting(false));
								}
							}}
						>
							取消待恢复操作
						</Button>
					) : null}
					{records.length === 0 ? (
						<p className="text-sm text-text-secondary">
							{progress?.phase === "cancelled"
								? "结案请求已取消；历史尝试与保留载荷仍可查询。"
								: "结案结果未标注；历史缺失的成果归档不可用。"}
						</p>
					) : (
						records.map((record) => <ClosureHistoryRecord key={record.closureRequestId} record={record} />)
					)}
					{editing ? (
						<TaskClosureFormFields
							draft={draft}
							onChange={setDraft}
							disabled={submitting}
							includeArtifactSelection={false}
						/>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button disabled={submitting} onClick={() => setOpen(false)}>
						关闭
					</Button>
					{isClosed && workspaceId ? (
						editing ? (
							<Button
								variant="primary"
								disabled={submitting || !draft.outcome}
								onClick={() => void saveCorrection()}
							>
								追加更正记录
							</Button>
						) : (
							<Button
								onClick={() => {
									if (floatingFormHost && workspaceId) {
										floatingFormHost.openWindow({
											formKind: "closure-outcome-correction",
											instanceIdentity: JSON.stringify([workspaceId, card.id, card.createdAt]),
											ownership: {
												workspaceId,
												taskId: card.id,
												taskIncarnationCreatedAtEpochMs: card.createdAt,
											},
											render: ({ close }) => (
												<TaskClosureOutcomeCorrectionForm
													workspaceId={workspaceId}
													card={{ ...card, taskClosureSummary: latestClosed ?? card.taskClosureSummary }}
													close={close}
												/>
											),
										});
										setOpen(false);
									} else {
										setDraft(createTaskClosureFormDraft(latestClosed?.details));
										setEditing(true);
									}
								}}
							>
								补记或更正结果
							</Button>
						)
					) : null}
				</DialogFooter>
			</Dialog>
		</>
	);
}

function ClosureHistoryRecord({ record }: { record: TaskClosureRecord }) {
	const manifest = record.archiveManifest;
	return (
		<section className="flex flex-col gap-2 border-t border-border pt-3 text-sm text-text-secondary">
			<p className="text-text-primary">
				{record.eventKind === "reopened"
					? "重新打开"
					: record.eventKind === "outcome_corrected"
						? "结果更正："
						: ""}
				{record.eventKind !== "reopened" ? TASK_CLOSURE_OUTCOME_LABELS[record.details.outcome] : ""} ·{" "}
				{new Date(record.recordedAtEpochMs).toLocaleString()}
			</p>
			{record.details.reason ? <p className="whitespace-pre-wrap break-words">{record.details.reason}</p> : null}
			{record.details.authorizationSource ? <p>授权来源：{record.details.authorizationSource}</p> : null}
			{record.details.successorTask ? (
				<p>
					承接任务：{record.details.successorTask.workspaceId}/{record.details.successorTask.taskId}（
					{record.details.successorTask.taskIncarnationCreatedAtEpochMs}）
				</p>
			) : null}
			{record.details.evidence.map((evidence) => (
				<p key={evidence} className="break-all">
					证据：{evidence}
				</p>
			))}
			{record.details.acceptedDeliverables.map((item, index) => (
				<div key={`${index}-${item.description}`}>
					<p>已接受成果：{item.description}</p>
					{item.evidence.map((evidence) => (
						<p key={evidence} className="break-all">
							验收证据：{evidence}
						</p>
					))}
				</div>
			))}
			<p>
				{manifest.availability === "verified_recoverable"
					? `归档已经实际还原验证，保留 ${manifest.preservedFileCount} 个文件。`
					: manifest.availability === "no_task_worktree"
						? "结案时没有任务工作树。"
						: "历史成果归档不可用。"}
			</p>
			{manifest.archiveDirectory ? <p className="break-all">成果位置：{manifest.archiveDirectory}</p> : null}
			{manifest.headCommit ? <p className="break-all">保全提交：{manifest.headCommit}</p> : null}
			<details>
				<summary>实际操作者</summary>
				<p className="break-all">{describeTaskClosureActor(record.actor)}</p>
			</details>
		</section>
	);
}

function describeTaskClosureActor(actor: Record<string, unknown>): string {
	const labels: Record<string, string> = {
		kanban_board_card_work_unit: "任务中的 Agent",
		kanban_unmanaged_standalone_agent_conversation_session_work_unit: "独立 Agent 会话",
		kanban_home_sidebar_agent_session_not_a_work_unit: "侧栏 Agent 会话",
		kanban_web_ui_user_gesture_with_verified_page_load_nonce: "浏览器用户操作",
		kanban_web_ui_client_side_automation_with_verified_page_load_nonce: "浏览器自动流程",
		kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation:
			"已验证来源的浏览器请求",
		kanban_runtime_system_component: "运行时系统流程",
		kanban_cli_invocation_without_task_or_session_environment: "CLI 调用（没有任务或会话身份）",
		direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce:
			"直接 API 调用（没有操作者身份声明）",
		unresolved_actor: "操作者来源未能确认",
	};
	const label =
		typeof actor.kanbanActorKind === "string"
			? (labels[actor.kanbanActorKind] ?? "操作者类型未识别")
			: "操作者来源未能确认";
	const task = actor.actingKanbanBoardCardWorkUnit;
	if (task && typeof task === "object" && "workspaceId" in task && "taskId" in task)
		return `${label}：${String(task.workspaceId)}/${String(task.taskId)}`;
	return label;
}
