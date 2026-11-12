import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import type { BoardCard } from "@/types";
import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";

export function TaskExternalWorkflowRunReference({
	card,
	workspaceId,
}: {
	card: BoardCard;
	workspaceId: string | null;
}) {
	const binding = card.externalWorkflowRunBinding;
	if (!binding) return null;
	const belongsToCurrentTask =
		binding.owningWorkspaceId === workspaceId &&
		binding.owningTaskId === card.id &&
		binding.owningTaskIncarnationCreatedAtEpochMs === card.createdAt;
	const observation = belongsToCurrentTask ? binding.lastObservedState : undefined;
	const observationAvailable = observation?.availability === "observed";
	return (
		<details
			className="mt-2 rounded border border-border px-2 py-1 text-xs text-text-secondary"
			data-verification-anchor={`task-external-workflow:${card.id}`}
			onClick={(event) => event.stopPropagation()}
		>
			<summary className="cursor-pointer break-words">
				{binding.workflowProviderId} ·{" "}
				{observationAvailable ? `最近阶段：${observation.businessStage ?? "unknown"}` : "状态 unknown"}
			</summary>
			<div className="mt-2 space-y-1 break-words">
				<p>
					工作项：{binding.workItemId} · Run：{binding.runId}
				</p>
				{!belongsToCurrentTask ? <p>引用属于其他工作区或任务代次，请核对原 Run；此处不授予执行资格。</p> : null}
				{observation ? (
					<p>观察时间：{new Date(observation.observedAtEpochMs).toLocaleString()}；仅为已记录快照。</p>
				) : (
					<p>尚无当前任务的状态观察。</p>
				)}
				{observationAvailable ? (
					<>
						<p>执行资格：{observation.executionQualification ?? "unknown"}</p>
						{observation.waitingReason ? <p>等待原因：{observation.waitingReason}</p> : null}
						{observation.materialFilePaths.length ? (
							<div>
								材料：
								{observation.materialFilePaths.map((path) => (
									<p key={path} className="select-text font-mono">
										{path}
									</p>
								))}
							</div>
						) : null}
					</>
				) : (
					<p>当前状态未证实。读取原 Run 补证，不创建替代执行。</p>
				)}
				<p className="select-text font-mono">产物目录：{binding.artifactDirectoryPath}</p>
				<Button
					size="sm"
					variant="default"
					onClick={async () => {
						try {
							await writeTextToSystemClipboardWithInsecureContextFallback(JSON.stringify(binding, null, 2));
							showAppToast({ message: "已复制原 Run 引用；继续前由所属工作流核对当前资格。" });
						} catch {
							showAppToast({ message: "复制失败，请选中材料路径或 Run 身份复制。", intent: "danger" });
						}
					}}
				>
					复制原 Run 引用
				</Button>
			</div>
		</details>
	);
}
