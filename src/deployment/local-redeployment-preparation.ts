import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	taskCommandExecutionAdoptExistingSupervisorRequestSchema,
	taskCommandExecutionSpecificationSchema,
} from "../core/task-command-execution-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import { lockedFileSystem } from "../fs/locked-file-system";
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
export const localRedeploymentRequestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: z.uuid(),
	workspaceId: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
	taskId: z.string().min(1),
	originatingTaskWorktreePath: absolutePath,
	sourceCheckoutPath: absolutePath,
	candidateSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
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
});
export type LocalRedeploymentRequest = z.infer<typeof localRedeploymentRequestSchema>;
export const LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME =
	"local-redeployment-source-validation-preparer.mjs";
export const LOCAL_REDEPLOYMENT_SESSION_CONTINUITY_PREFLIGHT_FILENAME = "session-continuity-preflight.json";
const frozenRequestSchema = z.strictObject({
	request: localRedeploymentRequestSchema,
	requestSha256: z.string().length(64),
	executorSha256: z.string().length(64),
	sourceValidationPreparerSha256: z.string().length(64).optional(),
	npmCliEntrypointPath: absolutePath,
	serviceExecutableSha256: z.string().length(64),
	owner: taskCommandExecutionAdoptExistingSupervisorRequestSchema.shape.expectedOwner.nullable(),
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
	const metadata = await stat(request.originatingTaskWorktreePath);
	return {
		taskIncarnationCreatedAtEpochMs: card.createdAt,
		conversationSessionId,
		nativeSessionId,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId ?? null,
		worktreeIdentity: {
			realPath: await realpath(request.originatingTaskWorktreePath),
			device: metadata.dev,
			inode: metadata.ino,
			createdAtEpochMs: metadata.birthtimeMs,
		},
	};
}

export async function canonicalizeLocalRedeploymentRequest(
	parsedRequest: LocalRedeploymentRequest,
): Promise<LocalRedeploymentRequest> {
	return {
		...parsedRequest,
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

export function createBoundLocalRedeploymentSourceValidationArguments(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): string[] {
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
		...(frozen.request.sourceValidationEvidenceFilePaths ?? []).flatMap((path) => [
			"--source-validation-evidence-file-path",
			path,
		]),
	];
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
	if (
		!summary ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== frozen.owner.nativeSessionId ||
		(summary.runtimeSessionIncarnationId ?? null) !== frozen.owner.runtimeSessionIncarnationId ||
		!summary.workspacePath ||
		(await realpath(summary.workspacePath)) !== frozen.owner.worktreeIdentity.realPath
	)
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
