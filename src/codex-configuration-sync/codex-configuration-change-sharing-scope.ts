import { randomUUID } from "node:crypto";
import type { CodexConfigurationSetChangeSharingScopeRequest } from "../core/codex-configuration-sync-contract";
import {
	type CodexConfigurationFields,
	type CodexConfigurationFieldValue,
	configurationDigest,
	sameConfigurationField,
} from "./codex-configuration-field-projection";
import {
	codexConfigurationExceptionGroup,
	restoreObservedCodexHookTrustDecision,
	updateCodexConfigurationProfileFields,
} from "./codex-configuration-profiles";
import { isCodexConfigurationChangeExcludedFromSettingsSynchronization } from "./codex-configuration-settings-isolation";
import type {
	CodexConfigurationSyncStore,
	StoredCodexConfigurationChange,
	StoredCodexConfigurationWriter,
} from "./codex-configuration-sync-store";

function setLocalFieldOverride(
	writer: StoredCodexConfigurationWriter,
	fieldKey: string,
	value: CodexConfigurationFieldValue | undefined,
	profileVersion: number,
) {
	const group = codexConfigurationExceptionGroup(fieldKey) ?? fieldKey;
	writer.localExceptionOverrides ??= {};
	writer.localExceptionOverrides[group] ??= { profileVersionAtSelection: profileVersion, fields: {} };
	const override = writer.localExceptionOverrides[group];
	override.profileVersionAtSelection = profileVersion;
	if (value === undefined) {
		delete override.fields[fieldKey];
		override.deletedFieldKeys = [...new Set([...(override.deletedFieldKeys ?? []), fieldKey])];
	} else {
		override.fields[fieldKey] = structuredClone(value);
		override.deletedFieldKeys = override.deletedFieldKeys?.filter((key) => key !== fieldKey);
	}
}

function resolveContinuingWriter(
	store: CodexConfigurationSyncStore,
	original: StoredCodexConfigurationWriter,
	nativeSessionId?: string,
) {
	const candidates = Object.values(store.writers).filter(
		(writer) =>
			!writer.retiredAt &&
			writer.binding.workspaceId === original.binding.workspaceId &&
			writer.binding.conversationSessionId === original.binding.conversationSessionId &&
			writer.binding.sourceIdentity === original.binding.sourceIdentity,
	);
	return (
		candidates.find(
			(writer) =>
				writer.binding.writerId === original.binding.writerId &&
				(!nativeSessionId || writer.nativeConversationSessionId === nativeSessionId),
		) ??
		candidates.find(
			(writer) =>
				nativeSessionId &&
				writer.nativeConversationSessionId === nativeSessionId &&
				(() => {
					let parent = writer.previousWriterId;
					const visited = new Set<string>();
					while (parent && !visited.has(parent)) {
						if (parent === original.binding.writerId) return true;
						visited.add(parent);
						parent = store.writers[parent]?.previousWriterId;
					}
					return false;
				})(),
		)
	);
}

