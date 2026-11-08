import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAcpSummary } from "../../../src/acp-client-session/acp-session-state";
import * as conversationHistory from "../../../src/agent-session-history/task-conversation-history-page";
import type { RuntimeTaskChatMessage, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	projectTaskSessionIntentMessages,
	readTaskSessionIntentMaterial,
} from "../../../src/task-indexing-support/read-task-session-intent-material";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const card = {
	id: "abc12",
	title: "意图检索",
	prompt: "不读取的 Initial Prompt",
	createdAt: 1,
	updatedAt: 1,
	baseRef: "main",
	startInPlanMode: false,
};
const message = (
	id: string,
	role: RuntimeTaskChatMessage["role"],
	content: string,
	meta?: RuntimeTaskChatMessage["meta"],
): RuntimeTaskChatMessage => ({ id, role, content, createdAt: 1, meta });

describe("查卡 Session Intent 来源", () => {
	it.each(["AskUserQuestion", "functions.request_user_input", "functions.request_user_input_async"])(
		"%s 的同一调用结果保留工具名时仍归为实际答案，排除无关联工具正文",
		(toolName) => {
			const result = projectTaskSessionIntentMessages([
				message("user", "user", "用户输入"),
				message("question", "tool", "允许部署吗？", { toolName, toolCallId: "question-call" }),
				message("unrelated", "tool", "不应读取的文件正文", { toolName: "Read", toolCallId: "read-call" }),
				message("answer", "tool", "不允许", { toolName, toolCallId: "question-call" }),
			]);
			expect(result.map((entry) => entry.kind)).toEqual(["user_prompt", "user_question", "user_question_answer"]);
			expect(result.at(-1)).toMatchObject({
				sourceMessageId: "answer",
				turnUserMessageId: "user",
				questionToolCallId: "question-call",
				text: "不允许",
			});
		},
	);
	it.each(["question", "plan_review", "permission", "needs_input"] as const)(
		"主会话等待 %s 时不将未标记的过程答复当作末轮最终答复",
		async (userTurnKind) => {
			const messages = [message("user", "user", "用户输入"), message("progress", "assistant", "还在确认方案")];
			const readPage = vi.spyOn(conversationHistory, "loadTaskConversationHistoryPage").mockResolvedValue({
				availability: "available",
				messages,
				nextCursor: null,
				notice: null,
			});
			const summary: RuntimeTaskSessionSummary = {
				...createDefaultAcpSummary("abc12", "codex"),
				turnOwner: "user",
				liveness: "live",
				userTurnKind,
			};
			const result = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
			expect(result.sessionIntent.messages.map((entry) => entry.kind)).toEqual(["user_prompt"]);
			readPage.mockResolvedValue({
				availability: "available",
				messages: [
					...messages,
					message("final", "assistant", "原生最终答复", { nativeMessagePhase: "final_answer" }),
				],
				nextCursor: null,
				notice: null,
			});
			const withNativeFinal = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
			expect(withNativeFinal.sessionIntent.messages.at(-1)).toMatchObject({
				kind: "agent_turn_final_response",
				text: "原生最终答复",
			});
		},
	);
	it("正常交棒 review 时保留没有原生 phase 的最后答复", async () => {
		vi.spyOn(conversationHistory, "loadTaskConversationHistoryPage").mockResolvedValue({
			availability: "available",
			messages: [message("user", "user", "用户输入"), message("final", "assistant", "已完成的答复")],
			nextCursor: null,
			notice: null,
		});
		const summary: RuntimeTaskSessionSummary = {
			...createDefaultAcpSummary("abc12", "claude"),
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		};
		const result = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
		expect(result.sessionIntent.messages.at(-1)).toMatchObject({
			kind: "agent_turn_final_response",
			text: "已完成的答复",
		});
	});
	it("运行中尚未结束的过程答复不冒充回合最后答复", () => {
		const messages = [message("u", "user", "用户输入"), message("progress", "assistant", "还在执行")];
		expect(projectTaskSessionIntentMessages(messages, true).map((entry) => entry.kind)).toEqual(["user_prompt"]);
		expect(
			projectTaskSessionIntentMessages(
				[...messages, message("final", "assistant", "原生最终答复", { nativeMessagePhase: "final_answer" })],
				true,
			).at(-1)?.text,
		).toBe("原生最终答复");
	});
	it("保留用户输入、问题与实际答案、每轮最后答复，排除过程与普通工具内容", () => {
		const result = projectTaskSessionIntentMessages([
			message("orphan", "assistant", "没有用户归属的旧输出"),
			message("u1", "user", "用户的计划要求"),
			message("a1", "assistant", "过程答复"),
			message("reasoning", "reasoning", "不读取的推理"),
			message("grep", "tool", "不读取的文件正文", { toolName: "exec_command", toolCallId: "command" }),
			message("q1", "tool", '{"questions":[{"question":"允许部署吗？"}]}', {
				toolName: "functions.request_user_input",
				toolCallId: "question",
			}),
			message("q2", "tool", '{"answers":{"question":["不允许"]}}', { toolName: "工具结果", toolCallId: "question" }),
			message("final1", "assistant", "第一段结论。\n\n第二段限制。", { nativeMessagePhase: "final_answer" }),
			message("u2", "user", "主 Session 中的旁支讨论"),
			message("commentary", "assistant", "过程说明", { nativeMessagePhase: "commentary" }),
			message("final2", "assistant", "旁支讨论的最后答复"),
		]);
		expect(result.map((entry) => entry.sourceMessageId)).toEqual(["u1", "q1", "q2", "final1", "u2", "final2"]);
		expect(result.find((entry) => entry.sourceMessageId === "q2")).toMatchObject({
			kind: "user_question_answer",
			turnUserMessageId: "u1",
			questionToolCallId: "question",
		});
		expect(result.find((entry) => entry.sourceMessageId === "final1")?.text).toBe("第一段结论。\n\n第二段限制。");
	});
	it("使用原生稳定快照跨页读取，任务正文及过程工具不会进入意图材料", async () => {
		const directory = await mkdtemp(join(tmpdir(), "task-session-intent-"));
		directories.push(directory);
		const transcriptPath = join(directory, "native.jsonl");
		const records = [
			{ type: "session_meta", payload: { id: "native", cwd: directory, source: "cli" } },
			{ type: "event_msg", payload: { type: "user_message", message: "用户要求：只查意图" } },
			...Array.from({ length: 120 }, (_, index) => ({
				type: "response_item",
				payload: {
					type: "function_call",
					name: "exec_command",
					call_id: `tool-${index}`,
					arguments: "普通工具的大段结果",
				},
			})),
			{
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text: "最终答复：范围已确认" }],
				},
			},
		];
		await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const summary = {
			...createDefaultAcpSummary("abc12", "codex"),
			workspacePath: directory,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex" as const,
				nativeSessionId: "native",
				transcriptPath,
				observedAt: 1,
			},
		};
		const result = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
		expect(result.missingContextParts).toEqual([]);
		expect(result.sessionIntent.messages.map((entry) => entry.text)).toEqual([
			"用户要求：只查意图",
			"最终答复：范围已确认",
		]);
		expect(JSON.stringify(result)).not.toContain(card.prompt);
	});
	it("身份未绑定时保留未知，不回退任务正文或最新 hook", async () => {
		const result = await readTaskSessionIntentMaterial({ card, sessions: {} });
		expect(result.sessionIntent.messages).toEqual([]);
		expect(result.missingContextParts).toContain("session_intent_binding_pending_unavailable");
		expect(JSON.stringify(result)).not.toContain(card.prompt);
	});
	it("OMP 持久问答记录保留同名工具及调用归属，实际答案不会再次标为提问", async () => {
		const directory = await mkdtemp(join(tmpdir(), "omp-session-intent-"));
		directories.push(directory);
		const transcriptPath = join(directory, "native.jsonl");
		const records = [
			{ type: "session", id: "native" },
			{ type: "message", id: "user", parentId: null, message: { role: "user", content: "用户输入" } },
			{
				type: "message",
				id: "question",
				parentId: "user",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "question-call",
							name: "request_user_input",
							arguments: { question: "允许部署吗？" },
						},
					],
				},
			},
			{
				type: "message",
				id: "answer",
				parentId: "question",
				message: {
					role: "toolResult",
					toolCallId: "question-call",
					toolName: "request_user_input",
					content: "不允许",
				},
			},
		];
		await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const summary = {
			...createDefaultAcpSummary("abc12", "omp"),
			workspacePath: directory,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "omp" as const,
				nativeSessionId: "native",
				transcriptPath,
				observedAt: 1,
			},
		};
		const result = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
		expect(result.missingContextParts).toEqual([]);
		expect(result.sessionIntent.messages.map((entry) => entry.kind)).toEqual([
			"user_prompt",
			"user_question",
			"user_question_answer",
		]);
		expect(result.sessionIntent.messages.at(-1)).toMatchObject({
			text: "不允许",
			questionToolCallId: "question-call",
			turnUserMessageId: result.sessionIntent.messages[0]?.sourceMessageId,
		});
	});
	it("Claude 问题的答案来自结构化实际作答，不能只保留工具的通用结束语", async () => {
		const directory = await mkdtemp(join(tmpdir(), "claude-session-intent-"));
		directories.push(directory);
		const transcriptPath = join(directory, "native.jsonl");
		const records = [
			{
				type: "user",
				sessionId: "native",
				uuid: "u",
				parentUuid: null,
				promptSource: "typed",
				message: { role: "user", content: "计划查卡" },
			},
			{
				type: "assistant",
				sessionId: "native",
				uuid: "q",
				parentUuid: "u",
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "question",
							name: "AskUserQuestion",
							input: { questions: [{ question: "允许部署吗？" }] },
						},
					],
				},
			},
			{
				type: "user",
				sessionId: "native",
				uuid: "answer",
				parentUuid: "q",
				toolUseResult: { answers: { "允许部署吗？": "不允许" } },
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "question", content: "问题已结束" }],
				},
			},
			{
				type: "assistant",
				sessionId: "native",
				uuid: "final",
				parentUuid: "answer",
				message: { role: "assistant", content: "已记录限制。" },
			},
		];
		await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		const summary = {
			...createDefaultAcpSummary("abc12", "claude"),
			workspacePath: directory,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "claude" as const,
				nativeSessionId: "native",
				transcriptPath,
				observedAt: 1,
			},
		};
		const result = await readTaskSessionIntentMaterial({ card, sessions: { abc12: summary } });
		expect(result.missingContextParts).toEqual([]);
		expect(result.sessionIntent.messages.find((entry) => entry.kind === "user_question_answer")?.text).toContain(
			"不允许",
		);
		expect(result.sessionIntent.messages.filter((entry) => entry.kind === "user_prompt")).toHaveLength(1);
	});
	it("历史分页受界限约束并保留缺口，下次查询会重新尝试", async () => {
		const readPage = vi
			.spyOn(conversationHistory, "loadTaskConversationHistoryPage")
			.mockResolvedValue({ availability: "available", messages: [], nextCursor: "has-older-records", notice: null });
		const first = await readTaskSessionIntentMaterial({ card, sessions: {} });
		expect(readPage).toHaveBeenCalledTimes(64);
		expect(first.missingContextParts).toContain("session_intent_scan_bounded");
		readPage.mockResolvedValue({
			availability: "available",
			messages: [message("restored", "user", "已恢复的用户输入")],
			nextCursor: null,
			notice: null,
		});
		const recovered = await readTaskSessionIntentMaterial({ card, sessions: {} });
		expect(recovered.missingContextParts).toEqual([]);
		expect(recovered.sessionIntent.messages[0]?.text).toBe("已恢复的用户输入");
	});
});
