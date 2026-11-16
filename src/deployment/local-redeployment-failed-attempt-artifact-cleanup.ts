import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { taskCommandExecutionOwnedProcessesExitConfirmationSchema } from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { taskCommandExecutionArtifactDirectory } from "../task-command-execution/task-command-execution-store";
import {
	hasSameProcessGeneration,
	readProcessIdentity,
	readSystemBootIdentity,
} from "../task-command-execution/task-command-execution-supervisor";
import {
	type FrozenLocalRedeploymentRequest,
	localRedeploymentSha256,
	readFrozenLocalRedeploymentRequest,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";

const cleanupRecordFilename = "failed-attempt-artifact-cleanup.json";
const filesystemDirectoryEntityIdentitySchema = z.strictObject({
	device: z.number(),
	inode: z.number(),
	createdAtEpochMs: z.number(),
});
const registeredArtifactWriterProcessScopeSchema = z.strictObject({
	pid: z.number(),
	startAndCommand: z.string(),
	systemBootIdentity: z.string().nullable(),
	registeredAtEpochMs: z.number(),
	stage: z.string(),
	attemptNumber: z.number(),
});
const registeredLocalRedeploymentRebuildableArtifactSchema = z.strictObject({
	path: z.string(),
	kind: z.enum(["runtime_state_backup_capture_collection", "previous_distribution_copy", "publication_staging_copy"]),
	parentIdentity: filesystemDirectoryEntityIdentitySchema,
	identity: filesystemDirectoryEntityIdentitySchema.nullable(),
	writers: z.array(registeredArtifactWriterProcessScopeSchema),
	status: z.enum(["registered_not_created", "registered", "completed", "pending"]),
	deletions: z.record(
		z.string(),
		z.strictObject({
			path: z.string(),
			identity: filesystemDirectoryEntityIdentitySchema,
			status: z.enum(["intent_persisted", "deleted", "pending"]),
			evidenceFilePath: z.string(),
			evidenceSha256: z.string(),
			attemptsByRelevantCondition: z.record(z.string(), z.number()),
			blockingFailure: z
				.strictObject({
					path: z.string(),
					code: z.string().nullable(),
					syscall: z.string().nullable(),
				})
				.nullable()
				.optional(),
			error: z.string().nullable(),
		}),
	),
	pendingReason: z.string().nullable(),
});
const localRedeploymentFailedAttemptArtifactCleanupRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: z.string(),
	requestSha256: z.string(),
	executorSha256: z.string(),
	automaticCleanupEnabled: z.boolean(),
	settingHistory: z.array(
		z.strictObject({ enabled: z.boolean(), inspectionReason: z.string().nullable(), changedAtEpochMs: z.number() }),
	),
	lastConfirmedExitEvidenceFilePath: z.string().nullable(),
	artifacts: z.array(registeredLocalRedeploymentRebuildableArtifactSchema),
});
type CleanupRecord = z.infer<typeof localRedeploymentFailedAttemptArtifactCleanupRecordSchema>;
type CleanupArtifact = z.infer<typeof registeredLocalRedeploymentRebuildableArtifactSchema>;
type ArtifactWriter = z.infer<typeof registeredArtifactWriterProcessScopeSchema>;
interface ProcessExitEvidence {
	status: "exited" | "running" | "unknown";
	reference: string;
}

const readFilesystemDirectoryEntityIdentityFromMetadata = (metadata: Awaited<ReturnType<typeof lstat>>) => ({
	device: Number(metadata.dev),
	inode: Number(metadata.ino),
	createdAtEpochMs: Number(metadata.birthtimeMs),
});
const pathIsInsideArtifact = (artifactPath: string, candidate: string) => {
	const relation = relative(resolve(artifactPath), resolve(candidate));
	return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
};

