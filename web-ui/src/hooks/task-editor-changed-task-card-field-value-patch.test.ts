import { describe, expect, it } from "vitest";

import {
	buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor,
	type TaskEditorSubmittedTaskCardFieldValues,
} from "@/hooks/task-editor-changed-task-card-field-value-patch";
import type { BoardCard } from "@/types";

// 编辑器保存只发改过的字段：没动的字段交给服务端保留最新现值（编辑期间别人改的不会被旧值顶掉）。

function seededTaskCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Title",
		prompt: "Do the thing",
		startInPlanMode: false,
		taskAgentPermissionMode: "ask_for_every_tool_use",
		taskConversationMode: "operational",
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		worktreeMode: "branch",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as BoardCard;
}

function submittedValuesMatching(card: BoardCard): TaskEditorSubmittedTaskCardFieldValues {
	return {
		prompt: card.prompt.trim(),
		images: card.images ?? [],
		startInPlanMode: card.startInPlanMode,
		taskAgentPermissionMode: card.taskAgentPermissionMode ?? "ask_for_every_tool_use",
		taskConversationMode: card.taskConversationMode ?? "operational",
		autoReviewEnabled: card.autoReviewEnabled === true,
		autoReviewMode: card.autoReviewMode ?? "commit",
		baseRef: card.baseRef,
		worktreeMode: card.worktreeMode ?? "branch",
		agentId: card.agentId,
		clineSettings: card.clineSettings,
		terminalAgentModelOverrideSettings: card.terminalAgentModelOverrideSettings,
		taskAgentSessionInitialization: card.taskAgentSessionInitialization,
	};
}

describe("buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor", () => {
	it("表单与铺表单时的卡片完全一致：patch 为空（标题也不发）", () => {
		const card = seededTaskCard({ prompt: "  Do the thing  " });
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, submittedValuesMatching(card)),
		).toEqual({});
	});

	it("名称未改保持并发名称，显式修改与清空才进入 patch", () => {
		const card = seededTaskCard();
		const submitted = submittedValuesMatching(card);
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
				...submitted,
				taskTitleOverride: card.title,
			}),
		).toEqual({});
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
				...submitted,
				taskTitleOverride: "新名称",
			}),
		).toEqual({ title: "新名称" });
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
				...submitted,
				taskTitleOverride: " ",
			}),
		).toEqual({ title: null });
	});

	it("只带改过的字段；清掉可选字段发 null，清空图片发 null", () => {
		const card = seededTaskCard({
			agentId: "codex",
			images: [{ id: "img-1", data: "AAAA", mimeType: "image/png" }],
		});
		const patch = buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
			...submittedValuesMatching(card),
			prompt: "Do the other thing",
			agentId: undefined,
			images: [],
		});
		expect(patch).toEqual({ prompt: "Do the other thing", agentId: null, images: null });
	});

	it("卡片上缺省、表单补了默认值的字段照发（与改动前整卡覆盖的落盘结果一致）", () => {
		const card = seededTaskCard({
			taskAgentPermissionMode: undefined,
			taskConversationMode: undefined,
			autoReviewEnabled: undefined,
			autoReviewMode: undefined,
			worktreeMode: undefined,
		});
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, submittedValuesMatching(card)),
		).toEqual({
			taskAgentPermissionMode: "ask_for_every_tool_use",
			taskConversationMode: "operational",
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			worktreeMode: "branch",
		});
	});

	it("结构化字段按内容比较：内容相同但是新对象不算改动", () => {
		const card = seededTaskCard({
			taskAgentSessionInitialization: {
				sourceAgentId: "claude",
				sourceSessionId: "6f1c1f9e-2c3b-4d5e-8f70-1a2b3c4d5e6f",
				sourceSessionReuseMode: "fork_existing_session",
			},
		});
		const submitted = submittedValuesMatching(card);
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
				...submitted,
				taskAgentSessionInitialization: JSON.parse(JSON.stringify(card.taskAgentSessionInitialization)),
			}),
		).toEqual({});
		expect(
			buildTaskCardFieldValuePatchContainingOnlyFieldsChangedInTaskEditor(card, {
				...submitted,
				taskAgentSessionInitialization: undefined,
			}),
		).toEqual({ taskAgentSessionInitialization: null });
	});
});
