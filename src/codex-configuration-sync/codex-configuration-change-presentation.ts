import { isDeepStrictEqual } from "node:util";
import type {
	CodexConfigurationChangeDetails,
	CodexConfigurationSourceEvidence,
	CodexConfigurationTaskSourceSnapshot,
	CodexConfigurationValueOrigin,
} from "../core/codex-configuration-sync-contract";
import {
	type CodexConfigurationFieldValue,
	configurationDigest,
	configurationFieldAddress,
	configurationTable,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import type { CodexConfigurationSyncStore, StoredCodexConfigurationChange } from "./codex-configuration-sync-store";

export interface CodexConfigurationTaskSourceContext {
	writerTasks: Record<string, CodexConfigurationTaskSourceSnapshot>;
	taskLinks: Record<string, { workspaceId: string; taskId: string; taskIncarnationCreatedAtEpochMs: number }>;
}
export const codexConfigurationTaskSourceIdentityKey = (
	task: Pick<CodexConfigurationTaskSourceSnapshot, "workspaceId" | "taskId" | "taskIncarnationCreatedAtEpochMs">,
) => JSON.stringify([task.workspaceId, task.taskId, task.taskIncarnationCreatedAtEpochMs]);

export function describeCodexConfigurationSourceEvidence(
	store: CodexConfigurationSyncStore,
	writerId: string,
	snapshot?: CodexConfigurationTaskSourceSnapshot,
	context?: CodexConfigurationTaskSourceContext,
	modificationInitiator?: CodexConfigurationSourceEvidence["initiator"],
): CodexConfigurationSourceEvidence {
	const writer = store.writers[writerId];
	const task = snapshot ?? writer?.sourceTaskSnapshot ?? context?.writerTasks[writerId];
	const currentTaskLink = task ? context?.taskLinks[codexConfigurationTaskSourceIdentityKey(task)] : undefined;
	const isProfileEdit = writerId.startsWith("profile:");
	return {
		initiator: modificationInitiator ?? {
			status: "unknown",
			description: "文件观测与 writer 绑定只能证明检测归属，缺少修改发起者的原生记录。",
		},
		detectedOwner: {
			writerId,
			workspaceId: task?.workspaceId ?? writer?.binding.workspaceId ?? "",
			conversationSessionId: task?.conversationSessionId ?? writer?.binding.conversationSessionId ?? "",
			description: writerId.startsWith("user-source:")
				? "用户全局配置"
				: isProfileEdit
					? "看板 profile 设置"
					: "持久 writer 绑定",
			...(task ? { task } : {}),
			...(currentTaskLink ? { currentTaskLink } : {}),
			...(!task
				? { unavailableReason: "未找到与 writer 及运行代次一致的任务归属证据。" }
				: !currentTaskLink
					? { unavailableReason: "原任务已删除、迁移或项目暂不可读，当前任务链接尚未核验。" }
					: {}),
		},
		recoveryCondition:
			"持久 writer、同一运行代次的会话归属或任务身份账本恢复后自动重验；不会按值相同或时间相近推断修改者。",
	};
}

export function describeCodexConfigurationFieldIdentity(fieldKey: string) {
	const { fileName, keyPath } = configurationFieldAddress(fieldKey);
	const hook = keyPath.includes("state") ? /^(.*):([a-z_]+):(\d+):(\d+)$/.exec(keyPath.at(-1) ?? "") : null;
	return hook
		? `${fileName} · ${keyPath.slice(0, -1).join(".")} · ${hook[1]} · Hook ${hook[2]}:${hook[3]}:${hook[4]}`
		: `${fileName} · ${keyPath.join(".")}`;
}

export function describeCodexConfigurationHistorySearchText(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	const keys = new Set([
		change.fieldKey,
		...Object.keys(change.relatedFields ?? {}),
		...(change.relatedDeletedFieldKeys ?? []),
	]);
	return JSON.stringify([
		...[...keys].map(describeCodexConfigurationFieldIdentity),
		change.fieldKey,
		change.codexConfigurationProfileId,
		describeCodexConfigurationSourceEvidence(
			store,
			change.sourceWriterId,
			change.sourceTaskSnapshot,
			undefined,
			change.modificationInitiator,
		),
	]).toLocaleLowerCase();
}

const sensitiveFieldName = /secret|token|password|credential|api.?key|authorization|private.?key|^env$/i;
// 对象、数组和命令里的凭据也须脱敏，浏览器不接收原始配置对象。
export function redactCodexConfigurationDisplayValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactCodexConfigurationDisplayValue);
	if (configurationTable(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				sensitiveFieldName.test(key) ? "[已脱敏]" : redactCodexConfigurationDisplayValue(entry),
			]),
		);
	if (typeof value !== "string") return value;
	return value
		.replace(/(Bearer\s+)[^\s"']+/gi, "$1[已脱敏]")
		.replace(
			/((?:[a-z0-9_]*(?:secret|token|password|credential|api[_-]?key|authorization|private[_-]?key)[a-z0-9_]*)(?:\s*[=:]\s*|\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
			"$1[已脱敏]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已脱敏]@");
}

function comparedValue(value: unknown, present: boolean, full: boolean, fieldName: string, known = true) {
	if (!known) return { state: "unknown" as const, text: "未知：历史记录未保存此字段。" };
	if (!present) return { state: "absent" as const, text: "未设置（不存在）" };
	const safeValue = sensitiveFieldName.test(fieldName) ? "[已脱敏]" : redactCodexConfigurationDisplayValue(value);
	let text = JSON.stringify(safeValue, null, full ? 2 : undefined) ?? String(safeValue);
	if (!full && (fieldName === "trusted_hash" || fieldName === "trusted_content_hash"))
		text = typeof value === "string" ? `已保存信任指纹 ${value.slice(0, 12)}…` : "未保存信任决定";
	if (!full && text.length > 320) text = `${text.slice(0, 320)}…（展开查看完整值）`;
	return { state: "present" as const, text };
}

function sharedValueOrigin(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
	fieldKey: string,
	context?: CodexConfigurationTaskSourceContext,
): CodexConfigurationValueOrigin {
	const profile = store.profiles[change.codexConfigurationProfileId ?? ""];
	const version = profile?.fieldVersions[fieldKey];
	const sourceReference = store.sources[change.sourceIdentity]?.fieldChangeIds?.[fieldKey];
	const accepted = profile
		? store.changes.find(
				(entry) =>
					entry.codexConfigurationProfileId === profile.profileId &&
					entry.fieldKey === fieldKey &&
					version !== undefined &&
					(entry.acceptedProfileFieldVersion ?? entry.version) === version &&
					sameConfigurationField(entry.value, profile.fields[fieldKey]) &&
					(entry.approvalStatus === "approved" ||
						(entry.approvalStatus === "historical" && entry.mergeStatus === "shared_default_updated")),
			)
		: store.changes.find(
				(entry) =>
					entry.changeId === sourceReference &&
					entry.fieldKey === fieldKey &&
					entry.sourceIdentity === change.sourceIdentity,
			);
	return accepted
		? {
				description: "已接受的字段版本",
				changeId: accepted.changeId,
				fieldVersion: version ?? accepted.version,
				sourceEvidence: describeCodexConfigurationSourceEvidence(
					store,
					accepted.sourceWriterId,
					accepted.sourceTaskSnapshot,
					context,
					accepted.modificationInitiator,
				),
			}
		: {
				description: "共享初始值或历史来源未知：缺少对应的已接受字段版本记录。",
				...(version !== undefined ? { fieldVersion: version } : {}),
			};
}

function conflictSnapshotOrigin(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
	fieldKey: string,
	context?: CodexConfigurationTaskSourceContext,
): CodexConfigurationValueOrigin {
	const changeId = change.sharedConflictEvidence?.changeIds[fieldKey];
	const fieldVersion = change.sharedConflictEvidence?.fieldVersions[fieldKey];
	const accepted = store.changes.find(
		(entry) =>
			entry.changeId === changeId && entry.fieldKey === fieldKey && entry.sourceIdentity === change.sourceIdentity,
	);
	return {
		description: accepted ? "冲突快照绑定的已接受变更" : "冲突快照来源未知：历史记录缺少对应变更引用。",
		...(fieldVersion !== undefined ? { fieldVersion } : {}),
		...(accepted
			? {
					changeId,
					sourceEvidence: describeCodexConfigurationSourceEvidence(
						store,
						accepted.sourceWriterId,
						accepted.sourceTaskSnapshot,
						context,
						accepted.modificationInitiator,
					),
				}
			: {}),
	};
}

export function captureCodexConfigurationChangePresentationEvidence(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	change.sourceTaskSnapshot ??= store.writers[change.sourceWriterId]?.sourceTaskSnapshot;
	const profile = store.profiles[change.codexConfigurationProfileId ?? ""];
	const shared = profile?.fields ?? store.sources[change.sourceIdentity]?.fields;
	const keys = new Set([
		change.fieldKey,
		...Object.keys(change.relatedFields ?? {}),
		...(change.relatedDeletedFieldKeys ?? []),
	]);
	change.sharedFieldsAtObservation ??= structuredClone(
		Object.fromEntries([...keys].flatMap((key) => (shared?.[key] ? [[key, shared[key]]] : []))),
	);
	change.sharedFieldVersionsAtObservation ??= Object.fromEntries(
		[...keys].flatMap((key) =>
			profile?.fieldVersions[key] !== undefined ? [[key, profile.fieldVersions[key]]] : [],
		),
	);
	change.sharedChangeIdsAtObservation ??= Object.fromEntries(
		[...keys].flatMap((key) => {
			const origin = sharedValueOrigin(store, change, key);
			return origin.changeId ? [[key, origin.changeId]] : [];
		}),
	);
	if (change.mergeStatus === "conflict") captureCodexConfigurationConflictPresentationEvidence(store, change);
}

function comparedFieldKeys(change: StoredCodexConfigurationChange) {
	return [
		...new Set([
			change.fieldKey,
			...Object.keys(change.relatedFields ?? {}),
			...(change.relatedDeletedFieldKeys ?? []),
			...Object.keys(change.relatedPreviousFields ?? {}),
		]),
	].sort();
}

export function completeCodexConfigurationCandidateValueDigest(change: StoredCodexConfigurationChange) {
	const canonicalValue = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonicalValue);
		if (!configurationTable(value)) return value;
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalValue(value[key])]),
		);
	};
	return configurationDigest(
		canonicalValue(
			Object.fromEntries(
				comparedFieldKeys(change).map((key) => [
					key,
					change.relatedDeletedFieldKeys?.includes(key)
						? null
						: ((key === change.fieldKey ? change.value : change.relatedFields?.[key]) ?? null),
				]),
			),
		),
	);
}

