import { configurationFieldAddress } from "./codex-configuration-field-projection";
import type { CodexConfigurationSyncStore, StoredCodexConfigurationChange } from "./codex-configuration-sync-store";

export function isCodexDesktopConfigurationField(fieldKey: string) {
	const { keyPath } = configurationFieldAddress(fieldKey);
	return (keyPath[0] === "profiles" ? keyPath[2] : keyPath[0]) === "desktop";
}

export function isCodexConfigurationChangeExcludedFromSettingsSynchronization(change: StoredCodexConfigurationChange) {
	return Boolean(
		change.settingsIsolationArchivedAtMs !== undefined ||
			change.sourceWriterId.startsWith("user-source:") ||
			isCodexDesktopConfigurationField(change.fieldKey),
	);
}

export function migrateCodexConfigurationSettingsIsolation(store: CodexConfigurationSyncStore) {
	for (const fields of [
		...Object.values(store.sources).map((source) => source.fields),
		...Object.values(store.profiles).map((profile) => profile.fields),
		...Object.values(store.writers).flatMap((writer) => [writer.mergeBaselineFields, writer.lastObservedFields]),
	])
		for (const key of Object.keys(fields)) if (isCodexDesktopConfigurationField(key)) delete fields[key];
	for (const profile of Object.values(store.profiles))
		for (const key of Object.keys(profile.fieldVersions))
			if (isCodexDesktopConfigurationField(key)) {
				delete profile.fieldVersions[key];
				profile.version = ++store.revision;
			}
	for (const change of store.changes) {
		if (
			change.settingsIsolationArchivedAtMs !== undefined ||
			!isCodexConfigurationChangeExcludedFromSettingsSynchronization(change)
		)
			continue;
		change.settingsIsolationArchivedAtMs = Date.now();
		change.recordKind = "historical_record";
		change.acknowledgedAt ??= change.settingsIsolationArchivedAtMs;
		if (change.approvalStatus === "pending") {
			change.recordKind = "historical_record";
			change.approvalStatus = "historical";
			change.mergeStatus = "superseded";
			change.acknowledgedAt ??= change.settingsIsolationArchivedAtMs;
		}
		for (const target of change.targets) {
			if (!["accepted", "pending_reload", "pending_next_start"].includes(target.status)) continue;
			target.settingsIsolationCancellation = {
				previousStatus: target.status,
				previousReason: target.reason,
				cancelledAtMs: change.settingsIsolationArchivedAtMs,
			};
			target.status = "not_applicable";
			target.reason = "外部配置与 desktop 设置已退出 Kanban 设置同步，原传播记录保留。";
			target.recoveryCondition = null;
		}
		change.version = ++store.revision;
	}
	for (const observation of store.sourceObservations) {
		if (observation.acknowledgedAt !== null || !observation.rawChangeIds.length) continue;
		if (
			observation.rawChangeIds.every((id) =>
				store.changes.some(
					(change) =>
						change.changeId === id && isCodexConfigurationChangeExcludedFromSettingsSynchronization(change),
				),
			)
		) {
			observation.acknowledgedAt = Date.now();
			observation.reminderDisposition = "confirmed";
			observation.version = ++store.revision;
		}
	}
}
