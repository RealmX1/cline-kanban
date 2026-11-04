import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { captureCodexConfigurationChangePresentationEvidence } from "./codex-configuration-change-presentation";
import {
	type CodexConfigurationFields,
	type CodexConfigurationFieldValue,
	configurationDigest,
	configurationFieldAddress,
	configurationTable,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import type {
	CodexConfigurationSyncStore,
	StoredCodexConfigurationChange,
	StoredCodexConfigurationProfile,
	StoredCodexConfigurationWriter,
} from "./codex-configuration-sync-store";

export const CODEX_PROFILE_FEEDBACK_OPPORTUNITY_DURATION_MS = 10 * 60_000;
export function codexConfigurationExceptionGroup(
	fieldKey: string,
): "model" | "reasoning_effort" | "permissions" | undefined {
	const { keyPath } = configurationFieldAddress(fieldKey);
	const rootKey = keyPath[0] === "profiles" ? keyPath[2] : keyPath[0];
	if (rootKey === "model") return "model";
	if (rootKey === "model_reasoning_effort") return "reasoning_effort";
	if (
		["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "permissions"].includes(
			rootKey ?? "",
		)
	)
		return "permissions";
	return undefined;
}

export function ensureCodexConfigurationSourceProfile(store: CodexConfigurationSyncStore, sourceIdentity: string) {
	const existing = Object.values(store.profiles).find((profile) => profile.sourceIdentity === sourceIdentity);
	if (existing) return existing;
	const source = store.sources[sourceIdentity];
	if (!source) throw new Error("Codex profile 的配置来源不存在。");
	const profileId = `compatible-source-${sourceIdentity}`;
	const profile: StoredCodexConfigurationProfile = {
		profileId,
		name: Object.keys(store.profiles).length ? `兼容配置 ${Object.keys(store.profiles).length + 1}` : "默认配置",
		sourceIdentity,
		version: source.version,
		fields: structuredClone(source.fields),
		fieldVersions: Object.fromEntries(Object.keys(source.fields).map((key) => [key, source.version])),
	};
	store.profiles[profileId] = profile;
	store.defaultCodexConfigurationProfileId ??= profileId;
	return profile;
}

export function getCodexConfigurationWriterProfile(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
) {
	const profile = writer.codexConfigurationProfileId
		? store.profiles[writer.codexConfigurationProfileId]
		: ensureCodexConfigurationSourceProfile(store, writer.binding.sourceIdentity);
	if (!profile || profile.sourceIdentity !== writer.binding.sourceIdentity)
		throw new Error("Codex profile 与 writer 的配置来源不符，保留原归属。");
	writer.codexConfigurationProfileId = profile.profileId;
	return profile;
}

export function codexConfigurationChangeSharedFields(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	return change.codexConfigurationProfileId
		? store.profiles[change.codexConfigurationProfileId]?.fields
		: store.sources[change.sourceIdentity]?.fields;
}

export function migrateCodexConfigurationProfiles(store: CodexConfigurationSyncStore) {
	if (store.schemaVersion === 3) return;
	for (const sourceIdentity of Object.keys(store.sources))
		ensureCodexConfigurationSourceProfile(store, sourceIdentity);
	for (const writer of Object.values(store.writers)) {
		const profile = getCodexConfigurationWriterProfile(store, writer);
		writer.legacyLaunchExceptionSelectionAtMigration = {
			profileId: profile.profileId,
			profileVersion: profile.version,
		};
		writer.consumedProfileFieldVersions = structuredClone(profile.fieldVersions);
		writer.localExceptionOverrides ??= {};
		for (const fieldKey of new Set([...Object.keys(profile.fields), ...Object.keys(writer.lastObservedFields)])) {
			const group = codexConfigurationExceptionGroup(fieldKey);
			if (!group) continue;
			writer.localExceptionOverrides[group] ??= {
				profileVersionAtSelection: profile.version,
				fields: {},
			};
			const override = writer.localExceptionOverrides[group];
			const field = writer.lastObservedFields[fieldKey];
			if (field === undefined) {
				delete override.fields[fieldKey];
				override.deletedFieldKeys = [...new Set([...(override.deletedFieldKeys ?? []), fieldKey])];
			} else override.fields[fieldKey] = structuredClone(field);
		}
	}
	for (const change of store.changes) {
		change.codexConfigurationProfileId ??=
			store.writers[change.sourceWriterId]?.codexConfigurationProfileId ??
			ensureCodexConfigurationSourceProfile(store, change.sourceIdentity).profileId;
		if (change.approvalStatus === "pending") {
			change.recordKind = "historical_record";
			change.approvalStatus = "historical";
			change.mergeStatus = "superseded";
			change.acknowledgedAt ??= Date.now();
		}
	}
	store.schemaVersion = 3;
	store.revision++;
}

export function createCodexConfigurationProfile(
	store: CodexConfigurationSyncStore,
	input: { name: string; copyFromProfileId: string },
) {
	const original = store.profiles[input.copyFromProfileId];
	if (!original || !input.name.trim() || input.name.trim().length > 100)
		throw new Error("配置来源或 profile 名称无效。");
	const profile: StoredCodexConfigurationProfile = {
		...structuredClone(original),
		profileId: randomUUID(),
		name: input.name.trim(),
		version: ++store.revision,
	};
	store.profiles[profile.profileId] = profile;
	return profile;
}

function supersedeFeedbackSuggestions(
	store: CodexConfigurationSyncStore,
	matches: (change: StoredCodexConfigurationChange) => boolean,
) {
	for (const change of store.changes) {
		if (change.approvalStatus !== "pending" || !matches(change)) continue;
		change.approvalStatus = "historical";
		change.mergeStatus = "superseded";
		change.acknowledgedAt = Date.now();
		change.version = ++store.revision;
	}
}

export function expireCodexConfigurationProfileFeedbackSuggestions(
	store: CodexConfigurationSyncStore,
	nowMs = Date.now(),
) {
	for (const change of store.changes) {
		if (
			change.approvalStatus !== "pending" ||
			change.feedbackExpiresAtMs === undefined ||
			nowMs < change.feedbackExpiresAtMs
		)
			continue;
		change.approvalStatus = "expired";
		change.mergeStatus = "superseded";
		change.acknowledgedAt = nowMs;
		change.version = ++store.revision;
	}
}

export function updateCodexConfigurationProfileFields(
	store: CodexConfigurationSyncStore,
	profileId: string,
	fields: Record<string, CodexConfigurationFieldValue | undefined>,
	input: {
		modificationInitiator?: StoredCodexConfigurationChange["modificationInitiator"];
		sourceWriterId?: string;
		sharingScope?: "profile" | "all_profiles_hook_trust";
		adoptedFeedbackSuggestion?: StoredCodexConfigurationChange;
	} = {},
) {
	const profile = store.profiles[profileId];
	if (!profile) throw new Error("Codex profile 不存在。");
	for (const [fieldKey, value] of Object.entries(fields)) {
		const previous = profile.fields[fieldKey];
		const priorFieldVersion = profile.fieldVersions[fieldKey];
		const priorChange = store.changes.find(
			(entry) =>
				entry.codexConfigurationProfileId === profileId &&
				entry.fieldKey === fieldKey &&
				priorFieldVersion !== undefined &&
				entry.acceptedProfileFieldVersion === priorFieldVersion,
		);
		const presentationEvidence = {
			sharedFieldsAtObservation: previous ? { [fieldKey]: structuredClone(previous) } : {},
			sharedFieldVersionsAtObservation: priorFieldVersion !== undefined ? { [fieldKey]: priorFieldVersion } : {},
			sharedChangeIdsAtObservation: priorChange ? { [fieldKey]: priorChange.changeId } : {},
		};
		const exceptionGroup = codexConfigurationExceptionGroup(fieldKey);
		const version = ++store.revision;
		if (value === undefined) delete profile.fields[fieldKey];
		else profile.fields[fieldKey] = structuredClone(value);
		profile.fieldVersions[fieldKey] = version;
		profile.version = version;
		supersedeFeedbackSuggestions(
			store,
			(change) =>
				change.codexConfigurationProfileId === profileId &&
				(exceptionGroup ? change.exceptionGroup === exceptionGroup : change.fieldKey === fieldKey),
		);
		for (const writer of Object.values(store.writers)) {
			if (writer.codexConfigurationProfileId !== profileId) continue;
			if (exceptionGroup) delete writer.localExceptionOverrides?.[exceptionGroup];
			if (
				exceptionGroup === "permissions" &&
				writer.binding.workspaceId &&
				writer.binding.conversationSessionId &&
				!writer.pendingSessionProfileBinding
			)
				writer.pendingSessionProfileBinding = {
					workspaceId: writer.binding.workspaceId,
					conversationSessionId: writer.binding.conversationSessionId,
					profileId,
					onlyUpdatePermissionSelectionSource: true,
				};
		}
		const change: StoredCodexConfigurationChange = {
			modificationInitiator: input.modificationInitiator,
			...presentationEvidence,
			sourceTaskSnapshot:
				input.adoptedFeedbackSuggestion?.sourceTaskSnapshot ??
				store.writers[input.sourceWriterId ?? ""]?.sourceTaskSnapshot,
			changeId: randomUUID(),
			version,
			sourceWriterId: input.sourceWriterId ?? `profile:${profileId}`,
			sourceIdentity: profile.sourceIdentity,
			codexConfigurationProfileId: profileId,
			acceptedProfileFieldVersion: version,
			fieldKey,
			previous,
			value: structuredClone(value),
			observedAt: Date.now(),
			recordKind: "historical_record",
			approvalStatus: "approved",
			decidedAt: Date.now(),
			acknowledgedAt: Date.now(),
			mergeStatus: "shared_default_updated",
			sharingScope: input.sharingScope ?? "profile",
			targets: [],
		};
		const adoptedSuggestion =
			input.adoptedFeedbackSuggestion?.fieldKey === fieldKey ? input.adoptedFeedbackSuggestion : undefined;
		if (adoptedSuggestion)
			Object.assign(adoptedSuggestion, {
				...change,
				changeId: adoptedSuggestion.changeId,
				observedAt: adoptedSuggestion.observedAt,
				previous: adoptedSuggestion.previous,
				sharedFieldsAtObservation: adoptedSuggestion.sharedFieldsAtObservation,
				sharedFieldVersionsAtObservation: adoptedSuggestion.sharedFieldVersionsAtObservation,
				sharedChangeIdsAtObservation: adoptedSuggestion.sharedChangeIdsAtObservation,
			});
		const acceptedChange = adoptedSuggestion ?? change;
		for (const writer of Object.values(store.writers)) {
			if (
				writer.codexConfigurationProfileId !== profileId ||
				writer.binding.purpose !== "native_session" ||
				writer.binding.writerId === input.sourceWriterId
			)
				continue;
			acceptedChange.targets.push({
				writerId: writer.binding.writerId,
				conversationSessionId: writer.binding.conversationSessionId ?? "",
				workspaceId: writer.binding.workspaceId ?? "",
				status: writer.retiredAt ? "pending_next_start" : "accepted",
				reason: "profile 已更新，等待原所有者采用。",
				attemptCount: 0,
				acceptedAt: Date.now(),
				diskSavedAt: null,
				ownerReloadedAt: null,
				recoveryCondition: "原所有者可达，或安全续接同一原生会话",
			});
		}
		if (!adoptedSuggestion) store.changes.push(change);
		const source = store.sources[profile.sourceIdentity];
		if (!source) throw new Error("profile 的原配置来源待恢复。");
		if (ensureCodexConfigurationSourceProfile(store, profile.sourceIdentity).profileId === profileId) {
			source.fieldChangeIds ??= {};
			source.fieldChangeIds[fieldKey] = acceptedChange.changeId;
			if (value === undefined) delete source.fields[fieldKey];
			else source.fields[fieldKey] = structuredClone(value);
			source.version = version;
		}
	}
}

export function recordCodexConfigurationExceptionFeedbackSuggestion(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
	group: "model" | "reasoning_effort" | "permissions",
	observed: CodexConfigurationFields,
	launchFeedback?: { selectionId: string; observedAtMs: number; previousFields: CodexConfigurationFields },
) {
	const existing =
		launchFeedback &&
		store.changes.find((change) => change.taskReasoningEffortFeedbackSelectionId === launchFeedback.selectionId);
	if (existing) return existing;
	const previousFields = launchFeedback?.previousFields ?? writer.lastObservedFields;
	const profile = getCodexConfigurationWriterProfile(store, writer);
	supersedeFeedbackSuggestions(store, (change) => {
		const previousBinding = store.writers[change.sourceWriterId]?.binding;
		return (
			change.exceptionGroup === group &&
			(change.sourceWriterId === writer.binding.writerId ||
				Boolean(
					writer.binding.workspaceId &&
						writer.binding.conversationSessionId &&
						previousBinding?.workspaceId === writer.binding.workspaceId &&
						previousBinding.conversationSessionId === writer.binding.conversationSessionId,
				))
		);
	});
	const fieldKeys = [
		...new Set([...Object.keys(previousFields), ...Object.keys(observed), ...Object.keys(profile.fields)]),
	].filter((key) => codexConfigurationExceptionGroup(key) === group);
	const fieldKey =
		fieldKeys.find((key) => !sameConfigurationField(previousFields[key], observed[key])) ?? fieldKeys[0];
	if (!fieldKey) return;
	const fields = Object.fromEntries(
		Object.entries(observed)
			.filter(([key]) => fieldKeys.includes(key))
			.map(([key, field]) => [key, structuredClone(field)]),
	);
	const deletedFieldKeys = fieldKeys.filter((key) => observed[key] === undefined);
	if (!launchFeedback) {
		writer.localExceptionOverrides ??= {};
		writer.localExceptionOverrides[group] = { profileVersionAtSelection: profile.version, fields, deletedFieldKeys };
	}
	const observedAt = launchFeedback?.observedAtMs ?? Date.now();
	const change: StoredCodexConfigurationChange = {
		taskReasoningEffortFeedbackSelectionId: launchFeedback?.selectionId,
		changeId: randomUUID(),
		version: ++store.revision,
		sourceWriterId: writer.binding.writerId,
		sourceIdentity: writer.binding.sourceIdentity,
		codexConfigurationProfileId: profile.profileId,
		fieldKey,
		previous: previousFields[fieldKey],
		sourceTaskSnapshot: writer.sourceTaskSnapshot,
		relatedPreviousFields: structuredClone(
			Object.fromEntries(fieldKeys.flatMap((key) => (previousFields[key] ? [[key, previousFields[key]]] : []))),
		),
		value: observed[fieldKey],
		relatedFields: Object.fromEntries(fieldKeys.map((key) => [key, observed[key]])),
		relatedDeletedFieldKeys: deletedFieldKeys,
		sharedValueAtProposal: profile.fields[fieldKey],
		exceptionGroup: group,
		feedbackExpiresAtMs: observedAt + CODEX_PROFILE_FEEDBACK_OPPORTUNITY_DURATION_MS,
		sharingScope: "profile",
		observedAt,
		recordKind: "settings_proposal",
		approvalStatus: "pending",
		decidedAt: null,
		mergeStatus: "pending_approval",
		acknowledgedAt: null,
		targets: [],
	};
	captureCodexConfigurationChangePresentationEvidence(store, change);
	store.changes.push(change);
	return change;
}

function hookTrustDecisionIdentity(sourceIdentity: string, hookSourceKey: string, definitionDigest: string) {
	return configurationDigest([sourceIdentity, hookSourceKey, definitionDigest]);
}

export function reuseConfirmedCodexHookTrust(
	store: CodexConfigurationSyncStore,
	sourceIdentity: string,
	fieldKey: string,
	field: CodexConfigurationFieldValue,
) {
	const { keyPath } = configurationFieldAddress(fieldKey);
	if (!field.definitionDigest || !keyPath.includes("state") || !configurationTable(field.value)) return field;
	const hookSourceKey = keyPath.at(-1) ?? "";
	const decision =
		store.hookTrustDecisions[hookTrustDecisionIdentity(sourceIdentity, hookSourceKey, field.definitionDigest)];
	if (!decision) return field;
	if (decision.trustedHash !== null) {
		// 内容事实缺失不能补造；插件及已有内容约束不能降为旧格式信任。
		if (decision.trustedContentHash === undefined) return field;
		if (
			decision.trustedContentHash === null &&
			(!isAbsolute(hookSourceKey) || typeof field.value.trusted_content_hash === "string")
		)
			return field;
	}
	const state = { ...field.value };
	if (decision.trustedHash === null) {
		delete state.trusted_hash;
		delete state.trusted_content_hash;
	} else {
		state.trusted_hash = decision.trustedHash;
		if (typeof decision.trustedContentHash === "string") state.trusted_content_hash = decision.trustedContentHash;
	}
	return { ...field, value: state };
}

export function shareObservedCodexHookTrust(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
	fieldKey: string,
	previous: CodexConfigurationFieldValue | undefined,
	value: CodexConfigurationFieldValue | undefined,
) {
	const hookSourceKey = configurationFieldAddress(fieldKey).keyPath.at(-1) ?? "";
	const definitionDigest = value?.definitionDigest ?? previous?.definitionDigest;
	if (!definitionDigest || !configurationFieldAddress(fieldKey).keyPath.includes("state")) return;
	const previousTrustedHash =
		configurationTable(previous?.value) && typeof previous.value.trusted_hash === "string"
			? previous.value.trusted_hash
			: null;
	const trustedHash =
		configurationTable(value?.value) && typeof value.value.trusted_hash === "string"
			? value.value.trusted_hash
			: null;
	const previousTrustedContentHash =
		configurationTable(previous?.value) && typeof previous.value.trusted_content_hash === "string"
			? previous.value.trusted_content_hash
			: null;
	const trustedContentHash =
		configurationTable(value?.value) && typeof value.value.trusted_content_hash === "string"
			? value.value.trusted_content_hash
			: null;
	if (trustedHash === previousTrustedHash && trustedContentHash === previousTrustedContentHash) return;
	store.hookTrustDecisions[hookTrustDecisionIdentity(writer.binding.sourceIdentity, hookSourceKey, definitionDigest)] =
		{
			sourceIdentity: writer.binding.sourceIdentity,
			hookSourceKey,
			definitionDigest,
			trustedHash,
			trustedContentHash,
			version: ++store.revision,
		};
	for (const profile of Object.values(store.profiles)) {
		if (
			profile.sourceIdentity !== writer.binding.sourceIdentity ||
			profile.profileId === writer.codexConfigurationProfileId
		)
			continue;
		const matchingFields = Object.entries(profile.fields).filter(
			([key]) => configurationFieldAddress(key).keyPath.at(-1) === hookSourceKey,
		);
		if (!matchingFields.length) matchingFields.push([fieldKey, { value: {}, definitionDigest }]);
		for (const [targetFieldKey, targetValue] of matchingFields) {
			if (
				configurationFieldAddress(targetFieldKey).keyPath.at(-1) !== hookSourceKey ||
				targetValue.definitionDigest !== definitionDigest
			)
				continue;
			const next = reuseConfirmedCodexHookTrust(store, profile.sourceIdentity, targetFieldKey, targetValue);
			if (!sameConfigurationField(targetValue, next))
				updateCodexConfigurationProfileFields(
					store,
					profile.profileId,
					{ [targetFieldKey]: next },
					{ sharingScope: "all_profiles_hook_trust" },
				);
		}
	}
}

export function enqueueCodexConfigurationProfileAdoptionForWriter(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
) {
	const profile = getCodexConfigurationWriterProfile(store, writer);
	for (const fieldKey of new Set([
		...Object.keys(profile.fields),
		...Object.keys(profile.fieldVersions),
		...Object.keys(writer.lastObservedFields),
	])) {
		const value = profile.fields[fieldKey];
		store.changes.push({
			changeId: randomUUID(),
			version: ++store.revision,
			acceptedProfileFieldVersion: profile.fieldVersions[fieldKey] ?? 0,
			sourceWriterId: `profile:${profile.profileId}`,
			sourceIdentity: profile.sourceIdentity,
			codexConfigurationProfileId: profile.profileId,
			fieldKey,
			previous: writer.lastObservedFields[fieldKey],
			value,
			observedAt: Date.now(),
			recordKind: "historical_record",
			approvalStatus: "approved",
			decidedAt: Date.now(),
			acknowledgedAt: Date.now(),
			mergeStatus: "shared_default_updated",
			sharingScope: "profile",
			targets: [
				{
					writerId: writer.binding.writerId,
					workspaceId: writer.binding.workspaceId ?? "",
					conversationSessionId: writer.binding.conversationSessionId ?? "",
					status: writer.retiredAt ? "pending_next_start" : "accepted",
					reason: "会话已选择此 profile，等待实际采用。",
					attemptCount: 0,
					acceptedAt: Date.now(),
					diskSavedAt: null,
					ownerReloadedAt: null,
					recoveryCondition: "原所有者可达或满足安全续接条件",
				},
			],
		});
	}
}