export function currentCodexConfigurationSharedValueDigest(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	const shared = change.codexConfigurationProfileId
		? store.profiles[change.codexConfigurationProfileId]?.fields
		: store.sources[change.sourceIdentity]?.fields;
	const keys = comparedFieldKeys(change);
	return configurationDigest(
		keys.length === 1
			? (shared?.[change.fieldKey] ?? null)
			: Object.fromEntries(keys.map((key) => [key, shared?.[key] ?? null])),
	);
}

export function captureCodexConfigurationConflictPresentationEvidence(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	if (change.sharedConflictEvidence) return;
	const profile = store.profiles[change.codexConfigurationProfileId ?? ""];
	const shared = profile?.fields ?? store.sources[change.sourceIdentity]?.fields;
	const keys = comparedFieldKeys(change);
	change.sharedConflictEvidence = {
		fields: structuredClone(Object.fromEntries(keys.flatMap((key) => (shared?.[key] ? [[key, shared[key]]] : [])))),
		fieldVersions: Object.fromEntries(
			keys.flatMap((key) => (profile?.fieldVersions[key] !== undefined ? [[key, profile.fieldVersions[key]]] : [])),
		),
		changeIds: Object.fromEntries(
			keys.flatMap((key) => {
				const origin = sharedValueOrigin(store, change, key);
				return origin.changeId ? [[key, origin.changeId]] : [];
			}),
		),
	};
}

