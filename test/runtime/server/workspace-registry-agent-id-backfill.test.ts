import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { applyBoardCardAgentIdsToSessions } from "../../../src/server/workspace-registry";

// 纯函数测试，不启动 SDK host、不读磁盘（见 AGENTS.md Node22 CI 挂起告警）。
// 覆盖恢复根因：sessions.json 仅在 graceful shutdown 落盘，非优雅退出会留下 agent 完全启动前的默认
// 快照（agentId=null）。hydrate 时用 board card 的 durable agentId 回填，否则 summary.agentId===null 会
// 同时击穿 canRefresh（Refresh 按钮禁用）、refreshTaskTerminal 的 agentId gate、以及聚焦自动续跑判据。

function makeCard(id: string, agentId?: RuntimeBoardCard["agentId"]): RuntimeBoardCard {
	return { id, title: id, prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 0, updatedAt: 0, agentId };
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

function sessionsOf(...summaries: RuntimeTaskSessionSummary[]): Record<string, RuntimeTaskSessionSummary> {
	return Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
}

describe("applyBoardCardAgentIdsToSessions（board card 回填丢失的 summary.agentId）", () => {
	it("agentId=null 的会话 → 用同 taskId 的 board card agentId 回填（c17ce 复现）", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "c17ce", agentId: null }));
		applyBoardCardAgentIdsToSessions(makeBoard({ in_progress: [makeCard("c17ce", "claude")] }), sessions);
		expect(sessions.c17ce.agentId).toBe("claude");
	});

	it("已有 agentId 的会话不被覆盖（board card 值不同也不动）", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: "codex" }));
		applyBoardCardAgentIdsToSessions(makeBoard({ in_progress: [makeCard("t", "claude")] }), sessions);
		expect(sessions.t.agentId).toBe("codex");
	});

	it("无匹配 card（shell / home / synthetic 会话）→ 保留 null", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "__detail_terminal__:x", agentId: null }));
		applyBoardCardAgentIdsToSessions(makeBoard({ in_progress: [makeCard("other", "claude")] }), sessions);
		expect(sessions["__detail_terminal__:x"].agentId).toBeNull();
	});

	it("匹配的 card 未设 agentId → 保留 null", () => {
		const sessions = sessionsOf(makeSummary({ taskId: "t", agentId: null }));
		applyBoardCardAgentIdsToSessions(makeBoard({ backlog: [makeCard("t")] }), sessions);
		expect(sessions.t.agentId).toBeNull();
	});
});
