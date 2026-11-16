import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	runtimeTaskConversationSessionCreationProgressSchema,
	runtimeTaskConversationSessionReportResponseSchema,
	runtimeTaskSessionStartRequestSchema,
} from "../core/api-contract";
import { logTuiFreezeError } from "../diagnostics/tui-freeze-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";

const recoveryEvidenceSchema = z.object({
	fingerprint: z.string().nullable(),
	unchangedProbeCount: z.number().int().min(0).max(3),
	nextProbeAt: z.number().nullable(),
});
export type TaskConversationSessionRecoveryEvidence = z.infer<typeof recoveryEvidenceSchema>;

const creationRecordSchema = z.object({
	progress: runtimeTaskConversationSessionCreationProgressSchema,
	requestFingerprint: z.string(),
	idempotencyKey: z.string(),
	launchRequest: runtimeTaskSessionStartRequestSchema,
	launchOwnerRuntimeProcessInstanceId: z.string().nullable(),
	processLaunchMayHaveStarted: z.boolean().default(true),
	nameSuggestion: z
		.object({
			operationId: z.string().uuid(),
			basisText: z.string().nullable(),
			expectedNameVersion: z.number().int().nonnegative(),
			status: z.enum([
				"waiting_for_real_input",
				"ready",
				"request_may_have_started",
				"result_available",
				"completed",
				"unavailable",
			]),
			suggestedName: z.string().optional(),
			notice: z.string().optional(),
		})
		.optional(),
	recoveryEvidence: recoveryEvidenceSchema,
});
export type TaskConversationSessionCreationRecord = z.infer<typeof creationRecordSchema>;
const reportRecordSchema = z.object({
	receipt: runtimeTaskConversationSessionReportResponseSchema,
	taskId: z.string(),
	taskIncarnationCreatedAt: z.number(),
	idempotencyKey: z.string(),
	text: z.string(),
	createdAt: z.number(),
	sourceNativeSessionId: z.string().nullable(),
	assistantMessageProvenanceSha256: z.string().optional(),
	resumeMayHaveStarted: z.boolean().default(false),
	requestFingerprint: z.string().optional(),
	assistantOriginVerification: z
		.object({
			nativeMessageIdentity: z.string(),
			status: z.enum(["pending", "verified", "inherited"]),
			contextHistoryCursor: z.string().nullable(),
			recoveryEvidence: recoveryEvidenceSchema,
		})
		.optional(),
	recoveryEvidence: recoveryEvidenceSchema,
});
export type TaskConversationSessionReportRecord = z.infer<typeof reportRecordSchema>;
const operationStoreSchema = z.object({
	schemaVersion: z.literal(1),
	workspaceId: z.string(),
	workspacePath: z.string(),
	creations: z.array(creationRecordSchema),
	reports: z.array(reportRecordSchema),
	explicitlyStoppedSessionIds: z.array(z.string()),
	assistantReportHistoryScans: z
		.array(
			z.object({
				taskConversationSessionId: z.string(),
				nativeSessionId: z.string(),
				evidenceFingerprint: z.string(),
				nextCursor: z.string().nullable(),
				completed: z.boolean(),
			}),
		)
		.default([]),
});
export type TaskConversationSessionOperationStore = z.infer<typeof operationStoreSchema>;
export type TaskConversationSessionWorkspaceScope = { workspaceId: string; workspacePath: string };

export function emptyTaskConversationSessionRecoveryEvidence(): TaskConversationSessionRecoveryEvidence {
	return { fingerprint: null, unchangedProbeCount: 0, nextProbeAt: null };
}

// 相同证据至多补查三次，跨重启保存；身份、原生记录或控制端点变化后获得新预算。
export function claimTaskConversationSessionEvidenceProbe(
	evidence: TaskConversationSessionRecoveryEvidence,
	fingerprint: string,
	now: number,
): boolean {
	if (evidence.fingerprint !== fingerprint) {
		evidence.fingerprint = fingerprint;
		evidence.unchangedProbeCount = 0;
		evidence.nextProbeAt = null;
	}
	if (evidence.unchangedProbeCount >= 3 || (evidence.nextProbeAt !== null && now < evidence.nextProbeAt)) return false;
	evidence.unchangedProbeCount++;
	evidence.nextProbeAt = now + 15_000;
	return true;
}

