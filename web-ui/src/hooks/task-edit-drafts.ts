import type { RuntimeAgentId, RuntimeTaskClineSettings } from "@/runtime/types";
import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";
import type { BoardCard, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import {
	runtimeAgentIdSchema,
	runtimeTaskClineSettingsSchema,
	runtimeTaskImageSchema,
} from "../../../src/core/api-contract";

export interface TaskEditDraft {
	taskId: string;
	prompt: string;
	images: TaskImage[];
	startInPlanMode: boolean;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	branchRef: string;
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	savedAt: number;
}

interface StoredTaskEditDrafts {
	drafts: Record<string, TaskEditDraft>;
}

function getDraftKey(projectId: string, taskId: string): string {
	return JSON.stringify([projectId, taskId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readOptionalAgentId(value: unknown): RuntimeAgentId | undefined {
	const parsed = runtimeAgentIdSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function readTaskImages(value: unknown): TaskImage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((image): TaskImage[] => {
		const parsed = runtimeTaskImageSchema.safeParse(image);
		return parsed.success ? [parsed.data] : [];
	});
}

function readClineSettings(value: unknown): RuntimeTaskClineSettings | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const parsed = runtimeTaskClineSettingsSchema.safeParse(value);
	if (!parsed.success) {
		return undefined;
	}
	const settings = parsed.data;
	if (!settings.providerId && !settings.modelId && !settings.reasoningEffort) {
		return undefined;
	}
	return settings;
}

function readTaskEditDraft(value: unknown): TaskEditDraft | null {
	if (!isRecord(value)) {
		return null;
	}
	const taskId = readOptionalString(value.taskId);
	const prompt = readOptionalString(value.prompt);
	const branchRef = readOptionalString(value.branchRef);
	if (!taskId || prompt === undefined || !branchRef) {
		return null;
	}
	return {
		taskId,
		prompt,
		images: readTaskImages(value.images),
		startInPlanMode: value.startInPlanMode === true,
		autoReviewEnabled: value.autoReviewEnabled === true,
		autoReviewMode: resolveTaskAutoReviewMode(
			readOptionalString(value.autoReviewMode) as TaskAutoReviewMode | undefined,
		),
		branchRef,
		agentId: readOptionalAgentId(value.agentId),
		clineSettings: readClineSettings(value.clineSettings),
		savedAt: typeof value.savedAt === "number" ? value.savedAt : 0,
	};
}

function readStoredTaskEditDrafts(): StoredTaskEditDrafts {
	const raw = readLocalStorageItem(LocalStorageKey.TaskEditDrafts);
	if (!raw) {
		return { drafts: {} };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || !isRecord(parsed.drafts)) {
			return { drafts: {} };
		}
		const drafts: Record<string, TaskEditDraft> = {};
		for (const [key, value] of Object.entries(parsed.drafts)) {
			const draft = readTaskEditDraft(value);
			if (draft) {
				drafts[key] = draft;
			}
		}
		return { drafts };
	} catch {
		return { drafts: {} };
	}
}

function writeStoredTaskEditDrafts(stored: StoredTaskEditDrafts): void {
	if (Object.keys(stored.drafts).length === 0) {
		removeLocalStorageItem(LocalStorageKey.TaskEditDrafts);
		return;
	}
	writeLocalStorageItem(LocalStorageKey.TaskEditDrafts, JSON.stringify(stored));
}

export function readSavedTaskEditDraft(projectId: string | null, taskId: string): TaskEditDraft | null {
	if (!projectId) {
		return null;
	}
	return readStoredTaskEditDrafts().drafts[getDraftKey(projectId, taskId)] ?? null;
}

export function saveTaskEditDraft(projectId: string | null, draft: TaskEditDraft): void {
	if (!projectId) {
		return;
	}
	const stored = readStoredTaskEditDrafts();
	stored.drafts[getDraftKey(projectId, draft.taskId)] = draft;
	writeStoredTaskEditDrafts(stored);
}

export function clearTaskEditDraft(projectId: string | null, taskId: string): void {
	if (!projectId) {
		return;
	}
	const stored = readStoredTaskEditDrafts();
	delete stored.drafts[getDraftKey(projectId, taskId)];
	writeStoredTaskEditDrafts(stored);
}

export function isTaskEditDraftEqualToTask(draft: Omit<TaskEditDraft, "savedAt">, task: BoardCard): boolean {
	return (
		draft.prompt === task.prompt.trim() &&
		JSON.stringify(draft.images) === JSON.stringify(task.images ?? []) &&
		draft.startInPlanMode === task.startInPlanMode &&
		draft.autoReviewEnabled === (task.autoReviewEnabled === true) &&
		draft.autoReviewMode === resolveTaskAutoReviewMode(task.autoReviewMode) &&
		draft.branchRef === task.baseRef &&
		draft.agentId === task.agentId &&
		JSON.stringify(draft.clineSettings ?? null) === JSON.stringify(task.clineSettings ?? null)
	);
}
