import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
	type RuntimePostDeployVerificationDoneEntryClosureRequest,
	runtimePostDeployVerificationDoneEntryClosureRequestSchema,
	runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema,
	runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema,
} from "../core/api-contract";
import { resolveProjectInputPath } from "../projects/project-path";

// CLI 带原因结案的参数（`kanban deployment verification-complete / verification-confirm` 与 `kanban task done` 共用）：
// 受 Post-Deploy Verification 门禁的任务未全勾时，必须给每个未勾项原因，否则 runtime 拒绝移入 Done。

export interface PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions {
	closureReasonForAllUncheckedItems?: string;
	closureReasonText?: string;
	closureReasonsFile?: string;
}

const CLOSURE_REASON_CODES_DESCRIPTION =
	runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema.options.join(" | ");

export function addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions(command: Command): Command {
	return command
		.option(
			"--closure-reason-for-all-unchecked-items <code>",
			`Post-Deploy Verification: close the task into Done with this reason for every unchecked item (${CLOSURE_REASON_CODES_DESCRIPTION}).`,
		)
		.option(
			"--closure-reason-text <text>",
			"Free-text reason accompanying --closure-reason-for-all-unchecked-items (required for custom_reason_described_in_reason_text).",
		)
		.option(
			"--closure-reasons-file <path>",
			'JSON file with per-item reasons: an array of {"checklistItemId","uncheckedChecklistItemClosureReasonCode","uncheckedChecklistItemClosureReasonText"?} or a full closure request object.',
		);
}

/** 解析出随移入 Done 请求提交的结案信息；三个参数都没给时返回 undefined（全勾或不受门禁的任务不需要）。 */
export async function parsePostDeployVerificationDoneEntryClosureFromCliOptions(
	options: PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
	cwd: string,
): Promise<RuntimePostDeployVerificationDoneEntryClosureRequest | undefined> {
	const closure: RuntimePostDeployVerificationDoneEntryClosureRequest = {};
	if (options.closureReasonsFile !== undefined) {
		const raw = JSON.parse(
			await readFile(resolveProjectInputPath(options.closureReasonsFile, cwd), "utf8"),
		) as unknown;
		if (Array.isArray(raw)) {
			closure.uncheckedChecklistItemClosureReasons = raw.map((entry) =>
				runtimePostDeployVerificationUncheckedChecklistItemClosureReasonSchema.parse(entry),
			);
		} else {
			Object.assign(closure, runtimePostDeployVerificationDoneEntryClosureRequestSchema.parse(raw));
		}
	}
	if (options.closureReasonForAllUncheckedItems !== undefined) {
		const code = runtimePostDeployVerificationUncheckedChecklistItemClosureReasonCodeSchema.safeParse(
			options.closureReasonForAllUncheckedItems.trim(),
		);
		if (!code.success) {
			throw new Error(
				`Invalid --closure-reason-for-all-unchecked-items "${options.closureReasonForAllUncheckedItems}". Expected one of: ${CLOSURE_REASON_CODES_DESCRIPTION}.`,
			);
		}
		const reasonText = options.closureReasonText?.trim();
		if (code.data === "custom_reason_described_in_reason_text" && !reasonText) {
			throw new Error("custom_reason_described_in_reason_text requires --closure-reason-text.");
		}
		closure.closureReasonAppliedToRemainingUncheckedChecklistItems = {
			uncheckedChecklistItemClosureReasonCode: code.data,
			...(reasonText ? { uncheckedChecklistItemClosureReasonText: reasonText } : {}),
		};
	} else if (options.closureReasonText !== undefined) {
		throw new Error("--closure-reason-text requires --closure-reason-for-all-unchecked-items.");
	}
	return closure.uncheckedChecklistItemClosureReasons !== undefined ||
		closure.closureReasonAppliedToRemainingUncheckedChecklistItems !== undefined
		? closure
		: undefined;
}
