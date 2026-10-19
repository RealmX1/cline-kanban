import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runtimeTaskAgentSessionInitializationSchema, runtimeTaskSessionSummarySchema } from "../core/api-contract";
import { independentTaskCreationDraftSchema } from "../core/independent-task-creation-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";

export const persistedIndependentTaskCreationDraftSchema = z.object({
	draft: independentTaskCreationDraftSchema,
	sourceSummary: runtimeTaskSessionSummarySchema.nullable(),
	sourceTaskIncarnationCreatedAtEpochMs: z.number().nullable().default(null),
	contextBeforeSideSession: z.string(),
	contextAfterSideSession: z.string(),
	nativeConversationSeed: runtimeTaskAgentSessionInitializationSchema.nullable(),
	reservedTaskId: z.string().nullable(),
	// 请求已发出而进程随后退出时，不重放付费调用；用户可显式重新生成。
	generationAttemptId: z.string().nullable(),
	initialStartAttempted: z.boolean().default(false),
	deferredSourceLandingAuthorized: z.boolean().default(false),
});
export type PersistedIndependentTaskCreationDraft = z.input<typeof persistedIndependentTaskCreationDraftSchema>;

export function independentTaskCreationArtifactDirectory(workspaceId: string, requestId: string) {
	z.string().uuid().parse(requestId);
	const workspaceKey = createHash("sha256").update(workspaceId).digest("hex").slice(0, 20);
	return join(
		getRuntimeHomePath(),
		"cross-task-handoff-artifacts",
		"independent-task-creation",
		workspaceKey,
		requestId,
	);
}

export async function readIndependentTaskCreationDraft(workspaceId: string, requestId: string) {
	try {
		return persistedIndependentTaskCreationDraftSchema.parse(
			JSON.parse(
				await readFile(
					join(independentTaskCreationArtifactDirectory(workspaceId, requestId), "creation-draft.json"),
					"utf8",
				),
			),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function withIndependentTaskCreationDraftLock<T>(
	workspaceId: string,
	requestId: string,
	operation: () => Promise<T>,
) {
	return await lockedFileSystem.withLock(
		{ type: "directory", path: independentTaskCreationArtifactDirectory(workspaceId, requestId) },
		operation,
	);
}

export async function writeIndependentTaskCreationDraft(
	workspaceId: string,
	record: PersistedIndependentTaskCreationDraft,
) {
	await lockedFileSystem.writeTextFileAtomic(
		join(independentTaskCreationArtifactDirectory(workspaceId, record.draft.requestId), "creation-draft.json"),
		JSON.stringify(record),
		{ lock: null },
	);
}

export async function findLatestIndependentTaskCreationDraft(
	workspaceId: string,
	source: { sourceTaskId: string; sourceTaskConversationSessionId: string },
) {
	const root = join(
		independentTaskCreationArtifactDirectory(workspaceId, "00000000-0000-4000-8000-000000000000"),
		"..",
	);
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const drafts = await Promise.all(
		entries
			.filter((entry) => z.string().uuid().safeParse(entry).success)
			.map(async (requestId) => {
				const record = await readIndependentTaskCreationDraft(workspaceId, requestId);
				if (
					!record ||
					record.draft.status === "created" ||
					record.draft.sourceTaskId !== source.sourceTaskId ||
					record.draft.sourceTaskConversationSessionId !== source.sourceTaskConversationSessionId
				)
					return null;
				return { record, updatedAt: (await stat(join(root, requestId, "creation-draft.json"))).mtimeMs };
			}),
	);
	return drafts.filter((entry) => entry !== null).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.record ?? null;
}
