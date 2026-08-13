import { describe, expect, it } from "vitest";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { backfillMissingSessionAgentIdsFromDurableSources } from "../../../src/server/workspace-registry";
import type { PersistedAgentSessionReclamationDeadlineRecord } from "../../../src/state/agent-session-reclamation-deadline-store";

// 纯函数测试，不启动 SDK host、不读磁盘（见 AGENTS.md Node22 CI 挂起告警）。
//
// 覆盖恢复根因：sessions.json 只在 graceful shutdown 与客户端 saveState 落盘，非优雅退出会让
// summary.agentId 丢成 null，而 agentId===null 同时击穿三条恢复路径（canRefresh 按钮禁用、
// refreshTaskTerminal 的 gate、聚焦自动续跑判据）。hydrate 前必须尽最大努力找回它。
//
// 三个 durable 源各自的存在理由（按优先级从高到低列出）：
//   源 3 card.mostRecentlyLaunchedAgentSessionAgentId —— 上一次会话启动成功那一刻的运行时观测值，
//        与要复原的 summary 同指一个会话，故最优先；**走项目默认档的卡片也只有这一条**，
//        2026-07 那次修复只做了源 2，正是漏了这类卡片才让 bug 复发；
//   源 2 card.agentId —— 用户显式选过 agent 的卡片，表达的是「下次想用谁」的意图而非既存会话事实，
//        只在观测值缺席时兜底；
//   源 4 回收期限记录 —— 本修复上线**之前**就已损坏的存量任务唯一的回血通道。

function makeCard(
	id: string,
	overrides: Partial<Pick<RuntimeBoardCard, "agentId" | "mostRecentlyLaunchedAgentSessionAgentId">> = {},
): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeBoard(cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const allColumns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: allColumns.map((id) => ({ id, title: id, cards: cardsByColumn[id] ?? [] })),
		dependencies: [],
	};
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function makeReclamationRecord(
	taskId: string,
	agentId: RuntimeAgentId | null,
	overrides: Partial<PersistedAgentSessionReclamationDeadlineRecord> = {},
): PersistedAgentSessionReclamationDeadlineRecord {
	return {
		recordId: `${taskId}:incarnation:0`,
		taskId,
		agentId,
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "incarnation",
		agentResponseGenerationTurnSequence: 0,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: 1_000,
		responseGenerationStopSignalConfidence: "harness_turn_complete",
		reclamationEligibleAt: 2_000,
		reclamationState: "grace_running",
		reclamationAttemptCount: 0,
		nextReclaimRetryAt: null,
		lastReclaimFailureReason: null,
		createdAt: 1_000,
		updatedAt: 1_000,
		schemaVersion: 1,
		...overrides,
	};
}

function sessionsOf(...summaries: RuntimeTaskSessionSummary[]): Record<string, RuntimeTaskSessionSummary> {
	return Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
}

function backfill(
	sessions: Record<string, RuntimeTaskSessionSummary>,
	board: RuntimeBoardData,
	agentSessionReclamationDeadlineRecords: PersistedAgentSessionReclamationDeadlineRecord[] = [],
): void {
	backfillMissingSessionAgentIdsFromDurableSources({ board, agentSessionReclamationDeadlineRecords }, sessions);
}

