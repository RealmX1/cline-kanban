// 「这条 agent 会话该走哪条通话通道」的域逻辑。最要紧的两条不变量：
//  1. 解析优先级恒为「显式请求 → 卡片建卡时固化值 → 全局新任务默认 → catalog 默认」；
//  2. 不可切换的 agent 收到别的通道请求时**如实报告降级**，绝不假装生效（与权限档同一口径）。
import { describe, expect, it } from "vitest";

import { getRuntimeAgentSessionTransport } from "../../../src/core/agent-catalog";
import {
	canAgentSessionTransportBeSwitched,
	doesAgentSupportSessionTransport,
	getOppositeAgentSessionTransport,
	getSwitchableAgentSessionTransportsForAgent,
	resolveAgentSessionTransportForLaunch,
	resolveAgentSessionTransportPinnedAtTaskCreation,
} from "../../../src/core/agent-session-transport-selection";

describe("agent session transport selection", () => {
	it("treats omp as the only switchable agent, with TUI as its default", () => {
		expect(canAgentSessionTransportBeSwitched("omp")).toBe(true);
		expect(getSwitchableAgentSessionTransportsForAgent("omp")).toEqual(["pty_terminal", "acp_stdio_subprocess"]);
		expect(getRuntimeAgentSessionTransport("omp")).toBe("pty_terminal");

		for (const agentId of ["claude", "codex", "cursor", "kimi", "droid", "kiro", "cline"] as const) {
			expect(canAgentSessionTransportBeSwitched(agentId)).toBe(false);
		}
		expect(canAgentSessionTransportBeSwitched(null)).toBe(false);
	});

	it("returns the other transport for a switchable agent and null otherwise", () => {
		expect(getOppositeAgentSessionTransport("omp", "pty_terminal")).toBe("acp_stdio_subprocess");
		expect(getOppositeAgentSessionTransport("omp", "acp_stdio_subprocess")).toBe("pty_terminal");
		expect(getOppositeAgentSessionTransport("claude", "pty_terminal")).toBeNull();
	});

	it("only accepts transports the agent can actually run over", () => {
		expect(doesAgentSupportSessionTransport("omp", "pty_terminal")).toBe(true);
		expect(doesAgentSupportSessionTransport("omp", "acp_stdio_subprocess")).toBe(true);
		expect(doesAgentSupportSessionTransport("omp", "in_process_cline_sdk")).toBe(false);
		expect(doesAgentSupportSessionTransport("claude", "acp_stdio_subprocess")).toBe(false);
		expect(doesAgentSupportSessionTransport("cline", "in_process_cline_sdk")).toBe(true);
	});

	it("resolves launch transport with explicit request > card pin > global default > catalog default", () => {
		expect(
			resolveAgentSessionTransportForLaunch({
				agentId: "omp",
				explicitlyRequestedSessionTransport: "acp_stdio_subprocess",
				cardPinnedSessionTransport: "pty_terminal",
				globalDefaultSessionTransportForNewTasks: "pty_terminal",
			}).effectiveSessionTransport,
		).toBe("acp_stdio_subprocess");

		expect(
			resolveAgentSessionTransportForLaunch({
				agentId: "omp",
				cardPinnedSessionTransport: "acp_stdio_subprocess",
				globalDefaultSessionTransportForNewTasks: "pty_terminal",
			}).effectiveSessionTransport,
		).toBe("acp_stdio_subprocess");

		expect(
			resolveAgentSessionTransportForLaunch({
				agentId: "omp",
				globalDefaultSessionTransportForNewTasks: "acp_stdio_subprocess",
			}).effectiveSessionTransport,
		).toBe("acp_stdio_subprocess");

		expect(resolveAgentSessionTransportForLaunch({ agentId: "omp" }).effectiveSessionTransport).toBe("pty_terminal");
	});

	// 本轮有意为之的默认切换：本改动之前建的 omp 卡片没有固化字段，于是回落到全局默认（= TUI），
	// 把它们从 ACP 翻到 TUI。这条钉住那个行为，别在重构时把回落改成 catalog 默认再悄悄改回去。
	it("falls back to the global default for legacy cards that have no pinned transport", () => {
		const resolved = resolveAgentSessionTransportForLaunch({
			agentId: "omp",
			cardPinnedSessionTransport: null,
			globalDefaultSessionTransportForNewTasks: "pty_terminal",
		});
		expect(resolved.effectiveSessionTransport).toBe("pty_terminal");
		expect(resolved.degradedBecauseAgentCannotUseRequestedTransport).toBe(false);
	});

	it("reports a degrade instead of pretending an unsupported transport took effect", () => {
		const resolved = resolveAgentSessionTransportForLaunch({
			agentId: "claude",
			explicitlyRequestedSessionTransport: "acp_stdio_subprocess",
		});
		expect(resolved.effectiveSessionTransport).toBe("pty_terminal");
		expect(resolved.requestedSessionTransport).toBe("acp_stdio_subprocess");
		expect(resolved.degradedBecauseAgentCannotUseRequestedTransport).toBe(true);
	});

	it("pins a transport onto new cards only for switchable agents", () => {
		expect(
			resolveAgentSessionTransportPinnedAtTaskCreation({
				agentIdTheNewTaskWillRunWith: "omp",
				globalDefaultSessionTransportForNewTasks: "acp_stdio_subprocess",
			}),
		).toBe("acp_stdio_subprocess");
		expect(
			resolveAgentSessionTransportPinnedAtTaskCreation({
				agentIdTheNewTaskWillRunWith: "omp",
				globalDefaultSessionTransportForNewTasks: "pty_terminal",
			}),
		).toBe("pty_terminal");
		// 不可切换的 agent 不该落这个字段——落了就是把它钉在一个可能会变的默认上。
		// 「连会跑哪个 agent 都不知道」（调用方既没有 override 也没接工作区默认 agent）同理：
		// 注意这不等于「用户没在建卡对话框里挑 agent」，那种情况调用方要传工作区默认 agent 进来。
		expect(
			resolveAgentSessionTransportPinnedAtTaskCreation({
				agentIdTheNewTaskWillRunWith: "claude",
				globalDefaultSessionTransportForNewTasks: "acp_stdio_subprocess",
			}),
		).toBeUndefined();
		expect(
			resolveAgentSessionTransportPinnedAtTaskCreation({
				agentIdTheNewTaskWillRunWith: undefined,
				globalDefaultSessionTransportForNewTasks: "pty_terminal",
			}),
		).toBeUndefined();
		// 全局默认是该 agent 表达不了的通道时，落 catalog 默认而不是把非法值钉上去。
		expect(
			resolveAgentSessionTransportPinnedAtTaskCreation({
				agentIdTheNewTaskWillRunWith: "omp",
				globalDefaultSessionTransportForNewTasks: "in_process_cline_sdk",
			}),
		).toBe("pty_terminal");
	});
});
