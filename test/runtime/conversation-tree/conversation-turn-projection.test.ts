import { describe, expect, it } from "vitest";

import {
	buildConversationTurnProjectionSignature,
	type ConversationTurnProjectionSourceMessage,
	classifyConversationTurnBoundaryMessage,
	deriveConversationTurnProjection,
	sliceConversationTurnProjectionEntries,
} from "../../../src/conversation-tree/conversation-turn-projection";

let nextMessageId = 0;
function message(
	role: ConversationTurnProjectionSourceMessage["role"],
	content: string,
	options: { createdAt?: number; meta?: ConversationTurnProjectionSourceMessage["meta"] } = {},
): ConversationTurnProjectionSourceMessage {
	nextMessageId += 1;
	return {
		id: `task-1-${1_700_000_000_000 + nextMessageId}-abc${nextMessageId}`,
		role,
		content,
		createdAt: options.createdAt ?? 1_700_000_000_000 + nextMessageId * 1_000,
		meta: options.meta ?? null,
	};
}

describe("classifyConversationTurnBoundaryMessage — turn 边界分类", () => {
	it("真实用户提交是边界", () => {
		expect(classifyConversationTurnBoundaryMessage(message("user", "帮我查一下这个 bug"))).toBe(true);
	});

	it("带 messageKind 元数据的用户消息仍是边界（分类只排 hookEventName / displayRole）", () => {
		const sent = message("user", "从 task chat 发送", {
			meta: { messageKind: "terminal-input", hookEventName: null, displayRole: null },
		});
		expect(classifyConversationTurnBoundaryMessage(sent)).toBe(true);
	});

	it("hook 注入 / hydrate 旁白（hookEventName 非空）不是边界", () => {
		const hydrated = message("user", "会话已从落盘状态恢复", {
			meta: { hookEventName: "history_notice", messageKind: null, displayRole: null },
		});
		expect(classifyConversationTurnBoundaryMessage(hydrated)).toBe(false);
	});

	it("displayRole 旁白不是边界", () => {
		const notice = message("user", "系统提示", {
			meta: { hookEventName: null, messageKind: null, displayRole: "system" },
		});
		expect(classifyConversationTurnBoundaryMessage(notice)).toBe(false);
	});

	it.each(["assistant", "system", "tool", "reasoning", "status"] as const)("%s 角色不是边界", (role) => {
		expect(classifyConversationTurnBoundaryMessage(message(role, "x"))).toBe(false);
	});
});

describe("deriveConversationTurnProjection — turn 派生", () => {
	it("空消息流 → 空投影", () => {
		const projection = deriveConversationTurnProjection([]);
		expect(projection.entries).toEqual([]);
		expect(projection.signature).toBe("0:none:0");
	});

	it("首个边界之前的旁白消息不进任何 turn", () => {
		const projection = deriveConversationTurnProjection([
			message("system", "恢复旁白", { meta: { hookEventName: "history_notice" } }),
			message("user", "第一轮问题", { createdAt: 100 }),
			message("assistant", "第一轮回答"),
		]);
		expect(projection.entries).toHaveLength(1);
		expect(projection.entries[0]).toMatchObject({
			turnNumber: 1,
			turnStartedAt: 100,
			turnUserMessageExcerpt: "第一轮问题",
			turnAssistantResponseExcerpt: "第一轮回答",
			turnMessageCount: 2,
		});
	});

	it("多轮切段：turn 序号连续、每轮统计本段消息数、助手摘录取段内最后一条", () => {
		const projection = deriveConversationTurnProjection([
			message("user", "Q1"),
			message("assistant", "A1-part1"),
			message("reasoning", "thinking…"),
			message("assistant", "A1-final"),
			message("user", "Q2"),
			message("assistant", "A2"),
		]);
		expect(projection.entries.map((entry) => entry.turnNumber)).toEqual([1, 2]);
		expect(projection.entries[0]).toMatchObject({
			turnUserMessageExcerpt: "Q1",
			turnAssistantResponseExcerpt: "A1-final",
			turnMessageCount: 4,
		});
		expect(projection.entries[1]).toMatchObject({
			turnUserMessageExcerpt: "Q2",
			turnAssistantResponseExcerpt: "A2",
			turnMessageCount: 2,
		});
	});

	it("用户连发两条（agent 未答）各自开 turn，无助手摘录时 excerpt 为 null", () => {
		const projection = deriveConversationTurnProjection([message("user", "Q1"), message("user", "Q2")]);
		expect(projection.entries).toHaveLength(2);
		expect(projection.entries[0]?.turnAssistantResponseExcerpt).toBeNull();
		expect(projection.entries[1]?.turnAssistantResponseExcerpt).toBeNull();
	});

	it("摘录按 maxExcerptLength 截断", () => {
		const longContent = "长".repeat(500);
		const projection = deriveConversationTurnProjection([message("user", longContent)]);
		expect(projection.entries[0]?.turnUserMessageExcerpt).toHaveLength(400);
	});

	it("turnIsInProgress 只标末尾 turn 且仅当调用方声明 finalTurnIsInProgress", () => {
		const messages = [message("user", "Q1"), message("assistant", "A1"), message("user", "Q2")];
		const inProgress = deriveConversationTurnProjection(messages, { finalTurnIsInProgress: true });
		expect(inProgress.entries.map((entry) => entry.turnIsInProgress)).toEqual([false, true]);
		const settled = deriveConversationTurnProjection(messages, { finalTurnIsInProgress: false });
		expect(settled.entries.map((entry) => entry.turnIsInProgress)).toEqual([false, false]);
	});

	it("M0 阶段 turnHasConversationTreeForkAnchor 恒为 false（锚 join 属树装配步骤）", () => {
		const projection = deriveConversationTurnProjection([message("user", "Q1")]);
		expect(projection.entries[0]?.turnHasConversationTreeForkAnchor).toBe(false);
	});
});

