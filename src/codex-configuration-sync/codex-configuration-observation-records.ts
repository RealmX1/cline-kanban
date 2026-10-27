import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CodexConfigurationFieldValue,
	configurationDigest,
	configurationFieldAddress,
} from "./codex-configuration-field-projection";
import type { CodexConfigurationSyncStore, StoredCodexConfigurationChange } from "./codex-configuration-sync-store";

export function hasOnlyCodexConfigurationDefinitionChange(
	change: Pick<StoredCodexConfigurationChange, "previous" | "value">,
) {
	return Boolean(
		change.previous &&
			change.value &&
			isDeepStrictEqual(change.previous.value, change.value.value) &&
			change.previous.definitionDigest !== change.value.definitionDigest,
	);
}

export function recordCodexConfigurationSourceObservation(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	const { keyPath, fileName } = configurationFieldAddress(change.fieldKey);
	const sourceKey = keyPath.includes("state") ? (keyPath.at(-1) ?? fileName).replace(/:[^:]+:\d+:\d+$/, "") : fileName;
	const observationId = `source-observation:${configurationDigest([change.sourceIdentity, sourceKey])}`;
	let observation = store.sourceObservations.find((entry) => entry.observationId === observationId);
	if (!observation) {
		observation = {
			observationId,
			sourceIdentity: change.sourceIdentity,
			sourceKey,
			sourceLabel: sourceKey.startsWith("plugin:") ? sourceKey : basename(sourceKey),
			version: change.version,
			firstObservedAt: change.observedAt,
			observedAt: change.observedAt,
			observationCount: 1,
			detectedLocationCount: 1,
			acknowledgedAt: null,
			reminderDisposition: "unread",
			rawChangeIds: [],
			detectedWriterIds: [],
		};
		store.sourceObservations.push(observation);
	}
	if (observation.rawChangeIds.includes(change.changeId)) return;
	observation.rawChangeIds.push(change.changeId);
	if (!observation.detectedWriterIds.includes(change.sourceWriterId))
		observation.detectedWriterIds.push(change.sourceWriterId);
	observation.observationCount = observation.rawChangeIds.length;
	observation.detectedLocationCount = observation.detectedWriterIds.length;
	observation.observedAt = change.observedAt;
	observation.version = change.version;
	observation.acknowledgedAt = null;
	observation.reminderDisposition = "unread";
}

// 迁移只纠正展示归类；旧默认值、原始记录、传播回执与失败历史均保持原样。
export function migrateCodexConfigurationApprovalRecords(store: CodexConfigurationSyncStore) {
	if (store.schemaVersion === 2) return;
	for (const change of store.changes) {
		if (hasOnlyCodexConfigurationDefinitionChange(change)) {
			change.recordKind = "source_observation";
			change.approvalStatus = "not_required";
			recordCodexConfigurationSourceObservation(store, change);
		} else {
			change.recordKind = "historical_record";
			change.approvalStatus = "historical";
		}
		change.decidedAt = null;
	}
	for (const observation of store.sourceObservations) {
		const originalRecords = store.changes.filter((change) => observation.rawChangeIds.includes(change.changeId));
		if (originalRecords.length && originalRecords.every((change) => change.acknowledgedAt !== null)) {
			observation.acknowledgedAt = Math.max(...originalRecords.map((change) => change.acknowledgedAt ?? 0));
			observation.reminderDisposition = "confirmed";
		}
	}
	store.schemaVersion = 2;
	store.revision++;
}

function describeDifferenceValue(value: unknown, fieldName?: string) {
	if (fieldName === "trusted_hash")
		return typeof value === "string"
			? `已保存信任决定（摘要 ${configurationDigest(value).slice(0, 10)}）`
			: "未保存信任决定";
	if (value === undefined) return "未设置";
	if (typeof value === "boolean") return value ? "开启" : "关闭";
	return `已设置（摘要 ${configurationDigest(value).slice(0, 10)}）`;
}

export function describeCodexConfigurationSettingDifferences(
	previous: CodexConfigurationFieldValue | undefined,
	current: CodexConfigurationFieldValue | undefined,
) {
	if (isDeepStrictEqual(previous?.value, current?.value)) return [];
	const previousValue = previous?.value,
		currentValue = current?.value;
	const isRecord = (value: unknown): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	if (isRecord(previousValue) && isRecord(currentValue))
		return [...new Set([...Object.keys(previousValue), ...Object.keys(currentValue)])]
			.filter((key) => !isDeepStrictEqual(previousValue[key], currentValue[key]))
			.map((key) => ({
				label: key === "enabled" ? "启用状态" : key === "trusted_hash" ? "信任绑定" : key,
				previous: describeDifferenceValue(previousValue[key], key),
				current: describeDifferenceValue(currentValue[key], key),
			}));
	return [
		{
			label: "设置值",
			previous: describeDifferenceValue(previousValue),
			current: describeDifferenceValue(currentValue),
		},
	];
}
