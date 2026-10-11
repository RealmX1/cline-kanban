import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "../../../src/core/task-agent-permission-mode";
import { updateTask } from "../../../src/core/task-board-mutations";
import {
	buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch,
	resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard,
} from "../../../src/core/task-card-field-patch-resolution";

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Explicit title",
		prompt: "Original prompt",
		startInPlanMode: true,
		taskAgentPermissionMode: "ask_for_every_tool_use",
		autoReviewEnabled: true,
		autoReviewMode: "pr",
		agentId: "codex",
		clineSettings: { providerId: "anthropic" },
		terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "gpt-5" },
		taskConversationMode: "exploratory",
		baseRef: "main",
		worktreeMode: "inplace",
		prepFilePath: "/tmp/prep.md",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function applyPatch(
	card: RuntimeBoardCard,
	input: Parameters<typeof buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch>[1],
) {
	const board = { columns: [{ id: "review" as const, title: "Review", cards: [card] }] };
	const updated = updateTask(
		board,
		card.id,
		buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(card, input),
		99,
	);
	if (!updated.task) {
		throw new Error("expected the card to be updated");
	}
	return updated.task;
}

describe("buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch", () => {
	it("键缺省 = 保留卡片现值（含 updateTask 里非三态、漏传即复位的那些字段）", () => {
		const renamed = applyPatch(createCard(), { title: "Renamed" });

		expect(renamed).toMatchObject({
			title: "Renamed",
			prompt: "Original prompt",
			startInPlanMode: true,
			taskAgentPermissionMode: "ask_for_every_tool_use",
			autoReviewEnabled: true,
			autoReviewMode: "pr",
			agentId: "codex",
			clineSettings: { providerId: "anthropic" },
			terminalAgentModelOverrideSettings: { agentId: "codex", modelId: "gpt-5" },
			taskConversationMode: "exploratory",
			baseRef: "main",
			worktreeMode: "inplace",
			prepFilePath: "/tmp/prep.md",
		});
	});

	it("null = 清除：标题回落到由 prompt 派生、覆盖类字段回落默认、worktreeMode 回到 branch", () => {
		const cleared = applyPatch(createCard(), {
			title: null,
			agentId: null,
			clineSettings: null,
			terminalAgentModelOverrideSettings: null,
			taskConversationMode: null,
			worktreeMode: null,
			prepFilePath: null,
			taskAgentPermissionMode: null,
		});

		expect(cleared.title).toBe("Original prompt");
		expect(cleared.agentId).toBeUndefined();
		expect(cleared.clineSettings).toBeUndefined();
		expect(cleared.terminalAgentModelOverrideSettings).toBeUndefined();
		expect(cleared.taskConversationMode).toBeUndefined();
		expect(cleared.worktreeMode).toBe("branch");
		expect(cleared.prepFilePath).toBeUndefined();
		expect(cleared.taskAgentPermissionMode).toBe(DEFAULT_TASK_AGENT_PERMISSION_MODE);
	});

	it("images: null 清空附图并推进 Description 时间戳；不提 images 时附图原样保留", () => {
		const withImages = createCard({ images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png" }] });

		expect(applyPatch(withImages, { autoReviewEnabled: false }).images).toEqual(withImages.images);
		const imagesCleared = applyPatch(withImages, { images: null });
		expect(imagesCleared.images).toBeUndefined();
		expect(imagesCleared.taskDescriptionLastUpdatedAt).toBe(99);
	});

	it("改会话初始化（含清除）时一并清掉遗留 parentSessionId，否则卡片 schema 会从它重新派生出被清掉的初始化", () => {
		const legacyCard = createCard({ parentSessionId: "11111111-2222-4333-8444-555555555555" });

		const initializationCleared = applyPatch(legacyCard, { taskAgentSessionInitialization: null });
		expect(initializationCleared.parentSessionId).toBeUndefined();
		expect(initializationCleared.taskAgentSessionInitialization).toBeUndefined();

		// 不碰初始化时 parentSessionId 原样保留。
		expect(applyPatch(legacyCard, { title: "x" }).parentSessionId).toBe("11111111-2222-4333-8444-555555555555");
	});
});

describe("resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard", () => {
	it("按输入种类分派：CLI 原始参数走 inherit / default 哨兵规则", () => {
		const resolved = resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(createCard(), {
			taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
			kanbanCliTaskCardFieldUpdateRawInput: { clineModelId: "claude-opus", clineReasoningEffort: "default" },
		});

		expect(resolved).toMatchObject({
			title: "Explicit title",
			prompt: "Original prompt",
			autoReviewEnabled: true,
			autoReviewMode: "pr",
			clineSettings: { providerId: "anthropic", modelId: "claude-opus" },
		});
	});

	it("按输入种类分派：三态 patch", () => {
		const resolved = resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(createCard(), {
			taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
			taskCardFieldValuePatch: { autoReviewEnabled: false },
		});

		expect(resolved).toMatchObject({ autoReviewEnabled: false, autoReviewMode: "pr", prompt: "Original prompt" });
		expect(resolved.clineSettings).toBeUndefined();
	});
});
