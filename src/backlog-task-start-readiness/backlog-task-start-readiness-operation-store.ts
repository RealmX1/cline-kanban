import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	runtimeTaskCardActionStartAgentSessionRequestSchema,
	runtimeTaskSessionSummarySchema,
} from "../core/api-contract";
import {
	backlogTaskStartReadinessReportSchema,
	backlogTaskStartReadinessReviewSchema,
} from "../core/backlog-task-start-readiness-contract";
import { kanbanCliInvocationEnvironmentActorClaimsSchema } from "../core/kanban-cli-invocation-environment-actor-claims";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { backlogTaskStartReadinessFingerprint } from "./backlog-task-start-readiness-evidence";

const requestOriginEvidenceSchema = z.object({
	decodedCliActorClaimsRequestHeader: z.discriminatedUnion("cliActorClaimsRequestHeaderStatus", [
		z.object({ cliActorClaimsRequestHeaderStatus: z.literal("absent") }),
		z.object({ cliActorClaimsRequestHeaderStatus: z.literal("present_but_malformed") }),
		z.object({
			cliActorClaimsRequestHeaderStatus: z.literal("present"),
			claims: kanbanCliInvocationEnvironmentActorClaimsSchema,
		}),
	]),
	webUiPageLoadRequestOriginNonceVerificationStatus: z.enum(["absent", "verified", "unknown"]).optional(),
});
const operationSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	workspacePath: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	acceptedAtEpochMs: z.number(),
	startRequested: z.boolean(),
	authorizedBacklogUnshelvingLastChangedAt: z.number().optional(),
	acceptedStartRequest: runtimeTaskCardActionStartAgentSessionRequestSchema,
	acceptedRequestOriginEvidence: requestOriginEvidenceSchema,
	review: backlogTaskStartReadinessReviewSchema,
	reports: z.array(backlogTaskStartReadinessReportSchema),
	completedReadOnlyRoundCount: z.number().int().min(0).max(3),
	readOnlyEvidence: z.array(z.unknown()),
	lastDependencyFingerprint: z.string().nullable(),
	sameDependencyAttemptCount: z.number().int().nonnegative(),
	nextAttemptAtEpochMs: z.number(),
	agentProcessLaunchMayHaveBegunAtEpochMs: z.number().nullable(),
	launchingSessionSnapshot: runtimeTaskSessionSummarySchema.nullable().default(null),
	initialPromptSha256: z.string().nullable().default(null),
	appliedRevisionTaskFingerprint: z.string().nullable(),
	failureHistory: z.array(z.object({ occurredAtEpochMs: z.number(), message: z.string() })),
	previousWorkspaceIds: z.array(z.string()).default([]),
	conditionOverrides: z.array(
		z.object({
			operationId: z.string(),
			reason: z.string(),
			dependencyFingerprint: z.string(),
			acceptedAtEpochMs: z.number(),
			requestOriginEvidence: requestOriginEvidenceSchema,
		}),
	),
});
export type BacklogTaskStartReadinessOperation = z.infer<typeof operationSchema>;
export const backlogTaskStartReadinessOperationsDirectory = () =>
	join(getRuntimeHomePath(), "backlog-task-start-readiness-operations");
function operationPath(workspaceId: string, taskId: string, createdAt: number) {
	return join(
		backlogTaskStartReadinessOperationsDirectory(),
		`${backlogTaskStartReadinessFingerprint([workspaceId, taskId, createdAt])}.json`,
	);
}
export async function readBacklogTaskStartReadinessOperation(workspaceId: string, taskId: string, createdAt: number) {
	try {
		const record = operationSchema.parse(
			JSON.parse(await readFile(operationPath(workspaceId, taskId, createdAt), "utf8")),
		);
		if (
			record.workspaceId !== workspaceId ||
			record.taskId !== taskId ||
			record.taskIncarnationCreatedAtEpochMs !== createdAt ||
			record.acceptedStartRequest.taskId !== taskId
		)
			throw new Error("开启复核操作与任务完整身份不一致。");
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function writeBacklogTaskStartReadinessOperation(record: BacklogTaskStartReadinessOperation) {
	await lockedFileSystem.writeJsonFileAtomic(
		operationPath(record.workspaceId, record.taskId, record.taskIncarnationCreatedAtEpochMs),
		operationSchema.parse(record),
		{ lock: null, durable: true },
	);
}
export async function listBacklogTaskStartReadinessOperations(onUnreadable: (path: string, error: unknown) => void) {
	let names: string[];
	try {
		names = await readdir(backlogTaskStartReadinessOperationsDirectory());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: BacklogTaskStartReadinessOperation[] = [];
	for (const name of names.filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))) {
		const path = join(backlogTaskStartReadinessOperationsDirectory(), name);
		try {
			records.push(operationSchema.parse(JSON.parse(await readFile(path, "utf8"))));
		} catch (error) {
			onUnreadable(path, error);
		}
	}
	return records;
}
