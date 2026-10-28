import {
	TASK_CLOSURE_OUTCOME_LABELS,
	type TaskClosureDetails,
	type TaskClosureOutcome,
	taskClosureDetailsSchema,
} from "@runtime-task-closure-contract";
import { Button } from "@/components/ui/button";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";

export interface TaskClosureFormDraft {
	outcome: TaskClosureOutcome | "";
	reason: string;
	authorizationSource: string;
	successorWorkspaceId: string;
	successorTaskId: string;
	evidenceText: string;
	acceptedDeliverables: { description: string; evidenceText: string }[];
	selectedArtifactPathsText: string;
}
export function createTaskClosureFormDraft(details?: TaskClosureDetails): TaskClosureFormDraft {
	return {
		outcome: details?.outcome ?? "",
		reason: details?.reason ?? "",
		authorizationSource: details?.authorizationSource ?? "",
		successorWorkspaceId: details?.successorTask?.workspaceId ?? "",
		successorTaskId: details?.successorTask?.taskId ?? "",
		evidenceText: details?.evidence.join("\n") ?? "",
		selectedArtifactPathsText: "",
		acceptedDeliverables:
			details?.acceptedDeliverables.map((item) => ({
				description: item.description,
				evidenceText: item.evidence.join("\n"),
			})) ?? [],
	};
}
export const nonemptyClosureFormLines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
export async function resolveTaskClosureFormDetails(draft: TaskClosureFormDraft, workspaceId: string) {
	let successorTask: TaskClosureDetails["successorTask"];
	if (draft.successorTaskId.trim()) {
		const successorWorkspaceId = draft.successorWorkspaceId.trim() || workspaceId;
		const result = await readTaskCardWithBoardColumnInWorkspace(successorWorkspaceId, draft.successorTaskId.trim());
		if (result.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
			throw new Error("承接任务不存在，请核对项目与任务 ID。");
		successorTask = {
			workspaceId: successorWorkspaceId,
			taskId: result.taskCardSnapshot.taskCard.id,
			taskIncarnationCreatedAtEpochMs: result.taskCardSnapshot.taskCard.createdAt,
		};
	}
	const parsed = taskClosureDetailsSchema.safeParse({
		outcome: draft.outcome,
		reason: draft.reason.trim() || undefined,
		authorizationSource: draft.authorizationSource.trim() || undefined,
		successorTask,
		evidence: nonemptyClosureFormLines(draft.evidenceText),
		acceptedDeliverables: draft.acceptedDeliverables.map((item) => ({
			description: item.description,
			evidence: nonemptyClosureFormLines(item.evidenceText),
		})),
	});
	if (!parsed.success)
		throw new Error(
			[
				...new Set(
					parsed.error.issues.map((issue) =>
						issue.code === "custom" ? issue.message : "请检查结案结果及已填写成果的说明和验收证据。",
					),
				),
			].join("；"),
		);
	return parsed.data;
}

const closureInputClassName =
	"w-full rounded-md border border-border-bright bg-surface-0 p-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
export function TaskClosureFormFields({
	draft,
	onChange,
	disabled = false,
	includeArtifactSelection = true,
}: {
	draft: TaskClosureFormDraft;
	onChange: (draft: TaskClosureFormDraft) => void;
	disabled?: boolean;
	includeArtifactSelection?: boolean;
}) {
	const change = <K extends keyof TaskClosureFormDraft>(key: K, value: TaskClosureFormDraft[K]) =>
		onChange({ ...draft, [key]: value });
	return (
		<fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3 text-sm text-text-primary">
			<label className="flex flex-col gap-1">
				结案结果
				<select
					aria-label="结案结果"
					className={closureInputClassName}
					value={draft.outcome}
					onChange={(event) => change("outcome", event.target.value as TaskClosureFormDraft["outcome"])}
				>
					<option value="">请选择结案结果</option>
					{Object.entries(TASK_CLOSURE_OUTCOME_LABELS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</label>
			<label className="flex flex-col gap-1">
				原因或判断依据
				{draft.outcome && !["delivery_accepted", "closure_outcome_unspecified"].includes(draft.outcome)
					? "（必填）"
					: "（可选）"}
				<textarea
					aria-label="原因或判断依据"
					rows={3}
					className={closureInputClassName}
					value={draft.reason}
					onChange={(event) => change("reason", event.target.value)}
				/>
			</label>
			{draft.outcome === "cancelled_by_user" ? (
				<label className="flex flex-col gap-1">
					用户授权来源（必填）
					<input
						aria-label="用户授权来源"
						className={closureInputClassName}
						value={draft.authorizationSource}
						onChange={(event) => change("authorizationSource", event.target.value)}
					/>
				</label>
			) : null}
			{["plan_retired", "merged_into_successor_task"].includes(draft.outcome) ? (
				<div className="grid gap-2 sm:grid-cols-2">
					<label>
						承接项目 ID（留空使用当前项目）
						<input
							aria-label="承接项目 ID"
							className={closureInputClassName}
							value={draft.successorWorkspaceId}
							onChange={(event) => change("successorWorkspaceId", event.target.value)}
						/>
					</label>
					<label>
						承接任务 ID{draft.outcome === "merged_into_successor_task" ? "（必填）" : "（可选）"}
						<input
							aria-label="承接任务 ID"
							className={closureInputClassName}
							value={draft.successorTaskId}
							onChange={(event) => change("successorTaskId", event.target.value)}
						/>
					</label>
				</div>
			) : null}
			<label className="flex flex-col gap-1">
				证据位置（每行一项，可选）
				<textarea
					aria-label="证据位置"
					rows={2}
					className={closureInputClassName}
					value={draft.evidenceText}
					onChange={(event) => change("evidenceText", event.target.value)}
				/>
			</label>
			{draft.acceptedDeliverables.map((item, index) => (
				<div key={index} className="flex flex-col gap-2 border-l-2 border-border-bright pl-3">
					<label>
						已接受成果 {index + 1}
						<input
							aria-label={`已接受成果 ${index + 1}`}
							className={closureInputClassName}
							value={item.description}
							onChange={(event) =>
								change(
									"acceptedDeliverables",
									draft.acceptedDeliverables.map((other, i) =>
										i === index ? { ...other, description: event.target.value } : other,
									),
								)
							}
						/>
					</label>
					<label>
						成果验收证据（必填）
						<textarea
							aria-label={`成果验收证据 ${index + 1}`}
							rows={2}
							className={closureInputClassName}
							value={item.evidenceText}
							onChange={(event) =>
								change(
									"acceptedDeliverables",
									draft.acceptedDeliverables.map((other, i) =>
										i === index ? { ...other, evidenceText: event.target.value } : other,
									),
								)
							}
						/>
					</label>
					<Button
						onClick={() =>
							change(
								"acceptedDeliverables",
								draft.acceptedDeliverables.filter((_, i) => i !== index),
							)
						}
					>
						移除此成果
					</Button>
				</div>
			))}
			<Button
				onClick={() =>
					change("acceptedDeliverables", [...draft.acceptedDeliverables, { description: "", evidenceText: "" }])
				}
			>
				添加已接受成果
			</Button>
			{includeArtifactSelection ? (
				<label className="flex flex-col gap-1">
					额外保全的报告或反例（任务目录内相对路径，每行一项）
					<textarea
						aria-label="额外保全路径"
						rows={2}
						className={closureInputClassName}
						value={draft.selectedArtifactPathsText}
						onChange={(event) => change("selectedArtifactPathsText", event.target.value)}
					/>
					<span className="text-xs text-text-secondary">
						提交和非忽略的工作改动会自动归档。ignored 文件只有明确选择后才纳入。
					</span>
				</label>
			) : null}
		</fieldset>
	);
}