const appliedDuplicateProjectStopMigrationSchema = z.object({
	operationId: z.string().min(1),
	sourceWorkspaceId: z.string().min(1),
});
type AppliedDuplicateProjectStopMigration = z.infer<typeof appliedDuplicateProjectStopMigrationSchema>;
type ExplicitStopMarkerDocument = {
	sessionIds: string[];
	appliedDuplicateProjectStopMigrations: AppliedDuplicateProjectStopMigration[];
};
// 旧文件仍是会话 ID 数组。只有记下“这次合并已经复制”时才写成对象，并且和名单同一次原子提交。
const explicitStopMarkerDocumentSchema = z.union([
	z.array(z.string()).transform(
		(sessionIds): ExplicitStopMarkerDocument => ({
			sessionIds,
			appliedDuplicateProjectStopMigrations: [],
		}),
	),
	z
		.object({
			schemaVersion: z.literal(1),
			sessionIds: z.array(z.string()),
			appliedDuplicateProjectStopMigrations: z.array(appliedDuplicateProjectStopMigrationSchema).default([]),
		})
		.transform(
			(document): ExplicitStopMarkerDocument => ({
				sessionIds: document.sessionIds,
				appliedDuplicateProjectStopMigrations: document.appliedDuplicateProjectStopMigrations,
			}),
		),
]);

function explicitStopMarkerPayload(document: ExplicitStopMarkerDocument): unknown {
	if (document.appliedDuplicateProjectStopMigrations.length === 0) return document.sessionIds;
	return {
		schemaVersion: 1,
		sessionIds: document.sessionIds,
		appliedDuplicateProjectStopMigrations: document.appliedDuplicateProjectStopMigrations,
	};
}