function appendProtectedTargetCompensation(
	store: CodexConfigurationSyncStore,
	shared: StoredCodexConfigurationChange,
	target: StoredCodexConfigurationChange["targets"][number],
	state: NonNullable<StoredCodexConfigurationChange["changeSharingScope"]>,
) {
	const before = shared.sharingPropagationSnapshot?.targets[target.writerId];
	const originalTarget = store.writers[target.writerId];
	const writer = originalTarget && resolveContinuingWriter(store, originalTarget, before?.nativeConversationSessionId);
	const profile = store.profiles[shared.codexConfigurationProfileId ?? ""];
	state.conflicts = state.conflicts.filter(
		(conflict) => conflict.writerId !== target.writerId || conflict.fieldKey !== shared.fieldKey,
	);
	if (!before || !writer || !profile) {
		state.conflicts.push({
			writerId: target.writerId,
			fieldKey: shared.fieldKey,
			reason: "目标换代后的同一原生会话继承关系尚不可核验。",
			recoveryCondition: "同一原生会话身份、父 writer 链和原归属恢复后自动重验",
		});
		return;
	}
	const groupChanges = store.changes.filter(
		(entry) =>
			entry.codexConfigurationProfileId === shared.codexConfigurationProfileId &&
			(entry.changeId === shared.changeId ||
				(shared.sharingScopeGroupId && entry.sharingScopeGroupId === shared.sharingScopeGroupId)),
	);
	const expectedGroupMutationVersions = Object.fromEntries(
		groupChanges.map((entry) => [
			entry.fieldKey,
			entry.sharingPropagationSnapshot?.targets[target.writerId]?.localFieldMutationVersion ?? -1,
		]),
	);
	if (
		writer.codexConfigurationProfileId !== profile.profileId ||
		profile.fieldVersions[shared.fieldKey] !== shared.withdrawalProfileFieldVersion ||
		groupChanges.some((entry) => profile.fieldVersions[entry.fieldKey] !== entry.withdrawalProfileFieldVersion) ||
		Object.entries(expectedGroupMutationVersions).some(
			([key, version]) => (writer.localFieldMutationVersions?.[key] ?? 0) !== version,
		)
	) {
		state.conflicts.push({
			writerId: writer.binding.writerId,
			fieldKey: shared.fieldKey,
			reason: "目标已有后续局部修改、默认变化或已改选配置，保留其新决定。",
			recoveryCondition: null,
		});
		target.sharingWithdrawalCompensationPending = false;
		return;
	}
	const compensation: StoredCodexConfigurationChange = {
		changeId: randomUUID(),
		version: ++store.revision,
		sourceWriterId: `profile:${profile.profileId}`,
		sourceIdentity: shared.sourceIdentity,
		codexConfigurationProfileId: profile.profileId,
		acceptedProfileFieldVersion: profile.fieldVersions[shared.fieldKey],
		compensationForChangeId: shared.changeId,
		fieldKey: shared.fieldKey,
		previous: shared.value,
		value: before.value,
		observedAt: Date.now(),
		recordKind: "historical_record",
		approvalStatus: "approved",
		decidedAt: Date.now(),
		acknowledgedAt: Date.now(),
		mergeStatus: "shared_default_updated",
		targetSpecificCompensation: {
			expectedProfileFieldVersions: Object.fromEntries(
				groupChanges.map((entry) => [entry.fieldKey, profile.fieldVersions[entry.fieldKey] ?? 0]),
			),
			expectedLocalFieldMutationVersion: before.localFieldMutationVersion,
			expectedGroupMutationVersions,
			expectedNativeConversationSessionId: before.nativeConversationSessionId,
			expectedTargetValueDigest: configurationDigest(shared.value ?? null),
			previousTargetValueDigest: configurationDigest(before.value ?? null),
		},
		targets: [
			{
				writerId: writer.binding.writerId,
				workspaceId: target.workspaceId,
				conversationSessionId: target.conversationSessionId,
				status: "accepted",
				reason: "等待版本与归属核验后补偿此次传播。",
				attemptCount: 0,
				acceptedAt: Date.now(),
				diskSavedAt: null,
				ownerReloadedAt: null,
				recoveryCondition: "原所有者可达，值与字段归属仍属于原传播时自动恢复",
			},
		],
	};
	store.changes.push(compensation);
	state.compensationChangeIds.push(compensation.changeId);
	target.sharingWithdrawalCompensationPending = false;
	setLocalFieldOverride(writer, shared.fieldKey, before.value, profile.version);
}

export function retainProtectedTargetDecisionAfterRejectedCompensation(
	writer: StoredCodexConfigurationWriter,
	change: StoredCodexConfigurationChange,
	fields: CodexConfigurationFields,
) {
	if (!change.compensationForChangeId) return;
	const group = codexConfigurationExceptionGroup(change.fieldKey) ?? change.fieldKey;
	const local = writer.localExceptionOverrides?.[group];
	if (!local || (!(change.fieldKey in local.fields) && !local.deletedFieldKeys?.includes(change.fieldKey))) return;
	if (!sameConfigurationField(local.fields[change.fieldKey], change.value)) return;
	const current = fields[change.fieldKey];
	if (sameConfigurationField(current, change.value)) return;
	if (current === undefined) {
		delete local.fields[change.fieldKey];
		local.deletedFieldKeys = [...new Set([...(local.deletedFieldKeys ?? []), change.fieldKey])];
	} else {
		local.fields[change.fieldKey] = structuredClone(current);
		local.deletedFieldKeys = local.deletedFieldKeys?.filter((key) => key !== change.fieldKey);
	}
}

