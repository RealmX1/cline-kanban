import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { TRPCError } from "@trpc/server";
import { type RuntimeTaskFileDownloadRequest, runtimeTaskFileDownloadRequestSchema } from "../core/api-contract";
import { taskFileAccessError } from "./task-file-access";
import type { TaskFileDownloadContents } from "./task-file-download-service";

export async function handleTaskFileDownloadHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	openDownload: (input: RuntimeTaskFileDownloadRequest) => Promise<TaskFileDownloadContents>,
): Promise<void> {
	response.setHeader("Cache-Control", "private, no-store, no-transform");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" });
		response.end();
		return;
	}
	let download: TaskFileDownloadContents | null = null;
	try {
		const params = new URL(request.url ?? "/", "http://localhost").searchParams;
		const parsed = runtimeTaskFileDownloadRequestSchema.safeParse({
			taskId: params.get("taskId"),
			expectedTaskIncarnationCreatedAtEpochMs: params.has("expectedTaskIncarnationCreatedAtEpochMs")
				? Number(params.get("expectedTaskIncarnationCreatedAtEpochMs"))
				: undefined,
			source: params.get("source"),
			path: params.get("path") ?? undefined,
			candidateId: params.get("candidateId") ?? undefined,
		});
		if (!parsed.success)
			throw new TRPCError({ code: "BAD_REQUEST", message: "下载请求缺少有效的任务身份或文件来源。" });
		download = await openDownload(parsed.data);
		const filename = encodeURIComponent(download.fileName).replace(
			/['()*]/gu,
			(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		response.setHeader("Content-Disposition", `attachment; filename="task-file"; filename*=UTF-8''${filename}`);
		const markdown = "markdown" in download ? Buffer.from(download.markdown, "utf8") : null;
		response.writeHead(200, {
			"Content-Type": markdown ? "text/markdown; charset=utf-8" : "application/octet-stream",
			"Content-Length": markdown ? markdown.length : "size" in download ? download.size : 0,
		});
		if (request.method === "HEAD") response.end();
		else if (markdown) response.end(markdown);
		else if ("handle" in download) await pipeline(download.handle.createReadStream({ autoClose: false }), response);
	} catch (error) {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		const failure = taskFileAccessError(error);
		const status =
			failure.code === "FORBIDDEN"
				? 403
				: failure.code === "CONFLICT"
					? 409
					: failure.code === "BAD_REQUEST"
						? 400
						: 404;
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"X-Kanban-Download-Error": encodeURIComponent(failure.message),
		});
		response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: failure.message }));
	} finally {
		if (download && "handle" in download) await download.handle.close();
	}
}