export function createTaskConversationSessionOperationStore(
	storageRootDirectoryPath = join(getRuntimeHomePath(), "task-conversation-session-operations"),
) {
	const pathForScope = (scope: TaskConversationSessionWorkspaceScope) =>
		join(storageRootDirectoryPath, `${createHash("sha256").update(scope.workspaceId).digest("hex")}.json`);
	const explicitStopMarkerPathForScope = (scope: TaskConversationSessionWorkspaceScope) =>
		join(
			storageRootDirectoryPath,
			"explicit-session-stop-markers",
			`${createHash("sha256").update(scope.workspaceId).digest("hex")}.json`,
		);
	const readExplicitStopMarkerDocument = async (
		scope: TaskConversationSessionWorkspaceScope,
	): Promise<ExplicitStopMarkerDocument | null> => {
		try {
			return explicitStopMarkerDocumentSchema.parse(
				JSON.parse(await readFile(explicitStopMarkerPathForScope(scope), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	};
	const readExplicitStopMarkers = async (scope: TaskConversationSessionWorkspaceScope): Promise<string[] | null> =>
		(await readExplicitStopMarkerDocument(scope))?.sessionIds ?? null;
	const writeExplicitStopMarkerDocument = async (
		scope: TaskConversationSessionWorkspaceScope,
		document: ExplicitStopMarkerDocument,
	) => {
		await lockedFileSystem.writeJsonFileAtomic(
			explicitStopMarkerPathForScope(scope),
			explicitStopMarkerPayload(document),
			{
				lock: null,
				durable: true,
				fileMode: 0o600,
			},
		);
	};
	const previousExplicitStopSessionIds = async (
		scope: TaskConversationSessionWorkspaceScope,
		previous: ExplicitStopMarkerDocument | null,
	): Promise<string[]> =>
		previous?.sessionIds ?? (await read(scope).catch(() => null))?.explicitlyStoppedSessionIds ?? [];
	const updateExplicitStopMarkers = async (
		scope: TaskConversationSessionWorkspaceScope,
		update: (sessionIds: string[]) => string[],
	) => {
		await mkdir(join(storageRootDirectoryPath, "explicit-session-stop-markers"), { recursive: true, mode: 0o700 });
		await lockedFileSystem.withLock({ path: explicitStopMarkerPathForScope(scope) }, async () => {
			// 操作记录损坏时，独立 Stop 标记仍须落盘；损坏的操作记录本身继续阻止自动执行。
			const previous = await readExplicitStopMarkerDocument(scope);
			await writeExplicitStopMarkerDocument(scope, {
				sessionIds: update(await previousExplicitStopSessionIds(scope, previous)),
				appliedDuplicateProjectStopMigrations: previous?.appliedDuplicateProjectStopMigrations ?? [],
			});
		});
	};
	const read = async (
		scope: TaskConversationSessionWorkspaceScope,
	): Promise<TaskConversationSessionOperationStore> => {
		try {
			const record = operationStoreSchema.parse(JSON.parse(await readFile(pathForScope(scope), "utf8")));
			if (record.workspaceId !== scope.workspaceId || record.workspacePath !== scope.workspacePath)
				throw new Error("会话操作记录的工作区身份不匹配。");
			return {
				...record,
				explicitlyStoppedSessionIds: (await readExplicitStopMarkers(scope)) ?? record.explicitlyStoppedSessionIds,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return {
				schemaVersion: 1,
				...scope,
				creations: [],
				reports: [],
				explicitlyStoppedSessionIds: (await readExplicitStopMarkers(scope)) ?? [],
				assistantReportHistoryScans: [],
			};
		}
	};
	return {
		read,
		async recordExplicitStopMarkers(scope: TaskConversationSessionWorkspaceScope, sessionIds: readonly string[]) {
			await updateExplicitStopMarkers(scope, (previousSessionIds) => [
				...new Set([...previousSessionIds, ...sessionIds]),
			]);
		},
		async clearExplicitStopMarker(scope: TaskConversationSessionWorkspaceScope, sessionId: string) {
			await updateExplicitStopMarkers(scope, (previousSessionIds) =>
				previousSessionIds.filter((id) => id !== sessionId),
			);
		},
		// 复制事实和目标名单同一次写入。已记录的合并即使名单随后被清空，也不能再次并集。
		async migrateTransferredExplicitStopMarkers(
			target: TaskConversationSessionWorkspaceScope,
			migration: AppliedDuplicateProjectStopMigration,
			sourceStoppedSessionIds: readonly string[],
		) {
			const parsedMigration = appliedDuplicateProjectStopMigrationSchema.parse(migration);
			await mkdir(join(storageRootDirectoryPath, "explicit-session-stop-markers"), { recursive: true, mode: 0o700 });
			await lockedFileSystem.withLock({ path: explicitStopMarkerPathForScope(target) }, async () => {
				const previous = await readExplicitStopMarkerDocument(target);
				const alreadyApplied = previous?.appliedDuplicateProjectStopMigrations.some(
					(entry) =>
						entry.operationId === parsedMigration.operationId &&
						entry.sourceWorkspaceId === parsedMigration.sourceWorkspaceId,
				);
				if (alreadyApplied) return;
				if (sourceStoppedSessionIds.length === 0 && previous === null) return;
				await writeExplicitStopMarkerDocument(target, {
					sessionIds: [
						...new Set([...(await previousExplicitStopSessionIds(target, previous)), ...sourceStoppedSessionIds]),
					],
					appliedDuplicateProjectStopMigrations: [
						...(previous?.appliedDuplicateProjectStopMigrations ?? []),
						parsedMigration,
					],
				});
			});
		},
		async update<T>(
			scope: TaskConversationSessionWorkspaceScope,
			update: (store: TaskConversationSessionOperationStore) => T | Promise<T>,
		): Promise<T> {
			await mkdir(storageRootDirectoryPath, { recursive: true, mode: 0o700 });
			return await lockedFileSystem.withLock({ path: pathForScope(scope) }, async () => {
				const store = await read(scope);
				const result = await update(store);
				await lockedFileSystem.writeJsonFileAtomic(pathForScope(scope), store, {
					lock: null,
					durable: true,
					fileMode: 0o600,
				});
				return result;
			});
		},
		async listScopes(): Promise<TaskConversationSessionWorkspaceScope[]> {
			const paths = await readdir(storageRootDirectoryPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			});
			const scopes: TaskConversationSessionWorkspaceScope[] = [];
			for (const path of paths.filter((path) => path.endsWith(".json"))) {
				try {
					const store = operationStoreSchema.parse(
						JSON.parse(await readFile(join(storageRootDirectoryPath, path), "utf8")),
					);
					scopes.push({ workspaceId: store.workspaceId, workspacePath: store.workspacePath });
				} catch (error) {
					logTuiFreezeError(`侧会话操作记录暂不可读，继续其他工作区 path=${path}`, error);
				}
			}
			return scopes;
		},
	};
}
