import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { constants } from "node:zlib";
import compression from "compression";

const compressHttpResponse = compression({
	threshold: 1024,
	level: 4,
	brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } },
});

export function withCompressedHttpResponses(
	handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): RequestListener {
	return (request, response) => {
		response.setHeader("Cache-Control", "private, no-store");
		// compression 的类型声明沿用 Express，实际只依赖原生 Node HTTP 请求/响应。
		compressHttpResponse(
			request as Parameters<typeof compressHttpResponse>[0],
			response as Parameters<typeof compressHttpResponse>[1],
			() => {
				void Promise.resolve(handler(request, response)).catch(() => response.destroy());
			},
		);
	};
}
