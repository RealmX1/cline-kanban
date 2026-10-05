// 在测试运行末尾把「负载敏感软档告警」汇总成一个短块，打到 stdout 尾部。
// 软档告警本身不判失败，散落在各用例里容易被忽略；RVF 只截取失败输出的末尾 60 行，所以总行数封顶 20。
// 注意：命令行传 `--reporter` 会整体替换 vitest.config.ts 里的 reporters，这个汇总块随之消失。
import { relative } from "node:path";

import type { Reporter, TestModule } from "vitest/node";

import { LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE } from "./utilities/load-sensitive-wall-clock-two-tier-deadline";

export const LOAD_SENSITIVE_SOFT_DEADLINE_SUMMARY_MAXIMUM_LINE_COUNT = 20;

// 只取汇总需要的字段，单测可以直接构造；vitest 的 TestModule / TestCase 天然满足。
export interface TestCaseFieldsReadBySoftDeadlineSummary {
	fullName: string;
	result(): { state: string };
	annotations(): ReadonlyArray<{ type: string; message: string }>;
}

export interface TestModuleFieldsReadBySoftDeadlineSummary {
	moduleId: string;
	children: { allTests(): Iterable<TestCaseFieldsReadBySoftDeadlineSummary> };
}

export interface LoadSensitiveSoftDeadlineWarningForEndOfRunSummary {
	relativeTestModulePath: string;
	fullTestName: string;
	testCaseFailed: boolean;
	annotationMessage: string;
}

export function collectLoadSensitiveSoftDeadlineWarningsFromTestModules(
	testModules: ReadonlyArray<TestModuleFieldsReadBySoftDeadlineSummary>,
	repositoryRootDirectoryPath: string,
): LoadSensitiveSoftDeadlineWarningForEndOfRunSummary[] {
	const warnings: LoadSensitiveSoftDeadlineWarningForEndOfRunSummary[] = [];
	for (const testModule of testModules) {
		for (const testCase of testModule.children.allTests()) {
			for (const annotation of testCase.annotations()) {
				if (annotation.type !== LOAD_SENSITIVE_SOFT_DEADLINE_EXCEEDED_ANNOTATION_TYPE) {
					continue;
				}
				warnings.push({
					relativeTestModulePath: relative(repositoryRootDirectoryPath, testModule.moduleId),
					fullTestName: testCase.fullName,
					testCaseFailed: testCase.result().state === "failed",
					annotationMessage: annotation.message,
				});
			}
		}
	}
	return warnings;
}

function formatSoftDeadlineWarningLine(warning: LoadSensitiveSoftDeadlineWarningForEndOfRunSummary): string {
	return `  - ${warning.relativeTestModulePath} › ${warning.fullTestName} — ${warning.annotationMessage}`;
}

// 分两段：「通过但超过软档」与「失败用例此前的软档告警」——后者已经判了失败，不能统称「未判失败」。
export function formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines(
	warnings: ReadonlyArray<LoadSensitiveSoftDeadlineWarningForEndOfRunSummary>,
	maximumLineCount = LOAD_SENSITIVE_SOFT_DEADLINE_SUMMARY_MAXIMUM_LINE_COUNT,
): string[] {
	if (warnings.length === 0) {
		return [];
	}
	const warningsOnPassedTestCases = warnings.filter((warning) => !warning.testCaseFailed);
	const warningsOnFailedTestCases = warnings.filter((warning) => warning.testCaseFailed);
	const summaryLines = [
		`[负载敏感软档告警] 共 ${warnings.length} 条：通过但超过软档 ${warningsOnPassedTestCases.length} 条，失败用例此前的软档告警 ${warningsOnFailedTestCases.length} 条（判定规则见 test/README.md）`,
	];
	// 标题行之外再预留一行给「另有 N 条未列出」。失败用例的告警在 reporter 的错误块里已经打印过，
	// 行数不够时优先保留「通过但超过软档」段。
	const sectionLineBudget = maximumLineCount - summaryLines.length - 1;
	const sectionLines: string[] = [];
	let listedWarningCount = 0;
	for (const [sectionHeading, sectionWarnings] of [
		["通过但超过软档：", warningsOnPassedTestCases],
		["失败用例此前的软档告警：", warningsOnFailedTestCases],
	] as const) {
		// 一段至少要放得下标题和一条告警。
		if (sectionWarnings.length === 0 || sectionLines.length + 2 > sectionLineBudget) {
			continue;
		}
		sectionLines.push(sectionHeading);
		for (const warning of sectionWarnings) {
			if (sectionLines.length >= sectionLineBudget) {
				break;
			}
			sectionLines.push(formatSoftDeadlineWarningLine(warning));
			listedWarningCount += 1;
		}
	}
	summaryLines.push(...sectionLines);
	if (listedWarningCount < warnings.length) {
		summaryLines.push(`  （另有 ${warnings.length - listedWarningCount} 条未列出）`);
	}
	return summaryLines;
}

export default class LoadSensitiveSoftDeadlineExceededEndOfRunSummaryReporter implements Reporter {
	onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
		const summaryLines = formatLoadSensitiveSoftDeadlineWarningsEndOfRunSummaryLines(
			collectLoadSensitiveSoftDeadlineWarningsFromTestModules(testModules, process.cwd()),
		);
		if (summaryLines.length > 0) {
			process.stdout.write(`\n${summaryLines.join("\n")}\n`);
		}
	}
}
