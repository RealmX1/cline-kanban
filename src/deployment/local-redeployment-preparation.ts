import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { authorizedUnretainableHandoverSessionSchema } from "../core/api-contract";
import {
	taskCommandExecutionAdoptExistingSupervisorRequestSchema,
	taskCommandExecutionSpecificationSchema,
} from "../core/task-command-execution-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceSessionsById,
	loadPersistedWorkspaceStateById,
} from "../state/workspace-state";
import { createTaskConversationSessionOperationStore } from "../task-conversation-sessions/task-conversation-session-operation-store";

export class LocalRedeploymentIdentityMismatch extends Error {
	override name = "LocalRedeploymentIdentityMismatch";
}

export const executeLocalRedeploymentFile = promisify(execFile);
export const localRedeploymentSha256 = (value: string | Buffer): string =>
	createHash("sha256").update(value).digest("hex");
const absolutePath = z.string().min(1).refine(isAbsolute, "必须提供绝对路径");
const processBaseline = z.strictObject({
	processId: z.number().int().positive(),
	processStartTimeText: z.string().min(1),
});
const nonPreservableSessionInterruptionAuthorizationSchema = z.strictObject({
	sourceReference: z.string().trim().min(1),
	userRequestQuote: z.string().trim().min(1),
});
const storedSessionInterruptionAuthorizationSchema = z.strictObject({
	requestSha256: z.string().length(64),
	authorization: nonPreservableSessionInterruptionAuthorizationSchema,
});
const sessionInterruptionAuthorizationFilename = "non-preservable-session-interruption-authorization.json";
export const localRedeploymentRequestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: z.uuid(),
	workspaceId: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
	taskId: z.string().min(1),
	originatingTaskWorktreePath: absolutePath,
	sourceCheckoutPath: absolutePath,
	candidateSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
	previousDeploymentExecution: z
		.strictObject({
			executionId: z.uuid(),
			executionDirectory: absolutePath,
		})
		.optional(),
	sourceValidationEvidenceFilePaths: z.array(absolutePath.refine((path) => !path.includes("\0"))).optional(),
	deploymentNodeBinaryPath: absolutePath,
	distributionDirectoryPath: absolutePath,
	runtimeIdentity: z.strictObject({
		runtimeHomeDirectoryPath: absolutePath,
		runtimeHost: z.enum(["127.0.0.1", "localhost", "::1"]),
		runtimePort: z.number().int().min(1).max(65535),
	}),
	serviceLaunch: z.strictObject({
		command: z
			.array(
				z
					.string()
					.min(1)
					.refine((value) => !value.includes("\0")),
			)
			.nonempty(),
		tmuxSessionName: z
			.string()
			.regex(/^[A-Za-z0-9_-]+$/u)
			.optional(),
	}),
	authorization: z.strictObject({ sourceReference: z.string().min(1), userRequestQuote: z.string().min(1) }),
	nonPreservableSessionInterruptionAuthorization: nonPreservableSessionInterruptionAuthorizationSchema.optional(),
});
export type LocalRedeploymentRequest = z.infer<typeof localRedeploymentRequestSchema>;
export const LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME =
	"local-redeployment-source-validation-preparer.mjs";
export const LOCAL_REDEPLOYMENT_SESSION_CONTINUITY_PREFLIGHT_FILENAME = "session-continuity-preflight.json";
const deploymentSourceValidationReportFilename = "source-validation-evidence-reuse-report.json";
const frozenRequestSchema = z.strictObject({
	request: localRedeploymentRequestSchema,
	requestSha256: z.string().length(64),
	executorSha256: z.string().length(64),
	sourceValidationPreparerSha256: z.string().length(64).optional(),
	npmCliEntrypointPath: absolutePath,
	serviceExecutableSha256: z.string().length(64),
	owner: taskCommandExecutionAdoptExistingSupervisorRequestSchema.shape.expectedOwner.nullable(),
	previousDeploymentTaskIdentity: z
		.strictObject({
			taskIncarnationCreatedAtEpochMs: z.number().nullable(),
			worktreeIdentity:
				taskCommandExecutionAdoptExistingSupervisorRequestSchema.shape.expectedOwner.shape.worktreeIdentity,
		})
		.optional(),
});
export type FrozenLocalRedeploymentRequest = z.infer<typeof frozenRequestSchema>;
export const localRedeploymentRuntimeBaselineSchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("verified_online"), runtimeBefore: processBaseline }),
	z.strictObject({
		state: z.literal("verified_offline"),
		runtimeBefore: z.null(),
		listenerObservation: z.literal("connection_refused_and_no_listener"),
		systemBootIdentity: z.string().min(1),
	}),
	z.strictObject({ state: z.literal("unknown"), runtimeBefore: z.null(), reason: z.string() }),
]);

