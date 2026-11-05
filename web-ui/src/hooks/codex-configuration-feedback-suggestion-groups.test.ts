import { describe, expect, it } from "vitest";
import { groupCodexConfigurationFeedbackSuggestions } from "@/hooks/codex-configuration-feedback-suggestion-groups";
import type { CodexConfigurationChange } from "@/runtime/types";

function candidate(
	changeId: string,
	profileId = "profile-a",
	candidateValueDigest = "complete-value-b",
): CodexConfigurationChange {
	return {
		changeId,
		version: 1,
		sourceWriterId: changeId,
		sourceConversationSessionId: changeId,
		sourceWorkspaceId: "workspace",
		fieldKey: '["config.toml","model"]',
		fieldLabel: "model",
		previousValueSummary: "A",
		valueSummary: "相同脱敏文案",
		observedAt: 1,
		recordKind: "settings_proposal",
		approvalStatus: "pending",
		decidedAt: null,
		settingDifferences: [],
		mergeStatus: "pending_approval",
		acknowledgedAt: null,
		eligibleTargetCount: 0,
		targets: [],
		candidateFieldGroupKey: `${profileId}:model`,
		codexConfigurationProfileId: profileId,
		completeCandidateValueDigest: candidateValueDigest,
	};
}

describe("配置候选按完整摘要归并", () => {
	it("同值合并来源、异值并列、不同 profile 隔离，旧服务端文案相同也不猜测合并", () => {
		const groups = groupCodexConfigurationFeedbackSuggestions([
			candidate("a"),
			candidate("b"),
			candidate("c", "profile-a", "complete-value-c"),
			candidate("d", "profile-b"),
			{ ...candidate("legacy"), completeCandidateValueDigest: undefined },
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0]?.candidates.map((group) => group.members.map((change) => change.changeId))).toEqual([
			["a", "b"],
			["c"],
			["legacy"],
		]);
		expect(groups[1]?.members.map((change) => change.changeId)).toEqual(["d"]);
	});
	it("过期、被替代和归档的来源退出当前候选，保留的成员继续绑定其原始版本", () => {
		const groups = groupCodexConfigurationFeedbackSuggestions(
			[
				{ ...candidate("expired"), feedbackExpiresAtMs: 10 },
				{ ...candidate("superseded"), approvalStatus: "historical" },
				{ ...candidate("archived"), settingsIsolationArchivedAtMs: 5 },
				{ ...candidate("current"), version: 9, feedbackExpiresAtMs: 11 },
			],
			10,
		);
		expect(groups[0]?.members.map((change) => [change.changeId, change.version])).toEqual([["current", 9]]);
	});
	it("完整权限组由服务端分组键归并，不受触发变化主字段不同的影响", () => {
		const first = {
			...candidate("approval-change"),
			candidateFieldGroupKey: "profile-a:permissions",
			exceptionGroup: "permissions" as const,
		};
		const second = { ...first, changeId: "sandbox-change", fieldKey: '["config.toml","sandbox_mode"]' };
		expect(groupCodexConfigurationFeedbackSuggestions([first, second])[0]?.candidates[0]?.members).toEqual([
			first,
			second,
		]);
	});
});
