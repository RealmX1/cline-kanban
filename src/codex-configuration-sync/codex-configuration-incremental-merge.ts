import { randomUUID } from "node:crypto";
import { type CodexConfigurationFields, sameConfigurationField } from "./codex-configuration-field-projection";
import type { CodexConfigurationSyncStore, StoredCodexConfigurationWriter } from "./codex-configuration-sync-store";

export function mergeObservedCodexConfigurationWriter(
	store: CodexConfigurationSyncStore,
	writer: StoredCodexConfigurationWriter,
	observed: CodexConfigurationFields,
) {
	if (writer.binding.purpose !== "native_session") return;
	const source = store.sources[writer.binding.sourceIdentity];
	if (!source) throw new Error("Codex 配置来源绑定缺失，未合并本地决定。");
	for (const fieldKey of new Set([...Object.keys(writer.lastObservedFields), ...Object.keys(observed)])) {
		const value = observed[fieldKey];
		if (sameConfigurationField(writer.lastObservedFields[fieldKey], value)) continue;
		const baseline = writer.mergeBaselineFields[fieldKey];
		const shared = source.fields[fieldKey];
		const conflict = !sameConfigurationField(shared, baseline) && !sameConfigurationField(shared, value);
		store.revision++;
		store.changes.push({
			changeId: randomUUID(),
			version: store.revision,
			sourceWriterId: writer.binding.writerId,
			sourceIdentity: writer.binding.sourceIdentity,
			fieldKey,
			previous: writer.lastObservedFields[fieldKey],
			value,
			sharedValueAtConflict: conflict ? shared : undefined,
			observedAt: Date.now(),
			mergeStatus: conflict ? "conflict" : "shared_default_updated",
			acknowledgedAt: null,
			targets: [],
		});
		if (!conflict) {
			if (value === undefined) delete source.fields[fieldKey];
			else source.fields[fieldKey] = value;
			source.version = store.revision;
			if (value === undefined) delete writer.mergeBaselineFields[fieldKey];
			else writer.mergeBaselineFields[fieldKey] = value;
		}
	}
	writer.lastObservedFields = observed;
}

// 用户全局文件仍由用户自己的 Codex 管理；这里只吸收没有与内部明确决定冲突的来源变化。
export function reconcileCodexConfigurationUserSourceFields(
	store: CodexConfigurationSyncStore,
	sourceIdentity: string,
	current: CodexConfigurationFields,
) {
	const source = store.sources[sourceIdentity];
	if (!source) return;
	for (const key of new Set([...Object.keys(source.observedUserFields), ...Object.keys(current)])) {
		if (sameConfigurationField(current[key], source.observedUserFields[key])) continue;
		const shared = source.fields[key];
		const conflict =
			!sameConfigurationField(shared, source.observedUserFields[key]) &&
			!sameConfigurationField(shared, current[key]);
		store.revision++;
		store.changes.push({
			changeId: randomUUID(),
			version: store.revision,
			sourceWriterId: `user-source:${sourceIdentity}`,
			sourceIdentity,
			fieldKey: key,
			previous: source.observedUserFields[key],
			value: current[key],
			sharedValueAtConflict: conflict ? shared : undefined,
			mergeStatus: conflict ? "conflict" : "shared_default_updated",
			observedAt: Date.now(),
			acknowledgedAt: null,
			targets: [],
		});
		if (!conflict) {
			if (current[key] === undefined) delete source.fields[key];
			else source.fields[key] = current[key];
			source.version = store.revision;
		}
	}
	source.observedUserFields = current;
}