function hookChangeExplanation(change: StoredCodexConfigurationChange) {
	if (!configurationFieldAddress(change.fieldKey).keyPath.includes("state")) return null;
	const before = configurationTable(change.previous?.value) ? change.previous.value : {};
	const after = configurationTable(change.value?.value) ? change.value.value : {};
	if ((!before.trusted_hash && after.trusted_hash) || (!before.trusted_content_hash && after.trusted_content_hash))
		return "新增 Hook 信任确认；信任绑定于该来源和定义。";
	if ((before.trusted_hash && !after.trusted_hash) || (before.trusted_content_hash && !after.trusted_content_hash))
		return "撤销 Hook 信任确认；没有继续信任旧内容。";
	if (before.trusted_content_hash !== after.trusted_content_hash || before.trusted_hash !== after.trusted_hash)
		return "Hook 内容信任更新；完整指纹可展开核对。历史 Hook 代码正文未采集，保持未知。";
	if (before.enabled !== after.enabled)
		return after.enabled === false
			? "禁用 Hook；信任决定的保存情况按字段比较。"
			: after.enabled === true
				? "启用 Hook；实际采用状态仍由原所有者核验。"
				: "删除 Hook 启停设置；实际默认行为由原生配置决定。";
	if (change.previous?.definitionDigest !== change.value?.definitionDigest)
		return "Hook 来源定义更新；定义摘要变化不会自动重新授予信任。";
	return "Hook 配置更新；具体变化按字段比较。";
}