export function codexConfigurationPropagationReceiptBelongsToCurrentTarget(input: {
	capturedAcceptedProfileFieldVersion: number | undefined;
	currentAcceptedProfileFieldVersion: number | undefined;
	capturedTargetAcceptedAt: number;
	currentTargetAcceptedAt: number | undefined;
}) {
	return (
		input.currentTargetAcceptedAt === input.capturedTargetAcceptedAt &&
		input.currentAcceptedProfileFieldVersion === input.capturedAcceptedProfileFieldVersion
	);
}

export function codexConfigurationSharingScopeMutationDigest(input: CodexConfigurationSetChangeSharingScopeRequest) {
	return configurationDigest([
		"change_sharing_scope",
		input.changeId,
		input.expectedVersion,
		input.targetScope,
		input.idempotencyKey,
	]);
}

export function resolveCodexConfigurationChangeSourceWriter(
	store: CodexConfigurationSyncStore,
	change: StoredCodexConfigurationChange,
) {
	const original = store.writers[change.sourceWriterId];
	return (
		original &&
		resolveContinuingWriter(
			store,
			original,
			change.sharingPropagationSnapshot?.targets[change.sourceWriterId]?.nativeConversationSessionId ??
				original.nativeConversationSessionId,
		)
	);
}

export function codexConfigurationChangeCompleteFieldsForSharingScope(change: StoredCodexConfigurationChange) {
	const fields = { ...(change.relatedFields ?? {}), [change.fieldKey]: change.value };
	for (const key of change.relatedDeletedFieldKeys ?? []) fields[key] = undefined;
	return fields;
}

