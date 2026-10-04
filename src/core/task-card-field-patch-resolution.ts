import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeClineReasoningEffort,
	RuntimeKanbanCliTaskCardFieldUpdateRawInput,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAgentSessionInitializationReuseMode,
	RuntimeTaskCardFieldUpdate,
	RuntimeTaskCardFieldValuePatch,
	RuntimeTaskClineSettings,
} from "./api-contract";
import { runtimeTaskAgentSessionInitializationSchema } from "./api-contract";
import type { RuntimeUpdateTaskInput } from "./task-board-mutations";

// 「改卡片字段」的各种输入 → updateTask 完整输入的纯函数解析。两类输入：
//   - `kanban task create / update` 的命令行参数（inherit / default 哨兵、会话初始化 id + 模式的组合规则）；
//   - 编辑器整卡保存 / 行内改名 / 取消自动动作提交的三态字段 patch。
// 为什么放在 core：与卡片现值的合并在 runtime 的 board 锁内对**最新**卡片执行
// （src/trpc/task-card-action-api.ts 的 updateTaskCardFieldValues），CLI 进程与 runtime 进程必须共用同一份规则；
// 浏览器之后也可经 alias 复用（解析出的结果与服务端逐字一致）。

// CLI `--cline-reasoning-effort` 解析后的四态：具体档位 / "default"（显式回落默认档）/ null（inherit，清除）/ undefined（未传）。
export type ParsedTaskClineReasoningEffort = RuntimeClineReasoningEffort | "default" | null | undefined;

export function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

export function buildTaskAgentSessionInitialization(input: {
	agentId: RuntimeAgentId | null | undefined;
	sourceSessionId: string | null | undefined;
	sourceSessionReuseMode: RuntimeTaskAgentSessionInitializationReuseMode | undefined;
	existingTaskAgentId?: RuntimeAgentId;
	existing?: RuntimeTaskAgentSessionInitialization;
}): RuntimeTaskAgentSessionInitialization | null | undefined {
	if (input.sourceSessionId === undefined && input.sourceSessionReuseMode === undefined) {
		if (
			input.agentId !== undefined &&
			input.existing !== undefined &&
			input.agentId !== input.existing.sourceAgentId
		) {
			return null;
		}
		return undefined;
	}
	if (input.sourceSessionId === null) {
		return null;
	}
	if (
		input.sourceSessionId === undefined &&
		input.agentId !== undefined &&
		input.existing !== undefined &&
		input.agentId !== input.existing.sourceAgentId
	) {
		throw new Error(
			"Changing the session reuse mode while switching agents also requires --agent-session-initialization-id.",
		);
	}
	const sourceSessionId = input.sourceSessionId ?? input.existing?.sourceSessionId;
	const sourceAgentId = input.agentId ?? input.existingTaskAgentId ?? input.existing?.sourceAgentId;
	if (!sourceSessionId || (sourceAgentId !== "claude" && sourceAgentId !== "codex" && sourceAgentId !== "cursor")) {
		throw new Error("Agent session initialization requires --agent-id claude, codex, or cursor and a session UUID.");
	}
	return runtimeTaskAgentSessionInitializationSchema.parse({
		sourceAgentId,
		sourceSessionId,
		sourceSessionReuseMode:
			input.sourceSessionReuseMode ?? input.existing?.sourceSessionReuseMode ?? "resume_existing_session",
		sourceSessionWorkingDirectoryPath: input.existing?.sourceSessionWorkingDirectoryPath,
	});
}

export function buildTaskClineSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskClineReasoningEffort;
}): RuntimeTaskClineSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

export function buildTaskClineSettingsForUpdate(
	currentSettings: RuntimeTaskClineSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskClineReasoningEffort;
	},
): RuntimeTaskClineSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
}

