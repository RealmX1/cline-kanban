import type { CodexConfigurationChange } from "@/runtime/types";

export interface CodexConfigurationCandidateValueGroup {
	candidateValueDigest: string;
	members: CodexConfigurationChange[];
}
export interface CodexConfigurationFeedbackSuggestionGroup {
	fieldGroupKey: string;
	members: CodexConfigurationChange[];
	candidates: CodexConfigurationCandidateValueGroup[];
}

export function groupCodexConfigurationFeedbackSuggestions(changes: CodexConfigurationChange[], nowMs = Date.now()) {
	const groups = new Map<string, CodexConfigurationFeedbackSuggestionGroup>();
	for (const change of changes) {
		if (
			change.recordKind !== "settings_proposal" ||
			change.approvalStatus !== "pending" ||
			change.settingsIsolationArchivedAtMs !== undefined ||
			(change.feedbackExpiresAtMs !== undefined && change.feedbackExpiresAtMs <= nowMs)
		)
			continue;
		const fieldGroupKey =
			change.candidateFieldGroupKey ??
			JSON.stringify([
				change.codexConfigurationProfileId,
				change.exceptionGroup ?? change.fieldKey ?? change.changeId,
			]);
		let group = groups.get(fieldGroupKey);
		if (!group) {
			group = { fieldGroupKey, members: [], candidates: [] };
			groups.set(fieldGroupKey, group);
		}
		group.members.push(change);
		// 旧服务端缺少完整摘要时逐项保留，不能按截断或脱敏文案猜测相等。
		const candidateValueDigest = change.completeCandidateValueDigest ?? `unknown:${change.changeId}`;
		let candidate = group.candidates.find((entry) => entry.candidateValueDigest === candidateValueDigest);
		if (!candidate) {
			candidate = { candidateValueDigest, members: [] };
			group.candidates.push(candidate);
		}
		candidate.members.push(change);
	}
	return [...groups.values()];
}