export function describeCodexConfigurationChange(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
	full = false,
	targetWriterId?: string,
	context?: CodexConfigurationTaskSourceContext,
): CodexConfigurationChangeDetails {
	const sharedFields = change.codexConfigurationProfileId
		? store.profiles[change.codexConfigurationProfileId]?.fields
		: store.sources[change.sourceIdentity]?.fields;
	const target = targetWriterId ? store.writers[targetWriterId] : undefined;
	const fields = comparedFieldKeys(change);
	const rows: CodexConfigurationChangeDetails["rows"] = [];
	for (const fieldKey of fields) {
		const previous = fieldKey === change.fieldKey ? change.previous : change.relatedPreviousFields?.[fieldKey];
		const detected = fieldKey === change.fieldKey ? change.value : change.relatedFields?.[fieldKey];
		const sharedCurrent = sharedFields?.[fieldKey];
		const sharedAtConflict = change.sharedConflictEvidence
			? change.sharedConflictEvidence.fields[fieldKey]
			: fieldKey === change.fieldKey
				? change.sharedValueAtConflict
				: undefined;
		const targetValue = target?.lastObservedFields[fieldKey];
		const isHook = configurationFieldAddress(fieldKey).keyPath.includes("state");
		const values = [previous, detected, sharedCurrent, sharedAtConflict, targetValue];
		const names = isHook
			? new Set(values.flatMap((value) => (configurationTable(value?.value) ? Object.keys(value.value) : [])))
			: new Set([""]);
		if (!names.size) names.add("");
		for (const name of names) {
			const read = (field: CodexConfigurationFieldValue | undefined, known = true) =>
				comparedValue(
					name && configurationTable(field?.value) ? field.value[name] : field?.value,
					Boolean(field && (!name || (configurationTable(field.value) && Object.hasOwn(field.value, name)))),
					full,
					name || configurationFieldAddress(fieldKey).keyPath.at(-1) || "",
					known,
				);
			const before = read(previous, fieldKey === change.fieldKey || change.relatedPreviousFields !== undefined);
			const after = read(detected);
			rows.push({
				fieldKey,
				label: `${describeCodexConfigurationFieldIdentity(fieldKey)}${name ? ` · ${name}` : ""}`,
				changeKind:
					before.state === "unknown"
						? "unknown"
						: before.state === "absent" && after.state === "present"
							? "added"
							: before.state === "present" && after.state === "absent"
								? "deleted"
								: isDeepStrictEqual(
											name && configurationTable(previous?.value) ? previous.value[name] : previous?.value,
											name && configurationTable(detected?.value) ? detected.value[name] : detected?.value,
										)
									? "unchanged"
									: "modified",
				previous: before,
				detected: after,
				sharedCurrent: read(sharedCurrent, sharedFields !== undefined),
				previousMatchesSharedCurrent: sameConfigurationField(previous, sharedCurrent),
				sharedOrigin: sharedValueOrigin(store, change, fieldKey, context),
				...(change.mergeStatus === "conflict" || change.sharedValueAtConflict
					? {
							sharedAtConflict: read(
								sharedAtConflict,
								fieldKey === change.fieldKey || change.sharedConflictEvidence !== undefined,
							),
							sharedCurrent: read(sharedCurrent, sharedFields !== undefined),
							sharedOrigin: sharedValueOrigin(store, change, fieldKey, context),
							sharedAtConflictOrigin: conflictSnapshotOrigin(store, change, fieldKey, context),
						}
					: {}),
				...(targetWriterId ? { target: read(targetValue, Boolean(target)) } : {}),
			});
		}
		if (full && isHook)
			rows.push({
				fieldKey,
				label: `${describeCodexConfigurationFieldIdentity(fieldKey)} · definitionDigest`,
				changeKind: previous?.definitionDigest === detected?.definitionDigest ? "unchanged" : "modified",
				previous: comparedValue(
					previous?.definitionDigest,
					Boolean(previous?.definitionDigest),
					true,
					"definitionDigest",
				),
				detected: comparedValue(
					detected?.definitionDigest,
					Boolean(detected?.definitionDigest),
					true,
					"definitionDigest",
				),
				sharedCurrent: comparedValue(
					sharedCurrent?.definitionDigest,
					Boolean(sharedCurrent?.definitionDigest),
					true,
					"definitionDigest",
					sharedFields !== undefined,
				),
				...(change.mergeStatus === "conflict"
					? {
							sharedAtConflict: comparedValue(
								sharedAtConflict?.definitionDigest,
								Boolean(sharedAtConflict?.definitionDigest),
								true,
								"definitionDigest",
							),
							sharedCurrent: comparedValue(
								sharedCurrent?.definitionDigest,
								Boolean(sharedCurrent?.definitionDigest),
								true,
								"definitionDigest",
								sharedFields !== undefined,
							),
						}
					: {}),
				...(targetWriterId
					? {
							target: comparedValue(
								targetValue?.definitionDigest,
								Boolean(targetValue?.definitionDigest),
								true,
								"definitionDigest",
								Boolean(target),
							),
						}
					: {}),
			});
	}
	const hookExplanation = hookChangeExplanation(change);
	return {
		changeId: change.changeId,
		version: change.version,
		fieldLabel: `${describeCodexConfigurationFieldIdentity(change.fieldKey)}${hookExplanation ? ` · ${hookExplanation.split("；")[0]}` : ""}`,
		sourceEvidence: describeCodexConfigurationSourceEvidence(
			store,
			change.sourceWriterId,
			change.sourceTaskSnapshot,
			context,
			change.modificationInitiator,
		),
		hookExplanation,
		rows,
		expectedSharedValueDigest: currentCodexConfigurationSharedValueDigest(store, change),
		...(targetWriterId
			? {
					targetWriterId,
					expectedTargetValueDigest: configurationDigest(target?.lastObservedFields[change.fieldKey] ?? null),
					targetSourceEvidence: describeCodexConfigurationSourceEvidence(
						store,
						targetWriterId,
						undefined,
						context,
					),
				}
			: {}),
	};
}
