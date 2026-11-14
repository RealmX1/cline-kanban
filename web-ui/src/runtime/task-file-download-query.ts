import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskDirectoryRequest,
	RuntimeTaskFileDownloadRequest,
	RuntimeTaskFileIdentityRequest,
} from "@/runtime/types";

export const fetchTaskDirectory = (workspaceId: string, input: RuntimeTaskDirectoryRequest) =>
	getRuntimeTrpcClient(workspaceId).runtime.listTaskDirectory.query(input);
export const fetchTaskMainSessionPlan = (workspaceId: string, input: RuntimeTaskFileIdentityRequest) =>
	getRuntimeTrpcClient(workspaceId).runtime.getTaskMainSessionPlan.query(input);

export async function startTaskFileDownload(
	workspaceId: string,
	input: RuntimeTaskFileDownloadRequest,
	signal?: AbortSignal,
): Promise<void> {
	const query = new URLSearchParams({
		workspaceId,
		taskId: input.taskId,
		expectedTaskIncarnationCreatedAtEpochMs: String(input.expectedTaskIncarnationCreatedAtEpochMs),
		source: input.source,
	});
	if (input.path !== undefined) query.set("path", input.path);
	if (input.candidateId !== undefined) query.set("candidateId", input.candidateId);
	const url = `/api/task-file-download?${query}`;
	// HEAD 只核验来源与可读性，原文件由浏览器下载管理器直接接收，不进入前端内存。
	const response = await fetch(url, { method: "HEAD", credentials: "same-origin", cache: "no-store", signal });
	if (!response.ok) {
		const detail = response.headers.get("x-kanban-download-error");
		throw new Error(
			detail
				? decodeURIComponent(detail)
				: response.status === 401
					? "请先登录，再重新下载。"
					: "文件暂不可下载，请刷新后重试。",
		);
	}
	signal?.throwIfAborted();
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = "";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
}