async function readDeletionAccessCondition(
	targetPath: string,
	blockingFailure: { path: string; code: string | null; syscall: string | null } | null,
): Promise<string> {
	const parentMetadata = await lstat(dirname(targetPath));
	let blocking: unknown = null;
	if (blockingFailure) {
		if (!pathIsInsideArtifact(targetPath, blockingFailure.path))
			blocking = {
				path: blockingFailure.path,
				code: blockingFailure.code,
				syscall: blockingFailure.syscall,
				contained: false,
			};
		else {
			const observed: unknown[] = [];
			for (const node of [dirname(blockingFailure.path), blockingFailure.path]) {
				try {
					const metadata = await lstat(node);
					observed.push({
						path: node,
						...readFilesystemDirectoryEntityIdentityFromMetadata(metadata),
						mode: metadata.mode,
					});
				} catch (error) {
					observed.push({ path: node, code: (error as NodeJS.ErrnoException).code ?? "unknown" });
				}
			}
			blocking = {
				code: blockingFailure.code,
				syscall: blockingFailure.syscall,
				observed,
			};
		}
	}
	return localRedeploymentSha256(
		JSON.stringify({
			parent: { ...readFilesystemDirectoryEntityIdentityFromMetadata(parentMetadata), mode: parentMetadata.mode },
			blocking,
		}),
	);
}

const filesystemDirectoryEntityIdentitiesMatch = (left: unknown, right: unknown) =>
	JSON.stringify(left) === JSON.stringify(right);
async function readFilesystemEntityMetadataIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
async function readLocalRedeploymentFailedAttemptArtifactCleanupRecord(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
): Promise<CleanupRecord> {
	const raw = await readLocalRedeploymentJson(join(directory, cleanupRecordFilename));
	const record =
		raw === null
			? {
					schemaVersion: 1 as const,
					executionId: frozen.request.executionId,
					requestSha256: frozen.requestSha256,
					executorSha256: frozen.executorSha256,
					automaticCleanupEnabled: true,
					settingHistory: [],
					lastConfirmedExitEvidenceFilePath: null,
					artifacts: [],
				}
			: localRedeploymentFailedAttemptArtifactCleanupRecordSchema.parse(raw);
	if (
		record.executionId !== frozen.request.executionId ||
		record.requestSha256 !== frozen.requestSha256 ||
		record.executorSha256 !== frozen.executorSha256
	)
		throw new Error("清理记录与冻结执行归属不一致");
	return record;
}
async function persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory: string, record: CleanupRecord) {
	await lockedFileSystem.writeJsonFileAtomic(
		join(directory, cleanupRecordFilename),
		localRedeploymentFailedAttemptArtifactCleanupRecordSchema.parse(record),
		{ lock: null, durable: true, fileMode: 0o600 },
	);
}

async function assertRegisteredLocalRedeploymentArtifactPathOwnership(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	artifact: Pick<CleanupArtifact, "kind" | "path">,
): Promise<void> {
	const expected =
		artifact.kind === "runtime_state_backup_capture_collection"
			? join(directory, "runtime-state-backup-capture-attempts")
			: artifact.kind === "previous_distribution_copy"
				? join(directory, "preserved-previous-distribution")
				: join(
						frozen.request.distributionDirectoryPath,
						`.kanban-redeployment-staging-${frozen.request.executionId}`,
					);
	if (artifact.path !== expected || (await realpath(dirname(expected))) !== dirname(expected))
		throw new Error("清理路径不是本次登记的真实归属目录");
	const current = await readFilesystemEntityMetadataIfPresent(expected);
	if (current && (!current.isDirectory() || current.isSymbolicLink() || (await realpath(expected)) !== expected))
		throw new Error("清理目录实体或软链接归属已变化");
}

