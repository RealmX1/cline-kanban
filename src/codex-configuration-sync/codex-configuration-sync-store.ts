import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { runWithCodexDirectoryVolumeSystemQueriesDisabled } from "../codex-conversation-storage/codex-persistent-directory-identity";
import {
	type CodexConfigurationPropagationTarget,
	type CodexConfigurationSessionAdoptionCounts,
	type CodexConfigurationSessionAdoptionProgressPage,
	type CodexConfigurationSessionAdoptionProgressRequest,
	type CodexConfigurationSourceEvidence,
	type CodexConfigurationSourceObservation,
	type CodexConfigurationTaskSourceSnapshot,
	type CodexConfigurationWriterBinding,
	codexConfigurationChangeSharingScopeStateSchema,
	codexConfigurationPropagationTargetSchema,
	codexConfigurationSetChangeSharingScopeRequestSchema,
	codexConfigurationSourceEvidenceSchema,
	codexConfigurationSourceObservationSchema,
	codexConfigurationTaskSourceSnapshotSchema,
	codexConfigurationWriterBindingSchema,
} from "../core/codex-configuration-sync-contract";
import { lockedFileSystem, releaseFilesystemKernelWriteLock } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import type { CodexConfigurationFields, CodexConfigurationFieldValue } from "./codex-configuration-field-projection";
import { migrateCodexConfigurationApprovalRecords } from "./codex-configuration-observation-records";
import { migrateCodexConfigurationProfiles } from "./codex-configuration-profiles";
import { migrateCodexConfigurationSettingsIsolation } from "./codex-configuration-settings-isolation";
import {
	type CodexConfigurationHistoryStoragePage,
	type CodexConfigurationStoreReadSelection,
	closeCodexConfigurationSyncDatabaseClients,
	getCodexConfigurationSyncDatabaseClient,
	restoreLatestCodexConfigurationSyncStateToLegacyStorage,
} from "./codex-configuration-sync-database-worker-client";
import { assertCodexSourceSharedPluginInstallationDirectoriesBinding } from "./codex-source-shared-plugin-installation-directories";
import { codexSourceSharedPluginNativeLaunchPreparationIntentSchema } from "./codex-source-shared-plugin-native-launch-preparation-intent-contract";

export interface StoredCodexConfigurationProfile {
	profileId: string;
	name: string;
	sourceIdentity: string;
	version: number;
	fields: CodexConfigurationFields;
	fieldVersions: Record<string, number>;
}

