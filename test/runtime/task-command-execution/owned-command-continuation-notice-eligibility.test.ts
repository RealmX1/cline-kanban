import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TaskCommandExecutionRecord } from "../../../src/core/task-command-execution-contract";
import {
	assertTaskCommandContinuationNoticeStillEligible,
	formatTaskCommandContinuationNotice,
	readEligibleTaskCommandContinuationNotices,
} from "../../../src/task-command-execution/task-command-execution-continuation-notices";

let isolatedContinuationEligibilityArtifactDirectory: string;
beforeEach(async () => {
	isolatedContinuationEligibilityArtifactDirectory = await mkdtemp(
		join(tmpdir(), "owned-command-continuation-eligibility-"),
	);
});
afterEach(async () => {
	await rm(isolatedContinuationEligibilityArtifactDirectory, { recursive: true, force: true });
});

function createOwnedCommandContinuationEligibilityRecord() {
	return {
		specification: {
			label: "独立后台验修",
			continuationNoticesFile: join(isolatedContinuationEligibilityArtifactDirectory, "continuation-notices.json"),
			resultFile: join(isolatedContinuationEligibilityArtifactDirectory, "business-result.json"),
		},
	} as TaskCommandExecutionRecord;
}

const finalNotice = {
	noticeId: "final-result-revision-1",
	stage: "final_review",
	text: "验证已完成，待最终审阅。",
	requiresCurrentResultNoticeMatch: true,
};

it("清单已发布而业务修订尚未发布时不投递最终结果，独立阶段事件仍可投递", async () => {
	const record = createOwnedCommandContinuationEligibilityRecord();
	const reviewerNotice = { noticeId: "anonymous-findings-1", stage: "findings", text: "独立发现已可供补充事实。" };
	await writeFile(
		record.specification.continuationNoticesFile as string,
		JSON.stringify({ notices: [reviewerNotice, finalNotice] }),
	);
	expect(await readEligibleTaskCommandContinuationNotices(record, null)).toEqual([reviewerNotice]);
	expect(
		await readEligibleTaskCommandContinuationNotices(record, {
			disposition: "agent_review_ready",
			agentContinuationNotice: { ...finalNotice, text: "另一份结果正文" },
		}),
	).toEqual([reviewerNotice]);
	expect(await readEligibleTaskCommandContinuationNotices(record, { agentContinuationNotice: finalNotice })).toEqual([
		reviewerNotice,
		finalNotice,
	]);
});

it("补充登记只写完业务待证状态时，写前核验仍会阻止旧清单中的最终通知", async () => {
	const record = createOwnedCommandContinuationEligibilityRecord();
	record.resultDelivery = {
		producerNoticeId: finalNotice.noticeId,
		text: formatTaskCommandContinuationNotice(record, finalNotice),
	} as NonNullable<TaskCommandExecutionRecord["resultDelivery"]>;
	await writeFile(record.specification.continuationNoticesFile as string, JSON.stringify({ notices: [finalNotice] }));
	await writeFile(record.specification.resultFile, JSON.stringify({ agentContinuationNotice: finalNotice }));
	await expect(assertTaskCommandContinuationNoticeStillEligible(record)).resolves.toBeUndefined();
	await writeFile(record.specification.resultFile, JSON.stringify({ disposition: "machine_evidence_pending" }));
	await expect(assertTaskCommandContinuationNoticeStillEligible(record)).rejects.toThrow(
		"事件已被新补充或结果修订替代",
	);
});

it("最新业务原件损坏时保留未知，不能继续使用已经读取过的最终通知", async () => {
	const record = createOwnedCommandContinuationEligibilityRecord();
	record.resultDelivery = {
		producerNoticeId: finalNotice.noticeId,
		text: formatTaskCommandContinuationNotice(record, finalNotice),
	} as NonNullable<TaskCommandExecutionRecord["resultDelivery"]>;
	await writeFile(record.specification.continuationNoticesFile as string, JSON.stringify({ notices: [finalNotice] }));
	await writeFile(record.specification.resultFile, "{unfinished");
	await expect(assertTaskCommandContinuationNoticeStillEligible(record)).rejects.toThrow();
});
