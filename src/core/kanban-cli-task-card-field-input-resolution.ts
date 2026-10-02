import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeClineReasoningEffort,
	RuntimeKanbanCliTaskCardFieldUpdateRawInput,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAgentSessionInitializationReuseMode,
	RuntimeTaskClineSettings,
} from "./api-contract";
import { runtimeTaskAgentSessionInitializationSchema } from "./api-contract";
import type { RuntimeUpdateTaskInput } from "./task-board-mutations";

// `kanban task create / update` 的命令行参数 → 卡片字段值的纯函数解析。
// 为什么放在 core：dd2db 1a.2b 之后 update 的「与卡片现值合并」挪进 runtime 的 board 锁内执行
// （src/trpc/kanban-cli-task-board-mutation-api.ts），CLI 进程与 runtime 进程必须共用同一份合并规则。

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