export function setStoredCodexConfigurationChangeSharingScope(
	store: CodexConfigurationSyncStore,
	input: CodexConfigurationSetChangeSharingScopeRequest,
	resumingAcceptedRequest = false,
	sourceCurrentFieldsVerified = true,
) {
	const requestDigest = codexConfigurationSharingScopeMutationDigest(input);
	const receipt = store.mutationReceipts[input.idempotencyKey];
	if (resumingAcceptedRequest && !receipt) throw new Error("原范围请求缺少持久受理回执，未自动执行。");
	if (receipt) {
		if (receipt.requestDigest !== requestDigest) throw new Error("幂等键已用于另一配置范围操作。");
		if (!resumingAcceptedRequest) return;
	}
	const change = store.changes.find((entry) => entry.changeId === input.changeId);
	if (!change || (!resumingAcceptedRequest && change.version !== input.expectedVersion))
		throw new Error("配置变更版本已变化，请刷新后切换本次范围。");
	if (
		!change.codexConfigurationProfileId ||
		isCodexConfigurationChangeExcludedFromSettingsSynchronization(change) ||
		change.recordKind === "source_observation" ||
		change.compensationForChangeId
	)
		throw new Error("此记录不属于可切换范围的会话配置变更。");
	const currentScope =
		change.changeSharingScope?.currentScope ?? (change.approvalStatus === "approved" ? "profile" : "session_only");
	if (change.pendingSharingScopeMutation && input.targetScope === currentScope) {
		change.changeSharingScope = change.pendingSharingScopeMutationPreviousState ?? {
			currentScope,
			requestedScope: currentScope,
			withdrawalStatus: "not_requested",
			compensationChangeIds: [],
			conflicts: [],
		};
		delete change.pendingSharingScopeMutation;
		delete change.pendingSharingScopeMutationPreviousState;
		change.version = ++store.revision;
		store.mutationReceipts[input.idempotencyKey] = { requestDigest, changeId: change.changeId };
		return;
	}
	const profile = store.profiles[change.codexConfigurationProfileId];
	const source = resolveCodexConfigurationChangeSourceWriter(store, change);
	if (!profile) throw new Error("配置方案已不存在，原请求不能再改变默认。");
	if (!source || !sourceCurrentFieldsVerified) {
		change.pendingSharingScopeMutationPreviousState ??= structuredClone(change.changeSharingScope);
		change.pendingSharingScopeMutation = input;
		change.changeSharingScope = {
			currentScope:
				change.changeSharingScope?.currentScope ??
				(change.approvalStatus === "approved" ? "profile" : "session_only"),
			requestedScope: input.targetScope,
			withdrawalStatus: "pending",
			compensationChangeIds: change.changeSharingScope?.compensationChangeIds ?? [],
			conflicts: [
				{
					fieldKey: change.fieldKey,
					reason: "来源会话继承关系或完整配置值尚不可核验，保留原进程和默认。",
					recoveryCondition: "同一原生会话身份、父 writer 链和原归属恢复后自动重验；同一证据最多三次",
				},
			],
		};
		change.version = ++store.revision;
		store.mutationReceipts[input.idempotencyKey] = { requestDigest, changeId: change.changeId };
		return;
	}
	if (source.codexConfigurationProfileId !== profile.profileId)
		throw new Error("来源已有较新修改，已改选其他配置方案。");
	const fields = codexConfigurationChangeCompleteFieldsForSharingScope(change);
	const observedMutationVersions = change.sourceFieldMutationVersionsAtObservation;
	for (const [fieldKey, value] of Object.entries(fields))
		if (
			!sameConfigurationField(source.lastObservedFields[fieldKey], value) ||
			(observedMutationVersions !== undefined &&
				(source.localFieldMutationVersions?.[fieldKey] ?? 0) !== (observedMutationVersions[fieldKey] ?? 0))
		)
			throw new Error("来源已有较新修改，不能把旧变更作为本次完整值共享或保留。");
	change.sharingScopeDecisionHistory ??= [];
	change.sharingScopeDecisionHistory.push({
		requestedScope: input.targetScope,
		recordedAtMs: Date.now(),
		priorAcceptedChange: structuredClone({
			acceptedProfileFieldVersion: change.acceptedProfileFieldVersion,
			sharingPropagationSnapshot: change.sharingPropagationSnapshot,
			targets: change.targets,
			changeSharingScope: change.changeSharingScope,
			sourceWriterId: change.sourceWriterId,
		}),
	});
	if (currentScope !== input.targetScope) {
		delete change.noticePresentedAtMs;
		if (input.targetScope === "profile") {
			const priorState = change.changeSharingScope;
			updateCodexConfigurationProfileFields(store, profile.profileId, fields, {
				sourceWriterId: source.binding.writerId,
				adoptedFeedbackSuggestion: change,
				recordIdenticalFields: true,
			});
			change.changeSharingScope = {
				currentScope: "profile",
				requestedScope: "profile",
				withdrawalStatus: "not_requested",
				compensationChangeIds: priorState?.compensationChangeIds ?? [],
				conflicts: [],
			};
		} else {
			const group = store.changes.filter(
				(entry) =>
					entry.changeId === change.changeId ||
					(change.sharingScopeGroupId && entry.sharingScopeGroupId === change.sharingScopeGroupId),
			);
			const state: NonNullable<StoredCodexConfigurationChange["changeSharingScope"]> = {
				currentScope: "session_only",
				requestedScope: "session_only",
				withdrawalStatus: "pending",
				compensationChangeIds: [],
				conflicts: [],
			};
			const profileDecisionMoved = (entry: StoredCodexConfigurationChange) => {
				const entryProfile = store.profiles[entry.codexConfigurationProfileId ?? ""];
				return (
					!entry.sharingPropagationSnapshot ||
					!entryProfile ||
					entryProfile.fieldVersions[entry.fieldKey] !== entry.acceptedProfileFieldVersion
				);
			};
			const queueTaskLocalPermissionSelection = (writer: StoredCodexConfigurationWriter) => {
				if (
					writer.taskPermissionSelectionSourceAtLaunch !== "task_local" ||
					!writer.binding.workspaceId ||
					!writer.binding.conversationSessionId ||
					!writer.codexConfigurationProfileId
				)
					return;
				writer.pendingSessionProfileBinding = {
					workspaceId: writer.binding.workspaceId,
					conversationSessionId: writer.binding.conversationSessionId,
					profileId: writer.codexConfigurationProfileId,
					onlyUpdatePermissionSelectionSource: true,
					permissionSelectionSource: "task_local",
				};
			};
			const profilesWithNewerDecisions = new Set(
				group
					.filter((entry) => profileDecisionMoved(entry))
					.map((entry) => entry.codexConfigurationProfileId ?? ""),
			);
			for (const shared of group) {
				const snapshot = shared.sharingPropagationSnapshot;
				const sharedProfile = store.profiles[shared.codexConfigurationProfileId ?? ""] ?? profile;
				const siblingsMoved = profilesWithNewerDecisions.has(shared.codexConfigurationProfileId ?? "");
				if (siblingsMoved || !snapshot) {
					state.conflicts.push({
						fieldKey: shared.fieldKey,
						reason: snapshot
							? "配置方案已有后续决定，保留较新版本，未回退。"
							: "旧共享记录缺少传播前快照，保留未知。",
						recoveryCondition: snapshot ? null : "原传播前的值、版本及归属快照恢复后重验",
					});
					shared.changeSharingScope = state;
					for (const target of shared.targets)
						if (["accepted", "pending_reload", "pending_next_start"].includes(target.status)) {
							target.status = "not_applicable";
							target.reason = "原共享已撤回；后续新决定受保护。";
							target.recoveryCondition = null;
						}
					continue;
				}
				updateCodexConfigurationProfileFields(
					store,
					sharedProfile.profileId,
					{ [shared.fieldKey]: snapshot.profileValue },
					{
						propagate: false,
						preserveLocalOverrides: true,
						compensationForChangeId: shared.changeId,
						recordIdenticalFields: true,
					},
				);
				const profileCompensation = store.changes.at(-1);
				if (!profileCompensation) throw new Error("共享默认补偿记录尚未登记，未提交此次撤回。");
				restoreObservedCodexHookTrustDecision(store, shared.sourceIdentity, shared.fieldKey, snapshot.profileValue);
				shared.withdrawalProfileFieldVersion = sharedProfile.fieldVersions[shared.fieldKey];
				state.compensationChangeIds.push(profileCompensation.changeId);
				for (const target of shared.targets) {
					const submitted =
						target.writeSubmissionStartedAt !== undefined ||
						target.diskSavedAt !== null ||
						target.appliedAtStartupByWriterId !== undefined;
					target.status =
						target.writeSubmissionStartedAt && !target.writeSubmissionFinishedAtMs
							? "pending_reload"
							: "not_applicable";
					target.sharingWithdrawalRequestedAtMs = Date.now();
					target.reason = "此次共享已撤回，尚未执行的传播已取消；历史保存事实保留。";
					target.recoveryCondition = null;
					if (submitted) target.sharingWithdrawalCompensationPending = true;
					else {
						const originalTarget = store.writers[target.writerId];
						const continuing =
							originalTarget &&
							resolveContinuingWriter(
								store,
								originalTarget,
								snapshot.targets[target.writerId]?.nativeConversationSessionId,
							);
						const before = snapshot.targets[target.writerId];
						if (
							continuing &&
							before?.localExceptionOverride &&
							(continuing.localFieldMutationVersions?.[shared.fieldKey] ?? 0) ===
								before.localFieldMutationVersion
						) {
							const groupKey = codexConfigurationExceptionGroup(shared.fieldKey) ?? shared.fieldKey;
							continuing.localExceptionOverrides ??= {};
							continuing.localExceptionOverrides[groupKey] = {
								...structuredClone(before.localExceptionOverride),
								profileVersionAtSelection: sharedProfile.version,
							};
							if (groupKey === "permissions") queueTaskLocalPermissionSelection(continuing);
						}
					}
				}
				shared.version = ++store.revision;
				shared.changeSharingScope = state;
			}
			for (const [fieldKey, value] of Object.entries(fields))
				setLocalFieldOverride(source, fieldKey, value, profile.version);
			if (Object.keys(fields).some((fieldKey) => codexConfigurationExceptionGroup(fieldKey) === "permissions"))
				queueTaskLocalPermissionSelection(source);
			for (const shared of group)
				for (const target of shared.targets)
					if (target.sharingWithdrawalCompensationPending)
						appendProtectedTargetCompensation(store, shared, target, state);
			for (const id of state.compensationChangeIds) {
				const compensation = store.changes.find((entry) => entry.changeId === id);
				const compensationProfile = store.profiles[compensation?.codexConfigurationProfileId ?? ""];
				if (compensation?.targetSpecificCompensation && compensationProfile)
					compensation.targetSpecificCompensation.expectedProfileFieldVersions = Object.fromEntries(
						group
							.filter((entry) => entry.codexConfigurationProfileId === compensation.codexConfigurationProfileId)
							.map((entry) => [entry.fieldKey, compensationProfile.fieldVersions[entry.fieldKey] ?? 0]),
					);
			}
			state.withdrawalStatus = state.conflicts.some((conflict) => conflict.recoveryCondition)
				? "pending"
				: state.conflicts.length
					? "protected_conflicts"
					: state.compensationChangeIds.some(
								(id) => store.changes.find((entry) => entry.changeId === id)?.targets.length,
							)
						? "pending"
						: "completed";
			change.changeSharingScope = state;
		}
	}
	if (input.targetScope === "session_only" && change.approvalStatus === "pending") {
		change.approvalStatus = "rejected";
		change.decidedAt = Date.now();
		change.acknowledgedAt = Date.now();
	}
	change.version = ++store.revision;
	delete change.pendingSharingScopeMutation;
	delete change.pendingSharingScopeMutationPreviousState;
	store.mutationReceipts[input.idempotencyKey] = { requestDigest, changeId: change.changeId };
}

