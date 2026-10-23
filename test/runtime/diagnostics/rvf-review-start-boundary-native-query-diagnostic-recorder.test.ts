import { describe, expect, it, vi } from "vitest";
import { createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder } from "../../../src/diagnostics/rvf-review-start-boundary-native-query-diagnostic-recorder";
import type { CodexNativeControlSocketRequestDiagnostic } from "../../../src/rvf-automatic-closeout/codex-app-server-control-socket-request-connection";

const diagnostic: CodexNativeControlSocketRequestDiagnostic = {
	event: "request_finished",
	connectionId: "connection-one",
	endpointSha256: "endpoint-fingerprint",
	connectionElapsedMs: 40,
	requestTimeoutMs: 2000,
	pendingRequestCount: 0,
	receivedFrameCount: 4,
	receivedByteCount: 1_200_000,
	requestId: 3,
	method: "thread/turns/list",
	requestElapsedMs: 35,
	outcome: "resolved",
};

describe("RVF 原生查询诊断归属", () => {
	it("并发 nonce、身份快照和连接各自归属，执行版本未知时不猜测磁盘版本", () => {
		const append = vi.fn();
		const first = createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder(
			{ workspaceId: "workspace", taskId: "task", requestNonce: "nonce-one" },
			append,
		);
		const second = createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder(
			{ workspaceId: "workspace", taskId: "task", requestNonce: "nonce-two" },
			append,
		);
		const identity = {
			conversationSessionId: "conversation-one",
			runtimeSessionIncarnationId: "incarnation-one",
			nativeSessionId: "native-one",
		};
		first.bindIdentity(identity);
		identity.nativeSessionId = "changed-after-snapshot";
		second.bindIdentity({ ...identity, conversationSessionId: "conversation-two" });
		second.onDiagnostic({ ...diagnostic, connectionId: "connection-two", outcome: "protocol_error" });
		first.onDiagnostic(diagnostic);
		first.finishObservation("observation_verified");
		second.finishObservation("observation_failed");
		expect(append.mock.calls).toEqual([
			[
				"codex-native-control-socket-request-diagnostic",
				expect.objectContaining({
					requestNonce: "nonce-two",
					connectionId: "connection-two",
					conversationSessionId: "conversation-two",
					nativeSessionId: "changed-after-snapshot",
					outcome: "protocol_error",
				}),
			],
			[
				"codex-native-control-socket-request-diagnostic",
				expect.objectContaining({
					requestNonce: "nonce-one",
					connectionId: "connection-one",
					conversationSessionId: "conversation-one",
					nativeSessionId: "native-one",
					outcome: "resolved",
					loadedRuntimeBuildIdentity: "unknown",
					nodeVersion: process.version,
					runtimeExecutablePath: process.execPath,
				}),
			],
			[
				"codex-native-control-socket-request-diagnostic",
				expect.objectContaining({
					requestNonce: "nonce-one",
					event: "observation_finished",
					outcome: "observation_verified",
				}),
			],
			[
				"codex-native-control-socket-request-diagnostic",
				expect.objectContaining({
					requestNonce: "nonce-two",
					event: "observation_finished",
					outcome: "observation_failed",
				}),
			],
		]);
	});

	it("journal 写入抛错也不阻断请求或观测结案", () => {
		const recorder = createRvfReviewStartBoundaryNativeQueryDiagnosticRecorder(
			{ workspaceId: "workspace", taskId: "task", requestNonce: "nonce" },
			() => {
				throw new Error("journal unavailable");
			},
		);
		expect(() => recorder.onDiagnostic(diagnostic)).not.toThrow();
		expect(() => recorder.finishObservation("observation_failed")).not.toThrow();
	});
});
