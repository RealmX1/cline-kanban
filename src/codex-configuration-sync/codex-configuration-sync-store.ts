import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { runWithCodexDirectoryVolumeSystemQueriesDisabled } from "../codex-conversation-storage/codex-persistent-directory-identity";
import {
	type CodexConfigurationPropagationTarget,
	type CodexConfigurationSourceEvidence,
	type CodexConfigurationSourceObservation,
	type CodexConfigurationTaskSourceSnapshot,
	type CodexConfigurationWriterBinding,
	codexConfigurationPropagationTargetSchema,
	codexConfigurationSourceEvidenceSchema,
	codexConfigurationSourceObservationSchema,
	codexConfigurationTaskSourceSnapshotSchema,
	codexConfigurationWriterBindingSchema,
} from "../core/codex-configuration-sync-contract";
import {
	createDefaultNonThrowingLockCompromiseHandler,
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	DEFAULT_LOCK_STALE_MS,
	releaseAdvisoryFileLock,
} from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { CodexConfigurationFields, CodexConfigurationFieldValue } from "./codex-configuration-field-projection";
import { migrateCodexConfigurationApprovalRecords } from "./codex-configuration-observation-records";
import { migrateCodexConfigurationProfiles } from "./codex-configuration-profiles";

export interface StoredCodexConfigurationProfile {
	profileId: string;
	name: string;
	sourceIdentity: string;
	version: number;
	fields: CodexConfigurationFields;
	fieldVersions: Record<string, number>;
}

export interface StoredCodexConfigurationWriter {
	sourceTaskSnapshot?: CodexConfigurationTaskSourceSnapshot;
	legacyLaunchExceptionSelectionAtMigration?: { profileId: string; profileVersion: number };
	pendingNativePermissionVerificationAtMs?: number;
	pendingSessionProfileBinding?: {
		workspaceId: string;
		conversationSessionId: string;
		profileId: string;
		onlyUpdatePermissionSelectionSource?: boolean;
	};
	taskModelSelectionAtLaunch?: string;
	taskPermissionModeSelectionAtLaunch?: string;
	taskPermissionSelectionSourceAtLaunch?: string;
	codexConfigurationProfileId?: string;
	localExceptionOverrides?: Record<
		string,
		{ profileVersionAtSelection: number; fields: CodexConfigurationFields; deletedFieldKeys?: string[] }
	>;
	consumedProfileFieldVersions?: Record<string, number>;
	binding: CodexConfigurationWriterBinding;
	fileNames: string[];
	launchBaselineFields: CodexConfigurationFields;
	mergeBaselineFields: CodexConfigurationFields;
	lastObservedFields: CodexConfigurationFields;
	overrideKeyPaths: string[];
	nativeBinaryVersion: string | null;
	nativeExecutableRealPath?: string | null;
	nativeExecutableIdentityDigest?: string | null;
	retiredAt?: number;
}
export interface StoredCodexConfigurationSource {
	fieldChangeIds?: Record<string, string>;
	home: string;
	version: number;
	fields: CodexConfigurationFields;
	observedUserFields: CodexConfigurationFields;
}
export interface StoredCodexConfigurationChange {
	modificationInitiator?: CodexConfigurationSourceEvidence["initiator"];
	sharedConflictEvidence?: {
		fields: CodexConfigurationFields;
		fieldVersions: Record<string, number>;
		changeIds: Record<string, string>;
	};
	sourceTaskSnapshot?: CodexConfigurationTaskSourceSnapshot;
	relatedPreviousFields?: CodexConfigurationFields;
	sharedFieldsAtObservation?: CodexConfigurationFields;
	sharedFieldVersionsAtObservation?: Record<string, number>;
	sharedChangeIdsAtObservation?: Record<string, string>;
	changeId: string;
	version: number;
	sourceWriterId: string;
	sourceIdentity: string;
	fieldKey: string;
	previous?: CodexConfigurationFieldValue;
	value?: CodexConfigurationFieldValue;
	sharedValueAtConflict?: CodexConfigurationFieldValue;
	observedAt: number;
	recordKind?: "settings_proposal" | "source_observation" | "historical_record";
	approvalStatus?: "pending" | "approved" | "rejected" | "historical" | "not_required" | "expired";
	codexConfigurationProfileId?: string;
	feedbackExpiresAtMs?: number;
	acceptedProfileFieldVersion?: number;
	exceptionGroup?: "model" | "reasoning_effort" | "permissions";
	relatedFields?: Record<string, CodexConfigurationFieldValue | undefined>;
	relatedDeletedFieldKeys?: string[];
	sharingScope?: "profile" | "all_profiles_hook_trust";
	decidedAt?: number | null;
	sharedValueAtProposal?: CodexConfigurationFieldValue;
	mergeStatus:
		| "pending_approval"
		| "superseded"
		| "shared_default_updated"
		| "conflict"
		| "kept_shared_value"
		| "target_conflict_source_change_selected"
		| "target_conflict_target_value_kept";
	acknowledgedAt: number | null;
	targets: Array<
		CodexConfigurationPropagationTarget & {
			evidenceFingerprint?: string;
			writeSubmissionStartedAt?: number;
			expectedNativeVersion?: string;
			startupVerificationAttemptCount?: number;
			safeResumeAttemptCount?: number;
			safeResumeEvidenceFingerprint?: string;
			safeResumeSubmissionStartedAt?: number;
			startupVerificationEvidenceFingerprint?: string;
			conflictHistory?: Array<{ observedAt: number; value?: CodexConfigurationFieldValue; resolution?: string }>;
		}
	>;
}
export interface StoredCodexConfigurationSourceObservation extends CodexConfigurationSourceObservation {
	sourceIdentity: string;
	sourceKey: string;
	rawChangeIds: string[];
	detectedWriterIds: string[];
}
export interface CodexConfigurationSyncStore {
	legacySessionProfileAdoptions: Record<
		string,
		{
			workspaceId: string;
			conversationSessionId: string;
			nativeSessionId: string;
			profileId: string;
			sourceIdentity: string;
			reason: string;
			attemptCount: number;
			evidenceFingerprint?: string;
		}
	>;
	schemaVersion: 1 | 2 | 3;
	profiles: Record<string, StoredCodexConfigurationProfile>;
	defaultCodexConfigurationProfileId: string | null;
	hookTrustDecisions: Record<
		string,
		{
			sourceIdentity: string;
			hookSourceKey: string;
			definitionDigest: string;
			trustedHash: string | null;
			trustedContentHash?: string | null;
			version: number;
		}
	>;
	revision: number;
	sources: Record<string, StoredCodexConfigurationSource>;
	writers: Record<string, StoredCodexConfigurationWriter>;
	changes: StoredCodexConfigurationChange[];
	sourceObservations: StoredCodexConfigurationSourceObservation[];
	mutationReceipts: Record<string, { requestDigest: string; changeId: string }>;
	observationProblem: string | null;
}

