import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getRuntimeAssetCacheControl } from "../../../src/server/assets";
import { withCompressedHttpResponses } from "../../../src/server/http-response-compression";

describe("HTTP 压缩与静态缓存", () => {
	it("协商 Brotli/gzip，保留 Vary 并移除压缩前长度；小响应及 HEAD 不产生正文", async () => {
		const body = JSON.stringify({ text: "完整活动文本。".repeat(1000) });
		const server = createServer(
			withCompressedHttpResponses((req, res) => {
				const content = req.url === "/small" ? "{}" : body;
				res.setHeader("Vary", "Origin");
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Content-Length", Buffer.byteLength(content));
				res.end(content);
			}),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		try {
			for (const encoding of ["br", "gzip", "identity"]) {
				const response = await readResponse((server.address() as AddressInfo).port, "/large", encoding);
				expect(response.headers.vary).toContain("Origin");
				expect(response.headers.vary).toContain("Accept-Encoding");
				expect(response.headers["cache-control"]).toBe("private, no-store");
				const decoded =
					encoding === "br"
						? brotliDecompressSync(response.body)
						: encoding === "gzip"
							? gunzipSync(response.body)
							: response.body;
				expect(decoded.toString()).toBe(body);
				if (encoding !== "identity") {
					expect(response.headers["content-encoding"]).toBe(encoding);
					expect(response.headers["content-length"]).toBeUndefined();
					expect(response.body.length).toBeLessThan(Buffer.byteLength(body) / 10);
				}
			}
			const small = await readResponse((server.address() as AddressInfo).port, "/small", "gzip");
			expect(small.headers["content-encoding"]).toBeUndefined();
			const head = await readResponse((server.address() as AddressInfo).port, "/large", "br", "HEAD");
			expect(head.body.length).toBe(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
	it("只有内容哈希资源长期缓存，入口与更新检查继续重新验证", () => {
		expect(getRuntimeAssetCacheControl("/assets/index-abcdefgh.js", "text/javascript")).toContain("immutable");
		for (const path of [
			"/index.html",
			"/sw.js",
			"/manifest.webmanifest",
			"/assets/index.js",
			"/assets/sw-abcdefgh.js",
			"/assets/service-worker-abcdefgh.js",
			"/assets/manifest-abcdefgh.webmanifest",
		]) {
			expect(getRuntimeAssetCacheControl(path, "text/javascript")).toBe("no-cache");
		}
		expect(getRuntimeAssetCacheControl("/assets/index-abcdefgh.js", "text/html")).toBe("no-cache");
		expect(getRuntimeAssetCacheControl("/assets/application-abcdefgh.json", "application/manifest+json")).toBe(
			"no-cache",
		);
	});
});

function readResponse(port: number, path: string, encoding: string, method = "GET") {
	return new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path, method, headers: { "Accept-Encoding": encoding } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("error", reject);
				res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}
