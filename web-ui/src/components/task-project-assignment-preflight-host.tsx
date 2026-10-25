import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	getPendingTaskProjectAssignmentDecisions,
	subscribeToTaskProjectAssignmentDecisions,
} from "@/state/task-project-assignment-preflight";

export function TaskProjectAssignmentPreflightHost() {
	const request = useSyncExternalStore(
		subscribeToTaskProjectAssignmentDecisions,
		getPendingTaskProjectAssignmentDecisions,
		getPendingTaskProjectAssignmentDecisions,
	)[0];
	return (
		<Dialog
			open={!!request}
			onOpenChange={(open) => {
				if (!open) request?.resolve("cancel");
			}}
			contentClassName="max-w-xl"
		>
			<DialogHeader title={request?.failureMessage ? "项目分析未完成" : "项目归属建议"} />
			<DialogBody>
				<p className="mb-3 text-sm font-medium text-text-primary">{request?.title || "当前任务"}</p>
				<p
					className="whitespace-pre-wrap text-sm text-text-secondary"
					role={request?.failureMessage ? "alert" : undefined}
				>
					{request?.failureMessage ?? request?.analysis?.rationale}
				</p>
				{request?.analysis?.suggestedProjectName ? (
					<p className="mt-3 text-sm text-text-primary">建议项目：{request.analysis.suggestedProjectName}</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button onClick={() => request?.resolve("cancel")}>返回编辑</Button>
				<Button onClick={() => request?.resolve("keep")}>
					{request?.failureMessage ? "继续使用原项目" : "保留原项目"}
				</Button>
				{request?.analysis?.suggestedWorkspaceId ? (
					<Button variant="primary" onClick={() => request.resolve("adopt")}>
						采纳项目建议
					</Button>
				) : null}
			</DialogFooter>
		</Dialog>
	);
}
