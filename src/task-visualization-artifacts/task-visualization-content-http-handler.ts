import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateHost, getAllowedHostHeaders } from "../server/middleware";
import type { TaskVisualizationArtifactService } from "./task-visualization-artifact-service";

export const TASK_VISUALIZATION_CONTENT_SECURITY_POLICY =
	"sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http: https: blob:; style-src 'unsafe-inline' http: https:; img-src http: https: data: blob:; font-src http: https: data:; connect-src http: https: blob:; media-src http: https: data: blob:; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export async function handleTaskVisualizationContentHttpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	service: TaskVisualizationArtifactService,
): Promise<boolean> {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (!url.pathname.startsWith("/api/task-visualization-content/")) return false;
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	try {
		if (evaluateHost({ hostHeader: request.headers.host, allowedHosts: getAllowedHostHeaders() }).kind !== "allow")
			throw new Error("Host 不受信。");
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405, { Allow: "GET, HEAD" });
			response.end();
			return true;
		}
		const match = /^\/api\/task-visualization-content\/([A-Za-z0-9_.-]+)\/(.+)$/u.exec(url.pathname);
		if (!match) throw new Error("内容路径无效。");
		const resource = await service.readContent(match[1], decodeURIComponent(match[2]));
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
		response.setHeader("Content-Security-Policy", TASK_VISUALIZATION_CONTENT_SECURITY_POLICY);
		response.writeHead(200, { "Content-Type": resource.contentType });
		let content = resource.content;
		if (resource.contentLoadConfirmation && resource.contentType.startsWith("text/html")) {
			// 只有成功读取并校验当前修订的入口文档才含此证明，404 与旧 frame 的 load 均不能确认展示。
			const message = JSON.stringify(resource.contentLoadConfirmation).replace(/</gu, "\\u003c");
			const confirmationScript = `<script>window.addEventListener("load",()=>parent.postMessage(${message},"*"),{once:true});</script>`;
			const html = content.toString("utf8");
			const doctype = /^(\s*<!doctype[^>]*>)/iu.exec(html)?.[0] ?? "";
			content = Buffer.from(`${doctype}${confirmationScript}${html.slice(doctype.length)}`);
		}
		response.end(request.method === "HEAD" ? undefined : content);
	} catch {
		response.writeHead(404, {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Security-Policy": "sandbox; default-src 'none'",
		});
		response.end("可视化资源不可用，请刷新查看器。");
	}
	return true;
}