export async function readLocalRedeploymentJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function writeLocalRedeploymentJson(path: string, value: unknown): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, value, { durable: true, fileMode: 0o600 });
}
export function assertLocalRedeploymentNotRevoked(directory: string): void {
	for (const name of ["redeployment-revocation.json", "local-deployment-execution-restriction.json"])
		if (existsSync(join(directory, name))) throw new Error("本次重部署已有持久撤销或执行限制");
}

export async function readLocalRedeploymentSessionInterruptionAuthorization(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
) {
	const stored = await readLocalRedeploymentJson(join(directory, sessionInterruptionAuthorizationFilename));
	if (stored === null) return frozen.request.nonPreservableSessionInterruptionAuthorization ?? null;
	const receipt = storedSessionInterruptionAuthorizationSchema.parse(stored);
	if (receipt.requestSha256 !== frozen.requestSha256)
		throw new LocalRedeploymentIdentityMismatch("会话中断授权与本次冻结请求不匹配");
	if (
		frozen.request.nonPreservableSessionInterruptionAuthorization &&
		JSON.stringify(receipt.authorization) !==
			JSON.stringify(frozen.request.nonPreservableSessionInterruptionAuthorization)
	)
		throw new LocalRedeploymentIdentityMismatch("补充授权与冻结请求中的会话中断授权不匹配");
	return receipt.authorization;
}

export async function authorizeLocalRedeploymentSessionInterruption(directory: string, raw: unknown) {
	const authorization = nonPreservableSessionInterruptionAuthorizationSchema.parse(raw);
	const path = join(directory, sessionInterruptionAuthorizationFilename);
	return lockedFileSystem.withLock(
		{ path: join(directory, "redeployment-session-interruption-authorization") },
		async () => {
			const frozen = await readFrozenLocalRedeploymentRequest(directory);
			await assertLocalRedeploymentOwnerStillEligible(directory, frozen);
			const previous = await readLocalRedeploymentSessionInterruptionAuthorization(directory, frozen);
			if (previous && JSON.stringify(previous) !== JSON.stringify(authorization))
				throw new LocalRedeploymentIdentityMismatch("本轮已绑定另一条会话中断授权");
			assertLocalRedeploymentNotRevoked(directory);
			if (!previous) await writeLocalRedeploymentJson(path, { requestSha256: frozen.requestSha256, authorization });
			return { ok: true, executionId: frozen.request.executionId, authorization };
		},
	);
}

export const LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME =
	"authorized-owner-session-interruption-at-restart.json";

export const localRedeploymentAuthorizedOwnerInterruptionSchema = z
	.object({
		requestSha256: z.string(),
		dispatchedAtEpochMs: z.number(),
		runtimeBefore: processBaseline,
		nativeHandover: z.object({
			outcome: z.literal("handover_restart_started"),
			runtimeProcessId: z.number().int().positive(),
			runtimeProcessStartTimeText: z.string().min(1),
			authorizedUnretainableSessionHandoverBound: z.literal(true),
			authorizedUnretainableSessionsAtHandoverAcceptance: z.array(authorizedUnretainableHandoverSessionSchema),
		}),
		authorizedOwnerSession: z.object({
			workspaceId: z.string().min(1),
			conversationSessionId: z.string().min(1),
			nativeConversationSessionId: z.string().min(1),
			runtimeSessionIncarnationId: z.string().nullable(),
		}),
	})
	.refine(({ authorizedOwnerSession, nativeHandover }) =>
		nativeHandover.authorizedUnretainableSessionsAtHandoverAcceptance.some(
			(session) =>
				session.workspaceId === authorizedOwnerSession.workspaceId &&
				session.conversationSessionId === authorizedOwnerSession.conversationSessionId &&
				session.nativeConversationSessionId === authorizedOwnerSession.nativeConversationSessionId &&
				session.runtimeSessionIncarnationId === authorizedOwnerSession.runtimeSessionIncarnationId,
		),
	);

