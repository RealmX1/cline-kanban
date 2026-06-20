import { describe, expect, it } from "vitest";
import { classifyConnectionError } from "../../../../src/terminal/output-reactions/connection-error-patterns";
import { normalizeDecodedTerminalOutput } from "../../../../src/terminal/terminal-output-normalization";

function classifyRaw(rawTerminalText: string) {
	return classifyConnectionError(normalizeDecodedTerminalOutput(rawTerminalText));
}

describe("classifyConnectionError — transient connection errors", () => {
	it("matches the real Claude Code 'Connection closed mid-response' line with ANSI + carriage-return redraw", () => {
		// 真实 Claude 错误行：带 `⏺` 前缀、ANSI 颜色、并用 `\r` 原地重绘。
		const raw = "[31m\r⏺ API Error: Connection closed mid-response. The response above may be incomplete.[0m\r";
		const result = classifyRaw(raw);
		expect(result.classification).toBe("transient");
		expect(result.signature).not.toBeNull();
	});

	it("matches common transient network error tokens", () => {
		for (const token of [
			"Error: read ECONNRESET",
			"TypeError: fetch failed",
			"stream disconnected before completion",
			"socket hang up",
			"request timed out",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"Error: getaddrinfo EAI_AGAIN api.anthropic.com",
			"connection reset by peer",
		]) {
			expect(classifyRaw(token).classification).toBe("transient");
		}
	});
});

describe("classifyConnectionError — permanent errors (never auto-continue)", () => {
	it("classifies auth / quota / 400 / context-overflow as permanent", () => {
		for (const token of [
			"401 Unauthorized",
			"Invalid API key provided",
			"429 Too Many Requests: rate limit reached",
			"insufficient_quota: you have exceeded your quota",
			"400 Bad Request: invalid_request_error",
			"prompt is too long: 250000 tokens exceeds the maximum",
			"context_length_exceeded",
		]) {
			expect(classifyRaw(token).classification).toBe("permanent");
		}
	});

	it("short-circuits to permanent even when a transient token is also present", () => {
		// 同一段文本里同时出现 429（permanent）与 connection reset（transient）：先判 permanent。
		const result = classifyRaw("429 rate limit reached after connection reset");
		expect(result.classification).toBe("permanent");
	});
});

describe("classifyConnectionError — non-errors", () => {
	it("returns null for ordinary agent output", () => {
		for (const token of ["Reading file src/index.ts", "Running tests…", "✓ 42 passed", "Editing component"]) {
			expect(classifyRaw(token).classification).toBeNull();
		}
	});

	it("does NOT classify ordinary output that merely contains the word timeout / a bare 5xx number", () => {
		// 收紧正则后：裸 `timeout` / `timed out` / 裸 5xx 数字不再误判为 transient，
		// 避免正常自主运行（写 setTimeout、讨论 500/overloaded、测试输出含 timeout）误起伪 episode。
		for (const token of [
			"const id = setTimeout(fn, 30)",
			"await sleep({ timeout: 5000 })",
			"the request timeout is configured to 30s",
			"jest test 'handles timeout' passed",
			"expected status 502 but got 200 in the mock fixture",
			"discuss the 500 line budget for this module",
			"status code 503 is asserted in the unit test fixture",
		]) {
			expect(classifyRaw(token).classification).toBeNull();
		}
	});

	it("still classifies explicit timeout phrases and 5xx gateway phrases as transient", () => {
		for (const token of [
			"Error: request timed out",
			"read timed out after 60s",
			"502 Bad Gateway",
			"503 Service Unavailable",
			"504 Gateway Timeout",
			"500 Internal Server Error",
			'{"type":"overloaded_error","message":"Overloaded"}',
			"upstream responded HTTP 529",
		]) {
			expect(classifyRaw(token).classification).toBe("transient");
		}
	});

	it("returns null for empty input", () => {
		expect(classifyRaw("").classification).toBeNull();
	});
});
