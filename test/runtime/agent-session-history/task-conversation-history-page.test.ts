import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTaskConversationHistoryPage } from "../../../src/agent-session-history/task-conversation-history-page";
import {
	getCodexConversationMigrationRecordPath,
	prepareManagedCodexConversationStorageHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const directories: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const card: RuntimeBoardCard = {
	id: "task",
	title: "完成的任务",
	prompt: "原始需求",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};
async function fixture(agentId: "claude" | "codex" | "omp", records: unknown[]) {
	const directory = await mkdtemp(join(tmpdir(), "kanban-done-task-conversation-history-"));
	directories.push(directory);
	const path = join(directory, "native.jsonl");
	await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
	const summary: RuntimeTaskSessionSummary = {
		taskId: "task",
		agentId,
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "exited",
		userTurnKind: "review",
		workspacePath: join(directory, "deleted-worktree"),
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: 0,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: agentId,
			nativeSessionId: "native",
			transcriptPath: path,
			observedAt: 1,
		},
	};
	const input = {
		request: { workspaceTaskId: "task", taskConversationSessionId: "task" },
		card,
		sessions: { task: summary },
	};
	return { path, input, summary };
}
function claudeMessage(uuid: string, parentUuid: string | null, role: "user" | "assistant", content: unknown) {
	return {
		type: role,
		promptSource: role === "user" ? "typed" : undefined,
		sessionId: "native",
		uuid,
		parentUuid,
		timestamp: "2026-10-23T10:00:00Z",
		message: { role, content },
	};
}

