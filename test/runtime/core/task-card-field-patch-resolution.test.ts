import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { updateTask } from "../../../src/core/task-board-mutations";
import {
	buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch,
	resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard,
} from "../../../src/core/task-card-field-patch-resolution";
import { resolveResumedCodexReasoningEffortOverride } from "../../../src/terminal/codex-reasoning-effort-resume-selection";

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
	it("Codex effort 可独立覆盖、保留或清除，模型仍可继承默认", () => {
		const initial = createCard({ terminalAgentModelOverrideSettings: undefined });
		const selected = applyPatch(initial, { codexReasoningEffortOverride: "ultra" });
		expect(selected.codexReasoningEffortOverride).toBe("ultra");
		expect(selected.terminalAgentModelOverrideSettings).toBeUndefined();
		expect(applyPatch(selected, { prompt: "新正文" }).codexReasoningEffortOverride).toBe("ultra");
		expect(applyPatch(selected, { codexReasoningEffortOverride: null }).codexReasoningEffortOverride).toBeUndefined();
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
	it("CLI 仅改标题时保留旧 profile 的权限来源，明确选择才替换它", () => {
		const legacyCard = createCard({
			codexConfigurationPermissionSelectionSource: "profile",
			taskAgentPermissionMode: "bypass_all_permission_prompts",
		});
		const board = { columns: [{ id: "review" as const, title: "Review", cards: [legacyCard] }] };
		const update = (fields: { title: string; taskAgentPermissionMode?: "ask_for_every_tool_use" }) =>
			updateTask(
				board,
				legacyCard.id,
				resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(legacyCard, {
					taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
					kanbanCliTaskCardFieldUpdateRawInput: fields,
				}),
				99,
			).task;
		expect(update({ title: "改标题" })?.codexConfigurationPermissionSelectionSource).toBe("profile");
		const restricted = update({ title: "编辑权限", taskAgentPermissionMode: "ask_for_every_tool_use" });
		expect(restricted?.codexConfigurationPermissionSelectionSource).toBe("task_local");
		expect(restricted?.taskAgentPermissionMode).toBe("ask_for_every_tool_use");
	});

	it("显式改回沿用 Codex 配置后，续跑不再套用归档推理强度", () => {
		const card = createCard({ codexReasoningEffortOverride: "high" });
		const cleared = applyPatch(card, { codexReasoningEffortOverride: null });
		expect(cleared.codexReasoningEffortOverride).toBeUndefined();
		expect(cleared.codexReasoningEffortFollowsNativeConfiguration).toBe(true);
		expect(
			resolveResumedCodexReasoningEffortOverride({
				requestedOverride: cleared.codexReasoningEffortOverride,
				followsNativeConfiguration: cleared.codexReasoningEffortFollowsNativeConfiguration,
				retiredWriterEffort: "high",
			}),
		).toBeUndefined();
		const selectedAgain = applyPatch(cleared, { codexReasoningEffortOverride: "low" });
		expect(selectedAgain.codexReasoningEffortOverride).toBe("low");
		expect(selectedAgain.codexReasoningEffortFollowsNativeConfiguration).toBeUndefined();
		expect(
			resolveResumedCodexReasoningEffortOverride({
				requestedOverride: undefined,
				retiredWriterEffort: "high",
			}),
		).toBe("high");
	});

	it("按输入种类分派：三态 patch", () => {
		const resolved = resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(createCard(), {
			taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch",
			taskCardFieldValuePatch: { autoReviewEnabled: false },
		});

		expect(resolved).toMatchObject({ autoReviewEnabled: false, autoReviewMode: "pr", prompt: "Original prompt" });
	});
});
