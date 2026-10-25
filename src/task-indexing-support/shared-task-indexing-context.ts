import { createHash } from "node:crypto";
import { z } from "zod";
import { CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID } from "../core/coding-agent-prompt-cache-retention-measured-ttl-lower-bounds";
import type {
	SharedTaskIndexingContext,
	TaskIndexingMaterial,
	TaskIndexingSupportExecutorSettings,
} from "../core/task-indexing-support-contract";

const normalizedTaskSchema = z.object({
	task: z.string(),
	project: z.string(),
	title: z.string(),
	column: z.string(),
	recap: z
		.object({
			requirementsFirstParagraph: z.string(),
			notification: z.string().nullable(),
			finalMessage: z.string().nullable(),
			awaySummary: z.string().nullable(),
		})
		.nullable(),
});
export const sharedTaskIndexingSnapshotSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	instructionVersion: z.string(),
	settingsKey: z.string(),
	levelOneBoardTaskIndexText: z.string(),
	levelTwoProjectTaskRecapsText: z.string(),
	appendedChanges: z.array(z.string()),
	snapshotEntries: z.record(z.string(), normalizedTaskSchema),
	latestEntries: z.record(z.string(), normalizedTaskSchema),
	lastModelRequestAt: z.number().nullable(),
	snapshotFingerprint: z.string(),
});
export type SharedTaskIndexingSnapshot = z.infer<typeof sharedTaskIndexingSnapshotSchema>;
type NormalizedTask = z.infer<typeof normalizedTaskSchema>;
export const taskIndexingTextFingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

/** 只转换稳定前缀；完整原文与限定身份保留在查询材料及业务存储中。 */
export function normalizeTaskIndexingStablePrefixText(text: string): string {
	return text
		.replace(/(?:[A-Za-z]:)?\/[\w.\-~/]+\/(?:\.cline|\.codex)\/worktrees\/[^\s/]+\/[^\s/]+/gu, "worktree:repository")
		.replace(
			/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| UTC)?)?\b/gu,
			"[时间引用]",
		)
		.replace(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu, "[会话引用]")
		.replace(/\b(?:session[_ -]?id|sessionId|nativeSessionId)\s*[=:]\s*[^\s,;]+/giu, "session-reference");
}

