import { describe, expect, it } from "vitest";
import {
	buildTurnBoundaryDerivationMemoKey,
	deriveTurnBoundariesFromChatMessages,
} from "@/components/conversation-tree/conversation-tree-model";
import type { RuntimeTaskChatMessage } from "@/runtime/types";

let nextMessageSerial = 0;

function createMessage(
	role: RuntimeTaskChatMessage["role"],
	content: string,
	meta?: RuntimeTaskChatMessage["meta"],
): RuntimeTaskChatMessage {
	nextMessageSerial += 1;
	return {
		id: `message-${nextMessageSerial}`,
		role,
		content,
		createdAt: nextMessageSerial,
		meta: meta ?? null,
	};
}

describe("deriveTurnBoundariesFromChatMessages", () => {
	it("真实用户提交开新 turn，其后消息归入该 turn", () => {
		const firstUser = createMessage("user", "第一个问题");
		const firstAssistant = createMessage("assistant", "回答一");
		const toolCall = createMessage("tool", "tool output");
		const secondUser = createMessage("user", "第二个问题");
		const secondAssistant = createMessage("assistant", "回答二");

		const turnById = deriveTurnBoundariesFromChatMessages([
			firstUser,
			firstAssistant,
			toolCall,
			secondUser,
			secondAssistant,
		]);

		expect(turnById.get(firstUser.id)).toBe(1);
		expect(turnById.get(firstAssistant.id)).toBe(1);
		expect(turnById.get(toolCall.id)).toBe(1);
		expect(turnById.get(secondUser.id)).toBe(2);
		expect(turnById.get(secondAssistant.id)).toBe(2);
		expect(turnById.size).toBe(5);
	});

	it("首个边界消息之前的旁白消息无所属 turn（不进映射）", () => {
		const restoreNotice = createMessage("system", "Session restored from history");
		const statusMessage = createMessage("status", "Connecting…");
		const firstUser = createMessage("user", "问题");
		const assistant = createMessage("assistant", "回答");

		const turnById = deriveTurnBoundariesFromChatMessages([restoreNotice, statusMessage, firstUser, assistant]);

		expect(turnById.has(restoreNotice.id)).toBe(false);
		expect(turnById.has(statusMessage.id)).toBe(false);
		expect(turnById.get(firstUser.id)).toBe(1);
		expect(turnById.get(assistant.id)).toBe(1);
	});

	it("hook 注入与 displayRole 旁白的 user 消息不开新 turn（与服务端分类器同源）", () => {
		const firstUser = createMessage("user", "问题一");
		const hookInjected = createMessage("user", "hook 注入的 user 消息", { hookEventName: "PostToolUse" });
		const displayRoleAside = createMessage("user", "旁白 user 消息", { displayRole: "history_notice" });
		const secondUser = createMessage("user", "问题二");

		const turnById = deriveTurnBoundariesFromChatMessages([firstUser, hookInjected, displayRoleAside, secondUser]);

		expect(turnById.get(firstUser.id)).toBe(1);
		// 注入/旁白消息不开新 turn，但仍归入「当前所在」的 turn（位置性归属）。
		expect(turnById.get(hookInjected.id)).toBe(1);
		expect(turnById.get(displayRoleAside.id)).toBe(1);
		expect(turnById.get(secondUser.id)).toBe(2);
	});

	it("tool / reasoning / status / system 角色永不开新 turn", () => {
		const user = createMessage("user", "问题");
		const assistant = createMessage("assistant", "回答");
		const reasoning = createMessage("reasoning", "思考");
		const tool = createMessage("tool", "工具结果");
		const status = createMessage("status", "状态");

		const turnById = deriveTurnBoundariesFromChatMessages([user, assistant, reasoning, tool, status]);

		for (const message of [user, assistant, reasoning, tool, status]) {
			expect(turnById.get(message.id)).toBe(1);
		}
	});

	it("空消息流返回空映射", () => {
		expect(deriveTurnBoundariesFromChatMessages([]).size).toBe(0);
	});
});

describe("buildTurnBoundaryDerivationMemoKey", () => {
	it("形状为 {消息数}:{末条 id}:{末条 content 长度}", () => {
		const messages = [createMessage("user", "hello"), createMessage("assistant", "world!")];
		const key = buildTurnBoundaryDerivationMemoKey(messages);
		expect(key).toBe(`2:${messages[1]!.id}:6`);
	});

	it("流式追加（同 id 原位增长 content）使键变化", () => {
		const streaming = createMessage("assistant", "部分");
		const messages = [createMessage("user", "问题"), streaming];
		const before = buildTurnBoundaryDerivationMemoKey(messages);
		streaming.content = "部分回答变长了";
		const after = buildTurnBoundaryDerivationMemoKey(messages);
		expect(after).not.toBe(before);
	});

	it("中间消息变化不改键（蓝图 §5.5 锁定的粗粒度语义：upsert 只动尾部）", () => {
		const first = createMessage("user", "原始问题");
		const messages = [first, createMessage("assistant", "回答")];
		const before = buildTurnBoundaryDerivationMemoKey(messages);
		first.content = "被编辑过的问题";
		expect(buildTurnBoundaryDerivationMemoKey(messages)).toBe(before);
	});

	it("空消息流的键稳定", () => {
		expect(buildTurnBoundaryDerivationMemoKey([])).toBe("0:none:0");
	});
});
