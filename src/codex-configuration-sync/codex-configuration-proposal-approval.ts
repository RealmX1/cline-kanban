import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { prepareCodexDirectoryVolumeObservations } from "../codex-conversation-storage/codex-persistent-directory-identity";
import {
	type CodexConfigurationFields,
	configurationFieldAddress,
	projectCodexConfigurationFields,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import {
	type CodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
	type StoredCodexConfigurationChange,
} from "./codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	resolveVerifiedCodexConfigurationSourceIdentity,
} from "./codex-configuration-writer-binding";

// 所选提案可能来自已退休 writer；不能把 observe 的活跃集合当作审批的卷资格集合。
export async function prepareCodexConfigurationProposalIdentityVolumeObservations(changeIds: Iterable<string>) {
	const store = await readCodexConfigurationSyncStore();
	const selectedChangeIds = new Set(changeIds);
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
		change.recordKind !== "source_observation" &&
		(change.approvalStatus === "approved" || change.approvalStatus === "historical") &&
		change.mergeStatus === "shared_default_updated"
	);
}

export function isCodexConfigurationSourceObservationStillCurrent(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	const writer = store.writers[change.sourceWriterId];
	const observed = writer?.lastObservedFields ?? store.sources[change.sourceIdentity]?.observedUserFields;
	return Boolean(observed && sameConfigurationField(observed[change.fieldKey], change.value));
}

export async function approveStoredCodexConfigurationProposal(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
	resolveSharedConflict = false,
) {
	if (change.recordKind !== "settings_proposal" || change.approvalStatus !== "pending")
		throw new CodexConfigurationApprovalError("not_approvable", "此记录不是待审批设置提案。");
	const source = store.sources[change.sourceIdentity];
	if (!source) throw new CodexConfigurationApprovalError("source_unverifiable", "配置来源绑定缺失，恢复后可重试。");
	const shared = source.fields[change.fieldKey];
	if (
		!sameConfigurationField(shared, change.value) &&
		(resolveSharedConflict
			? !sameConfigurationField(shared, change.sharedValueAtConflict)
			: change.mergeStatus === "conflict" || !sameConfigurationField(shared, change.sharedValueAtProposal))
	) {
		change.mergeStatus = "conflict";
		change.sharedValueAtConflict = shared;
		change.version = ++store.revision;
		throw new CodexConfigurationApprovalError("conflict", "共享默认已变化；双方决定保留，请单独处理冲突。");
	}
	let current: CodexConfigurationFields;
	try {
		await resolveVerifiedCodexConfigurationSourceIdentity(source.home, store, change.sourceIdentity);
		if (!(await lstat(join(source.home, "config.toml"))).isFile()) throw new Error("来源身份或配置不可核验");
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
	source.version = store.revision;
}
