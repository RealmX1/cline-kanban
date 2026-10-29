import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	taskEditorCreationSubmissionRequestSchema,
	taskEditorCreationSubmissionStatusSchema,
} from "../core/task-editor-creation-submission-contract";
import { webUiUserDecisionClientCharacteristicsSchema } from "../core/work-unit-relation-assertion-write-api-contract";
import { referenceRelationModelingEditorDraftSchema } from "../core/work-unit-relation-modeling-api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
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