export async function resumeStoredCodexConfigurationChangeSharingScopeMutations(
	store: CodexConfigurationSyncStore,
	verifySource?: (store: CodexConfigurationSyncStore, change: StoredCodexConfigurationChange) => Promise<boolean>,
) {
	for (const change of store.changes) {
		const request = change.pendingSharingScopeMutation;
		if (!request) continue;
		const original = store.writers[change.sourceWriterId];
		const fingerprint = configurationDigest([
			store.observationProblem,
			store.profiles[change.codexConfigurationProfileId ?? ""]?.version,
			Object.values(store.writers)
				.filter(
					(writer) =>
						writer.binding.workspaceId === original?.binding.workspaceId &&
						writer.binding.conversationSessionId === original?.binding.conversationSessionId,
				)
				.map((writer) => [
					writer.binding.writerId,
					writer.nativeConversationSessionId,
					writer.retiredAt,
					writer.previousWriterId,
					writer.codexConfigurationProfileId,
					writer.localFieldMutationVersions,
				]),
		]);
		if (
			change.sharingScopeRecoveryEvidenceFingerprint === fingerprint &&
			(change.sharingScopeRecoveryAttemptCount ?? 0) >= 3
		)
			continue;
		change.sharingScopeRecoveryAttemptCount =
			change.sharingScopeRecoveryEvidenceFingerprint === fingerprint
				? (change.sharingScopeRecoveryAttemptCount ?? 0) + 1
				: 1;
		change.sharingScopeRecoveryEvidenceFingerprint = fingerprint;
		try {
			setStoredCodexConfigurationChangeSharingScope(
				store,
				request,
				true,
				verifySource ? await verifySource(store, change) : true,
			);
		} catch (error) {
			if (change.changeSharingScope) {
				change.changeSharingScope.withdrawalStatus = "protected_conflicts";
				change.changeSharingScope.conflicts = [
					{
						fieldKey: change.fieldKey,
						reason: error instanceof Error ? error.message : "原范围请求已被后续决定保护。",
						recoveryCondition: null,
					},
				];
			}
			delete change.pendingSharingScopeMutation;
			change.version = ++store.revision;
		}
	}
}

