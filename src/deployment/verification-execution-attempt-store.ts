import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	runtimePostDeployVerificationRunSchema,
	runtimePostDeployVerificationScriptSchema,
	runtimePostDeployVerificationStateSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { readSystemBootIdentity } from "../task-command-execution/task-command-execution-supervisor";

const verificationExecutionAttemptSchema = z.object({
	verificationExecutionAttemptId: z.string().uuid(),
	workspaceId: z.string(),
	deploymentId: z.string(),
	taskId: z.string(),
	postDeployVerificationTaskInstanceId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number().nonnegative().nullable().default(null),
	itemId: z.string(),
	verificationId: z.string(),
	verificationDefinitionFingerprint: z.string(),
	script: runtimePostDeployVerificationScriptSchema.nullable(),
	startedAtIso: z.string(),
	deadlineAtEpochMs: z.number(),
	systemBootIdentity: z.string().nullable(),
	firstTrustedObservedSystemBootIdentity: z.string().nullable().default(null),
	launchStage: z.enum(["accepted", "launch_committed", "observing", "legacy_unowned", "terminal"]),
	cancellationIntent: z.object({ reason: z.string(), requestedAtIso: z.string() }).nullable(),
	assetsCleanupPending: z.boolean(),
	recoveryBudget: z.object({
		evidenceFingerprint: z.string(),
		unchangedEvidenceProbeCount: z.number().int().min(0).max(3),
		nextActiveProbeAtEpochMs: z.number(),
	}),
	terminalRun: runtimePostDeployVerificationRunSchema.nullable(),
});
export type VerificationExecutionAttempt = z.infer<typeof verificationExecutionAttemptSchema>;

export function verificationExecutionAttemptsDirectory(): string {
	return join(getRuntimeHomePath(), "verification-execution-attempts");
}

export async function withVerificationExecutionAdmissionLock<TResult>(
	operation: () => Promise<TResult>,
): Promise<TResult> {
	await mkdir(getRuntimeHomePath(), { recursive: true });
	return lockedFileSystem.withLock(
		{ path: join(getRuntimeHomePath(), "verification-execution-admission"), type: "file" },
		operation,
	);
}
export function verificationExecutionAttemptDirectory(attemptId: string): string {
	return join(verificationExecutionAttemptsDirectory(), z.string().uuid().parse(attemptId));
}
export function verificationExecutionAttemptCancellationPath(attemptId: string): string {
	return join(verificationExecutionAttemptDirectory(attemptId), "cancellation-intent.json");
}
function attemptRecordPath(attemptId: string): string {
	return join(verificationExecutionAttemptDirectory(attemptId), "attempt.json");
}

