// 热重启 P3：hosted 会话里的 hooks CLI 在 runtime 不可达时把事件存进 agent session PTY host 的 spool。
// 这里锁住「何时不必再重试」与「哪些事件可以在 spool 里合并」两个判据。
import { describe, expect, it, vi } from "vitest";
import type { HostedSessionBindingToAgentSessionPtyHost } from "../../../src/agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import { isRuntimeConnectionRefusedTransportError } from "../../../src/commands/cli-runtime-request-retry-while-kanban-runtime-restarts";
import {
	buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding,
	deliverHookIngestWithRetry,
	isHookEventCoalescibleInAgentSessionPtyHostSpool,
} from "../../../src/commands/hooks";
import type { RuntimeHookIngestResponse } from "../../../src/core/api-contract";

// fetch 失败时 ECONNREFUSED 藏在 cause 链里（undici: TypeError("fetch failed", { cause: { code } })，tRPC 再包一层）。
function buildRuntimeConnectionRefusedError(): Error {
	const systemError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3484"), { code: "ECONNREFUSED" });
	const fetchError = new TypeError("fetch failed", { cause: systemError });
	return new Error("fetch failed", { cause: fetchError });
}

describe("isRuntimeConnectionRefusedTransportError", () => {
	it("recognizes ECONNREFUSED nested in the fetch error cause chain", () => {
		expect(isRuntimeConnectionRefusedTransportError(buildRuntimeConnectionRefusedError())).toBe(true);
	});

	it("does not treat a timeout as connection refused (the request may have been sent)", () => {
		expect(isRuntimeConnectionRefusedTransportError(new Error("kanban hooks ingest timed out after 3500ms"))).toBe(
			false,
		);
		const resetError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		expect(isRuntimeConnectionRefusedTransportError(new TypeError("fetch failed", { cause: resetError }))).toBe(
			false,
		);
	});
});

const hostedSessionBindingToAgentSessionPtyHostForTest: HostedSessionBindingToAgentSessionPtyHost = {
	agentSessionPtyHostSocketPath: "/nonexistent/agent-session-pty-host.sock",
	hostedSessionKey: "hosted-session-key-1",
};

function neverResolvingHookIngestMutation(): Promise<RuntimeHookIngestResponse> {
	return new Promise<RuntimeHookIngestResponse>(() => {
		// 永不 resolve → withTimeout 在 timeoutMs 后 reject（模拟直投超时 / runtime 挂起）。
	});
}

// Codex 同步 hook 期限 8s：有 host 绑定时最坏耗时必须是「一次直投超时 + spool 期限」，
// 不能是「两次直投超时 + 退避 + spool 期限」（3500×2 + 250 + 1500 = 8750ms）。
describe("deliverHookIngestWithRetry with a host spool available", () => {
	it("stops retrying at once when the runtime is not listening", async () => {
		const mutate = vi.fn(
			(): Promise<RuntimeHookIngestResponse> => Promise.reject(buildRuntimeConnectionRefusedError()),
		);
		const onFinalFailure = vi.fn();

		await expect(
			deliverHookIngestWithRetry(mutate, {
				timeoutMs: 1_000,
				maxAttempts: 2,
				backoffMs: 0,
				shouldStopRetryingAfterTransportError:
					buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding(
						hostedSessionBindingToAgentSessionPtyHostForTest,
					),
				onFinalFailure,
			}),
		).rejects.toThrow("fetch failed");

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, failureKind: "transport" }));
	});

	it("stops retrying after a single direct-delivery timeout and hands the event to the spool", async () => {
		const mutate = vi.fn(neverResolvingHookIngestMutation);
		const onFinalFailure = vi.fn();

		await expect(
			deliverHookIngestWithRetry(mutate, {
				timeoutMs: 5,
				maxAttempts: 2,
				backoffMs: 0,
				shouldStopRetryingAfterTransportError:
					buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding(
						hostedSessionBindingToAgentSessionPtyHostForTest,
					),
				onFinalFailure,
			}),
		).rejects.toThrow(/timed out/);

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, failureKind: "transport" }));
	});
});

describe("deliverHookIngestWithRetry without a host spool", () => {
	it("keeps retrying a direct-delivery timeout up to maxAttempts", async () => {
		const mutate = vi.fn(neverResolvingHookIngestMutation);
		const onFinalFailure = vi.fn();

		await expect(
			deliverHookIngestWithRetry(mutate, {
				timeoutMs: 5,
				maxAttempts: 2,
				backoffMs: 0,
				shouldStopRetryingAfterTransportError:
					buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding(null),
				onFinalFailure,
			}),
		).rejects.toThrow(/timed out/);

		expect(mutate).toHaveBeenCalledTimes(2);
		expect(onFinalFailure).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, failureKind: "transport" }));
	});
});

describe("isHookEventCoalescibleInAgentSessionPtyHostSpool", () => {
	const baseHookIngestArgs = { taskId: "task-1", workspaceId: "workspace-1" };

	it("lets plain activity collapse into the latest one", () => {
		expect(isHookEventCoalescibleInAgentSessionPtyHostSpool({ ...baseHookIngestArgs, event: "activity" })).toBe(true);
	});

	it("keeps every lifecycle event and every event carrying a decision", () => {
		expect(isHookEventCoalescibleInAgentSessionPtyHostSpool({ ...baseHookIngestArgs, event: "to_review" })).toBe(
			false,
		);
		expect(
			isHookEventCoalescibleInAgentSessionPtyHostSpool({
				...baseHookIngestArgs,
				event: "main_agent_conversation_context_compaction_completed",
			}),
		).toBe(false);
		expect(
			isHookEventCoalescibleInAgentSessionPtyHostSpool({
				...baseHookIngestArgs,
				event: "activity",
				agentRaisedUserQuestionResolvedInAgentTerminal: {
					decisionSourceId: "tool-use-1",
					resolution: "answered_in_agent_terminal",
				} as never,
			}),
		).toBe(false);
	});
});
