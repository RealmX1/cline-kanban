import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePostDeployVerificationDoneEntryClosureFromCliOptions } from "../../../src/commands/post-deploy-verification-unchecked-item-closure-reason-cli-options";
import { createTempDir } from "../../utilities/temp-dir";

describe("CLI 带原因结案参数解析", () => {
	let sandbox: ReturnType<typeof createTempDir>;

	beforeEach(() => {
		sandbox = createTempDir("kanban-closure-reason-cli-options-");
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	it("三个参数都没给时返回 undefined（全勾或不受门禁的任务不需要原因）", async () => {
		expect(await parsePostDeployVerificationDoneEntryClosureFromCliOptions({}, sandbox.path)).toBeUndefined();
	});

	it("统一原因套用到其余未勾项；自定义原因必须带文本；未知原因码拒绝", async () => {
		expect(
			await parsePostDeployVerificationDoneEntryClosureFromCliOptions(
				{ closureReasonForAllUncheckedItems: "assertion_already_covered_by_other_verification_evidence" },
				sandbox.path,
			),
		).toEqual({
			closureReasonAppliedToRemainingUncheckedChecklistItems: {
				uncheckedChecklistItemClosureReasonCode: "assertion_already_covered_by_other_verification_evidence",
			},
		});
		await expect(
			parsePostDeployVerificationDoneEntryClosureFromCliOptions(
				{ closureReasonForAllUncheckedItems: "custom_reason_described_in_reason_text" },
				sandbox.path,
			),
		).rejects.toThrow("--closure-reason-text");
		await expect(
			parsePostDeployVerificationDoneEntryClosureFromCliOptions(
				{ closureReasonForAllUncheckedItems: "because-i-said-so" },
				sandbox.path,
			),
		).rejects.toThrow("Invalid --closure-reason-for-all-unchecked-items");
		await expect(
			parsePostDeployVerificationDoneEntryClosureFromCliOptions(
				{ closureReasonText: "孤立的原因文本" },
				sandbox.path,
			),
		).rejects.toThrow("--closure-reason-text requires");
	});

	it("原因文件可以是逐项数组，也可以与统一原因同时给", async () => {
		const reasonsFilePath = join(sandbox.path, "reasons.json");
		writeFileSync(
			reasonsFilePath,
			JSON.stringify([
				{
					checklistItemId: "authored:a",
					uncheckedChecklistItemClosureReasonCode:
						"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
				},
			]),
			"utf8",
		);
		expect(
			await parsePostDeployVerificationDoneEntryClosureFromCliOptions(
				{
					closureReasonsFile: "reasons.json",
					closureReasonForAllUncheckedItems: "custom_reason_described_in_reason_text",
					closureReasonText: "其余项由 RVF 端到端测试覆盖",
				},
				sandbox.path,
			),
		).toEqual({
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "authored:a",
					uncheckedChecklistItemClosureReasonCode:
						"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
				},
			],
			closureReasonAppliedToRemainingUncheckedChecklistItems: {
				uncheckedChecklistItemClosureReasonCode: "custom_reason_described_in_reason_text",
				uncheckedChecklistItemClosureReasonText: "其余项由 RVF 端到端测试覆盖",
			},
		});
	});
});
