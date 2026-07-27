import { describe, expect, it, vi } from "vitest";

// 捕获 [session-hydrate-reconcile] 诊断行（与 park / stall 套件同源的 logger mock）。
const tuiFreezeWarnings = vi.hoisted(() => [] as string[]);
vi.mock("../../../src/diagnostics/tui-freeze-logger.js", () => ({
	logTuiFreezeWarning: (message: string) => {
		tuiFreezeWarnings.push(message);
	},
	logTuiFreezeError: () => {},
}));

import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../../../src/core/session-activity";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

// `sessions.json` 只在 graceful shutdown 落盘，落的是那一刻的 liveness/pid 快照。运行时重启会带走全部
// 子进程，却没有任何一方观察到它们的 exit 事件，于是磁盘上的 `live` 永久留存（实测曾累积到 88 条声称
// live、仅 5 条进程真实存在）。本套件锁定 hydrateFromRecord 的运行态对账：**凡是声称仍挂着活 agent 进程
// 的重建会话一律归零为 idle**——重建条目恒 active: null，manager 没有任何路径能认领一个外部 pid，故那条
// 声称按构造不可恢复；判据刻意不看 pid 是否还在（pid 会被复用，存在性是弱判据）。
// 反向边界同样锁死：合法的「进程已退仍等人审」（liveness=exited、pid=null）、Cline SDK 的无-pid 会话、
// 以及已落终止态（interrupted 等）的会话一律不动。

// 超出所有平台 pid 上限（Linux pid_max 上限 4194304、macOS 远低于此），故这个 pid 必然不对应任何进程。
// 与「pid 恰好仍存活」的用例配对使用，证明对账结果与 pid 存在性无关。
const PID_ABOVE_EVERY_PLATFORM_MAXIMUM = 4_194_305;

function createPersistedSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: PID_ABOVE_EVERY_PLATFORM_MAXIMUM,
		startedAt: Date.now() - 60_000,
		updatedAt: Date.now() - 60_000,
		lastOutputAt: Date.now() - 60_000,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function hydrateOne(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord({ [summary.taskId]: summary });
	const hydrated = manager.getSummary(summary.taskId);
	if (!hydrated) {
		throw new Error("Expected the hydrated summary to exist.");
	}
	return hydrated;
}

describe("TerminalSessionManager.hydrateFromRecord 运行态对账", () => {
	it("声称 live 且 pid 已不存在的会话，重建时归零为 idle 并清空进程字段", () => {
		tuiFreezeWarnings.length = 0;
		const persisted = createPersistedSummary();

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated)).toEqual({
			turnOwner: null,
			liveness: "none",
			userTurnKind: null,
		});
		expect(hydrated.pid).toBeNull();
		expect(hydrated.startedAt).toBeNull();
		expect(hydrated.lastOutputAt).toBeNull();
		expect(hydrated.exitCode).toBeNull();
		// agentId 有意保留：canRefresh / 恢复路径靠它路由到正确的 agent 类型。
		expect(hydrated.agentId).toBe("claude");
		// 广播 / 落盘边界的 zod facet 共生与合法组合校验须通过。
		expect(() => runtimeTaskSessionSummarySchema.parse(hydrated)).not.toThrow();
		expect(tuiFreezeWarnings.some((line) => line.includes("[session-hydrate-reconcile]"))).toBe(true);
		// 入参不得被原地改动（clone 边界）。
		expect(persisted.pid).toBe(PID_ABOVE_EVERY_PLATFORM_MAXIMUM);
	});

	it("对账方向是取消 in_progress→review 的计入，绝不制造它", () => {
		// 僵尸的典型形态：turnOwner=user + liveness=live，正被 live-session overlay 从 in_progress 计入 review。
		const persisted = createPersistedSummary({ state: "awaiting_review", reviewReason: "hook" });
		expect(isAwaitingUserReviewTurn(resolveSessionFacets(persisted))).toBe(true);

		const hydrated = hydrateOne(persisted);

		// 归零后不再是待审回合 → overlay 不再把它挪进 review 计数。
		expect(isAwaitingUserReviewTurn(resolveSessionFacets(hydrated))).toBe(false);
		expect(hydrated.reviewReason).toBeNull();
	});

	it("pid 恰好仍被某个进程占用也照样归零：判据不是 PID 存在性，而是重建条目按构造不可认领", () => {
		// process.pid 必定存活（就是本测试进程自己），正是 PID 复用后「探测成功却不是本会话 agent」的形态。
		// 重建条目恒 active: null，manager 无法把这个 pid 认领回来，故它与已消失的 pid 同归零。
		const persisted = createPersistedSummary({ pid: process.pid });

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated)).toEqual({
			turnOwner: null,
			liveness: "none",
			userTurnKind: null,
		});
		expect(hydrated.pid).toBeNull();
		expect(hydrated.workspacePath).toBeNull();
	});

	it("connectionRetry 中的会话（liveness=retrying）同样归零，并清掉重连中渲染", () => {
		const persisted = createPersistedSummary({
			connectionRetry: {
				status: "retrying",
				retryCount: 2,
				firstErrorAt: Date.now() - 30_000,
				lastAttemptAt: Date.now() - 5_000,
				nextAttemptAt: Date.now() + 5_000,
			},
		});
		expect(resolveSessionFacets(persisted).liveness).toBe("retrying");

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated).liveness).toBe("none");
		expect(hydrated.connectionRetry ?? null).toBeNull();
	});

	it("「进程已退但仍等人」（liveness=exited、pid 已为 null）是合法状态，不参与对账", () => {
		const persisted = createPersistedSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
		});
		expect(resolveSessionFacets(persisted).liveness).toBe("exited");

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated).liveness).toBe("exited");
		expect(isAwaitingUserReviewTurn(resolveSessionFacets(hydrated))).toBe(true);
	});

	it("Cline SDK 会话（进程内运行、pid 恒 null、awaiting 为 live）不参与对账", () => {
		// pid 非空是「声称挂着 OS 进程」的唯一标记；Cline 的 pid=null + liveness=live 属跨重启保留的合法状态，
		// 若被一并归零，Cline 任务的待审信号会在每次重启后丢失。
		const persisted = createPersistedSummary({
			agentId: "cline",
			state: "awaiting_review",
			reviewReason: "hook",
			pid: null,
		});
		expect(resolveSessionFacets(persisted).liveness).toBe("live");

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated).liveness).toBe("live");
		expect(isAwaitingUserReviewTurn(resolveSessionFacets(hydrated))).toBe(true);
	});

	it("已落终止态的会话（interrupted，pid 仍残留）不参与对账", () => {
		const persisted = createPersistedSummary({
			state: "interrupted",
			reviewReason: "interrupted",
			pid: 999,
		});
		expect(resolveSessionFacets(persisted).liveness).toBe("interrupted");

		const hydrated = hydrateOne(persisted);

		expect(resolveSessionFacets(hydrated).liveness).toBe("interrupted");
		expect(hydrated.pid).toBe(999);
		expect(hydrated.workspacePath).toBe("/tmp/worktree");
	});
});
