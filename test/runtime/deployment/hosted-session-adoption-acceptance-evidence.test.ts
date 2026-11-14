import { describe, expect, it } from "vitest";
import {
	type HostedSessionRuntimeAdoptionAcceptanceReceipt,
	hostedSessionAdoptionReceiptMatchesDeploymentRestart,
} from "../../../src/terminal/hosted-session-runtime-adoption-acceptance-receipt";

describe("历史接管接受与后续正常回收分开", () => {
	it("原会话当前已回收不抹掉接受；旧部署、错代际和错载入代码均不算本次接受", () => {
		const original = {
			workspaceId: "workspace",
			conversationSessionId: "task-session",
			hostSocketPath: "/host.sock",
			hostedSessionKey: "hosted-key",
			processId: 123,
			processStartedAtEpochMs: 10,
			runtimeSessionIncarnationId: "incarnation",
			nativeConversationSessionId: "native",
		};
		const receipt: HostedSessionRuntimeAdoptionAcceptanceReceipt = {
			schemaVersion: 1,
			workspaceId: "workspace",
			conversationSessionId: "task-session",
			hostSocketPath: "/host.sock",
			hostedSessionKey: "hosted-key",
			sessionProcessId: 123,
			sessionProcessStartedAtEpochMs: 10,
			runtimeSessionIncarnationId: "incarnation",
			nativeConversationSessionId: "native",
			acceptingRuntimeProcessInstanceId: "successor",
			acceptingRuntimeProcessId: 222,
			acceptingRuntimeEntrypointSha256: "a".repeat(64),
			acceptedAtEpochMs: 200,
			summarySource: "usable_adoption_record",
		};
		const input = {
			receipt,
			originalSession: original,
			candidateEntrypointSha256: "a".repeat(64),
			restartIntentAtEpochMs: 100,
			previousRuntimeProcessId: 111,
		};
		expect(hostedSessionAdoptionReceiptMatchesDeploymentRestart(input)).toBe(true);
		for (const changed of [
			{ acceptedAtEpochMs: 99 },
			{ runtimeSessionIncarnationId: "different" },
			{ sessionProcessId: 999 },
			{ acceptingRuntimeEntrypointSha256: "b".repeat(64) },
			{ hostSocketPath: "/other-host.sock" },
		]) {
			expect(
				hostedSessionAdoptionReceiptMatchesDeploymentRestart({ ...input, receipt: { ...receipt, ...changed } }),
			).toBe(false);
		}
		expect(hostedSessionAdoptionReceiptMatchesDeploymentRestart(input)).toBe(true);
	});
});
