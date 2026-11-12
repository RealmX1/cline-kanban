import { realpath } from "node:fs/promises";
import { prepareCodexDirectoryVolumeObservations } from "../codex-conversation-storage/codex-persistent-directory-identity";
import {
	captureCodexConfigurationConflictPresentationEvidence,
	currentCodexConfigurationSharedValueDigest,
} from "./codex-configuration-change-presentation";
import {
	type CodexConfigurationFields,
	configurationFieldAddress,
	projectCodexConfigurationFields,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import {
	codexConfigurationChangeSharedFields,
	ensureCodexConfigurationSourceProfile,
	expireCodexConfigurationProfileFeedbackSuggestions,
	updateCodexConfigurationProfileFields,
} from "./codex-configuration-profiles";
import { isCodexConfigurationChangeExcludedFromSettingsSynchronization } from "./codex-configuration-settings-isolation";
import {
	type CodexConfigurationSyncStore,
	readCodexConfigurationSyncActiveStore as readCodexConfigurationSyncStore,
	type StoredCodexConfigurationChange,
} from "./codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	resolveVerifiedCodexConfigurationSourceIdentity,
} from "./codex-configuration-writer-binding";
import { codexSourceSharedPluginInstallationIdentityDirectoryPaths } from "./codex-source-shared-plugin-installation-directories";

// 所选提案可能来自已退休 writer；不能把 observe 的活跃集合当作审批的卷资格集合。
export async function prepareCodexConfigurationProposalIdentityVolumeObservations(changeIds: Iterable<string>) {
	const selectedChangeIds = new Set(changeIds);
	const store = await readCodexConfigurationSyncStore({ changeIds: [...selectedChangeIds] });
	const paths = new Set<string>();
	for (const change of store.changes) {
		if (!selectedChangeIds.has(change.changeId)) continue;
		const source = store.sources[change.sourceIdentity];
		if (source) paths.add(source.home);
		const binding = store.writers[change.sourceWriterId]?.binding;
		if (binding)
			for (const path of [
				binding.sourceHomeDirectoryPath,
				binding.conversationStorageHomeDirectoryPath,
				binding.sqliteHomeDirectoryPath,
				...codexSourceSharedPluginInstallationIdentityDirectoryPaths(binding),
			])
				paths.add(path);
	}
	await prepareCodexDirectoryVolumeObservations(paths);
}

export class CodexConfigurationApprovalError extends Error {
	constructor(
		public readonly status: "conflict" | "source_unverifiable" | "not_approvable" | "stale_version",
		message: string,
	) {
		super(message);
	}
}

export function isCodexConfigurationChangeApprovedForPropagation(change: StoredCodexConfigurationChange) {
	return (
		!isCodexConfigurationChangeExcludedFromSettingsSynchronization(change) &&
		change.recordKind !== "source_observation" &&
		(change.approvalStatus === "approved" || change.approvalStatus === "historical") &&
		change.mergeStatus === "shared_default_updated"
	);
}

export function isCodexConfigurationSourceObservationStillCurrent(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	if (change.codexConfigurationProfileId && change.approvalStatus === "approved")
		return (
			(change.acceptedProfileFieldVersion === undefined ||
				(store.profiles[change.codexConfigurationProfileId]?.fieldVersions[change.fieldKey] ?? 0) ===
					change.acceptedProfileFieldVersion) &&
			sameConfigurationField(codexConfigurationChangeSharedFields(store, change)?.[change.fieldKey], change.value)
		);
	const writer = store.writers[change.sourceWriterId];
	const observed = writer?.lastObservedFields ?? store.sources[change.sourceIdentity]?.observedUserFields;
	return Boolean(observed && sameConfigurationField(observed[change.fieldKey], change.value));
}

