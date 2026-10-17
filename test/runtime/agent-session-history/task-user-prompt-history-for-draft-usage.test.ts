import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_INCREMENTAL_READ_BYTES } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ currentPath: "", oldPath: "" }));
vi.mock("../../../src/state/workspace-state", () => ({
	loadPersistedWorkspaceSessionsById: async () => ({
		task: {
			taskId: "task",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "current",
				transcriptPath: fixtures.currentPath,
				observedAt: 2,
			},
		},
	}),
}));
vi.mock(
	"../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation",
	() => ({
		runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture: async (
			operation: (client: object) => Promise<unknown>,
		) =>
			operation({
				listCommittedEvents: async () => [
					{
						eventFamily: "agent_conversation_session_identity_event",
						occurredAt: 1,
						eventPayload: {
							conversationSessionIdentityKey: {
								conversationSessionHostKanbanAgentId: "codex",
								nativeConversationSessionId: "old",
							},
							agentNativeConversationSessionTranscriptPath: fixtures.oldPath,
						},
					},
				],
			}),
	}),
);

import {
	extractSubmittedUserPromptFromTranscriptRecord,
	readTaskUserPromptHistoryForDraftUsage,
} from "../../../src/agent-session-history/task-user-prompt-history-for-draft-usage";
import { matchPromptDraftAgainstSubmittedUserPrompt } from "../../../src/core/prompt-draft-user-prompt-matching";

const sanitizedCodexAgentInstructionsBlock =
	"# AGENTS.md instructions for /isolated/repository\n\n<INSTRUCTIONS>仓库规则</INSTRUCTIONS>";
const sanitizedCodexEnvironmentContextBlock =
	"<environment_context>\n<cwd>/isolated/repository</cwd>\n</environment_context>";
const sanitizedCodexTaskNotificationBlock = "<task-notification>后台任务完成</task-notification>";

function buildCodexResponseItemUserTranscriptRecord(textBlocks: string[], messageId = "codex-user-message") {
	return {
		type: "response_item",
		timestamp: "2026-10-17T12:00:00Z",
		payload: {
			type: "message",
			id: messageId,
			role: "user",
			content: textBlocks.map((text) => ({ type: "input_text", text })),
			internal_chat_message_metadata_passthrough: {},
		},
	};
}

