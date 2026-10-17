import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { storedPromptLibraryEntrySchema, type WorkspacePromptLibrarySnapshot } from "../../../src/core/api-contract";
import { applyWorkspacePromptLibraryMutation } from "../../../src/state/prompt-library-store";

function seededLibrary(): WorkspacePromptLibrarySnapshot {
	return {
		globalScopedPrompts: [{ id: "draft", text: "修复登录按钮", scope: "global", createdAt: 10, updatedAt: 20 }],
		repoScopedPrompts: [],
		taskScopedPromptsByTaskId: {},
	};
}

describe("草稿使用状态与可复用命令", () => {
	it("旧条目保留且默认没有使用状态", () => {
		expect(storedPromptLibraryEntrySchema.parse(seededLibrary().globalScopedPrompts[0]).draftUsage).toBeUndefined();
	});
	it("人工标记不改变编辑时间，恢复后记录忽略历史的边界", () => {
		const used = applyWorkspacePromptLibraryMutation(
			seededLibrary(),
			{ kind: "set_prompt_usage_status", promptId: "draft", isUsed: true },
			30,
		);
		expect(used.globalScopedPrompts[0].draftUsage?.markedUsedAtEpochMs).toBe(30);
		expect(used.globalScopedPrompts[0].updatedAt).toBe(20);
		const restored = applyWorkspacePromptLibraryMutation(
			used,
			{ kind: "set_prompt_usage_status", promptId: "draft", isUsed: false },
			40,
		);
		expect(restored.globalScopedPrompts[0].draftUsage).toEqual({
			markedUsedAtEpochMs: null,
			ignoreUserPromptsSubmittedAtOrBeforeEpochMs: 40,
		});
	});
	it("改文重置使用状态，同文冲刷不改变状态", () => {
		const used = applyWorkspacePromptLibraryMutation(
			seededLibrary(),
			{ kind: "set_prompt_usage_status", promptId: "draft", isUsed: true },
			30,
		);
		const same = applyWorkspacePromptLibraryMutation(
			used,
			{ kind: "upsert_prompt", promptId: "draft", scope: "global", text: "修复登录按钮" },
			40,
		);
		expect(same).toBe(used);
		const edited = applyWorkspacePromptLibraryMutation(
			used,
			{ kind: "upsert_prompt", promptId: "draft", scope: "global", text: "修复注册按钮" },
			40,
		);
		expect(edited.globalScopedPrompts[0].draftUsage).toBeUndefined();
	});
	it("自动结果必须仍对应原正文以及人工恢复边界", () => {
		const snapshot = seededLibrary();
		const evidence = {
			workspaceId: "project",
			taskId: "task",
			sourceAgentId: "codex",
			nativeSessionId: "session",
			userPromptMessageId: "message",
			userPromptSubmittedAtEpochMs: 25,
			matchKind: "normalized_exact" as const,
		};
		const mutation = {
			kind: "mark_prompt_used_from_user_prompt_match" as const,
			promptId: "draft",
			expectedPromptTextSha256: createHash("sha256").update("修复登录按钮").digest("hex"),
			expectedIgnoreUserPromptsSubmittedAtOrBeforeEpochMs: null,
			evidence,
		};
		expect(
			applyWorkspacePromptLibraryMutation(snapshot, mutation, 30).globalScopedPrompts[0].draftUsage?.matchEvidence,
		).toEqual(evidence);
		const restored = applyWorkspacePromptLibraryMutation(
			snapshot,
			{ kind: "set_prompt_usage_status", promptId: "draft", isUsed: false },
			40,
		);
		expect(applyWorkspacePromptLibraryMutation(restored, mutation, 50)).toBe(restored);
		expect(
			applyWorkspacePromptLibraryMutation(snapshot, { ...mutation, expectedPromptTextSha256: "stale" }, 50),
		).toBe(snapshot);
	});
	it("转为命令时保留身份及正文，移入指定范围且不再参与使用标记", () => {
		const commands = applyWorkspacePromptLibraryMutation(
			seededLibrary(),
			{ kind: "convert_prompt_to_reusable_command", promptId: "draft", scope: "repo" },
			30,
		);
		expect(commands.globalScopedPrompts).toEqual([]);
		expect(commands.repoScopedPrompts[0]).toMatchObject({
			id: "draft",
			text: "修复登录按钮",
			entryKind: "reusable_command",
			scope: "repo",
			textLastEditedAtEpochMs: 20,
		});
		expect(
			applyWorkspacePromptLibraryMutation(
				commands,
				{ kind: "set_prompt_usage_status", promptId: "draft", isUsed: true },
				40,
			),
		).toBe(commands);
		expect(
			applyWorkspacePromptLibraryMutation(
				commands,
				{ kind: "set_prompt_scope", promptId: "draft", scope: "task", taskId: "another" },
				40,
			),
		).toBe(commands);
	});
});
