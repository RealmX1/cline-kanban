import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { TaskCardBody } from "@/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "@/components/task-card-body-visual-density-context";
import { TaskOriginalPromptDialog } from "@/components/task-original-prompt-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePermanentlyDeletedTaskHistory } from "@/hooks/use-permanently-deleted-task-history";
import { useTextInputValueCommittedAfterImeCompositionEnds } from "@/hooks/use-text-input-value-committed-after-ime-composition-ends";
import { readPermanentlyDeletedTaskPromptVersions } from "@/runtime/permanently-deleted-task-history-query";
import type { PermanentlyDeletedTaskCardEntry } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

function HistoricalTaskPromptViewer({
	entry,
	onClose,
}: {
	entry: PermanentlyDeletedTaskCardEntry;
	onClose: () => void;
}) {
	const queryFn = useCallback(
		() => readPermanentlyDeletedTaskPromptVersions({ kanbanBoardCard: entry.kanbanBoardCard }),
		[entry],
	);
	const query = useTrpcQuery({ enabled: true, queryFn });
	return (
		<TaskOriginalPromptDialog
			open
			onClose={onClose}
			card={{
				title: entry.titleBeforePermanentRemoval ?? "标题未留存",
				prompt: "",
				createdAt: entry.kanbanBoardCard.taskIncarnationCreatedAtEpochMs,
			}}
			permanentlyDeletedTaskPromptHistory={{
				versions: query.data,
				isLoading: query.isLoading,
				errorMessage: query.error?.message ?? null,
				onRetry: () => {
					void query.refetch();
				},
				workspaceId: entry.kanbanBoardCard.workspaceId,
				deletedAt: entry.permanentlyRemovedFromBoardAt,
			}}
		/>
	);
}

export function PermanentlyDeletedTaskHistoryDialog({
	defaultWorkspaceId,
	currentProjectId,
	projects,
	onClose,
}: {
	defaultWorkspaceId: string | null;
	currentProjectId: string | null;
	projects: readonly { id: string; name: string }[];
	onClose: () => void;
}) {
	const history = usePermanentlyDeletedTaskHistory(defaultWorkspaceId);
	const [selectedEntry, setSelectedEntry] = useState<PermanentlyDeletedTaskCardEntry | null>(null);
	const { binding } = useTextInputValueCommittedAfterImeCompositionEnds({
		committedValue: history.query,
		onCommitValue: history.setQuery,
	});
	const knownIds = [
		...new Set([
			...(currentProjectId ? [currentProjectId] : []),
			...history.page.knownWorkspaces.map((workspace) => workspace.workspaceId),
			...(history.workspaceId ? [history.workspaceId] : []),
		]),
	];
	return (
		<TooltipProvider>
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) onClose();
				}}
				contentClassName="max-w-3xl!"
				contentAriaDescribedBy="permanently-deleted-task-history-description"
			>
				<DialogHeader title="已删除 Task" icon={<Trash2 size={16} />} />
				<DialogBody className="flex min-h-0 flex-col gap-3">
					<p id="permanently-deleted-task-history-description" className="m-0 text-xs text-text-secondary">
						这里只查永久删除记录；Done / Trash 卡片仍属于看板，请使用普通搜索。
					</p>
					<div className="flex flex-wrap gap-2">
						<input
							{...binding}
							aria-label="搜索已删除 Task"
							placeholder="输入 Task ID、标题或 Prompt 关键词"
							className="min-w-0 basis-full flex-1 rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary outline-accent sm:basis-0"
						/>
						<select
							aria-label="已删除 Task 的项目范围"
							value={history.workspaceId ?? ""}
							onChange={(event) => history.setWorkspaceId(event.target.value || null)}
							className="max-w-full rounded-md border border-border bg-surface-0 px-2 py-2 text-sm text-text-primary"
						>
							<option value="">全部项目</option>
							{knownIds.map((id) => (
								<option key={id} value={id}>
									{projects.find((project) => project.id === id)?.name ?? id}
									{id === currentProjectId ? "（当前项目）" : ""}
								</option>
							))}
						</select>
						<Button onClick={history.refresh} aria-label="刷新已删除 Task">
							刷新
						</Button>
					</div>
					{history.error ? (
						<div role="alert" className="flex items-center gap-2 text-sm text-status-orange">
							<span>{history.error}</span>
							<Button onClick={history.refresh}>重试查询</Button>
						</div>
					) : null}
					<div className="flex min-h-0 flex-col gap-3" aria-busy={history.isLoading}>
						<TaskCardBodyVisualDensityProvider value="compact_row_in_focus_view_left_column">
							{history.page.entries.map((entry) => (
								<div key={JSON.stringify(entry.kanbanBoardCard)} className="rounded-md p-0 ring-1 ring-border">
									<TaskCardBody
										historicalTaskCard={entry}
										historicalProjectName={
											projects.find((project) => project.id === entry.kanbanBoardCard.workspaceId)?.name
										}
										onOpenHistoricalPrompt={() => setSelectedEntry(entry)}
									/>
								</div>
							))}
						</TaskCardBodyVisualDensityProvider>
						{history.isLoading ? (
							<div role="status" className="flex items-center gap-2 py-4 text-sm text-text-secondary">
								<Spinner size={16} />
								正在读取历史…
							</div>
						) : !history.error && !history.page.entries.length ? (
							<p className="text-sm text-text-secondary">
								未找到已删除 Task。可切换全部项目或调整关键词；未被记录或未留存正文的历史可能无法查到。
							</p>
						) : null}
						{history.page.nextCursor ? (
							<Button disabled={history.isLoading} onClick={history.loadMore}>
								继续加载
							</Button>
						) : null}
					</div>
				</DialogBody>
			</Dialog>
			{selectedEntry ? (
				<HistoricalTaskPromptViewer
					key={JSON.stringify(selectedEntry.kanbanBoardCard)}
					entry={selectedEntry}
					onClose={() => setSelectedEntry(null)}
				/>
			) : null}
		</TooltipProvider>
	);
}