export async function readVerificationExecutionAttempt(attemptId: string): Promise<VerificationExecutionAttempt> {
	return verificationExecutionAttemptSchema.parse(JSON.parse(await readFile(attemptRecordPath(attemptId), "utf8")));
}
export async function listVerificationExecutionAttempts(): Promise<VerificationExecutionAttempt[]> {
	let directories: string[];
	try {
		directories = await readdir(verificationExecutionAttemptsDirectory());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: VerificationExecutionAttempt[] = [];
	for (const directory of directories) {
		if (!z.string().uuid().safeParse(directory).success) continue;
		try {
			records.push(await readVerificationExecutionAttempt(directory));
		} catch (error) {
			// 首次分配可先建目录再原子写记录；其间还不允许派发脚本。
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return records;
}

export async function persistVerificationExecutionAttempt(attempt: VerificationExecutionAttempt): Promise<void> {
	await mkdir(verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId), { recursive: true });
	await lockedFileSystem.writeJsonFileAtomic(
		attemptRecordPath(attempt.verificationExecutionAttemptId),
		verificationExecutionAttemptSchema.parse(attempt),
		{ durable: true },
	);
}

export async function mutateVerificationExecutionAttempt<TResult>(
	attemptId: string,
	mutation: (attempt: VerificationExecutionAttempt) => TResult | Promise<TResult>,
): Promise<TResult> {
	return lockedFileSystem.withLock({ path: attemptRecordPath(attemptId), type: "file" }, async () => {
		const attempt = await readVerificationExecutionAttempt(attemptId);
		const result = await mutation(attempt);
		await lockedFileSystem.writeJsonFileAtomic(attemptRecordPath(attemptId), attempt, { lock: null, durable: true });
		return result;
	});
}

export async function allocateVerificationExecutionAttempt(
	input: Pick<
		VerificationExecutionAttempt,
		| "workspaceId"
		| "deploymentId"
		| "taskId"
		| "postDeployVerificationTaskInstanceId"
		| "itemId"
		| "verificationId"
		| "verificationDefinitionFingerprint"
		| "script"
		| "startedAtIso"
	> & { legacyUnowned?: boolean; taskIncarnationCreatedAtEpochMs?: number | null; deadlineAtEpochMs?: number },
): Promise<VerificationExecutionAttempt> {
	const attempt: VerificationExecutionAttempt = {
		...input,
		taskIncarnationCreatedAtEpochMs: input.taskIncarnationCreatedAtEpochMs ?? null,
		verificationExecutionAttemptId: randomUUID(),
		deadlineAtEpochMs:
			input.deadlineAtEpochMs ?? (input.legacyUnowned ? Date.now() : Date.now() + (input.script?.timeoutMs ?? 0)),
		systemBootIdentity: await readSystemBootIdentity(),
		firstTrustedObservedSystemBootIdentity: null,
		launchStage: input.legacyUnowned ? "legacy_unowned" : "accepted",
		cancellationIntent: null,
		assetsCleanupPending: false,
		recoveryBudget: { evidenceFingerprint: "", unchangedEvidenceProbeCount: 0, nextActiveProbeAtEpochMs: 0 },
		terminalRun: null,
	};
	await persistVerificationExecutionAttempt(attempt);
	return attempt;
}

export async function cancelVerificationExecutionAttempt(
	attemptId: string,
	reason: string,
	nowIso: string,
	assetsCleanupPending = false,
): Promise<void> {
	const prior = await readVerificationExecutionAttempt(attemptId);
	if (prior.cancellationIntent && (!assetsCleanupPending || prior.assetsCleanupPending)) return;
	await mutateVerificationExecutionAttempt(attemptId, async (attempt) => {
		attempt.assetsCleanupPending ||= assetsCleanupPending;
		attempt.cancellationIntent ??= { reason, requestedAtIso: nowIso };
		// 取消原件在定义或资产改变之前持久化；监督者只读取原件，不依赖 Web 服务存活。
		await lockedFileSystem.writeJsonFileAtomic(
			verificationExecutionAttemptCancellationPath(attemptId),
			attempt.cancellationIntent,
			{ durable: true },
		);
	});
}

export async function cancelVerificationExecutionsForVerificationId(
	verificationId: string,
	reason: string,
	nowIso: string,
	assetsCleanupPending = false,
): Promise<boolean> {
	let awaitingConfirmedExit = false;
	const attempts = await listVerificationExecutionAttempts();
	// 旧 running 也先建立取消材料；缺少归属不能成为允许删除资产的理由。
	try {
		const state = runtimePostDeployVerificationStateSchema.parse(
			JSON.parse(await readFile(join(getRuntimeHomePath(), "post-deploy-verification-state.json"), "utf8")),
		);
		for (const group of state.deploymentGroups)
			for (const task of group.tasks)
				for (const item of task.checklist) {
					if (
						item.id.replace(/^authored:/, "") !== verificationId ||
						item.run?.status !== "running" ||
						item.run.verificationExecutionAttemptId
					)
						continue;
					if (
						attempts.some(
							(attempt) =>
								attempt.deploymentId === group.deploymentId &&
								attempt.taskId === task.taskId &&
								attempt.itemId === item.id &&
								attempt.startedAtIso === item.run?.startedAtIso,
						)
					)
						continue;
					attempts.push(
						await allocateVerificationExecutionAttempt({
							workspaceId: group.workspaceId,
							deploymentId: group.deploymentId,
							taskId: task.taskId,
							postDeployVerificationTaskInstanceId: task.postDeployVerificationTaskInstanceId ?? randomUUID(),
							itemId: item.id,
							verificationId,
							verificationDefinitionFingerprint: "legacy-unowned-definition",
							script: item.script,
							startedAtIso: item.run.startedAtIso ?? nowIso,
							legacyUnowned: true,
						}),
					);
				}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const attempt of attempts) {
		if (attempt.verificationId !== verificationId) continue;
		if (attempt.launchStage === "terminal") {
			if (!assetsCleanupPending)
				await cancelVerificationExecutionAttempt(attempt.verificationExecutionAttemptId, reason, nowIso);
			continue;
		}
		await cancelVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			reason,
			nowIso,
			assetsCleanupPending,
		);
		awaitingConfirmedExit = true;
	}
	return awaitingConfirmedExit;
}
