import { describe, expect, it } from "vitest";
import type { StoredPromptLibraryEntry, WorkspacePromptLibrarySnapshot } from "../../../src/core/api-contract";
import { createPromptDraftUsageService } from "../../../src/server/prompt-draft-usage-service";
import { applyWorkspacePromptLibraryMutation } from "../../../src/state/prompt-library-store";

describe("提交时检查三范围草稿", () => {
	it("检查当前 Task 及关联会话、Project、全局草稿，Command 与其他 Task 不受影响", async () => {
		const text = "请修复登录按钮并为用户登录失败增加清晰的错误提示";
		const entry = (id: string, scope: StoredPromptLibraryEntry["scope"]): StoredPromptLibraryEntry => ({
			id,
			text,
			scope,
			createdAt: 1,
			updatedAt: 2,
		});
		let library: WorkspacePromptLibrarySnapshot = {
			globalScopedPrompts: [
				entry("global", "global"),
				{ ...entry("command", "global"), entryKind: "reusable_command" },
			],
			repoScopedPrompts: [entry("project", "repo")],
			taskScopedPromptsByTaskId: {
				task: [entry("task", "task")],
				"by-the-way": [entry("associated-session", "task")],
				other: [entry("other", "task")],
			},
		};
		const service = createPromptDraftUsageService({
			listTaskConversationSessionIds: async () => ["task", "by-the-way"],
			readLibrary: async () => library,
			mutateLibrary: async (_workspaceId, mutation) => {
				library = applyWorkspacePromptLibraryMutation(library, mutation, 100);
				return library;
			},
			readHistory: async () => ({
				warnings: [],
				prompts: (async function* () {
					yield {
						text,
						sourceAgentId: "claude",
						nativeSessionId: "old-session",
						messageId: "old-prompt",
						submittedAtEpochMs: 5,
					};
				})(),
			}),
			warn: () => {},
		});
		service.notifyUserPromptSubmitted({ workspaceId: "workspace", taskId: "task", submittedAtEpochMs: 30 });
		await service.whenIdle();
		for (const item of [
			library.globalScopedPrompts.find((entry) => entry.id === "global"),
			library.repoScopedPrompts[0],
			library.taskScopedPromptsByTaskId.task[0],
			library.taskScopedPromptsByTaskId["by-the-way"][0],
		])
			expect(item?.draftUsage?.markedUsedAtEpochMs).toBe(100);
		expect(library.globalScopedPrompts.find((entry) => entry.id === "command")?.draftUsage).toBeUndefined();
		expect(library.taskScopedPromptsByTaskId.other[0].draftUsage).toBeUndefined();
		await service.close();
	});
	it("本次 hook 正文不依赖转录已落盘，连续提交不丢失", async () => {
		const texts = ["修复登录按钮", "修复注册按钮"];
		let library: WorkspacePromptLibrarySnapshot = {
			globalScopedPrompts: [],
			repoScopedPrompts: texts.map((text, i) => ({
				id: String(i),
				text,
				scope: "repo",
				createdAt: 1,
				updatedAt: 1,
			})),
			taskScopedPromptsByTaskId: {},
		};
		const service = createPromptDraftUsageService({
			listTaskConversationSessionIds: async () => ["task"],
			readLibrary: async () => library,
			mutateLibrary: async (_workspaceId, mutation) => {
				library = applyWorkspacePromptLibraryMutation(library, mutation, 100);
				return library;
			},
			readHistory: async () => ({ warnings: ["transcript_unreadable"], prompts: (async function* () {})() }),
			warn: () => {},
		});
		for (const text of texts)
			service.notifyUserPromptSubmitted({
				workspaceId: "workspace",
				taskId: "task",
				submittedAtEpochMs: 30,
				submittedPromptText: text,
			});
		await service.whenIdle();
		expect(library.repoScopedPrompts.every((entry) => entry.draftUsage?.markedUsedAtEpochMs === 100)).toBe(true);
		await service.close();
	});
	it("人工恢复未使用后忽略旧历史与无时间历史，之后的新提交仍可命中", async () => {
		const text = "请检查所有登录入口的失败提示";
		let library: WorkspacePromptLibrarySnapshot = {
			globalScopedPrompts: [
				{
					id: "restored",
					text,
					scope: "global",
					createdAt: 1,
					updatedAt: 1,
					draftUsage: { markedUsedAtEpochMs: null, ignoreUserPromptsSubmittedAtOrBeforeEpochMs: 40 },
				},
			],
			repoScopedPrompts: [],
			taskScopedPromptsByTaskId: {},
		};
		const service = createPromptDraftUsageService({
			listTaskConversationSessionIds: async () => ["task"],
			readLibrary: async () => library,
			mutateLibrary: async (_workspaceId, mutation) => {
				library = applyWorkspacePromptLibraryMutation(library, mutation, 100);
				return library;
			},
			readHistory: async () => ({
				warnings: [],
				prompts: (async function* () {
					for (const submittedAtEpochMs of [null, 20, 40])
						yield {
							text,
							sourceAgentId: "codex",
							nativeSessionId: "old-session",
							messageId: String(submittedAtEpochMs),
							submittedAtEpochMs,
						};
				})(),
			}),
			warn: () => {},
		});
		service.notifyUserPromptSubmitted({ workspaceId: "workspace", taskId: "task", submittedAtEpochMs: 50 });
		await service.whenIdle();
		expect(library.globalScopedPrompts[0].draftUsage?.markedUsedAtEpochMs).toBeNull();
		service.notifyUserPromptSubmitted({
			workspaceId: "workspace",
			taskId: "task",
			submittedAtEpochMs: 60,
			submittedPromptText: text,
		});
		await service.whenIdle();
		expect(library.globalScopedPrompts[0].draftUsage?.markedUsedAtEpochMs).toBe(100);
		await service.close();
	});
});