const fieldSchema = z.object({ value: z.unknown(), definitionDigest: z.string().optional() });
const fieldsSchema = z.record(z.string(), fieldSchema);
const storeSchema = z.object({
	legacySessionProfileAdoptions: z
		.record(
			z.string(),
			z.object({
				workspaceId: z.string(),
				conversationSessionId: z.string(),
				nativeSessionId: z.string(),
				profileId: z.string(),
				sourceIdentity: z.string(),
				reason: z.string(),
				attemptCount: z.number(),
				evidenceFingerprint: z.string().optional(),
			}),
		)
		.default({}),
	schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
	profiles: z
		.record(
			z.string(),
			z.object({
				profileId: z.string(),
				name: z.string(),
				sourceIdentity: z.string(),
				version: z.number(),
				fields: fieldsSchema,
				fieldVersions: z.record(z.string(), z.number()),
			}),
		)
		.default({}),
	defaultCodexConfigurationProfileId: z.string().nullable().default(null),
	hookTrustDecisions: z
		.record(
			z.string(),
			z.object({
				sourceIdentity: z.string(),
				hookSourceKey: z.string(),
				definitionDigest: z.string(),
				trustedHash: z.string().nullable(),
				trustedContentHash: z.string().nullable().optional(),
				version: z.number(),
			}),
		)
		.default({}),
	revision: z.number().int().nonnegative(),
	sources: z.record(
		z.string(),
		z.object({
			home: z.string(),
			version: z.number(),
			fields: fieldsSchema,
			observedUserFields: fieldsSchema,
			fieldChangeIds: z.record(z.string(), z.string()).optional(),
		}),
	),
	writers: z.record(
		z.string(),
		z.object({
			sourceTaskSnapshot: codexConfigurationTaskSourceSnapshotSchema.optional(),
			pendingSessionProfileBinding: z
				.object({
					workspaceId: z.string(),
					conversationSessionId: z.string(),
					profileId: z.string(),
					onlyUpdatePermissionSelectionSource: z.boolean().optional(),
				})
				.optional(),
			legacyLaunchExceptionSelectionAtMigration: z
				.object({ profileId: z.string(), profileVersion: z.number() })
				.optional(),
			pendingNativePermissionVerificationAtMs: z.number().optional(),
			taskModelSelectionAtLaunch: z.string().optional(),
			taskPermissionModeSelectionAtLaunch: z.string().optional(),
			taskPermissionSelectionSourceAtLaunch: z.string().optional(),
			codexConfigurationProfileId: z.string().optional(),
			localExceptionOverrides: z
				.record(
					z.string(),
					z.object({
						profileVersionAtSelection: z.number(),
						fields: fieldsSchema,
						deletedFieldKeys: z.array(z.string()).optional(),
					}),
				)
				.optional(),
			consumedProfileFieldVersions: z.record(z.string(), z.number()).optional(),
			binding: codexConfigurationWriterBindingSchema,
			fileNames: z.array(z.string()),
			launchBaselineFields: fieldsSchema,
			mergeBaselineFields: fieldsSchema,
			lastObservedFields: fieldsSchema,
			overrideKeyPaths: z.array(z.string()),
			nativeBinaryVersion: z.string().nullable(),
			nativeExecutableRealPath: z.string().nullable().optional(),
			nativeExecutableIdentityDigest: z.string().nullable().optional(),
			retiredAt: z.number().optional(),
		}),
	),
	changes: z.array(
		z.object({
			modificationInitiator: codexConfigurationSourceEvidenceSchema.shape.initiator.optional(),
			sharedConflictEvidence: z
				.object({
					fields: fieldsSchema,
					fieldVersions: z.record(z.string(), z.number()),
					changeIds: z.record(z.string(), z.string()),
				})
				.optional(),
			sourceTaskSnapshot: codexConfigurationTaskSourceSnapshotSchema.optional(),
			relatedPreviousFields: fieldsSchema.optional(),
			sharedFieldsAtObservation: fieldsSchema.optional(),
			sharedFieldVersionsAtObservation: z.record(z.string(), z.number()).optional(),
			sharedChangeIdsAtObservation: z.record(z.string(), z.string()).optional(),
			changeId: z.string(),
			version: z.number(),
			sourceWriterId: z.string(),
			sourceIdentity: z.string(),
			fieldKey: z.string(),
			previous: fieldSchema.optional(),
			value: fieldSchema.optional(),
			sharedValueAtConflict: fieldSchema.optional(),
			observedAt: z.number(),
			recordKind: z.enum(["settings_proposal", "source_observation", "historical_record"]).optional(),
			approvalStatus: z
				.enum(["pending", "approved", "rejected", "historical", "not_required", "expired"])
				.optional(),
			codexConfigurationProfileId: z.string().optional(),
			feedbackExpiresAtMs: z.number().optional(),
			acceptedProfileFieldVersion: z.number().optional(),
			exceptionGroup: z.enum(["model", "reasoning_effort", "permissions"]).optional(),
			relatedFields: z.record(z.string(), fieldSchema.optional()).optional(),
			relatedDeletedFieldKeys: z.array(z.string()).optional(),
			sharingScope: z.enum(["profile", "all_profiles_hook_trust"]).optional(),
			decidedAt: z.number().nullable().optional(),
			sharedValueAtProposal: fieldSchema.optional(),
			mergeStatus: z.enum([
				"pending_approval",
				"superseded",
				"shared_default_updated",
				"conflict",
				"kept_shared_value",
				"target_conflict_source_change_selected",
				"target_conflict_target_value_kept",
			]),
			acknowledgedAt: z.number().nullable(),
			targets: z.array(
				codexConfigurationPropagationTargetSchema.extend({
					evidenceFingerprint: z.string().optional(),
					writeSubmissionStartedAt: z.number().optional(),
					expectedNativeVersion: z.string().optional(),
					startupVerificationAttemptCount: z.number().optional(),
					safeResumeAttemptCount: z.number().optional(),
					safeResumeEvidenceFingerprint: z.string().optional(),
					safeResumeSubmissionStartedAt: z.number().optional(),
					startupVerificationEvidenceFingerprint: z.string().optional(),
					conflictHistory: z
						.array(
							z.object({
								observedAt: z.number(),
								value: fieldSchema.optional(),
								resolution: z.string().optional(),
							}),
						)
						.optional(),
				}),
			),
		}),
	),
	sourceObservations: z
		.array(
			codexConfigurationSourceObservationSchema.extend({
				sourceIdentity: z.string(),
				sourceKey: z.string(),
				rawChangeIds: z.array(z.string()),
				detectedWriterIds: z.array(z.string()),
			}),
		)
		.default([]),
	mutationReceipts: z.record(z.string(), z.object({ requestDigest: z.string(), changeId: z.string() })),
	observationProblem: z.string().nullable(),
});
export const getCodexConfigurationSyncDirectory = () =>
	join(getRuntimeHomePath(), "codex-configuration-writer-bindings-and-sync");