describe("Done 任务只读会话历史", () => {
	it.each(["source_archived", "rolled_back"] as const)(
		"%s：正式目录绑定改变后读取当前原生路径，不启动会话或读取旧副本",
		async (migrationStage) => {
			const nativeSessionId = "01a15120-4476-78b0-8c56-5a7321338e0b";
			const { input, path, summary } = await fixture("codex", []);
			const isolatedHomeDirectoryPath = dirname(path);
			vi.stubEnv("HOME", isolatedHomeDirectoryPath);
			const originalCodexHomeDirectoryPath = join(isolatedHomeDirectoryPath, ".codex");
			await mkdir(join(originalCodexHomeDirectoryPath, "sessions"), { recursive: true });
			const managedCodexHomeDirectoryPath =
				await prepareManagedCodexConversationStorageHome(originalCodexHomeDirectoryPath);
			const boundCodexHomeDirectoryPath =
				migrationStage === "source_archived" ? managedCodexHomeDirectoryPath : originalCodexHomeDirectoryPath;
			const staleCodexHomeDirectoryPath =
				migrationStage === "source_archived" ? originalCodexHomeDirectoryPath : managedCodexHomeDirectoryPath;
			const currentBoundTranscriptPath = join(
				boundCodexHomeDirectoryPath,
				"sessions",
				`rollout-${nativeSessionId}.jsonl`,
			);
			await mkdir(dirname(currentBoundTranscriptPath), { recursive: true });
			await writeFile(
				currentBoundTranscriptPath,
				`${[
					{ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } },
					{ type: "event_msg", payload: { type: "user_message", message: "当前绑定的完整历史" } },
				]
					.map((record) => JSON.stringify(record))
					.join("\n")}\n`,
			);
			const nativeCodexStateDatabase = new Database(join(boundCodexHomeDirectoryPath, "state_5.sqlite"));
			nativeCodexStateDatabase.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
			nativeCodexStateDatabase
				.prepare("INSERT INTO threads VALUES (?, ?)")
				.run(nativeSessionId, currentBoundTranscriptPath);
			nativeCodexStateDatabase.close();
			const migrationRecordPath = getCodexConversationMigrationRecordPath(
				originalCodexHomeDirectoryPath,
				nativeSessionId,
			);
			await mkdir(dirname(migrationRecordPath), { recursive: true });
			await writeFile(
				migrationRecordPath,
				JSON.stringify({
					nativeSessionId,
					sourceHomeDirectoryPath: originalCodexHomeDirectoryPath,
					targetHomeDirectoryPath: managedCodexHomeDirectoryPath,
					stage: migrationStage,
				}),
			);
			const staleRecordedTranscriptPath = join(
				staleCodexHomeDirectoryPath,
				"sessions",
				`rollout-${nativeSessionId}.jsonl`,
			);
			summary.agentNativeConversationSessionIdentity = {
				sourceAgentId: "codex",
				nativeSessionId,
				transcriptPath: staleRecordedTranscriptPath,
				observedAt: 1,
			};
			summary.codexConversationStorageHomeDirectoryPath = staleCodexHomeDirectoryPath;
			if (migrationStage === "rolled_back") {
				const stalePrivateTranscriptPath = staleRecordedTranscriptPath;
				await mkdir(dirname(stalePrivateTranscriptPath), { recursive: true });
				await writeFile(
					stalePrivateTranscriptPath,
					`${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId, source: "cli" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "过期的私有副本" } })}\n`,
				);
			}
			const page = await loadTaskConversationHistoryPage(input);
			expect(page.availability).toBe("available");
			expect(page.messages.map((message) => message.content)).toEqual(["当前绑定的完整历史"]);
			expect(summary.codexConversationStorageHomeDirectoryPath).toBe(staleCodexHomeDirectoryPath);
		},
	);
	it("工作树已删除且 agent 已退出，仍能读取用户、回答和工具原文", async () => {
		const { input } = await fixture("claude", [
			claudeMessage("u", null, "user", "原文\u2028仍在同一条消息"),
			claudeMessage("a", "u", "assistant", [
				{ type: "text", text: "完整回答" },
				{ type: "tool_use", id: "call", name: "Read", input: { file_path: "/example" } },
			]),
			claudeMessage("t", "a", "user", [{ type: "tool_result", tool_use_id: "call", content: "工具完整结果" }]),
		]);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.availability).toBe("available");
		expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
		expect(page.messages.map((message) => message.content).join("\n")).toContain("原文\u2028仍在同一条消息");
		expect(page.messages.at(-1)?.content).toBe("工具完整结果");
		expect(page.nextCursor).toBeNull();
	});

	it.each(["claude", "omp"] as const)("%s 混合原生内容按角色和顺序保留推理、回答及工具正文", async (agentId) => {
		const content = [
			{ type: "thinking", thinking: "第一段推理", signature: "signature" },
			{ type: "text", text: "工具前说明" },
			{ type: "text", text: "同一段说明的补充" },
			agentId === "claude"
				? { type: "tool_use", id: "call", name: "Read", input: { file_path: "/example" } }
				: { type: "toolCall", id: "call", name: "Read", arguments: { file_path: "/example" } },
			{ type: "thinking", thinking: "第二段推理" },
			{ type: "text", text: "最终回答" },
		];
		const toolResultContent = [
			{ type: "text", text: "工具完整结果" },
			{ type: "text", text: "第二行结果" },
		];
		const records =
			agentId === "claude"
				? [
						claudeMessage("assistant", null, "assistant", content),
						claudeMessage("result", "assistant", "user", [
							{ type: "tool_result", tool_use_id: "call", content: toolResultContent },
						]),
					]
				: [
						{ type: "session", id: "native" },
						{ type: "message", id: "assistant", parentId: null, message: { role: "assistant", content } },
						{
							type: "message",
							id: "result",
							parentId: "assistant",
							message: { role: "toolResult", toolCallId: "call", toolName: "Read", content: toolResultContent },
						},
					];
		const { input } = await fixture(agentId, records);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.availability).toBe("available");
		expect(page.messages.map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "reasoning", content: "第一段推理" },
			{ role: "assistant", content: "工具前说明\n同一段说明的补充" },
			{ role: "tool", content: JSON.stringify({ file_path: "/example" }, null, 2) },
			{ role: "reasoning", content: "第二段推理" },
			{ role: "assistant", content: "最终回答" },
			{ role: "tool", content: "工具完整结果\n第二行结果" },
		]);
		expect(page.messages[2]?.meta).toMatchObject({ toolName: "Read", toolCallId: "call" });
		expect(page.messages.at(-1)?.meta?.toolCallId).toBe("call");
	});

	it.each(["claude", "omp"] as const)("%s 纯推理记录只显示一次 reasoning", async (agentId) => {
		const content = [{ type: "thinking", thinking: "只有推理，没有正式回答" }];
		const records =
			agentId === "claude"
				? [claudeMessage("reasoning", null, "assistant", content)]
				: [
						{ type: "session", id: "native" },
						{ type: "message", id: "reasoning", parentId: null, message: { role: "assistant", content } },
					];
		const { input } = await fixture(agentId, records);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.messages.map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: "reasoning", content: "只有推理，没有正式回答" },
		]);
	});

	it("Codex 重复 envelope 不重复显示，但真人重复提交仍保留", async () => {
		const { input } = await fixture("codex", [
			{ type: "session_meta", payload: { id: "native", source: "cli" } },
			{ type: "event_msg", payload: { type: "user_message", message: "同一句话" } },
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "同一句话" }] },
			},
			{ type: "event_msg", payload: { type: "user_message", message: "同一句话" } },
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "同一句话" }] },
			},
			{
				type: "response_item",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "最终结果" }] },
			},
		]);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.messages.map((message) => message.content)).toEqual(["同一句话", "同一句话", "最终结果"]);
	});
	it("Codex 续接分段沿 history_base 翻页，严格保留父段的字节截点", async () => {
		const parentPrefix = `${[
			{ type: "session_meta", payload: { id: "native" } },
			{ type: "event_msg", payload: { type: "agent_message", message: "父段保留的回答" } },
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		const { input, path } = await fixture("codex", [
			{
				type: "session_meta",
				payload: {
					id: "native",
					history_mode: "paginated",
					history_base: {
						thread_id: "native",
						end_byte_offset: Buffer.byteLength(parentPrefix),
						end_ordinal_exclusive: 2,
					},
				},
			},
			{ type: "event_msg", payload: { type: "agent_message", message: "续接后的回答" } },
		]);
		await writeFile(
			join(path, "..", "rollout-native.jsonl"),
			parentPrefix +
				JSON.stringify({
					type: "event_msg",
					payload: { type: "agent_message", message: "父段截点之后的另一分支" },
				}) +
				"\n",
		);
		const current = await loadTaskConversationHistoryPage(input);
		expect(current.nextCursor).not.toBeNull();
		const parent = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: current.nextCursor },
		});
		expect([...parent.messages, ...current.messages].map((message) => message.content)).toEqual([
			"父段保留的回答",
			"续接后的回答",
		]);
		expect(new Set([...parent.messages, ...current.messages].map((message) => message.id)).size).toBe(2);
		expect(parent.nextCursor).toBeNull();
	});
	it("Codex 原生 fork 沿明确父身份读取固定前缀，后续源分支正文不会混入", async () => {
		const parentPrefix = `${[
			{ type: "session_meta", payload: { id: "source-native", cwd: "/task-working-directory" } },
			{ type: "event_msg", payload: { type: "user_message", message: "原主线输入" } },
			{ type: "event_msg", payload: { type: "agent_message", message: "固定父回答" } },
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		const { input, path, summary } = await fixture("codex", [
			{
				type: "session_meta",
				payload: {
					id: "native",
					history_mode: "paginated",
					forked_from_id: "source-native",
					history_base: {
						thread_id: "source-native",
						end_byte_offset: Buffer.byteLength(parentPrefix),
						end_ordinal_exclusive: 3,
					},
				},
			},
			{ type: "event_msg", payload: { type: "agent_message", message: "新主回答" } },
		]);
		summary.workspacePath = "/task-working-directory";
		const parentPath = join(dirname(path), "rollout-source-native.jsonl");
		await writeFile(
			parentPath,
			parentPrefix +
				JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "原主后来的偏题" } }) +
				"\n",
		);
		const current = await loadTaskConversationHistoryPage(input);
		expect(current.availability).toBe("available");
		expect(current.nextCursor).not.toBeNull();
		const parent = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: current.nextCursor },
		});
		expect(parent.availability).toBe("available");
		expect([...parent.messages, ...current.messages].map((message) => message.content)).toEqual([
			"原主线输入",
			"固定父回答",
			"新主回答",
		]);
		await writeFile(parentPath, parentPrefix.replace("source-native", "wrong-native"));
		const rejected = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: current.nextCursor },
		});
		expect(rejected.availability).toBe("unavailable");
	});

	it("Codex 父段缺失时保留当前分段，并明确标记历史不完整", async () => {
		const { input } = await fixture("codex", [
			{
				type: "session_meta",
				payload: {
					id: "native",
					history_mode: "paginated",
					history_base: {
						thread_id: "missing",
						end_byte_offset: 100,
						end_ordinal_exclusive: 2,
					},
				},
			},
			{ type: "event_msg", payload: { type: "agent_message", message: "当前分段" } },
		]);
		const result = await loadTaskConversationHistoryPage(input);
		expect(result.availability).toBe("partially_available");
		expect(result.messages[0]?.content).toBe("当前分段");
		expect(result.notice).toContain("更早");
	});

	it.each(["claude", "omp"] as const)("%s 只展示最新有效分支，不混入被回退的回答", async (agentId) => {
		const records =
			agentId === "claude"
				? [
						claudeMessage("root", null, "user", "需求"),
						claudeMessage("abandoned", "root", "assistant", "被回退的回答"),
						claudeMessage("current", "root", "assistant", "当前回答"),
					]
				: [
						{ type: "session", id: "native" },
						{ type: "message", id: "root", parentId: null, message: { role: "user", content: "需求" } },
						{
							type: "message",
							id: "abandoned",
							parentId: "root",
							message: { role: "assistant", content: "被回退的回答" },
						},
						{
							type: "message",
							id: "current",
							parentId: "root",
							message: { role: "assistant", content: "当前回答" },
						},
					];
		const { input } = await fixture(agentId, records);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.messages.map((message) => message.content)).toEqual(["需求", "当前回答"]);
	});

	it("长会话从最新页向前完整翻页，分页不会丢失或重复消息", async () => {
		const { input } = await fixture(
			"claude",
			Array.from({ length: 205 }, (_, index) =>
				claudeMessage(`m${index}`, index === 0 ? null : `m${index - 1}`, "assistant", `回答 ${index}`),
			),
		);
		const latest = await loadTaskConversationHistoryPage(input);
		expect(latest.messages).toHaveLength(100);
		expect(latest.messages.at(-1)?.content).toBe("回答 204");
		const older = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: latest.nextCursor },
		});
		const earliest = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: older.nextCursor },
		});
		expect([...earliest.messages, ...older.messages, ...latest.messages].map((message) => message.content)).toEqual(
			Array.from({ length: 205 }, (_, index) => `回答 ${index}`),
		);
		expect(earliest.nextCursor).toBeNull();
	});

	it("不能通过会话 ID 读取其他任务的历史", async () => {
		const { input, summary } = await fixture("claude", [claudeMessage("u", null, "user", "不能泄漏")]);
		const page = await loadTaskConversationHistoryPage({
			...input,
			sessions: {
				task: {
					...summary,
					taskConversationSessionMetadata: {
						workspaceTaskId: "another-task",
						taskConversationSessionRole: "main",
						parentTaskConversationSessionId: null,
						taskConversationSessionContextSource: "main",
						latestUserMessagePreview: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
					},
				},
			},
		});
		expect(page.availability).toBe("unavailable");
		expect(page.messages).toEqual([]);
	});

	it("ACP 内存回退同样分页，并拒绝变化后的旧分页标记", async () => {
		const { input, summary } = await fixture("omp", []);
		const retainedInput = {
			...input,
			sessions: { task: { ...summary, agentNativeConversationSessionIdentity: undefined } },
			retainedMessages: Array.from({ length: 105 }, (_, index) => ({
				id: `m${index}`,
				role: "assistant" as const,
				content: `回答 ${index}`,
				createdAt: index,
			})),
		};
		const latest = await loadTaskConversationHistoryPage(retainedInput);
		expect(latest.availability).toBe("partially_available");
		expect(latest.messages).toHaveLength(100);
		const older = await loadTaskConversationHistoryPage({
			...retainedInput,
			request: { ...input.request, cursor: latest.nextCursor },
		});
		expect(older.messages).toHaveLength(5);
		expect(older.messages[0]?.content).toBe("回答 0");
		expect(older.nextCursor).toBeNull();
		const changed = await loadTaskConversationHistoryPage({
			...retainedInput,
			retainedMessages: retainedInput.retainedMessages.slice(1),
			request: { ...input.request, cursor: latest.nextCursor },
		});
		expect(changed.availability).toBe("unavailable");
		const invalid = await loadTaskConversationHistoryPage({
			...retainedInput,
			request: { ...input.request, cursor: "invalid" },
		});
		expect(invalid.availability).toBe("unavailable");
	});

	it("ACP 持久文件移走时使用保留消息分页，文件恢复后仍沿用保留来源游标", async () => {
		const { input, path } = await fixture("omp", [{ type: "session", id: "native" }]);
		await rm(path);
		const retainedInput = {
			...input,
			retainedMessages: Array.from({ length: 105 }, (_, index) => ({
				id: `m${index}`,
				role: "assistant" as const,
				content: `保留回答 ${index}`,
				createdAt: index,
			})),
		};
		const latest = await loadTaskConversationHistoryPage(retainedInput);
		expect(latest.availability).toBe("partially_available");
		expect(latest.messages).toHaveLength(100);
		expect(latest.messages[0]?.content).toBe("保留回答 5");
		expect(latest.nextCursor).not.toBeNull();
		const olderInput = { ...retainedInput, request: { ...input.request, cursor: latest.nextCursor } };
		const older = await loadTaskConversationHistoryPage(olderInput);
		expect(older.messages.map((message) => message.content)).toEqual(
			Array.from({ length: 5 }, (_, index) => `保留回答 ${index}`),
		);
		expect(older.nextCursor).toBeNull();
		await writeFile(path, `${JSON.stringify({ type: "session", id: "native" })}\n`);
		expect(await loadTaskConversationHistoryPage(olderInput)).toEqual(older);
		const changed = await loadTaskConversationHistoryPage({
			...olderInput,
			retainedMessages: retainedInput.retainedMessages.slice(1),
		});
		expect(changed.availability).toBe("unavailable");
		expect(changed.messages).toEqual([]);
	});

	it("原生分页游标遇到文件缺失或变更时不切换到保留消息", async () => {
		const records = [
			{ type: "session", id: "native" },
			...Array.from({ length: 101 }, (_, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				message: { role: "assistant", content: `原生回答 ${index}` },
			})),
		];
		const { input, path } = await fixture("omp", records);
		const latest = await loadTaskConversationHistoryPage(input);
		expect(latest.nextCursor).not.toBeNull();
		const olderInput = {
			...input,
			request: { ...input.request, cursor: latest.nextCursor },
			retainedMessages: [{ id: "retained", role: "assistant" as const, content: "不能替换原生历史", createdAt: 1 }],
		};
		await rm(path);
		const missing = await loadTaskConversationHistoryPage(olderInput);
		expect(missing.availability).toBe("unavailable");
		expect(missing.messages).toEqual([]);
		await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n\n`);
		const changed = await loadTaskConversationHistoryPage(olderInput);
		expect(changed.availability).toBe("unavailable");
		expect(changed.messages).toEqual([]);
	});

	it("ACP 原生身份不符或记录损坏时不切换到保留消息", async () => {
		const { input, path } = await fixture("omp", [{ type: "session", id: "another-session" }]);
		const retainedInput = {
			...input,
			retainedMessages: [{ id: "retained", role: "assistant" as const, content: "不能替换原生历史", createdAt: 1 }],
		};
		const mismatch = await loadTaskConversationHistoryPage(retainedInput);
		expect(mismatch.availability).toBe("unavailable");
		expect(mismatch.messages).toEqual([]);
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", id: "native" })}\n${JSON.stringify({
				type: "message",
				id: "answer",
				parentId: null,
				message: { role: "assistant", content: "仍可确认的原生回答" },
			})}\n{malformed}\n`,
		);
		const damaged = await loadTaskConversationHistoryPage(retainedInput);
		expect(damaged.availability).toBe("partially_available");
		expect(damaged.messages.map((message) => message.content)).toEqual(["仍可确认的原生回答"]);
		expect(damaged.notice).toContain("损坏");
	});

	it("持久记录的原生身份不匹配时拒绝读取", async () => {
		const { input } = await fixture("codex", [
			{ type: "session_meta", payload: { id: "another-session" } },
			{ type: "event_msg", payload: { type: "agent_message", message: "不能泄漏" } },
		]);
		const page = await loadTaskConversationHistoryPage(input);
		expect(page.availability).toBe("unavailable");
		expect(page.messages).toEqual([]);
	});

	it("记录损坏和缺失均明确提示，不伪装成空会话", async () => {
		const { input, path } = await fixture("claude", [claudeMessage("u", null, "user", "需求")]);
		await appendFile(path, "{malformed}\n");
		const damaged = await loadTaskConversationHistoryPage(input);
		expect(damaged.availability).toBe("partially_available");
		expect(damaged.notice).toBeTruthy();
		await rm(path);
		const missing = await loadTaskConversationHistoryPage(input);
		expect(missing.availability).toBe("unavailable");
		expect(missing.notice).toBeTruthy();
	});

	it("分页后文件发生变化时要求刷新，不继续拼接另一份历史", async () => {
		const { input, path } = await fixture(
			"claude",
			Array.from({ length: 101 }, (_, index) =>
				claudeMessage(`m${index}`, index === 0 ? null : `m${index - 1}`, "assistant", `回答 ${index}`),
			),
		);
		const first = await loadTaskConversationHistoryPage(input);
		await appendFile(path, `${JSON.stringify(claudeMessage("new", "m100", "assistant", "新增"))}\n`);
		const stale = await loadTaskConversationHistoryPage({
			...input,
			request: { ...input.request, cursor: first.nextCursor },
		});
		expect(stale.availability).toBe("unavailable");
		expect(stale.notice).toContain("刷新");
	});
});
