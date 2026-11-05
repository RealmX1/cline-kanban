import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { TaskEditorCreationSubmissionStatus } from "../core/api-contract";
import {
	taskEditorCreationSubmissionRequestSchema,
	taskEditorCreationSubmissionStatusSchema,
} from "../core/task-editor-creation-submission-contract";
import { webUiUserDecisionClientCharacteristicsSchema } from "../core/work-unit-relation-assertion-write-api-contract";
import { referenceRelationModelingEditorDraftSchema } from "../core/work-unit-relation-modeling-api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { buildInterWorkUnitRelationWorkUnitKey } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { createParsedPersistedJsonFileReadCache } from "../state/parsed-persisted-json-file-read-cache";
import { getRuntimeHomePath } from "../state/runtime-home-path";

const recordSchema = z.object({
	schemaVersion: z.literal(1),
	legacyEditorDraft: referenceRelationModelingEditorDraftSchema.optional(),
	request: taskEditorCreationSubmissionRequestSchema,
	status: taskEditorCreationSubmissionStatusSchema,
	workspacePath: z.string(),
	requestFingerprint: z.string(),
	relationModelingSubmissionId: z.string(),
	// 这是首次受理的证据快照，恢复不能把当前请求伪装成原来的用户手势。
	acceptedUserAuthorization: z
		.object({
			verifiedPageLoadNonceAtAcceptance: z.literal(true),
			acceptedAtEpochMs: z.number(),
			webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
			requestOriginActorEvidence: z.object({
				decodedCliActorClaimsRequestHeader: z.object({ cliActorClaimsRequestHeaderStatus: z.literal("absent") }),
				webUiPageLoadRequestOriginNonceVerificationStatus: z.literal("verified"),
			}),
		})
		.nullable(),
	agentProcessLaunchMayHaveBegun: z.boolean(),
	lastAttemptRuntimeInstanceId: z.string().nullable(),
	lastRecoveryConditionFingerprint: z.string().nullable(),
	failureHistory: z.array(z.object({ occurredAtEpochMs: z.number(), message: z.string() })),
});
export type TaskEditorCreationSubmissionRecord = z.infer<typeof recordSchema>;
const startupProgressReadCache = createParsedPersistedJsonFileReadCache<TaskEditorCreationSubmissionStatus[]>();
const completedStartupProjectionSubmissionIdsByDirectory = new Map<string, Set<string>>();
export const taskEditorCreationFingerprint = (value: unknown) =>
	createHash("sha256")
		.update(
			JSON.stringify(value, (_key, entry: unknown) =>
				entry !== null && typeof entry === "object" && !Array.isArray(entry)
					? Object.fromEntries(
							Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
						)
					: entry,
			),
		)
		.digest("hex");