export interface StoredCodexConfigurationWriter {
	previousWriterId?: string;
	nativeConversationSessionId?: string;
	localFieldMutationVersions?: Record<string, number>;
	pendingSourceSharedPluginInstallationPreparations?: Record<string, unknown>;
	taskReasoningEffortSelectionAtLaunch?: string;
	taskReasoningEffortFeedbackSelection?: {
		selectionId: string;
		profileId: string;
		profileVersionAtSelection: number;
		effort: string;
		inheritedFields: CodexConfigurationFields;
		registeredChangeId?: string;
		supersededAtMs?: number;
	};
	sourceTaskSnapshot?: CodexConfigurationTaskSourceSnapshot;
	legacyLaunchExceptionSelectionAtMigration?: { profileId: string; profileVersion: number };
	pendingNativePermissionVerificationAtMs?: number;
	pendingSessionProfileBinding?: {
		workspaceId: string;
		conversationSessionId: string;
		profileId: string;
		onlyUpdatePermissionSelectionSource?: boolean;
		permissionSelectionSource?: "profile" | "task_local";
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
	configurationInitialization?: {
		status: "snapshot_persisted";
		snapshotFilePath: string;
		snapshotDigest: string;
		capturedAtMs: number;
	};
	fieldChangeIds?: Record<string, string>;
	home: string;
	version: number;
	fields: CodexConfigurationFields;
	observedUserFields: CodexConfigurationFields;
}
export interface StoredCodexConfigurationChange {
	changeSharingScope?: z.infer<typeof codexConfigurationChangeSharingScopeStateSchema>;
	noticePresentedAtMs?: number;
	sharingScopeGroupId?: string;
	sharingScopeDecisionHistory?: Array<{
		requestedScope: "session_only" | "profile";
		recordedAtMs: number;
		priorAcceptedChange: Record<string, unknown>;
	}>;
	pendingSharingScopeMutation?: z.infer<typeof codexConfigurationSetChangeSharingScopeRequestSchema>;
	pendingSharingScopeMutationPreviousState?: z.infer<typeof codexConfigurationChangeSharingScopeStateSchema>;
	sharingScopeRecoveryEvidenceFingerprint?: string;
	sharingScopeRecoveryAttemptCount?: number;
	withdrawalProfileFieldVersion?: number;
	sourceFieldMutationVersionsAtObservation?: Record<string, number>;
	compensationForChangeId?: string;
	sharingPropagationSnapshot?: {
		profileValue?: CodexConfigurationFieldValue;
		profileFieldVersion: number;
		targets: Record<
			string,
			{
				value?: CodexConfigurationFieldValue;
				localFieldMutationVersion: number;
				consumedProfileFieldVersion: number;
				nativeConversationSessionId?: string;
				localExceptionOverride?: NonNullable<StoredCodexConfigurationWriter["localExceptionOverrides"]>[string];
			}
		>;
	};
	targetSpecificCompensation?: {
		expectedLocalFieldMutationVersion: number;
		expectedGroupMutationVersions?: Record<string, number>;
		expectedNativeConversationSessionId?: string;
		expectedProfileFieldVersions?: Record<string, number>;
		expectedTargetValueDigest: string;
		previousTargetValueDigest: string;
	};
	propagationTargetTotalCount?: number;
	settingsIsolationArchivedAtMs?: number;
	taskReasoningEffortFeedbackSelectionId?: string;
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
			sharingWithdrawalCompensationPending?: boolean;
			writeSubmissionFinishedAtMs?: number;
			sharingWithdrawalRequestedAtMs?: number;
			withdrawnWriteObservedAtMs?: number;
			expectedNativeVersion?: string;
			startupVerificationAttemptCount?: number;
			safeResumeAttemptCount?: number;
			safeResumeEvidenceFingerprint?: string;
			safeResumeSubmissionStartedAt?: number;
			startupVerificationEvidenceFingerprint?: string;
			conflictHistory?: Array<{ observedAt: number; value?: CodexConfigurationFieldValue; resolution?: string }>;
			settingsIsolationCancellation?: { previousStatus: string; previousReason: string; cancelledAtMs: number };
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
	settingsIsolationProjectionVersion?: number;
	storageIdentity?: string;
	storageGeneration?: number;
	sourceDecisionGenerations?: Record<string, number>;
	historyTotalCount?: number;
	historyMaximumSequence?: number;
	historyProjectionGeneration?: number;
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
	settingsIsolationProjectionVersion: z.number().int().nonnegative().optional(),
	storageIdentity: z.string().optional(),
	storageGeneration: z.number().int().nonnegative().optional(),
	sourceDecisionGenerations: z.record(z.string(), z.number()).optional(),
	historyTotalCount: z.number().int().nonnegative().optional(),
	historyMaximumSequence: z.number().int().nonnegative().optional(),
	historyProjectionGeneration: z.number().int().nonnegative().optional(),
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
			configurationInitialization: z
				.object({
					status: z.literal("snapshot_persisted"),
					snapshotFilePath: z.string(),
					snapshotDigest: z.string(),
					capturedAtMs: z.number(),
				})
				.optional(),
			version: z.number(),
			fields: fieldsSchema,
			observedUserFields: fieldsSchema,
			fieldChangeIds: z.record(z.string(), z.string()).optional(),
		}),
	),
	writers: z.record(
		z.string(),
		z.object({
			previousWriterId: z.string().optional(),
			nativeConversationSessionId: z.string().optional(),
			localFieldMutationVersions: z.record(z.string(), z.number()).optional(),
			pendingSourceSharedPluginInstallationPreparations: z.record(z.string(), z.unknown()).optional(),
			sourceTaskSnapshot: codexConfigurationTaskSourceSnapshotSchema.optional(),
			pendingSessionProfileBinding: z
				.object({
					workspaceId: z.string(),
					conversationSessionId: z.string(),
					profileId: z.string(),
					onlyUpdatePermissionSelectionSource: z.boolean().optional(),
					permissionSelectionSource: z.enum(["profile", "task_local"]).optional(),
				})
				.optional(),
			legacyLaunchExceptionSelectionAtMigration: z
				.object({ profileId: z.string(), profileVersion: z.number() })
				.optional(),
			pendingNativePermissionVerificationAtMs: z.number().optional(),
			taskReasoningEffortSelectionAtLaunch: z.string().optional(),
			taskReasoningEffortFeedbackSelection: z
				.object({
					selectionId: z.string().uuid(),
					profileId: z.string(),
					profileVersionAtSelection: z.number(),
					effort: z.string(),
					inheritedFields: fieldsSchema,
					registeredChangeId: z.string().optional(),
					supersededAtMs: z.number().optional(),
				})
				.optional(),
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
			changeSharingScope: codexConfigurationChangeSharingScopeStateSchema.optional(),
			noticePresentedAtMs: z.number().optional(),
			sharingScopeGroupId: z.string().optional(),
			sharingScopeDecisionHistory: z
				.array(
					z.object({
						requestedScope: z.enum(["session_only", "profile"]),
						recordedAtMs: z.number(),
						priorAcceptedChange: z.record(z.string(), z.unknown()),
					}),
				)
				.optional(),
			pendingSharingScopeMutation: codexConfigurationSetChangeSharingScopeRequestSchema.optional(),
			pendingSharingScopeMutationPreviousState: codexConfigurationChangeSharingScopeStateSchema.optional(),
			sharingScopeRecoveryEvidenceFingerprint: z.string().optional(),
			sharingScopeRecoveryAttemptCount: z.number().optional(),
			withdrawalProfileFieldVersion: z.number().optional(),
			sourceFieldMutationVersionsAtObservation: z.record(z.string(), z.number()).optional(),
			compensationForChangeId: z.string().optional(),
			sharingPropagationSnapshot: z
				.object({
					profileValue: fieldSchema.optional(),
					profileFieldVersion: z.number(),
					targets: z.record(
						z.string(),
						z.object({
							value: fieldSchema.optional(),
							localFieldMutationVersion: z.number(),
							consumedProfileFieldVersion: z.number(),
							nativeConversationSessionId: z.string().optional(),
							localExceptionOverride: z
								.object({
									profileVersionAtSelection: z.number(),
									fields: fieldsSchema,
									deletedFieldKeys: z.array(z.string()).optional(),
								})
								.optional(),
						}),
					),
				})
				.optional(),
			targetSpecificCompensation: z
				.object({
					expectedLocalFieldMutationVersion: z.number(),
					expectedGroupMutationVersions: z.record(z.string(), z.number()).optional(),
					expectedProfileFieldVersions: z.record(z.string(), z.number()).optional(),
					expectedNativeConversationSessionId: z.string().optional(),
					expectedTargetValueDigest: z.string(),
					previousTargetValueDigest: z.string(),
				})
				.optional(),
			propagationTargetTotalCount: z.number().int().nonnegative().optional(),
			modificationInitiator: codexConfigurationSourceEvidenceSchema.shape.initiator.optional(),
			settingsIsolationArchivedAtMs: z.number().optional(),
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
			taskReasoningEffortFeedbackSelectionId: z.string().uuid().optional(),
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
					settingsIsolationCancellation: z
						.object({ previousStatus: z.string(), previousReason: z.string(), cancelledAtMs: z.number() })
						.optional(),
					evidenceFingerprint: z.string().optional(),
					writeSubmissionStartedAt: z.number().optional(),
					sharingWithdrawalCompensationPending: z.boolean().optional(),
					writeSubmissionFinishedAtMs: z.number().optional(),
					sharingWithdrawalRequestedAtMs: z.number().optional(),
					withdrawnWriteObservedAtMs: z.number().optional(),
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

function parseLegacyConfigurationSyncStore(value: unknown): CodexConfigurationSyncStore {
	const store = storeSchema.parse(
		value ?? {
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
	);
	migrateCodexConfigurationApprovalRecords(store);
	migrateCodexConfigurationProfiles(store);
	migrateCodexConfigurationSettingsIsolation(store);
	return store;
}
async function indexLegacySourcePluginRecoveryPreparations(store: CodexConfigurationSyncStore) {
	const visitedDirectories = new Set<string>();
	for (const writer of Object.values(store.writers)) {
		const shared = writer.binding.sourceSharedPluginInstallationDirectoriesBinding;
		if (!shared) continue;
		const directory = join(
			shared.pluginsDirectoryCanonicalPath,
			".kanban-source-installation-coordination",
			"native-launch-preparation-intents",
		);
		if (visitedDirectories.has(directory)) continue;
		visitedDirectories.add(directory);
		try {
			for (const name of await readdir(directory)) {
				if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
				const path = join(directory, name);
				const intent = codexSourceSharedPluginNativeLaunchPreparationIntentSchema.parse(
					JSON.parse(await readFile(path, "utf8")),
				);
				const owner = store.writers[intent.writerId];
				if (intent.status === "pending" && owner?.binding.sourceIdentity === intent.sourceIdentity) {
					owner.pendingSourceSharedPluginInstallationPreparations ??= {};
					owner.pendingSourceSharedPluginInstallationPreparations[path] = intent;
				}
			}
		} catch (error) {
			const sourceExists = await lstat(shared.pluginsDirectoryCanonicalPath).then(
				(file) => file.isDirectory(),
				() => false,
			);
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !sourceExists) {
				writer.pendingSourceSharedPluginInstallationPreparations ??= {};
				writer.pendingSourceSharedPluginInstallationPreparations[directory] = {
					requiresLegacyDirectoryObservation: true,
				};
			}
		}
	}
	return store;
}
async function configurationDatabaseClient() {
	return await getCodexConfigurationSyncDatabaseClient(
		getCodexConfigurationSyncDirectory(),
		parseLegacyConfigurationSyncStore,
		indexLegacySourcePluginRecoveryPreparations,
		materializePendingPluginPreparationsForLegacyRollback,
	);
}

async function materializePendingPluginPreparationsForLegacyRollback(store: CodexConfigurationSyncStore) {
	for (const writer of Object.values(store.writers)) {
		const preparations = writer.pendingSourceSharedPluginInstallationPreparations;
		if (!preparations || Object.keys(preparations).length === 0) continue;
		const shared = writer.binding.sourceSharedPluginInstallationDirectoriesBinding;
		if (!shared) throw new Error("插件恢复意图缺少共享来源绑定，尚不能回退。");
		await assertCodexSourceSharedPluginInstallationDirectoriesBinding(writer.binding);
		const directory = join(
			shared.pluginsDirectoryCanonicalPath,
			".kanban-source-installation-coordination",
			"native-launch-preparation-intents",
		);
		for (const parent of [dirname(directory), directory]) {
			await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
			const file = await lstat(parent);
			if (!file.isDirectory() || file.isSymbolicLink() || (await realpath(parent)) !== parent)
				throw new Error("插件回退恢复目录的物理归属不符。");
		}
		for (const [path, retained] of Object.entries(preparations)) {
			if (path === directory) continue;
			const intent = codexSourceSharedPluginNativeLaunchPreparationIntentSchema.parse(retained);
			if (
				dirname(path) !== directory ||
				basename(path) !== `${intent.intentId}.json` ||
				intent.writerId !== writer.binding.writerId ||
				intent.sourceIdentity !== writer.binding.sourceIdentity
			)
				throw new Error("插件恢复意图与回退 writer 身份不符。");
			try {
				const file = await lstat(path);
				if (!file.isFile() || file.isSymbolicLink()) throw new Error("插件回退意图路径不是普通文件。");
				const existing = codexSourceSharedPluginNativeLaunchPreparationIntentSchema.parse(
					JSON.parse(await readFile(path, "utf8")),
				);
				if (
					existing.intentId !== intent.intentId ||
					existing.writerId !== intent.writerId ||
					existing.sourceIdentity !== intent.sourceIdentity
				)
					throw new Error("插件回退意图文件归属不符。");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(retained), {
					lock: null,
					durable: true,
					fileMode: 0o600,
				});
			}
		}
	}
}
export function runOutsideCodexConfigurationSyncStoreSelection<T>(operation: () => T): T {
	return requestStorageSelection.exit(operation);
}
const requestStorageSelection = new AsyncLocalStorage<Omit<CodexConfigurationStoreReadSelection, "scope">>();
export function runWithCodexConfigurationSyncStoreSelection<T>(
	selection: Omit<CodexConfigurationStoreReadSelection, "scope">,
	operation: () => T,
): T {
	const inherited = requestStorageSelection.getStore() ?? {};
	return requestStorageSelection.run(
		{
			changeIds: [...(inherited.changeIds ?? []), ...(selection.changeIds ?? [])],
			writerIds: [...(inherited.writerIds ?? []), ...(selection.writerIds ?? [])],
			targetWriterIds: [...(inherited.targetWriterIds ?? []), ...(selection.targetWriterIds ?? [])],
			writerHomePaths: [...(inherited.writerHomePaths ?? []), ...(selection.writerHomePaths ?? [])],
			observationIds: [...(inherited.observationIds ?? []), ...(selection.observationIds ?? [])],
			receiptKeys: [...(inherited.receiptKeys ?? []), ...(selection.receiptKeys ?? [])],
			hookTrustDecisionIds: [...(inherited.hookTrustDecisionIds ?? []), ...(selection.hookTrustDecisionIds ?? [])],
		},
		operation,
	);
}
export async function readCodexConfigurationSyncStore(): Promise<CodexConfigurationSyncStore> {
	return storeSchema.parse(await (await configurationDatabaseClient()).request("snapshot", { scope: "full" }));
}
export async function readCodexConfigurationSyncActiveStore(
	selection: Omit<CodexConfigurationStoreReadSelection, "scope"> = {},
): Promise<CodexConfigurationSyncStore> {
	return storeSchema.parse(
		await (await configurationDatabaseClient()).request("snapshot", {
			...requestStorageSelection.getStore(),
			...selection,
			scope: "active",
		}),
	);
}
export async function readCodexConfigurationSyncLookupStore(
	selection: Omit<CodexConfigurationStoreReadSelection, "scope">,
): Promise<CodexConfigurationSyncStore> {
	return storeSchema.parse(
		await (await configurationDatabaseClient()).request("snapshot", { ...selection, scope: "lookup" }),
	);
}
export interface CodexConfigurationCurrentSessionIdentity {
	workspaceId: string;
	conversationSessionId: string;
	runtimeSessionIncarnationId: string;
	writerId: string | null;
	profileId: string | null;
}
export async function readCodexConfigurationSyncOverviewStore(sessions: CodexConfigurationCurrentSessionIdentity[]) {
	const result = await (await configurationDatabaseClient()).request<{
		store: CodexConfigurationSyncStore;
		adoptionCounts: CodexConfigurationSessionAdoptionCounts[];
	}>("overview", { sessions });
	return { store: storeSchema.parse(result.store), adoptionCounts: result.adoptionCounts };
}
export async function listCodexConfigurationStoredSessionAdoptionProgress(
	input: CodexConfigurationSessionAdoptionProgressRequest,
	sessions: CodexConfigurationCurrentSessionIdentity[],
): Promise<CodexConfigurationSessionAdoptionProgressPage> {
	return await (await configurationDatabaseClient()).request("session_adoption_progress", { ...input, sessions });
}
export async function listCodexConfigurationSyncStoredHistory(input: {
	category?: "all" | "settings" | "sources";
	search?: string;
	limit?: number;
	cursor?: string;
}): Promise<CodexConfigurationHistoryStoragePage> {
	return await (await configurationDatabaseClient()).request("history", input);
}
export async function readCodexConfigurationSyncStorageMetrics() {
	const client = await configurationDatabaseClient();
	return { ...client.lastReadMetrics, cumulative: { ...client.cumulativeReadMetrics } };
}
export async function readCodexConfigurationSyncActiveQueryPlans() {
	return await (await configurationDatabaseClient()).request<Array<{ detail: string }>>("active_query_plans");
}
export async function readCodexConfigurationSyncStorageMetadata() {
	const stored = await (await configurationDatabaseClient()).request<{
		storageIdentity: string;
		storageGeneration: number;
		storeHeader: { revision: number };
	}>("metadata");
	return {
		storageIdentity: stored.storageIdentity,
		storageGeneration: stored.storageGeneration,
		revision: stored.storeHeader.revision,
	};
}
export const closeCodexConfigurationSyncDatabase = closeCodexConfigurationSyncDatabaseClients;

// 复用旧跨进程锁保护异步取证；SQL 只在 worker 的短事务内提交。
export async function mutateCodexConfigurationSyncStore<T>(
	operation: (store: CodexConfigurationSyncStore) => Promise<T> | T,
	options: { skipUnchangedObservationPersistence?: boolean; selection?: CodexConfigurationStoreReadSelection } = {},
): Promise<T> {
	const client = await configurationDatabaseClient();
	await client.verifyWriteAdmission();
	const directory = getCodexConfigurationSyncDirectory();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("Codex 配置绑定目录被替换，已保留现场。");
	const lockfilePath = `${directory}.lock`;
	const lockAcquisitionStartedAtMs = performance.now();
	const release = await lockedFileSystem
		.acquireLock({ path: directory, type: "directory", lockfilePath })
		.catch(async (error: unknown) => {
			await client.recordWriteLockFailure(error);
			if (error instanceof Error)
				error.message = `Codex 配置存储取锁失败：lockPath=${lockfilePath} phase=lock_acquisition waitedMs=${Math.round(performance.now() - lockAcquisitionStartedAtMs)}；${error.message}`;
			throw error;
		});
	try {
		await client.confirmWriteLockAcquired();
		const selection = { ...requestStorageSelection.getStore(), ...(options.selection ?? { scope: "full" }) };
		const store = storeSchema.parse(await client.request("snapshot", selection));
		const before = structuredClone(store);
		const result = await runWithCodexDirectoryVolumeSystemQueriesDisabled(() => operation(store));
		await client.request("commit", {
			before,
			after: store,
			expectedStorageGeneration: before.storageGeneration,
			scope: selection.scope,
		});
		return result;
	} finally {
		await releaseFilesystemKernelWriteLock(release, lockfilePath);
	}
}
export async function mutateCodexConfigurationSyncActiveStore<T>(
	operation: (store: CodexConfigurationSyncStore) => Promise<T> | T,
	options: { skipUnchangedObservationPersistence?: boolean; selection?: CodexConfigurationStoreReadSelection } = {},
): Promise<T> {
	return await mutateCodexConfigurationSyncStore(operation, {
		...options,
		selection: options.selection ?? { scope: "active" },
	});
}

export async function restoreLatestCodexConfigurationSyncLegacyStorage() {
	return await restoreLatestCodexConfigurationSyncStateToLegacyStorage(
		getCodexConfigurationSyncDirectory(),
		parseLegacyConfigurationSyncStore,
		materializePendingPluginPreparationsForLegacyRollback,
	);
}