export function extractTaskRequirementsFirstParagraph(prompt: string): string {
	const text = prompt
		.replace(/^\s*## TLDR[\t ]*(?:\r?\n|$)/u, "")
		.replace(/<[^>]+>/gu, "\n")
		.replace(/^KANBAN_[A-Z_]+=.*$/gmu, "")
		.trim();
	return (
		text
			.split(/\n\s*\n/u)
			.find((paragraph) => paragraph.trim())
			?.trim() ?? ""
	);
}

export function advanceSharedTaskIndexingSnapshot(
	previous: unknown,
	input: {
		workspaceId: string;
		settings: TaskIndexingSupportExecutorSettings;
		instructionVersion: string;
		materials: readonly TaskIndexingMaterial[];
		now: number;
		forModelRequest?: boolean;
	},
): { snapshot: SharedTaskIndexingSnapshot; context: SharedTaskIndexingContext } {
	const completeness = new Set<string>();
	const boundedStableText = (text: string, key: string): string => {
		const normalized = normalizeTaskIndexingStablePrefixText(text);
		if (normalized !== text) completeness.add(`${key}:stable_reference_normalization`);
		// EXPERIMENT_NODE: 单来源 recap 上限为 12000 字符；较大材料仍可在 L4 按需读取完整要求。
		if (normalized.length > 12000) {
			completeness.add(`${key}:recap_truncated`);
			return `${normalized.slice(0, 12000)}\n[材料已裁剪]`;
		}
		return normalized;
	};
	const entries: Record<string, NormalizedTask> = {};
	for (const material of [...input.materials].sort((a, b) => {
		const key = (m: TaskIndexingMaterial) => `${m.taskReference.workspaceId}/${m.taskReference.taskId}`;
		return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
	})) {
		const reference = material.taskReference;
		const key = `${reference.workspaceId}/${reference.taskId}`;
		for (const part of material.missingContextParts) completeness.add(`${key}:${part}`);
		entries[key] = {
			task: key,
			project: boundedStableText(material.projectName, key),
			title: boundedStableText(material.title, key),
			column: material.columnId,
			recap:
				reference.workspaceId === input.workspaceId
					? {
							requirementsFirstParagraph: boundedStableText(
								extractTaskRequirementsFirstParagraph(material.prompt),
								key,
							),
							notification:
								material.latestNotificationSummaryText === null
									? null
									: boundedStableText(material.latestNotificationSummaryText, key),
							finalMessage:
								material.latestHookFinalMessage === null
									? null
									: boundedStableText(material.latestHookFinalMessage, key),
							awaySummary:
								material.claudeAwaySummary === null ? null : boundedStableText(material.claudeAwaySummary, key),
						}
					: null,
		};
	}
	const settingsKey = JSON.stringify(input.settings);
	const parsed = sharedTaskIndexingSnapshotSchema.safeParse(previous);
	let snapshot = parsed.success ? parsed.data : null;
	let reason: SharedTaskIndexingContext["rebuildReason"] =
		previous === null ? "initial_snapshot" : snapshot ? null : "invalid_snapshot";
	if (
		snapshot &&
		(snapshot.workspaceId !== input.workspaceId ||
			snapshot.settingsKey !== settingsKey ||
			snapshot.instructionVersion !== input.instructionVersion)
	)
		reason = "instruction_version_changed";
	const ttl = CODING_AGENT_PROMPT_CACHE_RETENTION_MEASURED_LOWER_BOUND_BY_AGENT_ID[input.settings.agentId];
	if (snapshot && !reason && snapshot.lastModelRequestAt !== null) {
		if (
			input.forModelRequest &&
			ttl?.promptCacheRetentionScope === "same_agent_process_only_cache_lost_when_agent_process_exits"
		)
			reason = "new_process_cache_reuse_unproven";
		else if (ttl && input.now - snapshot.lastModelRequestAt > ttl.promptCacheRetentionTtlLowerBoundMs)
			reason = "cache_retention_lower_bound_exceeded";
	}
	if (snapshot && !reason) {
		const retired = Object.values(snapshot.snapshotEntries).filter(
			(entry) =>
				entry.recap &&
				entry.column !== "trash" &&
				(!entries[entry.task] || entries[entry.task]?.column === "trash"),
		).length;
		const count = Object.values(snapshot.snapshotEntries).filter((entry) => entry.recap).length;
		if (count > 0 && retired > count * 0.25) reason = "retired_entries_exceed_snapshot_fraction";
	}
	if (snapshot && !reason) {
		const appended = [...snapshot.appendedChanges];
		for (const key of [...new Set([...Object.keys(snapshot.latestEntries), ...Object.keys(entries)])].sort()) {
			const old = snapshot.latestEntries[key],
				current = entries[key];
			if (JSON.stringify(old) === JSON.stringify(current)) continue;
			const changes =
				current && old
					? Object.fromEntries(
							Object.entries(current).filter(
								([name, value]) => JSON.stringify(value) !== JSON.stringify(old[name as keyof NormalizedTask]),
							),
						)
					: (current ?? null);
			appended.push(JSON.stringify({ task: key, changes }));
		}
		if (Buffer.byteLength(appended.join("\n")) > Buffer.byteLength(snapshot.levelTwoProjectTaskRecapsText) * 0.25)
			reason = "appended_changes_exceed_snapshot_fraction";
		else snapshot = { ...snapshot, appendedChanges: appended, latestEntries: entries };
	}
	if (!snapshot || reason) {
		const levelOne = Object.values(entries)
			.map(({ recap: _recap, ...entry }) => JSON.stringify(entry))
			.join("\n");
		const levelTwo = Object.values(entries)
			.filter((entry) => entry.recap)
			.map((entry) => JSON.stringify(entry))
			.join("\n");
		snapshot = {
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			instructionVersion: input.instructionVersion,
			settingsKey,
			levelOneBoardTaskIndexText: levelOne,
			levelTwoProjectTaskRecapsText: levelTwo,
			appendedChanges: [],
			snapshotEntries: entries,
			latestEntries: entries,
			lastModelRequestAt: parsed.success ? parsed.data.lastModelRequestAt : null,
			snapshotFingerprint: taskIndexingTextFingerprint(`${levelOne}\n${levelTwo}`),
		};
	}
	return {
		snapshot,
		context: {
			schemaVersion: 1,
			workspaceId: input.workspaceId,
			levelOneBoardTaskIndexText: snapshot.levelOneBoardTaskIndexText,
			levelTwoProjectTaskRecapsText: snapshot.levelTwoProjectTaskRecapsText,
			levelThreeAppendedChangesText: snapshot.appendedChanges.join("\n"),
			snapshotFingerprint: snapshot.snapshotFingerprint,
			contextCompleteness: [...completeness].sort(),
			asOf: input.now,
			rebuildReason: reason,
		},
	};
}