function submissionsDirectory() {
	return join(getRuntimeHomePath(), "task-editor-creation-submissions");
}
function submissionPath(submissionId: string) {
	z.string().uuid().parse(submissionId);
	return join(submissionsDirectory(), `${submissionId}.json`);
}
function parseTaskEditorCreationSubmissionRecord(text: string) {
	const record = recordSchema.parse(JSON.parse(text));
	if (
		record.request.submissionId !== record.status.submissionId ||
		record.request.newTaskCard.id !== record.status.taskId ||
		record.request.newTaskCard.createdAt !== record.status.taskIncarnationCreatedAtEpochMs ||
		record.request.startAgentAfterCreation !== record.status.startRequested ||
		record.requestFingerprint !== taskEditorCreationFingerprint(record.request)
	)
		throw new Error("创建提交的冻结输入、完整身份或指纹不一致，保留原记录等待核验。");
	return record;
}
export async function readTaskEditorCreationSubmission(workspaceId: string, submissionId: string) {
	try {
		const record = parseTaskEditorCreationSubmissionRecord(await readFile(submissionPath(submissionId), "utf8"));
		if (record.status.workspaceId !== workspaceId)
			throw new TRPCError({ code: "CONFLICT", message: "提交 ID 已绑定另一目标项目，不能修改创建归属。" });
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function writeTaskEditorCreationSubmission(record: TaskEditorCreationSubmissionRecord) {
	record.status.updatedAtEpochMs = Date.now();
	await lockedFileSystem.writeJsonFileAtomic(submissionPath(record.status.submissionId), record, {
		lock: null,
		durable: true,
	});
	startupProgressReadCache.forget(submissionsDirectory());
	if (record.status.phase !== "completed")
		completedStartupProjectionSubmissionIdsByDirectory
			.get(submissionsDirectory())
			?.delete(record.status.submissionId);
}

// 提交记录采用原子替换，目录指纹变化时重读；各项目广播共享同一轮读取，不反复解析冻结正文。
export async function readTaskEditorCreationAgentStartupProgressByTaskId(
	workspaceId: string,
	resolveTaskIncarnationCurrentLocationAndWorkspaceHistory: (status: TaskEditorCreationSubmissionStatus) => Promise<{
		workspaceId: string;
		taskIncarnationCreatedAtEpochMs: number;
		permanentlyRemoved: boolean;
		workspaceIdsUsedByTaskIncarnation?: string[];
	} | null> = (status) =>
		readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture((reader) => {
			const identity =
				reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
					buildInterWorkUnitRelationWorkUnitKey({
						workUnitType: "kanban_board_card",
						workspaceId: status.workspaceId,
						taskId: status.taskId,
						taskIncarnationCreatedAtEpochMs: status.taskIncarnationCreatedAtEpochMs,
					}),
				);
			return identity
				? {
						workspaceId: identity.currentWorkspaceId ?? identity.kanbanBoardCard.workspaceId,
						taskIncarnationCreatedAtEpochMs: identity.kanbanBoardCard.taskIncarnationCreatedAtEpochMs,
						permanentlyRemoved: identity.permanentlyRemovedFromBoardAt !== null,
						workspaceIdsUsedByTaskIncarnation: identity.workspaceIdsUsedByCard,
					}
				: null;
		}),
) {
	const statuses = await startupProgressReadCache.read(submissionsDirectory(), async () => {
		const completedSubmissionIds =
			completedStartupProjectionSubmissionIdsByDirectory.get(submissionsDirectory()) ?? new Set<string>();
		completedStartupProjectionSubmissionIdsByDirectory.set(submissionsDirectory(), completedSubmissionIds);
		const records = await listTaskEditorCreationSubmissions(completedSubmissionIds, () => undefined);
		for (const record of records)
			if (record.status.phase === "completed") completedSubmissionIds.add(record.status.submissionId);
		return records
			.map((record) => record.status)
			.filter(
				(status) =>
					status.cardPersisted &&
					status.startRequested &&
					!status.startCompleted &&
					!["completed", "stopped", "identity_conflict", "waiting_for_authorization"].includes(status.phase),
			);
	});
	const result = new Map<string, TaskEditorCreationSubmissionStatus>();
	for (const status of statuses) {
		const identity = await resolveTaskIncarnationCurrentLocationAndWorkspaceHistory(status);
		if (
			identity?.permanentlyRemoved ||
			(identity && identity.taskIncarnationCreatedAtEpochMs !== status.taskIncarnationCreatedAtEpochMs) ||
			(identity?.workspaceId ?? status.workspaceId) !== workspaceId
		)
			continue;
		const stops = await Promise.all(
			[...new Set([status.workspaceId, workspaceId, ...(identity?.workspaceIdsUsedByTaskIncarnation ?? [])])].map(
				(locationWorkspaceId) =>
					readTaskEditorCreationExplicitStop(
						locationWorkspaceId,
						status.taskId,
						status.taskIncarnationCreatedAtEpochMs,
					),
			),
		);
		if (stops.some((stoppedAt) => stoppedAt !== null && stoppedAt >= status.acceptedAtEpochMs)) continue;
		const previous = result.get(status.taskId);
		if (!previous || previous.acceptedAtEpochMs < status.acceptedAtEpochMs)
			result.set(status.taskId, { ...status, workspaceId });
	}
	return result;
}
export async function withTaskEditorCreationSubmissionLock<T>(
	_workspaceId: string,
	submissionId: string,
	run: () => Promise<T>,
) {
	return lockedFileSystem.withLock({ type: "file", path: submissionPath(submissionId) }, run);
}
export async function listTaskEditorCreationSubmissions(
	completedSubmissionIds: ReadonlySet<string> = new Set(),
	onUnreadableRecord?: (path: string, error: unknown) => void,
) {
	const records: TaskEditorCreationSubmissionRecord[] = [];
	let directories: string[];
	try {
		directories = await readdir(submissionsDirectory());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return records;
		throw error;
	}
	for (const name of directories) {
		if (!name.endsWith(".json")) continue;
		if (completedSubmissionIds.has(name.slice(0, -5))) continue;
		const path = join(submissionsDirectory(), name);
		try {
			records.push(parseTaskEditorCreationSubmissionRecord(await readFile(path, "utf8")));
		} catch (error) {
			if (onUnreadableRecord) onUnreadableRecord(path, error);
			else throw error;
		}
	}
	return records;
}
function explicitStopPath(workspaceId: string, taskId: string, createdAt: number) {
	return join(
		getRuntimeHomePath(),
		"task-editor-creation-explicit-stops",
		`${taskEditorCreationFingerprint([workspaceId, taskId, createdAt])}.json`,
	);
}
export async function recordTaskEditorCreationExplicitStop(workspaceId: string, taskId: string, createdAt: number) {
	await lockedFileSystem.writeJsonFileAtomic(
		explicitStopPath(workspaceId, taskId, createdAt),
		{ stoppedAtEpochMs: Date.now() },
		{ durable: true },
	);
}
export async function readTaskEditorCreationExplicitStop(workspaceId: string, taskId: string, createdAt: number) {
	try {
		return z
			.object({ stoppedAtEpochMs: z.number() })
			.parse(JSON.parse(await readFile(explicitStopPath(workspaceId, taskId, createdAt), "utf8"))).stoppedAtEpochMs;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