/** 先登记私有复制容器，再创建目录；其子路径继承同一次尝试的归属，不扫描历史目录认领产物。 */
export async function registerLocalRedeploymentRebuildableArtifact(
	directory: string,
	input: { kind: CleanupArtifact["kind"]; stage: string; attemptNumber: number; path: string },
): Promise<void> {
	directory = await realpath(directory);
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	await lockedFileSystem.withLock({ path: join(directory, cleanupRecordFilename) }, async () => {
		const record = await readLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, frozen);
		const path = join(await realpath(dirname(input.path)), input.path.slice(dirname(input.path).length + 1));
		await assertRegisteredLocalRedeploymentArtifactPathOwnership(directory, frozen, { kind: input.kind, path });
		const parentIdentity = readFilesystemDirectoryEntityIdentityFromMetadata(await lstat(dirname(path)));
		let artifact = record.artifacts.find((artifact) => artifact.path === path);
		const metadata = await readFilesystemEntityMetadataIfPresent(path);
		if (!artifact && metadata) throw new Error("目录在登记之前已存在，不能认领历史或其他执行的产物");
		if (
			artifact &&
			metadata &&
			(!filesystemDirectoryEntityIdentitiesMatch(
				artifact.identity,
				readFilesystemDirectoryEntityIdentityFromMetadata(metadata),
			) ||
				!filesystemDirectoryEntityIdentitiesMatch(artifact.parentIdentity, parentIdentity))
		)
			throw new Error("已登记产物实体变化，禁止继续写入或清理");
		const writer = await readProcessIdentity(process.pid);
		if (!writer) throw new Error("产物创建前无法证明执行进程身份");
		artifact ??= {
			path,
			kind: input.kind,
			parentIdentity,
			identity: null,
			writers: [],
			status: "registered_not_created",
			deletions: {},
			pendingReason: null,
		};
		if (!record.artifacts.includes(artifact)) record.artifacts.push(artifact);
		artifact.writers.push({
			pid: writer.pid,
			startAndCommand: writer.startAndCommand,
			systemBootIdentity: await readSystemBootIdentity(),
			registeredAtEpochMs: Date.now(),
			stage: input.stage,
			attemptNumber: input.attemptNumber,
		});
		artifact.status = metadata ? "registered" : "registered_not_created";
		await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
		if (!metadata) await mkdir(path);
		artifact.identity = readFilesystemDirectoryEntityIdentityFromMetadata(await lstat(path));
		artifact.status = "registered";
		await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
	});
}

export async function setLocalRedeploymentAutomaticFailedAttemptCleanup(
	directory: string,
	enabled: boolean,
	inspectionReason?: string,
): Promise<void> {
	if (!enabled && !inspectionReason?.trim()) throw new Error("关闭自动清理必须记录现场检查原因");
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	await lockedFileSystem.withLock({ path: join(directory, cleanupRecordFilename) }, async () => {
		const record = await readLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, frozen);
		record.automaticCleanupEnabled = enabled;
		record.settingHistory.push({
			enabled,
			inspectionReason: inspectionReason?.trim() || null,
			changedAtEpochMs: Date.now(),
		});
		await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
	});
}

async function readConfirmedProcessExitEvidence(
	directory: string,
	frozen: FrozenLocalRedeploymentRequest,
	writers: ArtifactWriter[],
	previousReference: string | null,
): Promise<ProcessExitEvidence> {
	const reference = process.env.KANBAN_COMMAND_EXECUTION_EXIT_CONFIRMATION_FILE ?? previousReference;
	if (!reference) return { status: "unknown", reference: "缺少所属命令及子进程的原生退出确认" };
	try {
		const proof = taskCommandExecutionOwnedProcessesExitConfirmationSchema.parse(
			await readLocalRedeploymentJson(reference),
		);
		const specification = (await readLocalRedeploymentJson(join(directory, "owned-command-specification.json"))) as {
			materialSha256?: string;
			command?: string[];
			resumeCommand?: string[];
		} | null;
		const expectedDirectory = taskCommandExecutionArtifactDirectory(frozen.request.workspaceId, proof.executionId);
		if (
			!specification ||
			(await realpath(reference)) !==
				join(
					await realpath(expectedDirectory),
					`post-process-exit-cleanup-confirmation-${proof.launchNonce}-dispatch-${proof.businessDispatchSequenceNumber}.json`,
				) ||
			proof.materialSha256 !== specification.materialSha256 ||
			![specification.command, specification.resumeCommand].some(
				(command) => JSON.stringify(command) === JSON.stringify(proof.command),
			)
		)
			throw new Error("退出确认未绑定本次冻结命令");
		const launch = (await readLocalRedeploymentJson(
			join(expectedDirectory, `launch-materials-${proof.launchNonce}.json`),
		)) as { executionId?: string; launchNonce?: string; materialSha256?: string } | null;
		if (
			launch?.executionId !== proof.executionId ||
			launch.launchNonce !== proof.launchNonce ||
			launch.materialSha256 !== proof.materialSha256
		)
			throw new Error("退出确认缺少匹配的原生启动材料");
		const boot = await readSystemBootIdentity();
		for (const writer of writers) {
			if (writer.registeredAtEpochMs > proof.confirmedAtEpochMs) throw new Error("退出确认早于本次产物写入");
			if (boot && writer.systemBootIdentity && boot !== writer.systemBootIdentity) continue;
			const current = await readProcessIdentity(writer.pid);
			if (hasSameProcessGeneration(current, writer)) return { status: "running", reference };
			if (!current) {
				try {
					process.kill(writer.pid, 0);
					return { status: "unknown", reference };
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { status: "unknown", reference };
				}
			}
		}
		return { status: "exited", reference };
	} catch {
		return { status: "unknown", reference };
	}
}