describe("backfillMissingSessionAgentIdsFromDurableSources（回填丢失的 summary.agentId）", () => {
	it("源 2：agentId=null 的会话 → 用同 taskId 的 card.agentId 回填（c17ce 复现）", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "c17ce", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("c17ce", { agentId: "claude" })] }));
		expect(sessions.c17ce.agentId).toBe("claude");
	});

	it("已有 agentId 的会话不被覆盖（card 值不同也不动）", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: "codex" }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("t", { agentId: "claude" })] }));
		expect(sessions.t.agentId).toBe("codex");
	});

	it("无匹配 card（shell / home / synthetic 会话）→ 保留 null", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "__detail_terminal__:x", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("other", { agentId: "claude" })] }));
		expect(sessions["__detail_terminal__:x"].agentId).toBeNull();
	});

	it("源 3：card 无 agentId 字段（走项目默认档）但有最近启动记录 → 用它回填", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "5e1f7", agentId: null }));
		backfill(
			sessions,
			makeBoard({ in_progress: [makeCard("5e1f7", { mostRecentlyLaunchedAgentSessionAgentId: "claude" })] }),
		);
		expect(sessions["5e1f7"].agentId).toBe("claude");
	});

	it("源 3 优先于源 2：runtime 观测值压过卡片上的 per-task 意图（persisted-Cline 探针场景）", () => {
		// `startTaskSession` 的 shouldProbePersistedClineSession 分支会在 card.agentId 仍是别的 agent 时
		// 改走 Cline，真正跑起来的事实只落在 mostRecentlyLaunchedAgentSessionAgentId 上。回填复原的是
		// 「既存会话是谁跑的」，故必须取观测值；取 card.agentId 会把 Cline 会话标成 PTY agent，
		// 并因 previousTerminalAgentId 不再为 null 而把那条 Cline 探针分支一并跳过。
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		backfill(
			sessions,
			makeBoard({
				in_progress: [makeCard("t", { agentId: "codex", mostRecentlyLaunchedAgentSessionAgentId: "cline" })],
			}),
		);
		expect(sessions.t.agentId).toBe("cline");
	});

	it("源 2 兜底：卡片没有观测值（本字段上线前的存量卡片）时仍用 per-task 覆盖回填", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("t", { agentId: "codex" })] }), [
			makeReclamationRecord("t", "claude"),
		]);
		expect(sessions.t.agentId).toBe("codex");
	});

	it("源 4：card 两个字段都没有（存量损坏任务）→ 用最近一条回收记录回填", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "5e1f7", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("5e1f7")] }), [
			makeReclamationRecord("other-task", "codex"),
			makeReclamationRecord("5e1f7", "claude"),
		]);
		expect(sessions["5e1f7"].agentId).toBe("claude");
	});

	it("源 4 不限 reclamationState：终态记录同样能回血（与超期对账解耦）", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("t")] }), [
			makeReclamationRecord("t", "claude", { reclamationState: "reclaimed" }),
		]);
		expect(sessions.t.agentId).toBe("claude");
	});

	it("源 4 取 updatedAt 最大的一条", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("t")] }), [
			makeReclamationRecord("t", "codex", { recordId: "t:old:0", updatedAt: 1_000 }),
			makeReclamationRecord("t", "claude", { recordId: "t:new:0", updatedAt: 9_000 }),
		]);
		expect(sessions.t.agentId).toBe("claude");
	});

	it("源 4 同 updatedAt 时取数组更靠后的一条（作废旧记录与追加新记录共享时间戳）", () => {
		// 复现 store 写入侧的合法形状：recordAgentSessionRetentionDeadline 用同一个 recordedAt
		// 把旧 live 记录置 superseded、并把新记录 push 到末尾，两条 updatedAt 完全相等。
		// 此时只有数组次序还保留因果顺序，必须取后者（换 agent 后当前在用的 harness）。
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		backfill(sessions, makeBoard({ in_progress: [makeCard("t")] }), [
			makeReclamationRecord("t", "codex", {
				recordId: "t:old:0",
				reclamationState: "superseded",
				updatedAt: 5_000,
			}),
			makeReclamationRecord("t", "claude", { recordId: "t:new:0", updatedAt: 5_000 }),
		]);
		expect(sessions.t.agentId).toBe("claude");
	});

	it("三个源都问不出结论 → 保留 null 且不抛", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		expect(() => {
			backfill(sessions, makeBoard({ backlog: [makeCard("t")] }), [makeReclamationRecord("t", null)]);
		}).not.toThrow();
		expect(sessions.t.agentId).toBeNull();
	});
});
