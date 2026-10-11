import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE } from "./utilities/load-sensitive-wall-clock-two-tier-deadline";
import {
	collectLoadSensitiveSoftDeadlineWarningsFromTestModules,
	formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines,
	type LoadSensitiveSoftDeadlineWarningForEndOfRunSummary,
	type TestCaseFieldsReadBySoftDeadlineSummary,
} from "./vitest-reporter-load-sensitive-soft-deadline-exceeded-end-of-run-summary";

const FAKE_REPOSITORY_ROOT_DIRECTORY_PATH = "/fake-repository-root";

function createFakeTestCase(input: {
	fullName: string;
	state: "passed" | "failed";
	annotations: Array<{ type: string; message: string }>;
}): TestCaseFieldsReadBySoftDeadlineSummary {
	return {
		fullName: input.fullName,
		result: () => ({ state: input.state }),
		annotations: () => input.annotations,
	};
}

function createSoftDeadlineWarnings(input: {
	count: number;
	testCaseFailed: boolean;
}): LoadSensitiveSoftDeadlineWarningForEndOfRunSummary[] {
	return Array.from({ length: input.count }, (_, index) => ({
		relativeTestModulePath: "test/integration/example.integration.test.ts",
		fullTestName: `${input.testCaseFailed ? "failed" : "passed"} case ${index + 1}`,
		testCaseFailed: input.testCaseFailed,
		annotationMessage: `等待对象 ${index + 1}：实测 3000ms，软档 2000ms / 硬档 8000ms`,
	}));
}

describe("load sensitive soft deadline exceeded end-of-run summary reporter", () => {
	it("只收集目标类型的 annotation，并区分用例是否失败", () => {
		const warnings = collectLoadSensitiveSoftDeadlineWarningsFromTestModules(
			[
				{
					moduleId: join(FAKE_REPOSITORY_ROOT_DIRECTORY_PATH, "test/integration/a.integration.test.ts"),
					children: {
						allTests: () => [
							createFakeTestCase({
								fullName: "suite > slow but passed",
								state: "passed",
								annotations: [
									{ type: LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE, message: "慢但通过" },
									{ type: "notice", message: "无关 annotation" },
								],
							}),
							createFakeTestCase({
								fullName: "suite > hard deadline failed",
								state: "failed",
								annotations: [
									{ type: LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE, message: "超过硬档" },
								],
							}),
							createFakeTestCase({ fullName: "suite > quiet", state: "passed", annotations: [] }),
						],
					},
				},
			],
			FAKE_REPOSITORY_ROOT_DIRECTORY_PATH,
		);

		expect(warnings).toEqual([
			{
				relativeTestModulePath: "test/integration/a.integration.test.ts",
				fullTestName: "suite > slow but passed",
				testCaseFailed: false,
				annotationMessage: "慢但通过",
			},
			{
				relativeTestModulePath: "test/integration/a.integration.test.ts",
				fullTestName: "suite > hard deadline failed",
				testCaseFailed: true,
				annotationMessage: "超过硬档",
			},
		]);
	});

	it("没有告警时不输出任何行", () => {
		expect(formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines([])).toEqual([]);
	});

	it("分「通过但超过软档」与「失败用例此前的软档告警」两段输出", () => {
		const summaryLines = formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines([
			...createSoftDeadlineWarnings({ count: 1, testCaseFailed: false }),
			...createSoftDeadlineWarnings({ count: 1, testCaseFailed: true }),
		]);

		expect(summaryLines).toEqual([
			"[负载敏感软档告警] 共 2 条：通过但超过软档 1 条，失败用例此前的软档告警 1 条（判定规则见 test/README.md）",
			"通过但超过软档：",
			"  - test/integration/example.integration.test.ts › passed case 1 — 等待对象 1：实测 3000ms，软档 2000ms / 硬档 8000ms",
			"失败用例此前的软档告警：",
			"  - test/integration/example.integration.test.ts › failed case 1 — 等待对象 1：实测 3000ms，软档 2000ms / 硬档 8000ms",
		]);
	});

	it("告警很多时总行数封顶 20，并注明未列出的条数", () => {
		const summaryLines = formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines([
			...createSoftDeadlineWarnings({ count: 30, testCaseFailed: false }),
			...createSoftDeadlineWarnings({ count: 5, testCaseFailed: true }),
		]);

		expect(summaryLines).toHaveLength(20);
		// 标题 + 段标题 + 17 条 + 未列出说明。
		expect(summaryLines.at(-1)).toBe("  （另有 18 条未列出）");
		expect(summaryLines).not.toContain("失败用例此前的软档告警：");
	});
});