async function readCodexConfigurationSyncStoreWithPersistedContent(): Promise<{
	store: CodexConfigurationSyncStore;
	persistedSerializedContent: string | null;
}> {
	try {
		const persistedSerializedContent = await readFile(
			join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"),
			"utf8",
		);
		const store = storeSchema.parse(JSON.parse(persistedSerializedContent));
		migrateCodexConfigurationApprovalRecords(store);
		migrateCodexConfigurationProfiles(store);
		return { store, persistedSerializedContent };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {
			persistedSerializedContent: null,
			store: {
				schemaVersion: 3,
				legacySessionProfileAdoptions: {},
				profiles: {},
				defaultCodexConfigurationProfileId: null,
				hookTrustDecisions: {},
				revision: 0,
				sources: {},
				writers: {},
				changes: [],
				sourceObservations: [],
				mutationReceipts: {},
				observationProblem: null,
			},
		};
	}
}

export async function readCodexConfigurationSyncStore(): Promise<CodexConfigurationSyncStore> {
	return (await readCodexConfigurationSyncStoreWithPersistedContent()).store;
}

// 所有共享决定只有这一处写入，活配置文件始终交给原 app-server。
export async function mutateCodexConfigurationSyncStore<T>(
	operation: (store: CodexConfigurationSyncStore) => Promise<T> | T,
	options: { skipUnchangedObservationPersistence?: boolean } = {},
) {
	const directory = getCodexConfigurationSyncDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("Codex 配置绑定目录被替换，已保留现场。");
	const lockAcquisitionStartedAtMs = performance.now();
	const lockfilePath = `${directory}.lock`;
	const release = await lockfile
		.lock(directory, {
			realpath: false,
			stale: DEFAULT_LOCK_STALE_MS,
			retries: DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
			// 与统一锁封装相同：失效回调不得抛出，否则定时器里的默认 throw 会杀掉整个运行时。
			onCompromised: createDefaultNonThrowingLockCompromiseHandler(lockfilePath),
		})
		.catch((error: unknown) => {
			if (error instanceof Error)
				error.message = `Codex 配置存储取锁失败：lockPath=${lockfilePath} phase=lock_acquisition waitedMs=${Math.round(performance.now() - lockAcquisitionStartedAtMs)}；${error.message}`;
			throw error;
		});
	const pendingPath = join(directory, `${randomUUID()}.pending-configuration-sync-state.json`);
	try {
		const { store, persistedSerializedContent } = await readCodexConfigurationSyncStoreWithPersistedContent();
		const result = await runWithCodexDirectoryVolumeSystemQueriesDisabled(() => operation(store));
		const serializedContent = JSON.stringify(store);
		// 明确操作及其幂等重试仍须持久化，以补齐此前原子替换成功但目录同步失败的情况。
		if (options.skipUnchangedObservationPersistence && serializedContent === persistedSerializedContent)
			return result;
		const pendingFile = await open(pendingPath, "wx", 0o600);
		try {
			await pendingFile.writeFile(serializedContent);
			await pendingFile.sync();
		} finally {
			await pendingFile.close();
		}
		await rename(pendingPath, join(directory, "configuration-sync-state.json"));
		if (process.platform !== "win32") {
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		}
		return result;
	} finally {
		await rm(pendingPath, { force: true });
		// compromise 之后 release 会以 ERELEASED 拒绝；吞掉该良性失败，避免已完成的配置写或 resume 被这次善后拖失败。
		await releaseAdvisoryFileLock(release, lockfilePath);
	}
}