const directories: string[] = [];
afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("真实用户提示提取与历史会话发现", () => {
	it("排除工具结果、系统通知及 Codex 注入的上下文", () => {
		expect(
			extractSubmittedUserPromptFromTranscriptRecord("claude", {
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", content: "不是用户提示" }] },
			}),
		).toBeNull();
		expect(
			extractSubmittedUserPromptFromTranscriptRecord("claude", {
				type: "user",
				message: { role: "user", content: "<task-notification>完成</task-notification>" },
			}),
		).toBeNull();
		expect(
			extractSubmittedUserPromptFromTranscriptRecord(
				"codex",
				buildCodexResponseItemUserTranscriptRecord([sanitizedCodexAgentInstructionsBlock]),
			),
		).toBeNull();
		expect(
			extractSubmittedUserPromptFromTranscriptRecord("omp", {
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "真实提示" },
						{ type: "image", data: "不可作为文字证据" },
					],
				},
				timestamp: "2026-10-17T12:00:00Z",
			})?.text,
		).toBe("真实提示");
	});
	it.each([
		["普通正文", ["请修复登录失败提示"], "请修复登录失败提示"],
		[
			"注入与真人输入混合的独立文字块",
			[
				sanitizedCodexAgentInstructionsBlock,
				"请修复登录失败提示",
				sanitizedCodexEnvironmentContextBlock,
				sanitizedCodexTaskNotificationBlock,
				"并保留已有验证",
			],
			"请修复登录失败提示\n并保留已有验证",
		],
		[
			"谈论注入格式的真人正文",
			["请解释 AGENTS.md 注入与 <environment_context>"],
			"请解释 AGENTS.md 注入与 <environment_context>",
		],
	])("Codex response_item 的%s保留原文与证据字段", (_description, textBlocks, expectedText) => {
		const prompt = extractSubmittedUserPromptFromTranscriptRecord(
			"codex",
			buildCodexResponseItemUserTranscriptRecord(textBlocks),
		);
		expect(prompt).toEqual({
			text: expectedText,
			messageId: "codex-user-message",
			submittedAtEpochMs: Date.parse("2026-10-17T12:00:00Z"),
		});
		expect(matchPromptDraftAgainstSubmittedUserPrompt(expectedText, prompt?.text ?? "")).toBe("normalized_exact");
	});
	it.each([
		["AGENTS.md", [sanitizedCodexAgentInstructionsBlock]],
		["environment_context", [sanitizedCodexEnvironmentContextBlock]],
		["系统通知", [sanitizedCodexTaskNotificationBlock]],
		[
			"多个注入块混合",
			[
				sanitizedCodexAgentInstructionsBlock,
				sanitizedCodexEnvironmentContextBlock,
				sanitizedCodexTaskNotificationBlock,
			],
		],
		["注入块的前导空白", [`  \n${sanitizedCodexEnvironmentContextBlock}`]],
	])("Codex response_item 的%s不能成为使用证据", (_description, textBlocks) => {
		expect(
			extractSubmittedUserPromptFromTranscriptRecord(
				"codex",
				buildCodexResponseItemUserTranscriptRecord(textBlocks),
			),
		).toBeNull();
	});
	it.each([
		{ description: "未标记来源的真人输入", messageMetadata: {}, expectedText: "用户提示原文" },
		{ description: "明确标记用户来源的输入", messageMetadata: { attribution: "user" }, expectedText: "用户提示原文" },
		{ description: "agent 自动注入", messageMetadata: { attribution: "agent" }, expectedText: null },
		{ description: "未知的 synthetic 来源", messageMetadata: { attribution: "synthetic" }, expectedText: null },
		{ description: "无来源的合成消息", messageMetadata: { synthetic: true }, expectedText: null },
		{
			description: "用户来源的合成消息",
			messageMetadata: { attribution: "user", synthetic: true },
			expectedText: null,
		},
		{
			description: "明确非合成的真人输入",
			messageMetadata: { attribution: "user", synthetic: false },
			expectedText: "用户提示原文",
		},
	])("OMP $description 只能以真实用户原文成为使用证据", ({ messageMetadata, expectedText }) => {
		const prompt = extractSubmittedUserPromptFromTranscriptRecord("omp", {
			type: "message",
			id: "脱敏消息标识",
			timestamp: "2026-10-17T12:00:00Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "用户提示原文" }],
				timestamp: Date.parse("2026-10-17T12:00:00Z"),
				...messageMetadata,
			},
		});
		if (expectedText === null) expect(prompt).toBeNull();
		else expect(prompt?.text).toBe(expectedText);
	});
	it("查询同一 Task 的旧会话，并完整流读中间段而非只看头尾", async () => {
		const directory = await mkdtemp(join(tmpdir(), "prompt-usage-history-"));
		directories.push(directory);
		fixtures.currentPath = join(directory, "current.jsonl");
		fixtures.oldPath = join(directory, "old.jsonl");
		const padding = `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(DEFAULT_MAX_INCREMENTAL_READ_BYTES - 512) } })}\n`;
		await writeFile(
			fixtures.oldPath,
			`${padding}${padding}${JSON.stringify({ type: "event_msg", timestamp: "2026-10-17T10:00:00Z", payload: { type: "user_message", message: "旧会话中间的用户提示" } })}\n${padding}${padding}`,
		);
		await writeFile(
			fixtures.currentPath,
			`${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "当前会话用户提示" } })}\n`,
		);
		const history = await readTaskUserPromptHistoryForDraftUsage({ workspaceId: "workspace", taskId: "task" });
		const prompts = [];
		for await (const prompt of history.prompts) prompts.push(prompt);
		expect(prompts.map((prompt) => prompt.text).sort()).toEqual(["当前会话用户提示", "旧会话中间的用户提示"].sort());
		expect(history.warnings).toEqual([]);
	});
	it.each([
		{ description: "用户主会话", oldSessionMetadata: { thread_source: "user" }, includeOldPrompt: true },
		{
			description: "非用户 thread_source",
			oldSessionMetadata: { thread_source: "subagent" },
			includeOldPrompt: false,
		},
		{
			description: "source 标记的分身会话",
			oldSessionMetadata: { source: { subagent: { parent_thread_id: "parent" } } },
			includeOldPrompt: false,
		},
	])(
		"流读只有 response_item 的 Codex 历史并遵守$description边界",
		async ({ oldSessionMetadata, includeOldPrompt }) => {
			const directory = await mkdtemp(join(tmpdir(), "prompt-usage-codex-response-items-"));
			directories.push(directory);
			fixtures.currentPath = join(directory, "current.jsonl");
			fixtures.oldPath = join(directory, "old.jsonl");
			await writeFile(
				fixtures.oldPath,
				`${[
					{ type: "session_meta", payload: { id: "old", ...oldSessionMetadata } },
					buildCodexResponseItemUserTranscriptRecord(["旧会话用户原文"], "old-message"),
				]
					.map((record) => JSON.stringify(record))
					.join("\n")}\n`,
			);
			await writeFile(
				fixtures.currentPath,
				`${[
					{ type: "session_meta", payload: { id: "current", thread_source: "user" } },
					buildCodexResponseItemUserTranscriptRecord([sanitizedCodexAgentInstructionsBlock]),
					buildCodexResponseItemUserTranscriptRecord(
						[sanitizedCodexEnvironmentContextBlock, "当前会话用户原文", sanitizedCodexTaskNotificationBlock],
						"current-message",
					),
				]
					.map((record) => JSON.stringify(record))
					.join("\n")}\n`,
			);
			const history = await readTaskUserPromptHistoryForDraftUsage({ workspaceId: "workspace", taskId: "task" });
			const prompts = [];
			for await (const prompt of history.prompts) prompts.push(prompt);
			expect(prompts.map((prompt) => prompt.text).sort()).toEqual(
				(includeOldPrompt ? ["当前会话用户原文", "旧会话用户原文"] : ["当前会话用户原文"]).sort(),
			);
			expect(prompts.find((prompt) => prompt.nativeSessionId === "current")).toEqual({
				text: "当前会话用户原文",
				sourceAgentId: "codex",
				nativeSessionId: "current",
				messageId: "current-message",
				submittedAtEpochMs: Date.parse("2026-10-17T12:00:00Z"),
			});
			expect(history.warnings).toEqual(includeOldPrompt ? [] : ["descendant_session_excluded:old"]);
		},
	);
});
