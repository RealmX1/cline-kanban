import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
	type ArchivedNotificationCandidate,
	notificationIntelligenceClient,
} from "@/runtime/notification-intelligence-query";

export function NotificationArchiveBrowser({
	onFocusTask,
	grouped,
	archiveRefreshSequence = 0,
}: {
	onFocusTask: (workspaceId: string, taskId: string) => void;
	grouped: boolean;
	archiveRefreshSequence?: number;
}) {
	const [entries, setEntries] = useState<ArchivedNotificationCandidate[]>([]);
	const [cursor, setCursor] = useState<number | undefined>();
	const [nextCursor, setNextCursor] = useState<number | null>(null);
	const [total, setTotal] = useState(0);
	const [workspaceId, setWorkspaceId] = useState("");
	const [taskId, setTaskId] = useState("");
	const [processingStatus, setProcessingStatus] = useState("");
	const [fromDate, setFromDate] = useState("");
	const [untilDate, setUntilDate] = useState("");
	const [detail, setDetail] =
		useState<Awaited<ReturnType<ReturnType<typeof notificationIntelligenceClient>["getLifecycle"]["query"]>>>(null);
	const [selectedDetailCandidateId, setSelectedDetailCandidateId] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [reloadSequence, setReloadSequence] = useState(0);
	const [audioUrl, setAudioUrl] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError("");
		void notificationIntelligenceClient()
			.listArchive.query({
				workspaceId: workspaceId || undefined,
				taskId: taskId || undefined,
				processingStatus: processingStatus || undefined,
				triggeredAtOrAfter: fromDate ? new Date(fromDate).getTime() : undefined,
				triggeredAtOrBefore: untilDate ? new Date(untilDate).getTime() : undefined,
				beforeSequence: cursor,
				limit: 50,
			})
			.then((page) => {
				if (cancelled) return;
				setEntries(page.entries);
				setNextCursor(page.nextBeforeSequence);
				setTotal(page.totalCount);
			})
			.catch(() => {
				if (!cancelled) setError("无法读取完整通知档案，请检查运行时和磁盘状态。");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [cursor, workspaceId, taskId, processingStatus, fromDate, untilDate, reloadSequence, archiveRefreshSequence]);
	useEffect(() => {
		let cancelled = false;
		setDetail(null);
		if (selectedDetailCandidateId) {
			void notificationIntelligenceClient()
				.getLifecycle.query({ candidateId: selectedDetailCandidateId })
				.then((lifecycle) => {
					if (!cancelled) setDetail(lifecycle);
				})
				.catch(() => {
					if (!cancelled) setError("读取生命周期失败");
				});
		}
		return () => {
			cancelled = true;
		};
	}, [selectedDetailCandidateId, reloadSequence, archiveRefreshSequence]);
	const arrangedEntries = grouped
		? [...entries].sort(
				(left, right) =>
					`${left.workspaceId}:${left.taskId}`.localeCompare(`${right.workspaceId}:${right.taskId}`) ||
					right.sequence - left.sequence,
			)
		: entries;
	return (
		<div className="space-y-3">
			<Button size="sm" variant="ghost" onClick={() => setReloadSequence((sequence) => sequence + 1)}>
				刷新档案
			</Button>
			<p className="text-xs text-text-secondary">
				永久档案 · 共 {total} 条 · 每页 50 条。包含被筛选、已清空和已读记录。{grouped ? "当前页按任务分组。" : ""}
			</p>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
				<label className="text-xs">
					项目 ID
					<input
						className="w-full rounded border border-border bg-surface-0 p-1.5"
						value={workspaceId}
						onChange={(event) => {
							setWorkspaceId(event.target.value);
							setCursor(undefined);
						}}
					/>
				</label>
				<label className="text-xs">
					任务 ID
					<input
						className="w-full rounded border border-border bg-surface-0 p-1.5"
						value={taskId}
						onChange={(event) => {
							setTaskId(event.target.value);
							setCursor(undefined);
						}}
					/>
				</label>
				<label className="text-xs" htmlFor="notification-archive-selection-1">
					处理结果
					<NativeSelect
						id="notification-archive-selection-1"
						value={processingStatus}
						onChange={(event) => {
							setProcessingStatus(event.target.value);
							setCursor(undefined);
						}}
					>
						<option value="">全部</option>
						{["published", "excluded", "deferred", "superseded", "legacy_imported", "preview"].map((status) => (
							<option key={status} value={status}>
								{status}
							</option>
						))}
					</NativeSelect>
				</label>
			</div>
			<div className="flex flex-wrap gap-3 text-xs">
				<label>
					开始时间
					<input
						type="datetime-local"
						value={fromDate}
						onChange={(event) => {
							setFromDate(event.target.value);
							setCursor(undefined);
						}}
					/>
				</label>
				<label>
					结束时间
					<input
						type="datetime-local"
						value={untilDate}
						onChange={(event) => {
							setUntilDate(event.target.value);
							setCursor(undefined);
						}}
					/>
				</label>
			</div>
			{error && <p role="alert">{error}</p>}
			{loading && <p role="status">正在读取…</p>}
			{arrangedEntries.map((entry) => (
				<article key={entry.candidateId} className="space-y-1 rounded border border-border p-2">
					<p className="m-0 text-sm font-medium">
						{entry.repositoryNameSnapshot} · {entry.taskTitleSnapshot}
					</p>
					<p className="m-0 whitespace-pre-wrap break-words text-sm">
						{entry.summaryText || "原始通知信号（没有摘要）"}
					</p>
					<p className="m-0 text-xs text-text-secondary">
						{new Date(entry.triggeredAt).toLocaleString()} · {entry.notificationProcessingStatus} · 面板{" "}
						{entry.notificationPanelVisibility}
					</p>
					<div className="flex gap-2">
						<Button size="sm" variant="ghost" onClick={() => onFocusTask(entry.workspaceId, entry.taskId)}>
							打开任务
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setAudioUrl(null);
								setSelectedDetailCandidateId(entry.candidateId);
							}}
						>
							查看原文与判断过程
						</Button>
						{entry.summaryText && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									void notificationIntelligenceClient()
										.retryArchivedSpeech.mutate({ candidateId: entry.candidateId })
										.then((audio) => setAudioUrl(`data:${audio.mimeType};base64,${audio.audioBase64}`))
										.catch((error) => setError(error instanceof Error ? error.message : "合成失败"));
								}}
							>
								重新合成（产生 API 费用）
							</Button>
						)}
						{entry.audioSha256 && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => {
									void notificationIntelligenceClient()
										.archivedAudio.query({ candidateId: entry.candidateId })
										.then((audio) => setAudioUrl(`data:${audio.mimeType};base64,${audio.audioBase64}`))
										.catch(() => setError("归档音频不可读"));
								}}
							>
								播放已保存音频
							</Button>
						)}
					</div>
				</article>
			))}
			{audioUrl && (
				<audio controls autoPlay src={audioUrl} aria-label="归档通知音频">
					<track kind="captions" />
				</audio>
			)}
			<div className="flex gap-2">
				<Button variant="default" disabled={cursor === undefined} onClick={() => setCursor(undefined)}>
					最新一页
				</Button>
				<Button
					variant="default"
					disabled={nextCursor === null || loading}
					onClick={() => setCursor(nextCursor ?? undefined)}
				>
					更早记录
				</Button>
			</div>
			{detail && (
				<div className="rounded border border-border p-2">
					<div className="flex items-center justify-between">
						<h3 className="text-sm">通知生命周期</h3>
						<Button size="sm" variant="ghost" onClick={() => setSelectedDetailCandidateId(null)}>
							关闭详情
						</Button>
					</div>
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
						{JSON.stringify(detail, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
