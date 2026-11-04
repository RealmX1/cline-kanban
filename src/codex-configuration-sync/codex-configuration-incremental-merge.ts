import { randomUUID } from "node:crypto";
import { captureCodexConfigurationChangePresentationEvidence } from "./codex-configuration-change-presentation";
import {
	type CodexConfigurationFields,
	configurationTable,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import {
	hasOnlyCodexConfigurationDefinitionChange,
	recordCodexConfigurationSourceObservation,
} from "./codex-configuration-observation-records";
import {
	codexConfigurationExceptionGroup,
	getCodexConfigurationWriterProfile,
	recordCodexConfigurationExceptionFeedbackSuggestion,
	reuseConfirmedCodexHookTrust,
	shareObservedCodexHookTrust,
	updateCodexConfigurationProfileFields,
} from "./codex-configuration-profiles";
import type { CodexConfigurationSyncStore, StoredCodexConfigurationWriter } from "./codex-configuration-sync-store";

export function mergeObservedCodexConfigurationWriter(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
	observed: CodexConfigurationFields,
	catchingUpBeforeNativeSessionRestart = false,
) {
	if (writer.binding.purpose !== "native_session") return;
	const source = store.sources[writer.binding.sourceIdentity];
	if (!source) throw new Error("Codex 配置来源绑定缺失，未合并本地决定。");
	const profile = getCodexConfigurationWriterProfile(store, writer);
	const changedExceptionGroups = new Set<"model" | "reasoning_effort" | "permissions">();
	for (const fieldKey of new Set([...Object.keys(writer.lastObservedFields), ...Object.keys(observed)])) {
		const value = observed[fieldKey];
		if (sameConfigurationField(writer.lastObservedFields[fieldKey], value)) {
			if (value) {
				const profileState = profile.fields[fieldKey]?.value;
				const candidate =
					configurationTable(profileState) && configurationTable(value.value)
						? { ...value, value: { ...profileState, trusted_hash: value.value.trusted_hash } }
						: { ...value, value: {} };
				const confirmed = reuseConfirmedCodexHookTrust(store, writer.binding.sourceIdentity, fieldKey, candidate);
				if (
					!sameConfigurationField(candidate, confirmed) &&
					!sameConfigurationField(profile.fields[fieldKey], confirmed)
				)
					updateCodexConfigurationProfileFields(
						store,
						profile.profileId,
						{ [fieldKey]: confirmed },
						{ sharingScope: "all_profiles_hook_trust" },
					);
			}
			continue;
		}
		const exceptionGroup = codexConfigurationExceptionGroup(fieldKey);
		const newerProfileFieldVersion =
			(profile.fieldVersions[fieldKey] ?? 0) > (writer.consumedProfileFieldVersions?.[fieldKey] ?? 0);
		if (
			catchingUpBeforeNativeSessionRestart &&
			newerProfileFieldVersion &&
			(!exceptionGroup ||
				(writer.localExceptionOverrides?.[exceptionGroup]?.profileVersionAtSelection ?? -1) <
					(profile.fieldVersions[fieldKey] ?? 0))
		)
			continue;
		if (exceptionGroup) {
			changedExceptionGroups.add(exceptionGroup);
			continue;
		}
		if (store.schemaVersion === 3) {
			const previous = writer.lastObservedFields[fieldKey];
			if (hasOnlyCodexConfigurationDefinitionChange({ previous, value })) {
				const change = {
					changeId: randomUUID(),
					version: ++store.revision,
					sourceWriterId: writer.binding.writerId,
					sourceIdentity: writer.binding.sourceIdentity,
					codexConfigurationProfileId: profile.profileId,
					fieldKey,
					previous,
					value,
					observedAt: Date.now(),
					mergeStatus: "superseded" as const,
					acknowledgedAt: null,
					targets: [],
				};
				registerObservedChange(store, change);
				if (value) {
					const profileState = profile.fields[fieldKey]?.value;
					const candidate =
						configurationTable(profileState) && configurationTable(value.value)
							? { ...value, value: { ...profileState, trusted_hash: value.value.trusted_hash } }
							: { ...value, value: {} };
					const confirmed = reuseConfirmedCodexHookTrust(
						store,
						writer.binding.sourceIdentity,
						fieldKey,
						candidate,
					);
					if (!sameConfigurationField(candidate, confirmed))
						updateCodexConfigurationProfileFields(
							store,
							profile.profileId,
							{ [fieldKey]: confirmed },
							{ sharingScope: "all_profiles_hook_trust" },
						);
				}
				continue;
			}
			if (!sameConfigurationField(profile.fields[fieldKey], value))
				updateCodexConfigurationProfileFields(
					store,
					profile.profileId,
					{ [fieldKey]: value },
					{ sourceWriterId: writer.binding.writerId },
				);
			shareObservedCodexHookTrust(store, writer, fieldKey, previous, value);
			if (value === undefined) delete writer.mergeBaselineFields[fieldKey];
			else writer.mergeBaselineFields[fieldKey] = structuredClone(value);
			writer.consumedProfileFieldVersions ??= {};
			writer.consumedProfileFieldVersions[fieldKey] = profile.fieldVersions[fieldKey] ?? 0;
			continue;
		}
		const baseline = writer.mergeBaselineFields[fieldKey];
		const shared = source.fields[fieldKey];
		const conflict = !sameConfigurationField(shared, baseline) && !sameConfigurationField(shared, value);
		store.revision++;
		const change = {
			changeId: randomUUID(),
			version: store.revision,
			sourceWriterId: writer.binding.writerId,
			sourceIdentity: writer.binding.sourceIdentity,
			fieldKey,
			previous: writer.lastObservedFields[fieldKey],
			value,
			sharedValueAtProposal: shared,
			sharedValueAtConflict: conflict ? shared : undefined,
			observedAt: Date.now(),
			mergeStatus: conflict ? ("conflict" as const) : ("pending_approval" as const),
			recordKind: "settings_proposal" as const,
			approvalStatus: "pending" as const,
			decidedAt: null,
			acknowledgedAt: null,
			targets: [],
		};
		registerObservedChange(store, change);
	}
	for (const group of changedExceptionGroups)
		recordCodexConfigurationExceptionFeedbackSuggestion(store, writer, group, observed);
	writer.lastObservedFields = observed;
}

function registerObservedChange(
	store: CodexConfigurationSyncStore,
	change: CodexConfigurationSyncStore["changes"][number],
) {
	captureCodexConfigurationChangePresentationEvidence(store, change);
	if (hasOnlyCodexConfigurationDefinitionChange(change)) {
		change.recordKind = "source_observation";
		change.approvalStatus = "not_required";
		recordCodexConfigurationSourceObservation(store, change);
	}
	store.changes.push(change);
}