async function isLocalRedeploymentArtifactReferencedByRetainedCheckpoint(
	directory: string,
	path: string,
): Promise<boolean> {
	const containsReference = (value: unknown): boolean =>
		typeof value === "string"
			? value === path || value.startsWith(`${path}${sep}`)
			: Array.isArray(value)
				? value.some(containsReference)
				: !!value && typeof value === "object" && Object.values(value).some(containsReference);
	const references = [
		"previous-distribution-backup.json",
		"runtime-state-backup-receipt.json",
		"candidate-build-receipt.json",
		"runtime-restart-acceptance.json",
	];
	for (const root of ["runtime-backup-checkpoints", "verification-checkpoints"]) {
		for (const name of await readdir(join(directory, root)).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}))
			if (name.endsWith(".json")) references.push(join(root, name));
	}
	for (const reference of references)
		if (containsReference(await readLocalRedeploymentJson(join(directory, reference)))) return true;
	return false;
}

export async function cleanupLocalRedeploymentFailedAttemptArtifacts(
	directory: string,
	deps: {
		readProcessExitEvidence?: (
			frozen: FrozenLocalRedeploymentRequest,
			writers: ArtifactWriter[],
			previousReference: string | null,
		) => Promise<ProcessExitEvidence>;
		deleteArtifact?: (path: string) => Promise<void>;
	} = {},
): Promise<{ status: "completed" | "pending" | "disabled"; artifacts: CleanupArtifact[] }> {
	directory = await realpath(directory);
	const frozen = await readFrozenLocalRedeploymentRequest(directory);
	return lockedFileSystem.withLock({ path: join(directory, cleanupRecordFilename) }, async () => {
		const record = await readLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, frozen);
		if (!record.automaticCleanupEnabled) {
			record.lastConfirmedExitEvidenceFilePath =
				process.env.KANBAN_COMMAND_EXECUTION_EXIT_CONFIRMATION_FILE ?? record.lastConfirmedExitEvidenceFilePath;
			await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
			return { status: "disabled", artifacts: record.artifacts };
		}
		let pending = false;
		for (const artifact of record.artifacts) {
			try {
				await assertRegisteredLocalRedeploymentArtifactPathOwnership(directory, frozen, artifact);
				const parent = readFilesystemDirectoryEntityIdentityFromMetadata(await lstat(dirname(artifact.path)));
				const metadata = await readFilesystemEntityMetadataIfPresent(artifact.path);
				if (
					!filesystemDirectoryEntityIdentitiesMatch(parent, artifact.parentIdentity) ||
					(metadata &&
						!filesystemDirectoryEntityIdentitiesMatch(
							readFilesystemDirectoryEntityIdentityFromMetadata(metadata),
							artifact.identity,
						))
				)
					throw new Error("产物或父目录实体不再属于登记的尝试");
				if (!metadata) {
					artifact.status = "completed";
					continue;
				}
				if (artifact.status === "completed") continue;
				const exit = await (
					deps.readProcessExitEvidence ??
					((frozen, writers, previous) => readConfirmedProcessExitEvidence(directory, frozen, writers, previous))
				)(frozen, artifact.writers, record.lastConfirmedExitEvidenceFilePath);
				if (exit.status !== "exited")
					throw new Error(`所属进程及子进程退出${exit.status === "running" ? "尚未发生" : "证据未知"}`);
				record.lastConfirmedExitEvidenceFilePath = exit.reference;
				for (const deletion of Object.values(artifact.deletions)) {
					if (deletion.status !== "deleted" && !(await readFilesystemEntityMetadataIfPresent(deletion.path))) {
						deletion.status = "deleted";
						deletion.error = null;
					}
				}
				const paths =
					artifact.kind === "runtime_state_backup_capture_collection"
						? (await readdir(artifact.path)).sort().map((name) => join(artifact.path, name))
						: [artifact.path];
				for (const path of paths) {
					const metadata = await readFilesystemEntityMetadataIfPresent(path);
					if (!metadata) continue;
					if (!metadata.isDirectory() || metadata.isSymbolicLink())
						throw new Error("产物子目录归属不明或已被软链接替换");
					if (
						(await readFilesystemEntityMetadataIfPresent(join(path, "verified-entry-backup.json"))) ||
						(await isLocalRedeploymentArtifactReferencedByRetainedCheckpoint(directory, path))
					)
						continue;
					const key = localRedeploymentSha256(
						JSON.stringify([path, readFilesystemDirectoryEntityIdentityFromMetadata(metadata)]),
					);
					let deletion = artifact.deletions[key];
					if (deletion?.status === "deleted") throw new Error("已删除路径被重新创建，不能沿用旧归属");
					if (!deletion) {
						const evidenceFilePath = join(directory, "failed-attempt-cleanup-evidence", `${key}.json`);
						const evidence = {
							executionId: record.executionId,
							requestSha256: record.requestSha256,
							executorSha256: record.executorSha256,
							path,
							identity: readFilesystemDirectoryEntityIdentityFromMetadata(metadata),
							writerScopes: artifact.writers,
							exitEvidenceReference: exit.reference,
							childNames: (await readdir(path)).sort(),
							stageFailureOriginalsDirectory: join(directory, "stage-failure-originals"),
							completeStdoutAndStderrRetained: true,
						};
						await writeLocalRedeploymentJson(evidenceFilePath, evidence);
						deletion = {
							path,
							identity: readFilesystemDirectoryEntityIdentityFromMetadata(metadata),
							status: "intent_persisted",
							evidenceFilePath,
							evidenceSha256: localRedeploymentSha256(JSON.stringify(evidence)),
							attemptsByRelevantCondition: {},
							blockingFailure: null,
							error: null,
						};
						artifact.deletions[key] = deletion;
					}
					const evidence = await readLocalRedeploymentJson(deletion.evidenceFilePath);
					if (localRedeploymentSha256(JSON.stringify(evidence)) !== deletion.evidenceSha256)
						throw new Error("删除所需证据未可靠保存或已变化");
					await assertRegisteredLocalRedeploymentArtifactPathOwnership(directory, frozen, artifact);
					if (
						!filesystemDirectoryEntityIdentitiesMatch(
							readFilesystemDirectoryEntityIdentityFromMetadata(await lstat(path)),
							deletion.identity,
						) ||
						(await isLocalRedeploymentArtifactReferencedByRetainedCheckpoint(directory, path))
					)
						throw new Error("删除前实体或恢复引用发生变化");
					const condition = await readDeletionAccessCondition(path, deletion.blockingFailure ?? null);
					if ((deletion.attemptsByRelevantCondition[condition] ?? 0) >= 3)
						throw new Error("相同清理条件已完成原尝试和两次重试，等待相关条件改善");
					deletion.attemptsByRelevantCondition[condition] =
						(deletion.attemptsByRelevantCondition[condition] ?? 0) + 1;
					deletion.status = "intent_persisted";
					await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
					try {
						await (deps.deleteArtifact ?? ((path) => rm(path, { recursive: true, force: false })))(path);
						deletion.status = "deleted";
						deletion.error = null;
						deletion.blockingFailure = null;
					} catch (error) {
						const errno = error as NodeJS.ErrnoException;
						deletion.status = "pending";
						deletion.error = String(error);
						deletion.blockingFailure = {
							path: typeof errno.path === "string" && errno.path.length > 0 ? errno.path : path,
							code: typeof errno.code === "string" ? errno.code : null,
							syscall: typeof errno.syscall === "string" ? errno.syscall : null,
						};
						const updatedCondition = await readDeletionAccessCondition(path, deletion.blockingFailure);
						if (updatedCondition !== condition) {
							const count = deletion.attemptsByRelevantCondition[condition] ?? 0;
							delete deletion.attemptsByRelevantCondition[condition];
							deletion.attemptsByRelevantCondition[updatedCondition] =
								(deletion.attemptsByRelevantCondition[updatedCondition] ?? 0) + count;
						}
						throw error;
					}
					await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
				}
				artifact.status = "completed";
				artifact.pendingReason = null;
			} catch (error) {
				pending = true;
				artifact.status = "pending";
				artifact.pendingReason = String(error);
			}
			await persistLocalRedeploymentFailedAttemptArtifactCleanupRecord(directory, record);
		}
		return { status: pending ? "pending" : "completed", artifacts: record.artifacts };
	});
}
