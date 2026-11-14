import { ArrowUp, Download, FileText, Folder, Link, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchTaskDirectory, startTaskFileDownload } from "@/runtime/task-file-download-query";
import type { RuntimeTaskDirectoryResponse } from "@/runtime/types";

export function TaskFilesPanel({
	workspaceId,
	taskId,
	taskCreatedAtEpochMs,
	headerNavigationContent,
	headerEndActions,
}: {
	workspaceId: string | null;
	taskId: string;
	taskCreatedAtEpochMs: number;
	headerNavigationContent?: ReactNode;
	headerEndActions?: ReactNode;
}) {
	const identity = JSON.stringify([workspaceId, taskId, taskCreatedAtEpochMs]);
	const [directory, setDirectory] = useState({ identity, path: "" });
	const path = directory.identity === identity ? directory.path : "";
	const [refresh, setRefresh] = useState(0);
	const [result, setResult] = useState<{
		identity: string;
		path: string;
		listing?: RuntimeTaskDirectoryResponse;
		error?: string;
	} | null>(null);
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const currentIdentity = useRef(identity);
	const downloadAbortController = useRef<AbortController | null>(null);
	currentIdentity.current = identity;
	useEffect(() => {
		downloadAbortController.current = new AbortController();
		return () => downloadAbortController.current?.abort();
	}, [identity]);
	useEffect(() => {
		let cancelled = false;
		setResult(null);
		setDownloadError(null);
		if (!workspaceId) return;
		void fetchTaskDirectory(workspaceId, {
			taskId,
			expectedTaskIncarnationCreatedAtEpochMs: taskCreatedAtEpochMs,
			path,
		}).then(
			(listing) => {
				if (!cancelled) setResult({ identity, path, listing });
			},
			(error: unknown) => {
				if (!cancelled)
					setResult({ identity, path, error: error instanceof Error ? error.message : "目录读取失败，请重试。" });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [workspaceId, taskId, taskCreatedAtEpochMs, identity, path, refresh]);
	const current = result?.identity === identity && result.path === path ? result : null;
	const navigate = (nextPath: string) => setDirectory({ identity, path: nextPath });
	const segments = path.split("/").filter(Boolean);
	const download = async (filePath: string) => {
		if (!workspaceId) return;
		setDownloadError(null);
		try {
			await startTaskFileDownload(
				workspaceId,
				{
					taskId,
					expectedTaskIncarnationCreatedAtEpochMs: taskCreatedAtEpochMs,
					source: "task_file",
					path: filePath,
				},
				downloadAbortController.current?.signal,
			);
		} catch (error) {
			if (currentIdentity.current === identity)
				setDownloadError(error instanceof Error ? error.message : "下载失败，请重试。");
		}
	};
	return (
		<section aria-label="任务文件" className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
				{headerNavigationContent ?? <span className="text-xs font-medium text-text-primary">任务文件</span>}
				<Button
					size="sm"
					variant="ghost"
					aria-label="刷新任务文件"
					icon={<RefreshCw size={13} />}
					onClick={() => setRefresh((value) => value + 1)}
				/>
				{headerEndActions}
			</div>
			<nav
				aria-label="任务文件目录"
				className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs"
			>
				<Button
					size="xs"
					variant="ghost"
					aria-label="返回上级目录"
					disabled={!path}
					icon={<ArrowUp size={12} />}
					onClick={() => navigate(segments.slice(0, -1).join("/"))}
				/>
				<Button size="xs" variant="ghost" aria-label="返回任务根目录" onClick={() => navigate("")}>
					任务根目录
				</Button>
				{segments.map((segment, index) => (
					<span className="flex min-w-0 items-center" key={segments.slice(0, index + 1).join("/")}>
						<span aria-hidden="true" className="text-text-secondary">
							/
						</span>
						<Button
							size="xs"
							variant="ghost"
							className="max-w-40 truncate"
							onClick={() => navigate(segments.slice(0, index + 1).join("/"))}
						>
							{segment}
						</Button>
					</span>
				))}
			</nav>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
				{!workspaceId ? (
					<p className="text-xs text-text-secondary">请先选择任务所属项目。</p>
				) : !current ? (
					<p role="status" className="text-xs text-text-secondary">
						正在读取目录…
					</p>
				) : current.error ? (
					<p role="alert" className="text-xs text-status-red">
						{current.error}
					</p>
				) : current.listing?.entries.length === 0 ? (
					<p className="text-xs text-text-secondary">此目录没有文件。</p>
				) : (
					<ul>
						{current.listing?.entries.map((entry) => (
							<li
								key={entry.path}
								className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 text-xs text-text-primary hover:bg-surface-2"
							>
								{entry.kind === "directory" ? (
									<Folder size={14} className="shrink-0 text-text-secondary" />
								) : entry.kind === "symlink" ? (
									<Link size={14} className="shrink-0 text-text-secondary" />
								) : (
									<FileText size={14} className="shrink-0 text-text-secondary" />
								)}
								{entry.kind === "directory" ? (
									<button
										type="button"
										aria-label={`进入目录 ${entry.name}`}
										className="min-w-0 flex-1 truncate py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
										onClick={() => navigate(entry.path)}
									>
										{entry.name}
									</button>
								) : (
									<span className="min-w-0 flex-1 truncate" title={entry.name}>
										{entry.name}
									</span>
								)}
								{entry.kind === "file" || entry.kind === "symlink" ? (
									<Button
										size="sm"
										variant="ghost"
										aria-label={`下载文件 ${entry.name}`}
										icon={<Download size={13} />}
										onClick={() => void download(entry.path)}
									/>
								) : entry.kind === "unsupported" ? (
									<span className="text-text-secondary">不可下载</span>
								) : null}
							</li>
						))}
					</ul>
				)}
				{downloadError ? (
					<p role="alert" className="mt-2 text-xs text-status-red">
						{downloadError}
					</p>
				) : null}
			</div>
		</section>
	);
}