export async function approveStoredCodexConfigurationProposal(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
	resolveSharedConflict = false,
	expectedSharedValueDigest?: string,
) {
	expireCodexConfigurationProfileFeedbackSuggestions(store);
	if (isCodexConfigurationChangeExcludedFromSettingsSynchronization(change))
		throw new CodexConfigurationApprovalError("not_approvable", "外部配置与本地状态已退出 Kanban 设置审批。");
	if (change.recordKind !== "settings_proposal" || change.approvalStatus !== "pending")
		throw new CodexConfigurationApprovalError("not_approvable", "此记录不是待审批设置提案。");
	const source = store.sources[change.sourceIdentity];
	if (!source) throw new CodexConfigurationApprovalError("source_unverifiable", "配置来源绑定缺失，恢复后可重试。");
	const sourceWriter = store.writers[change.sourceWriterId];
	if (
		change.codexConfigurationProfileId &&
		sourceWriter &&
		sourceWriter.codexConfigurationProfileId !== change.codexConfigurationProfileId
	)
		throw new CodexConfigurationApprovalError("stale_version", "来源会话已改选 profile，旧建议不能更新原 profile。");
	const sharedFields = codexConfigurationChangeSharedFields(store, change) ?? source.fields;
	const shared = sharedFields[change.fieldKey];
	const feedbackFields = { ...(change.relatedFields ?? { [change.fieldKey]: change.value }) };
	for (const fieldKey of change.relatedDeletedFieldKeys ?? []) feedbackFields[fieldKey] = undefined;
	const relatedSharedFieldChanged =
		!resolveSharedConflict &&
		change.codexConfigurationProfileId !== undefined &&
		change.exceptionGroup !== undefined &&
		Object.entries(feedbackFields).some(
			([fieldKey, value]) =>
				fieldKey !== change.fieldKey &&
				!sameConfigurationField(sharedFields[fieldKey], value) &&
				!sameConfigurationField(sharedFields[fieldKey], change.sharedFieldsAtObservation?.[fieldKey]),
		);
	if (
		(expectedSharedValueDigest !== undefined &&
			currentCodexConfigurationSharedValueDigest(store, change) !== expectedSharedValueDigest) ||
		relatedSharedFieldChanged ||
		(!sameConfigurationField(shared, change.value) &&
			(resolveSharedConflict
				? expectedSharedValueDigest !== undefined
					? currentCodexConfigurationSharedValueDigest(store, change) !== expectedSharedValueDigest
					: !sameConfigurationField(shared, change.sharedValueAtConflict)
				: change.mergeStatus === "conflict" || !sameConfigurationField(shared, change.sharedValueAtProposal)))
	) {
		if (change.mergeStatus !== "conflict") {
			change.sharedValueAtConflict = structuredClone(shared);
			captureCodexConfigurationConflictPresentationEvidence(store, change);
		}
		change.mergeStatus = "conflict";
		change.version = ++store.revision;
		throw new CodexConfigurationApprovalError("conflict", "共享默认已变化；双方决定保留，请单独处理冲突。");
	}
	let current: CodexConfigurationFields;
	try {
		await resolveVerifiedCodexConfigurationSourceIdentity(source.home, store, change.sourceIdentity);
		const writer = store.writers[change.sourceWriterId];
		if (writer) await assertCodexConfigurationWriterBindingIdentity(writer.binding);
		current = await projectCodexConfigurationFields({
			home: writer?.binding.configurationHomeDirectoryPath ?? source.home,
			sourceHome: await realpath(source.home),
			fileNames: writer?.fileNames ?? [
				...new Set([
					"config.toml",
					...Object.keys(source.observedUserFields).map((key) => configurationFieldAddress(key).fileName),
				]),
			],
			onHookDefinitionObservationProblem: (fieldKey) => {
				if (fieldKey === change.fieldKey) throw new Error("定义不可核验");
			},
		});
	} catch {
		throw new CodexConfigurationApprovalError(
			"source_unverifiable",
			"来源、writer 或 hook 定义暂不可核验；保留待审批，原归属恢复后可重试。",
		);
	}
	if (!sameConfigurationField(current[change.fieldKey], change.value))
		throw new CodexConfigurationApprovalError(
			"stale_version",
			"检测位置已有较新设置或定义；原提案保留，请刷新后选择。",
		);
	if (change.codexConfigurationProfileId && change.exceptionGroup) {
		if (change.feedbackExpiresAtMs === undefined || Date.now() >= change.feedbackExpiresAtMs) {
			expireCodexConfigurationProfileFeedbackSuggestions(store);
			throw new CodexConfigurationApprovalError("not_approvable", "十分钟反馈机会已结束，局部选择保留。");
		}
		for (const [fieldKey, value] of Object.entries(feedbackFields))
			if (!sameConfigurationField(current[fieldKey], value))
				throw new CodexConfigurationApprovalError("stale_version", "本会话已有更新的完整设置，旧反馈机会已结束。");
		change.approvalStatus = "approved";
		change.mergeStatus = "shared_default_updated";
		change.decidedAt = Date.now();
		change.acknowledgedAt = Date.now();
		updateCodexConfigurationProfileFields(store, change.codexConfigurationProfileId, feedbackFields, {
			sourceWriterId: change.sourceWriterId,
			adoptedFeedbackSuggestion: change,
		});
		return;
	}
	if (change.value === undefined) delete source.fields[change.fieldKey];
	else source.fields[change.fieldKey] = structuredClone(change.value);
	const writer = store.writers[change.sourceWriterId];
	if (writer) {
		if (change.value === undefined) delete writer.mergeBaselineFields[change.fieldKey];
		else writer.mergeBaselineFields[change.fieldKey] = structuredClone(change.value);
	}
	change.mergeStatus = "shared_default_updated";
	change.approvalStatus = "approved";
	change.decidedAt = Date.now();
	change.acknowledgedAt = Date.now();
	change.version = ++store.revision;
	source.fieldChangeIds ??= {};
	source.fieldChangeIds[change.fieldKey] = change.changeId;
	source.version = store.revision;
	if (!writer) {
		// 来源审批仍只更新未来默认，兼容 profile 与来源共用这次已接受的字段版本。
		const profile = ensureCodexConfigurationSourceProfile(store, change.sourceIdentity);
		if (change.value === undefined) delete profile.fields[change.fieldKey];
		else profile.fields[change.fieldKey] = structuredClone(change.value);
		profile.fieldVersions[change.fieldKey] = change.version;
		profile.version = change.version;
	}
}