// `kanban task update` 的原始输入与卡片**现值**合并成 updateTask 的完整输入。
// 必须在读到最新卡片的同一把 board 锁内调用：updateTask 里非三态的字段漏传会被复位，
// 所以未传的字段一律从现值回填。输入组合非法（如切 agent 却不给会话 id）时抛错，不产生任何写入。
export function buildRuntimeUpdateTaskInputFromKanbanCliTaskCardFieldUpdateRawInput(
	currentTaskCard: RuntimeBoardCard,
	rawInput: RuntimeKanbanCliTaskCardFieldUpdateRawInput,
): RuntimeUpdateTaskInput {
	const nextTaskClineSettings = buildTaskClineSettingsForUpdate(currentTaskCard.clineSettings, {
		providerId: rawInput.clineProviderId,
		modelId: rawInput.clineModelId,
		reasoningEffort: rawInput.clineReasoningEffort,
	});
	const nextTaskAgentSessionInitialization = buildTaskAgentSessionInitialization({
		agentId: rawInput.agentId,
		sourceSessionId: rawInput.taskAgentSessionInitializationId,
		sourceSessionReuseMode: rawInput.taskAgentSessionInitializationMode,
		existingTaskAgentId: currentTaskCard.agentId,
		existing: currentTaskCard.taskAgentSessionInitialization,
	});
	return {
		title: rawInput.title ?? currentTaskCard.title,
		prompt: rawInput.prompt ?? currentTaskCard.prompt,
		baseRef: rawInput.baseRef ?? currentTaskCard.baseRef,
		startInPlanMode: rawInput.startInPlanMode ?? currentTaskCard.startInPlanMode,
		taskAgentPermissionMode: rawInput.taskAgentPermissionMode ?? currentTaskCard.taskAgentPermissionMode,
		autoReviewEnabled: rawInput.autoReviewEnabled ?? currentTaskCard.autoReviewEnabled === true,
		autoReviewMode: rawInput.autoReviewMode ?? currentTaskCard.autoReviewMode ?? "commit",
		agentId: rawInput.agentId,
		clineSettings: nextTaskClineSettings,
		taskAgentSessionInitialization: nextTaskAgentSessionInitialization,
		parentSessionId: rawInput.parentSessionId,
		worktreeMode: rawInput.worktreeMode,
		prepFilePath: rawInput.prepFilePath,
	};
}

// 三态 patch 与卡片**最新**现值合并成 updateTask 的完整输入（规则见 api-contract 的 runtimeTaskCardFieldValuePatchSchema）。
// updateTask 里 title / prompt / startInPlanMode / autoReview* / baseRef 不是三态字段（漏传即复位），所以这里一律从现值回填；
// 其余字段 updateTask 本身就按「undefined 保留、null 清除」处理，原样下传。
export function buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(
	currentTaskCard: RuntimeBoardCard,
	patch: RuntimeTaskCardFieldValuePatch,
): RuntimeUpdateTaskInput {
	const patchTouchesTaskAgentSessionInitialization = patch.taskAgentSessionInitialization !== undefined;
	return {
		// null / 空白 = 不要显式标题，由 updateTask 按 prompt 派生。
		title: patch.title === undefined ? currentTaskCard.title : (patch.title ?? undefined),
		prompt: patch.prompt ?? currentTaskCard.prompt,
		startInPlanMode: patch.startInPlanMode ?? currentTaskCard.startInPlanMode,
		taskAgentPermissionMode: patch.taskAgentPermissionMode,
		autoReviewEnabled: patch.autoReviewEnabled ?? currentTaskCard.autoReviewEnabled === true,
		autoReviewMode: patch.autoReviewMode ?? currentTaskCard.autoReviewMode ?? "commit",
		// updateTask 的 images 只有两态（undefined 保留 / 数组覆盖，空数组 = 清空），null 折成空数组。
		images: patch.images === undefined ? undefined : (patch.images ?? []),
		taskCommentEntries: patch.taskCommentEntries,
		agentId: patch.agentId,
		ompAgentSessionTransport: patch.ompAgentSessionTransport,
		taskConversationMode: patch.taskConversationMode,
		clineSettings: patch.clineSettings,
		terminalAgentModelOverrideSettings: patch.terminalAgentModelOverrideSettings,
		taskAgentSessionInitialization: patch.taskAgentSessionInitialization,
		baseRef: patch.baseRef ?? currentTaskCard.baseRef,
		parentSessionId:
			patch.parentSessionId === undefined && patchTouchesTaskAgentSessionInitialization
				? null
				: patch.parentSessionId,
		worktreeMode: patch.worktreeMode,
		prepFilePath: patch.prepFilePath,
	};
}

// `taskCardAction.updateTaskCardFieldValues` 的单一入口：按输入种类分派。必须在读到最新卡片的同一把 board 锁内调用；
// 输入组合非法时抛普通 Error（调用方转成 BAD_REQUEST），不产生任何写入。
export function resolveRuntimeUpdateTaskInputFromTaskCardFieldUpdateAgainstLatestTaskCard(
	latestTaskCard: RuntimeBoardCard,
	taskCardFieldUpdate: RuntimeTaskCardFieldUpdate,
): RuntimeUpdateTaskInput {
	switch (taskCardFieldUpdate.taskCardFieldUpdateInputKind) {
		case "kanban_cli_task_update_command_raw_arguments":
			return buildRuntimeUpdateTaskInputFromKanbanCliTaskCardFieldUpdateRawInput(
				latestTaskCard,
				taskCardFieldUpdate.kanbanCliTaskCardFieldUpdateRawInput,
			);
		case "three_state_task_card_field_value_patch":
			return buildRuntimeUpdateTaskInputFromThreeStateTaskCardFieldValuePatch(
				latestTaskCard,
				taskCardFieldUpdate.taskCardFieldValuePatch,
			);
	}
}
