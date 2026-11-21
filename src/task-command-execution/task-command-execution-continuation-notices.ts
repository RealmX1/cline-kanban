import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
	type TaskCommandExecutionContinuationNotice,
	type TaskCommandExecutionRecord,
	taskCommandExecutionContinuationNoticeSchema,
} from "../core/task-command-execution-contract";

const continuationNoticeManifestSchema = z.object({
	notices: z.array(taskCommandExecutionContinuationNoticeSchema),
});

export async function readEligibleTaskCommandContinuationNotices(
	record: TaskCommandExecutionRecord,
	result: Record<string, unknown> | null,
): Promise<TaskCommandExecutionContinuationNotice[]> {
	if (record.specification.continuationNoticesFile) {
		try {
			const manifest = continuationNoticeManifestSchema.parse(
				JSON.parse(await readFile(record.specification.continuationNoticesFile, "utf8")),
			);
			if (new Set(manifest.notices.map((notice) => notice.noticeId)).size !== manifest.notices.length)
				throw new Error("后台事件清单含重复 noticeId");
			const currentNotice = taskCommandExecutionContinuationNoticeSchema.safeParse(result?.agentContinuationNotice);
			return manifest.notices.filter(
				(notice) =>
					!notice.requiresCurrentResultNoticeMatch ||
					(currentNotice.success &&
						currentNotice.data.requiresCurrentResultNoticeMatch === true &&
						currentNotice.data.noticeId === notice.noticeId &&
						currentNotice.data.stage === notice.stage &&
						currentNotice.data.text === notice.text),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}
	if (result?.agentContinuationNotice !== undefined)
		return [taskCommandExecutionContinuationNoticeSchema.parse(result.agentContinuationNotice)];
	return [];
}

export async function assertTaskCommandContinuationNoticeStillEligible(
	record: TaskCommandExecutionRecord,
): Promise<void> {
	const delivery = record.resultDelivery;
	if (!delivery) return;
	let result: Record<string, unknown> | null = null;
	try {
		result = JSON.parse(await readFile(record.specification.resultFile, "utf8")) as Record<string, unknown>;
	} catch (error) {
		// reviewer 阶段可能先于业务结果发布；损坏或不可读的既有原件继续阻止写入。
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const notices = await readEligibleTaskCommandContinuationNotices(record, result);
	if (!delivery.producerNoticeId) {
		if (notices.length > 0) throw new Error("后台事件已被新补充或结果修订替代，先对账既有接受，再选择当前有效事件");
		const disposition = result?.disposition;
		const expected =
			disposition === "agent_review_ready" || disposition === "agent_judgment_required"
				? formatTaskCommandContinuationNotice({ ...record, businessDisposition: disposition })
				: null;
		if (expected !== delivery.text) throw new Error("通用回退正文已与当前结果不一致，不能套用先前文案");
		return;
	}
	const notice = notices.find((item) => item.noticeId === delivery.producerNoticeId);
	if (!notice) throw new Error("原后台通知已从当前可投递清单撤下，可能已被消费或被新结果替换。");
	if (delivery.text !== formatTaskCommandContinuationNotice(record, notice))
		throw new Error("原后台通知的冻结正文与当前修订不一致。");
}

export function formatTaskCommandContinuationNotice(
	record: TaskCommandExecutionRecord,
	notice?: TaskCommandExecutionContinuationNotice,
): string {
	return notice
		? `【所属执行后台事件：${record.specification.label}】\n${notice.text}`
		: `【所属执行后台事件：${record.specification.label}】\n结果：${record.businessDisposition ?? "待审阅"}。\n原始结果：${record.specification.resultFile}\n按本任务已有授权继续。`;
}