describe("deriveConversationTurnProjection — checkpoint 对齐置信度", () => {
	const messages = [
		message("user", "Q1"),
		message("assistant", "A1"),
		message("user", "Q2"),
		message("assistant", "A2"),
	];

	it("最新 checkpoint 序数 == 投影最新 turn 且 ref 齐全 → 全序列 exact_ordinal_match", () => {
		const projection = deriveConversationTurnProjection(messages, {
			checkpointAlignment: {
				checkpointCommitsByTurnNumber: new Map([
					[1, "commit-1"],
					[2, "commit-2"],
				]),
				latestCheckpointTurnNumber: 2,
			},
		});
		expect(
			projection.entries.map((entry) => [entry.turnCheckpointCommit, entry.turnCheckpointAlignmentConfidence]),
		).toEqual([
			["commit-1", "exact_ordinal_match"],
			["commit-2", "exact_ordinal_match"],
		]);
	});

	it("checkpoint 序数超前（self-injection 轮次）→ 有 ref 的 turn 降级 best_effort", () => {
		const projection = deriveConversationTurnProjection(messages, {
			checkpointAlignment: {
				checkpointCommitsByTurnNumber: new Map([
					[1, "commit-1"],
					[2, "commit-2"],
					[3, "commit-3-followup"],
				]),
				latestCheckpointTurnNumber: 3,
			},
		});
		expect(projection.entries.map((entry) => entry.turnCheckpointAlignmentConfidence)).toEqual([
			"best_effort_ordinal_match",
			"best_effort_ordinal_match",
		]);
	});

	it("ref 缺失的 turn → unaligned 且 commit 为 null（M0 保留策略下旧 turn 的常态）", () => {
		const projection = deriveConversationTurnProjection(messages, {
			checkpointAlignment: {
				checkpointCommitsByTurnNumber: new Map([[2, "commit-2"]]),
				latestCheckpointTurnNumber: 2,
			},
		});
		expect(projection.entries[0]).toMatchObject({
			turnCheckpointCommit: null,
			turnCheckpointAlignmentConfidence: "unaligned",
		});
		expect(projection.entries[1]).toMatchObject({
			turnCheckpointCommit: "commit-2",
			turnCheckpointAlignmentConfidence: "exact_ordinal_match",
		});
	});

	it("无对齐输入 → 全部 unaligned", () => {
		const projection = deriveConversationTurnProjection(messages);
		expect(
			projection.entries.every(
				(entry) => entry.turnCheckpointAlignmentConfidence === "unaligned" && entry.turnCheckpointCommit === null,
			),
		).toBe(true);
	});
});

describe("buildConversationTurnProjectionSignature — 流式感知", () => {
	it("同 id 末条消息内容追加（流式 chunk）使签名失效", () => {
		const streaming = message("assistant", "前半");
		const before = buildConversationTurnProjectionSignature([message("user", "Q1"), streaming]);
		const after = buildConversationTurnProjectionSignature([
			message("user", "Q1"),
			{ ...streaming, content: "前半后半" },
		]);
		expect(before).not.toBe(after);
	});

	it("消息流不变则签名稳定", () => {
		const messages = [message("user", "Q1"), message("assistant", "A1")];
		expect(buildConversationTurnProjectionSignature(messages)).toBe(
			buildConversationTurnProjectionSignature(messages),
		);
	});
});

describe("sliceConversationTurnProjectionEntries — 增量切片", () => {
	const { entries } = deriveConversationTurnProjection([
		message("user", "Q1"),
		message("assistant", "A1"),
		message("user", "Q2"),
		message("assistant", "A2"),
		message("user", "Q3"),
	]);

	it("sinceTurnNumber 只返回更新的 turn", () => {
		const sliced = sliceConversationTurnProjectionEntries(entries, { sinceTurnNumber: 1 });
		expect(sliced.entries.map((entry) => entry.turnNumber)).toEqual([2, 3]);
		expect(sliced.isIncomplete).toBe(false);
	});

	it("maxTurnEntries 超限保留最新条目并标 incomplete", () => {
		const sliced = sliceConversationTurnProjectionEntries(entries, { maxTurnEntries: 2 });
		expect(sliced.entries.map((entry) => entry.turnNumber)).toEqual([2, 3]);
		expect(sliced.isIncomplete).toBe(true);
	});

	it("无参数 → 全量且 complete", () => {
		const sliced = sliceConversationTurnProjectionEntries(entries);
		expect(sliced.entries).toHaveLength(3);
		expect(sliced.isIncomplete).toBe(false);
	});
});
