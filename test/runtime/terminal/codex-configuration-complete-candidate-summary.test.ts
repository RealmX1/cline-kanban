import { describe, expect, it } from "vitest";
import { completeCodexConfigurationCandidateValueDigest } from "../../../src/codex-configuration-sync/codex-configuration-change-presentation";
import type { StoredCodexConfigurationChange } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";

const approvalKey = JSON.stringify(["config.toml", "approval_policy"]);
const sandboxKey = JSON.stringify(["config.toml", "sandbox_mode"]);
function suggestion(
	fields: Pick<StoredCodexConfigurationChange, "fieldKey" | "value" | "relatedFields" | "relatedDeletedFieldKeys">,
): StoredCodexConfigurationChange {
	return {
		...fields,
		changeId: "candidate",
		sourceWriterId: "writer",
		sourceIdentity: "source",
		version: 1,
		observedAt: 1,
		mergeStatus: "pending_approval",
		acknowledgedAt: null,
		targets: [],
	};
}
describe("完整候选摘要", () => {
	it("完整权限组不依赖变化主字段或对象键顺序，但区分其他权限字段与显式删除", () => {
		const fields = { [approvalKey]: { value: "never" }, [sandboxKey]: { value: "workspace-write" } };
		const first = suggestion({ fieldKey: approvalKey, value: fields[approvalKey], relatedFields: fields });
		const second = suggestion({
			fieldKey: sandboxKey,
			value: fields[sandboxKey],
			relatedFields: { [sandboxKey]: fields[sandboxKey], [approvalKey]: fields[approvalKey] },
		});
		expect(completeCodexConfigurationCandidateValueDigest(first)).toBe(
			completeCodexConfigurationCandidateValueDigest(second),
		);
		expect(
			completeCodexConfigurationCandidateValueDigest({ ...second, value: { value: "danger-full-access" } }),
		).not.toBe(completeCodexConfigurationCandidateValueDigest(first));
		expect(
			completeCodexConfigurationCandidateValueDigest({ ...first, relatedDeletedFieldKeys: [sandboxKey] }),
		).not.toBe(completeCodexConfigurationCandidateValueDigest(first));
	});
	it("摘要使用未截断、未脱敏的值及定义，不按展示文案合并", () => {
		const first = suggestion({
			fieldKey: approvalKey,
			value: { value: { token: "a", description: "x".repeat(400) } },
		});
		const second = { ...first, value: { value: { description: "x".repeat(400), token: "b" } } };
		expect(completeCodexConfigurationCandidateValueDigest(first)).not.toBe(
			completeCodexConfigurationCandidateValueDigest(second),
		);
		expect(
			completeCodexConfigurationCandidateValueDigest({
				...first,
				value: { value: { description: "x".repeat(400), token: "a" } },
			}),
		).toBe(completeCodexConfigurationCandidateValueDigest(first));
		expect(
			completeCodexConfigurationCandidateValueDigest({
				...first,
				value: { value: first.value?.value, definitionDigest: "new-definition" },
			}),
		).not.toBe(completeCodexConfigurationCandidateValueDigest(first));
	});
});