async function deploymentRestartAcceptedAfterAuthorizedOwnerInterruption(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<boolean> {
	const interruption = localRedeploymentAuthorizedOwnerInterruptionSchema.safeParse(
		await readLocalRedeploymentJson(join(directory, LOCAL_REDEPLOYMENT_AUTHORIZED_OWNER_INTERRUPTION_FILENAME)),
	);
	const authorizedOwner = interruption.success ? interruption.data.authorizedOwnerSession : null;
	if (
		!interruption.success ||
		!authorizedOwner ||
		!frozen.owner ||
		interruption.data.requestSha256 !== frozen.requestSha256 ||
		interruption.data.nativeHandover.runtimeProcessId !== interruption.data.runtimeBefore.processId ||
		interruption.data.nativeHandover.runtimeProcessStartTimeText.trim().replace(/\s+/gu, " ") !==
			interruption.data.runtimeBefore.processStartTimeText.trim().replace(/\s+/gu, " ") ||
		authorizedOwner.workspaceId !== frozen.request.workspaceId ||
		authorizedOwner.conversationSessionId !== frozen.owner.conversationSessionId ||
		authorizedOwner.nativeConversationSessionId !== frozen.owner.nativeSessionId ||
		authorizedOwner.runtimeSessionIncarnationId !== frozen.owner.runtimeSessionIncarnationId ||
		!(await readLocalRedeploymentSessionInterruptionAuthorization(directory, frozen))
	)
		return false;
	const deployment = z
		.object({
			manifest: z.object({
				executionId: z.string(),
				redeploymentRequestSha256: z.string(),
				candidateDistributionSha256: z.string(),
			}),
		})
		.safeParse(await readLocalRedeploymentJson(join(directory, "local-deployment-execution.json")));
	if (
		!deployment.success ||
		deployment.data.manifest.executionId !== frozen.request.executionId ||
		deployment.data.manifest.redeploymentRequestSha256 !== frozen.requestSha256
	)
		return false;
	const acceptance = z
		.object({
			executionId: z.string(),
			candidateDistributionSha256: z.string(),
			observedAtEpochMs: z.number(),
			runtime: z.object({
				ok: z.literal(true),
				runtimeProcessId: z.number(),
				runtimeProcessStartTimeText: z.string(),
			}),
		})
		.safeParse(await readLocalRedeploymentJson(join(directory, "runtime-restart-acceptance.json")));
	return (
		acceptance.success &&
		acceptance.data.executionId === frozen.request.executionId &&
		acceptance.data.candidateDistributionSha256 === deployment.data.manifest.candidateDistributionSha256 &&
		acceptance.data.observedAtEpochMs >= interruption.data.dispatchedAtEpochMs &&
		(acceptance.data.runtime.runtimeProcessId !== interruption.data.runtimeBefore.processId ||
			acceptance.data.runtime.runtimeProcessStartTimeText.trim().replace(/\s+/gu, " ") !==
				interruption.data.runtimeBefore.processStartTimeText.trim().replace(/\s+/gu, " "))
	);
}

export async function readCurrentBoundLocalRedeploymentOwner(
	request: LocalRedeploymentRequest,
): Promise<FrozenLocalRedeploymentRequest["owner"]> {
	// 外部 CLI 没有会话绑定时只保存业务结果，不从 taskId 猜测接收会话。
	if (process.env.KANBAN_TASK_ID !== request.taskId || !process.env.KANBAN_TASK_CONVERSATION_SESSION_ID) return null;
	const state = await loadPersistedWorkspaceStateById(request.workspaceId);
	const card = state.board.columns.flatMap((column) => column.cards).find((card) => card.id === request.taskId);
	const conversationSessionId = process.env.KANBAN_TASK_CONVERSATION_SESSION_ID;
	if (card && resolveMainTaskConversationSessionId(card) !== conversationSessionId) return null;
	const summary = (await loadPersistedWorkspaceSessionsById(request.workspaceId, { requireCompleteRead: true }))[
		conversationSessionId
	];
	const nativeSessionId = summary?.agentNativeConversationSessionIdentity?.nativeSessionId;
	if (
		!card ||
		!summary?.workspacePath ||
		!nativeSessionId ||
		(await realpath(summary.workspacePath)) !== (await realpath(request.originatingTaskWorktreePath))
	)
		throw new Error("会话绑定存在，但无法证明原任务与工作树归属，等待权威快照恢复");
	return {
		taskIncarnationCreatedAtEpochMs: card.createdAt,
		conversationSessionId,
		nativeSessionId,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
		worktreeIdentity: await readLocalRedeploymentWorktreeIdentity(request.originatingTaskWorktreePath),
	};
}

async function readLocalRedeploymentWorktreeIdentity(path: string) {
	const metadata = await stat(path);
	return {
		realPath: await realpath(path),
		device: metadata.dev,
		inode: metadata.ino,
		createdAtEpochMs: metadata.birthtimeMs,
	};
}

function optionalPredecessorEvidenceUnavailable(error: unknown): null {
	if (
		error instanceof SyntaxError ||
		error instanceof z.ZodError ||
		(error instanceof Error && "syscall" in error && "code" in error)
	)
		return null;
	throw error;
}

export async function canonicalizeLocalRedeploymentRequest(
	parsedRequest: LocalRedeploymentRequest,
): Promise<LocalRedeploymentRequest> {
	return {
		...parsedRequest,
		...(parsedRequest.previousDeploymentExecution
			? {
					previousDeploymentExecution: {
						...parsedRequest.previousDeploymentExecution,
						executionDirectory:
							(await realpath(parsedRequest.previousDeploymentExecution.executionDirectory).catch(
								optionalPredecessorEvidenceUnavailable,
							)) ?? resolve(parsedRequest.previousDeploymentExecution.executionDirectory),
					},
				}
			: {}),
		sourceCheckoutPath: await realpath(parsedRequest.sourceCheckoutPath),
		originatingTaskWorktreePath: await realpath(parsedRequest.originatingTaskWorktreePath),
		distributionDirectoryPath: existsSync(parsedRequest.distributionDirectoryPath)
			? await realpath(parsedRequest.distributionDirectoryPath)
			: resolve(parsedRequest.distributionDirectoryPath),
	};
}

export async function prepareLocalRedeployment(directory: string, raw: unknown, executorPath: string) {
	const request = await canonicalizeLocalRedeploymentRequest(localRedeploymentRequestSchema.parse(raw));
	if ((await realpath(request.deploymentNodeBinaryPath)) !== (await realpath(process.execPath)))
		throw new Error("必须使用本次服务绑定的实际 Node 准备重部署");
	const commit = (
		await executeLocalRedeploymentFile("git", [
			"--no-optional-locks",
			"-C",
			request.sourceCheckoutPath,
			"rev-parse",
			`${request.candidateSourceCommit}^{commit}`,
		])
	).stdout.trim();
	if (commit !== request.candidateSourceCommit) throw new Error("候选提交身份不匹配");
	if (!isAbsolute(request.serviceLaunch.command[0])) throw new Error("服务启动入口必须是绑定的绝对路径");
	await mkdir(directory, { recursive: true });
	return lockedFileSystem.withLock({ path: join(directory, "redeployment-request-preparation") }, async () => {
		const source = await readFile(executorPath);
		const sourceValidationPreparer = await readFile(
			join(dirname(executorPath), LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME),
		);
		const frozen: FrozenLocalRedeploymentRequest = {
			request,
			requestSha256: localRedeploymentSha256(JSON.stringify(request)),
			executorSha256: localRedeploymentSha256(source),
			sourceValidationPreparerSha256: localRedeploymentSha256(sourceValidationPreparer),
			npmCliEntrypointPath: await realpath(join(dirname(request.deploymentNodeBinaryPath), "npm")),
			serviceExecutableSha256: localRedeploymentSha256(await readFile(request.serviceLaunch.command[0])),
			owner: await readCurrentBoundLocalRedeploymentOwner(request),
		};
		if (!frozen.owner && getRuntimeHomePath() === request.runtimeIdentity.runtimeHomeDirectoryPath) {
			const { board } = await loadPersistedWorkspaceStateById(request.workspaceId);
			const card = board.columns.flatMap((column) => column.cards).find((card) => card.id === request.taskId);
			if (card)
				frozen.previousDeploymentTaskIdentity = {
					taskIncarnationCreatedAtEpochMs: card.createdAt,
					worktreeIdentity: await readLocalRedeploymentWorktreeIdentity(request.originatingTaskWorktreePath),
				};
		}
		await readBoundPreviousLocalRedeployment(directory, frozen);
		const previous = await readLocalRedeploymentJson(join(directory, "frozen-redeployment-request.json"));
		if (previous && JSON.stringify(frozenRequestSchema.parse(previous)) !== JSON.stringify(frozen))
			throw new LocalRedeploymentIdentityMismatch("相同执行目录已绑定不同请求、工具或会话归属");
		const entrypoint = join(directory, "frozen-local-redeployment-executor.mjs");
		if (existsSync(entrypoint) && localRedeploymentSha256(await readFile(entrypoint)) !== frozen.executorSha256)
			throw new LocalRedeploymentIdentityMismatch("冻结工具原件发生变化，不能覆盖");
		const frozenPreparerPath = join(directory, LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME);
		if (
			existsSync(frozenPreparerPath) &&
			localRedeploymentSha256(await readFile(frozenPreparerPath)) !== frozen.sourceValidationPreparerSha256
		)
			throw new LocalRedeploymentIdentityMismatch("冻结源码验证工具原件发生变化，不能覆盖");
		await lockedFileSystem.writeTextFileAtomic(entrypoint, source.toString("utf8"), {
			durable: true,
			fileMode: 0o700,
		});
		await lockedFileSystem.writeTextFileAtomic(frozenPreparerPath, sourceValidationPreparer.toString("utf8"), {
			durable: true,
			fileMode: 0o600,
		});
		// 仅复制启动所需的原生模块闭包，避免随后 npm ci 或共享依赖漂移影响冻结工具。
		for (const dependency of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
			const original = join(request.sourceCheckoutPath, "node_modules", dependency);
			const destination = join(directory, "node_modules", dependency);
			if (!existsSync(destination) && existsSync(original))
				await cp(await realpath(original), destination, { recursive: true, dereference: true });
		}
		await writeLocalRedeploymentJson(join(directory, "frozen-redeployment-request.json"), frozen);
		const specification = createLocalRedeploymentOwnedCommandSpecification(directory, frozen);
		await writeLocalRedeploymentJson(join(directory, "owned-command-specification.json"), specification);
		return {
			ok: true,
			executionDirectory: directory,
			taskId: request.taskId,
			idempotencyKey: `local-redeployment:${request.executionId}`,
			specification,
		};
	});
}

export async function readFrozenLocalRedeploymentRequest(directory: string): Promise<FrozenLocalRedeploymentRequest> {
	const frozen = frozenRequestSchema.parse(
		await readLocalRedeploymentJson(join(directory, "frozen-redeployment-request.json")),
	);
	if (
		localRedeploymentSha256(JSON.stringify(frozen.request)) !== frozen.requestSha256 ||
		localRedeploymentSha256(await readFile(join(directory, "frozen-local-redeployment-executor.mjs"))) !==
			frozen.executorSha256 ||
		(frozen.sourceValidationPreparerSha256 !== undefined &&
			localRedeploymentSha256(
				await readFile(join(directory, LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME)),
			) !== frozen.sourceValidationPreparerSha256)
	)
		throw new LocalRedeploymentIdentityMismatch("冻结请求或执行器摘要不匹配");
	return frozen;
}

export async function readBoundPreviousLocalRedeployment(
	directory: string,
	current: FrozenLocalRedeploymentRequest,
): Promise<FrozenLocalRedeploymentRequest | null> {
	const { request } = current;
	const previous = request.previousDeploymentExecution;
	if (!previous) return null;
	if (previous.executionId === request.executionId || previous.executionDirectory === (await realpath(directory)))
		throw new LocalRedeploymentIdentityMismatch("前序执行目录或身份与当前执行冲突");
	const previousRealPath = await realpath(previous.executionDirectory).catch(optionalPredecessorEvidenceUnavailable);
	if (!previousRealPath) return null;
	if (previous.executionDirectory !== previousRealPath)
		throw new LocalRedeploymentIdentityMismatch("前序执行目录与冻结的规范路径冲突");
	const frozen = await readFrozenLocalRedeploymentRequest(previousRealPath).catch(
		optionalPredecessorEvidenceUnavailable,
	);
	if (!frozen) return null;
	const previousTask = frozen.owner ?? frozen.previousDeploymentTaskIdentity;
	const currentTask = current.owner ?? current.previousDeploymentTaskIdentity;
	if (
		frozen.request.executionId !== previous.executionId ||
		frozen.request.workspaceId !== request.workspaceId ||
		frozen.request.taskId !== request.taskId ||
		frozen.request.originatingTaskWorktreePath !== request.originatingTaskWorktreePath ||
		JSON.stringify(frozen.request.runtimeIdentity) !== JSON.stringify(request.runtimeIdentity) ||
		frozen.request.distributionDirectoryPath !== request.distributionDirectoryPath
	)
		throw new LocalRedeploymentIdentityMismatch("前序执行与当前任务、部署目标或指定执行身份不匹配");
	if (
		currentTask &&
		(JSON.stringify(currentTask.worktreeIdentity) !==
			JSON.stringify(await readLocalRedeploymentWorktreeIdentity(request.originatingTaskWorktreePath)) ||
			(previousTask &&
				JSON.stringify(previousTask.worktreeIdentity) !== JSON.stringify(currentTask.worktreeIdentity)))
	)
		throw new LocalRedeploymentIdentityMismatch("前序执行与当前工作树实体不匹配");
	if (previousTask?.taskIncarnationCreatedAtEpochMs == null || currentTask?.taskIncarnationCreatedAtEpochMs == null)
		return null;
	if (previousTask.taskIncarnationCreatedAtEpochMs !== currentTask.taskIncarnationCreatedAtEpochMs)
		throw new LocalRedeploymentIdentityMismatch("前序执行与当前任务代际不匹配");
	return frozen;
}

export async function createBoundLocalRedeploymentSourceValidationArguments(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<string[]> {
	const predecessor = await readBoundPreviousLocalRedeployment(directory, frozen);
	const previousDirectory = frozen.request.previousDeploymentExecution?.executionDirectory;
	const previousReportPath =
		predecessor && previousDirectory
			? join(previousDirectory, "source-validation", deploymentSourceValidationReportFilename)
			: null;
	const boundPreviousReportPath =
		previousReportPath && (await isBoundPredecessorSourceValidationReportPath(previousReportPath))
			? previousReportPath
			: null;
	return [
		join(directory, LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME),
		"--source-checkout-path",
		join(directory, "candidate-source-checkout"),
		"--candidate-source-commit",
		frozen.request.candidateSourceCommit,
		"--runtime-home-directory",
		frozen.request.runtimeIdentity.runtimeHomeDirectoryPath,
		"--output-directory",
		join(directory, "source-validation"),
		...[
			...(frozen.request.sourceValidationEvidenceFilePaths ?? []).filter(
				(path) => basename(resolve(path)) !== deploymentSourceValidationReportFilename,
			),
			...(boundPreviousReportPath ? [boundPreviousReportPath] : []),
		].flatMap((path) => ["--source-validation-evidence-file-path", path]),
	];
}

async function isBoundPredecessorSourceValidationReportPath(path: string): Promise<boolean> {
	try {
		if (!(await lstat(dirname(path))).isDirectory()) return false;
		return (await lstat(path)).isFile();
	} catch (error) {
		// 同一执行可能已有该规范路径的持久原件副本。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		optionalPredecessorEvidenceUnavailable(error);
		return false;
	}
}

export function createLocalRedeploymentOwnedCommandSpecification(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
) {
	const command = [
		frozen.request.deploymentNodeBinaryPath,
		join(directory, "frozen-local-redeployment-executor.mjs"),
		"run-redeployment",
		"--execution-directory",
		resolve(directory),
	];
	return taskCommandExecutionSpecificationSchema.parse({
		command,
		resumeCommand: command,
		resumeCommandPreservesBusinessSingleFlight: true,
		ownerSessionInterruptPolicy: "preserve_execution",
		supervisorMaintainsSemanticRecovery: true,
		beforeSupervisorRecoveryDispatchValidationCommand: [
			frozen.request.deploymentNodeBinaryPath,
			join(directory, "frozen-local-redeployment-executor.mjs"),
			"validate-redeployment-owner",
			"--execution-directory",
			resolve(directory),
		],
		workingDirectory: frozen.request.originatingTaskWorktreePath,
		producerExecutionRevocationFile: join(directory, "redeployment-revocation.json"),
		postProcessExitCleanupCommand: [
			frozen.request.deploymentNodeBinaryPath,
			join(directory, "frozen-local-redeployment-executor.mjs"),
			"cleanup-redeployment-failed-attempts",
			"--execution-directory",
			resolve(directory),
		],
		cancelCommand: [
			frozen.request.deploymentNodeBinaryPath,
			join(directory, "frozen-local-redeployment-executor.mjs"),
			"cancel-redeployment",
			"--execution-directory",
			resolve(directory),
		],
		resultFile: join(directory, "owned-command-business-result.json"),
		materialSha256: localRedeploymentSha256(JSON.stringify(frozen)),
		label: "本地重部署自动执行与终审交回",
		readOnlyRecoveryEvidenceObservationCommand: [
			frozen.request.deploymentNodeBinaryPath,
			join(directory, "frozen-local-redeployment-executor.mjs"),
			"observe-redeployment",
			"--execution-directory",
			resolve(directory),
		],
		recoveryEvidenceObservationMode: "semantic_observation_only",
	});
}

export async function assertLocalRedeploymentOwnerStillEligible(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<void> {
	assertLocalRedeploymentNotRevoked(directory);
	if (!frozen.owner) return;
	const project = (await listWorkspaceIndexEntries({ requireCompleteRead: true })).find(
		(project) => project.workspaceId === frozen.request.workspaceId,
	);
	if (!project) throw new Error("原工作区归属暂不可读");
	const operations = await createTaskConversationSessionOperationStore().read({
		workspaceId: project.workspaceId,
		workspacePath: project.repoPath,
	});
	if (operations.explicitlyStoppedSessionIds.includes(frozen.owner.conversationSessionId)) {
		await writeLocalRedeploymentJson(join(directory, "redeployment-revocation.json"), {
			executionId: frozen.request.executionId,
			source: "persistent_explicit_session_stop",
			revokedAtEpochMs: Date.now(),
		});
		throw new Error("原会话持久 Stop 继续有效");
	}
	const state = await loadPersistedWorkspaceStateById(frozen.request.workspaceId);
	const column = state.board.columns.find((column) => column.cards.some((card) => card.id === frozen.request.taskId));
	const card = column?.cards.find((card) => card.id === frozen.request.taskId);
	if (
		!card ||
		card.createdAt !== frozen.owner.taskIncarnationCreatedAtEpochMs ||
		resolveMainTaskConversationSessionId(card) !== frozen.owner.conversationSessionId ||
		column?.id === "trash" ||
		card.taskShelvingState
	)
		throw new LocalRedeploymentIdentityMismatch("原任务 incarnation 或后续执行资格已变化");
	const summary = (
		await loadPersistedWorkspaceSessionsById(frozen.request.workspaceId, { requireCompleteRead: true })
	)[frozen.owner.conversationSessionId];
	const ownerSessionChanged =
		!summary ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== frozen.owner.nativeSessionId ||
		(summary.runtimeSessionIncarnationId ?? null) !== frozen.owner.runtimeSessionIncarnationId ||
		!summary.workspacePath ||
		(await realpath(summary.workspacePath)) !== frozen.owner.worktreeIdentity.realPath;
	if (ownerSessionChanged && !(await deploymentRestartAcceptedAfterAuthorizedOwnerInterruption(directory, frozen)))
		throw new LocalRedeploymentIdentityMismatch("原主会话、原生会话或运行时代际已变化");
	const metadata = await stat(frozen.request.originatingTaskWorktreePath);
	if (
		metadata.dev !== frozen.owner.worktreeIdentity.device ||
		metadata.ino !== frozen.owner.worktreeIdentity.inode ||
		metadata.birthtimeMs !== frozen.owner.worktreeIdentity.createdAtEpochMs ||
		(await realpath(frozen.request.originatingTaskWorktreePath)) !== frozen.owner.worktreeIdentity.realPath
	)
		throw new LocalRedeploymentIdentityMismatch("所属工作树实体已变化");
}