export function reconcileCodexConfigurationSharingScopeWithdrawals(store: CodexConfigurationSyncStore) {
	const unsettledWriteRecoveryCondition = "原传播回执恢复，或同一原生会话的新 writer 已核验补偿配置";
	const visitedGroups = new Set<string>();
	for (const change of store.changes) {
		const state = change.changeSharingScope;
		if (state?.withdrawalStatus !== "pending" || change.pendingSharingScopeMutation) continue;
		const groupKey = change.sharingScopeGroupId ?? change.changeId;
		if (visitedGroups.has(groupKey)) continue;
		visitedGroups.add(groupKey);
		const siblings = store.changes.filter(
			(entry) =>
				entry.changeId === change.changeId ||
				(change.sharingScopeGroupId && entry.sharingScopeGroupId === change.sharingScopeGroupId),
		);
		const previousStates = new Map(
			siblings.map((entry) => [entry.changeId, configurationDigest(entry.changeSharingScope)]),
		);
		for (const sibling of siblings) sibling.changeSharingScope = state;
		try {
			state.conflicts = state.conflicts.filter(
				(conflict) => conflict.recoveryCondition !== unsettledWriteRecoveryCondition,
			);
			for (const shared of [...store.changes]) {
				if (
					shared.changeId !== change.changeId &&
					(!change.sharingScopeGroupId || shared.sharingScopeGroupId !== change.sharingScopeGroupId)
				)
					continue;
				for (const target of shared.targets)
					if (target.sharingWithdrawalCompensationPending)
						appendProtectedTargetCompensation(store, shared, target, state);
			}
			for (const shared of siblings)
				for (const target of shared.targets) {
					if (
						!target.sharingWithdrawalRequestedAtMs ||
						!target.writeSubmissionStartedAt ||
						target.writeSubmissionFinishedAtMs
					)
						continue;
					const adoptedByReplacement = store.changes.some(
						(compensation) =>
							compensation.compensationForChangeId === shared.changeId &&
							compensation.fieldKey === shared.fieldKey &&
							compensation.targets.some(
								(adopted) =>
									adopted.workspaceId === target.workspaceId &&
									adopted.conversationSessionId === target.conversationSessionId &&
									adopted.status === "applied" &&
									adopted.appliedAtStartupByWriterId &&
									adopted.appliedAtStartupByWriterId !== target.writerId,
							),
					);
					if (!adoptedByReplacement)
						state.conflicts.push({
							writerId: target.writerId,
							fieldKey: shared.fieldKey,
							reason: "原传播可能已经提交，尚未取得结束回执；保留原失败历史，不宣称撤回完成。",
							recoveryCondition: unsettledWriteRecoveryCondition,
						});
				}
			if (state.conflicts.some((conflict) => conflict.recoveryCondition)) {
				continue;
			}
			const compensations = state.compensationChangeIds.map((id) =>
				store.changes.find((entry) => entry.changeId === id),
			);
			if (compensations.some((entry) => !entry)) continue;
			const targets = compensations.flatMap((entry) => entry?.targets ?? []);
			const conflicted = targets.filter((target) => target.status === "conflict");
			if (conflicted.length || state.conflicts.length) {
				state.withdrawalStatus = "protected_conflicts";
				for (const target of conflicted)
					state.conflicts.push({
						writerId: target.writerId,
						fieldKey: change.fieldKey,
						reason: target.reason,
						recoveryCondition: target.recoveryCondition,
					});
			} else if (targets.every((target) => target.status === "applied" || target.status === "not_applicable"))
				state.withdrawalStatus = "completed";
			else continue;
		} finally {
			for (const sibling of siblings)
				if (previousStates.get(sibling.changeId) !== configurationDigest(state)) sibling.version = ++store.revision;
		}
	}
}
