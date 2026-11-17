import { codexConfigurationExceptionGroup } from "../core/codex-configuration-profile-field-editing";
import {
	type CodexConfigurationFields,
	configurationDigest,
	configurationFieldAddress,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import type { StoredCodexConfigurationProfile, StoredCodexConfigurationWriter } from "./codex-configuration-sync-store";

const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const effortFieldKey = JSON.stringify(["config.toml", "model_reasoning_effort"]);
const approvalFieldKey = JSON.stringify(["config.toml", "approval_policy"]);
const sandboxFieldKey = JSON.stringify(["config.toml", "sandbox_mode"]);

export function codexConfigurationDiskFieldsAwaitingAutomaticReplacement(
	writer: Pick<StoredCodexConfigurationWriter, "consumedProfileFieldVersions" | "localExceptionOverrides">,
	profile: StoredCodexConfigurationProfile,
	observed: CodexConfigurationFields,
) {
	const pending: CodexConfigurationFields = {};
	for (const [fieldKey, value] of Object.entries(observed)) {
		const newerProfileFieldVersion =
			(profile.fieldVersions[fieldKey] ?? 0) > (writer.consumedProfileFieldVersions?.[fieldKey] ?? 0);
		const exceptionGroup = codexConfigurationExceptionGroup(fieldKey);
		if (
			newerProfileFieldVersion &&
			(!exceptionGroup ||
				(writer.localExceptionOverrides?.[exceptionGroup]?.profileVersionAtSelection ?? -1) <
					(profile.fieldVersions[fieldKey] ?? 0))
		)
			continue;
		pending[fieldKey] = value;
	}
	return pending;
}

export function codexConfigurationAutomaticReplacementLaunchOverlay(
	writer: Pick<StoredCodexConfigurationWriter, "taskModelSelectionAtLaunch" | "taskReasoningEffortSelectionAtLaunch">,
	launchSelection?: {
		sessionModelId?: string;
		sessionReasoningEffortOverride?: string;
		sessionPermissionMode?: string;
		sessionPermissionSelectionSource?: "profile" | "task_local";
	},
) {
	const fields: CodexConfigurationFields = {};
	if (launchSelection?.sessionModelId && launchSelection.sessionModelId !== writer.taskModelSelectionAtLaunch)
		fields[modelFieldKey] = { value: launchSelection.sessionModelId };
	if (
		launchSelection?.sessionReasoningEffortOverride &&
		launchSelection.sessionReasoningEffortOverride !== writer.taskReasoningEffortSelectionAtLaunch
	)
		fields[effortFieldKey] = { value: launchSelection.sessionReasoningEffortOverride };
	if (launchSelection?.sessionPermissionMode && launchSelection.sessionPermissionSelectionSource !== "profile") {
		const bypass = launchSelection.sessionPermissionMode === "bypass_all_permission_prompts";
		fields[approvalFieldKey] = { value: bypass ? "never" : "untrusted" };
		fields[sandboxFieldKey] = { value: bypass ? "danger-full-access" : "workspace-write" };
	}
	return fields;
}

export function assessCodexConfigurationAutomaticProcessReplacement(
	writer:
		| Pick<
				StoredCodexConfigurationWriter,
				"launchBaselineFields" | "localExceptionOverrides" | "codexConfigurationProfileId"
		  >
		| undefined,
	profile: StoredCodexConfigurationProfile | undefined,
	additionalFields?: CodexConfigurationFields,
) {
	if (!writer || !profile || writer.codexConfigurationProfileId !== profile.profileId)
		return { allowed: false, fingerprint: null, reason: "启动基线或配置归属尚未核验，等待正常启动或手动重启。" };
	const effectiveFields = structuredClone(profile.fields);
	for (const local of Object.values(writer.localExceptionOverrides ?? {})) {
		for (const fieldKey of new Set([...Object.keys(local.fields), ...(local.deletedFieldKeys ?? [])])) {
			const group = codexConfigurationExceptionGroup(fieldKey);
			const superseded = Object.entries(profile.fieldVersions).some(
				([key, version]) =>
					(group ? codexConfigurationExceptionGroup(key) === group : key === fieldKey) &&
					version > local.profileVersionAtSelection,
			);
			if (superseded) continue;
			if (local.fields[fieldKey] === undefined) delete effectiveFields[fieldKey];
			else effectiveFields[fieldKey] = local.fields[fieldKey];
		}
	}
	for (const [fieldKey, field] of Object.entries(additionalFields ?? {})) {
		if (field === undefined) delete effectiveFields[fieldKey];
		else effectiveFields[fieldKey] = field;
	}
	const changedFields = [
		...new Set([...Object.keys(writer.launchBaselineFields), ...Object.keys(effectiveFields)]),
	].filter((fieldKey) => !sameConfigurationField(writer.launchBaselineFields[fieldKey], effectiveFields[fieldKey]));
	const renderingOnly = changedFields.every((fieldKey) => {
		const { fileName, keyPath } = configurationFieldAddress(fieldKey);
		return (
			fileName === "config.toml" && keyPath.length === 2 && keyPath[0] === "tui" && keyPath[1] === "alternate_screen"
		);
	});
	return {
		allowed: renderingOnly,
		fingerprint: renderingOnly ? configurationDigest([profile.profileId, profile.version, effectiveFields]) : null,
		reason: renderingOnly
			? "全部待采用变化仅涉及终端显示，等待安全回合边界后自动采用。"
			: "此次启动包含可能影响 cache 或风险未知的配置，等待 stale 后重进、正常启动或手动重启。",
	};
}
