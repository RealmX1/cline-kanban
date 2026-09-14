// agent 会话恢复期间，Claude 可能把后台任务通知伪装成 UserPromptSubmit 自动塞回会话。恢复守卫会
// 先阻止这条 prompt 被 agent 消费，再把正文暂存在 workspace 账本里；下一条真人/结构化回答到来时，
// hook 将它作为 additionalContext 合并进去。这样恢复本身不会触发生成，通知也不会静默丢失。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "./workspace-state";

const RESTORATION_DEFERRED_HARNESS_GENERATED_PROMPTS_FILENAME = "restoration-deferred-harness-generated-prompts.json";
const MAX_DEFERRED_PROMPTS_PER_TASK = 20;
const MAX_DEFERRED_PROMPTS_PER_WORKSPACE = 200;

const restorationDeferredHarnessGeneratedPromptSchema = z.object({
	taskId: z.string(),
	sourceHarness: z.string(),
	promptText: z.string(),
	receivedAt: z.number(),
});
export type RestorationDeferredHarnessGeneratedPrompt = z.infer<typeof restorationDeferredHarnessGeneratedPromptSchema>;

const restorationDeferredHarnessGeneratedPromptFileSchema = z.array(restorationDeferredHarnessGeneratedPromptSchema);

function getRestorationDeferredHarnessGeneratedPromptPath(workspaceId: string): string {
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing restoration deferred harness prompt access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, RESTORATION_DEFERRED_HARNESS_GENERATED_PROMPTS_FILENAME);
}

async function readRawDeferredPrompts(workspaceId: string): Promise<RestorationDeferredHarnessGeneratedPrompt[]> {
	let raw: string;
	try {
		raw = await readFile(getRestorationDeferredHarnessGeneratedPromptPath(workspaceId), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	try {
		const parsed = restorationDeferredHarnessGeneratedPromptFileSchema.safeParse(JSON.parse(raw) as unknown);
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

async function writeDeferredPrompts(
	workspaceId: string,
	records: RestorationDeferredHarnessGeneratedPrompt[],
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getRestorationDeferredHarnessGeneratedPromptPath(workspaceId), records, {
		lock: null,
	});
}

const writeQueueByWorkspaceId = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
	const previous = writeQueueByWorkspaceId.get(workspaceId) ?? Promise.resolve();
	const next = previous.then(operation, operation);
	writeQueueByWorkspaceId.set(
		workspaceId,
		next.catch(() => undefined),
	);
	return next;
}

export async function deferHarnessGeneratedPromptDuringAgentSessionRestoration(input: {
	workspaceId: string;
	taskId: string;
	sourceHarness: string;
	promptText: string;
	receivedAt: number;
}): Promise<void> {
	await enqueueWrite(input.workspaceId, async () => {
		const records = await readRawDeferredPrompts(input.workspaceId);
		const taskRecords = records.filter((record) => record.taskId === input.taskId);
		const retainedTaskRecords = taskRecords.slice(-(MAX_DEFERRED_PROMPTS_PER_TASK - 1));
		const otherTaskRecords = records.filter((record) => record.taskId !== input.taskId);
		const nextRecords = [
			...otherTaskRecords,
			...retainedTaskRecords,
			{
				taskId: input.taskId,
				sourceHarness: input.sourceHarness,
				promptText: input.promptText,
				receivedAt: input.receivedAt,
			},
		].slice(-MAX_DEFERRED_PROMPTS_PER_WORKSPACE);
		await writeDeferredPrompts(input.workspaceId, nextRecords);
	});
}

// 只读列出，不消费：供 UI 判断「这个任务有没有攒下待放行的通知」并渲染一键放行入口。走同一条写队列
// 是为了不和正在进行的 defer / consume 读到半截状态。
export async function listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration(input: {
	workspaceId: string;
	taskId: string;
}): Promise<RestorationDeferredHarnessGeneratedPrompt[]> {
	return await enqueueWrite(input.workspaceId, async () => {
		const records = await readRawDeferredPrompts(input.workspaceId);
		return records.filter((record) => record.taskId === input.taskId);
	});
}

// 取出与清除位于同一个 workspace 写队列操作里，避免两条并发 UserPromptSubmit 重复携带同一通知。
export async function consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration(input: {
	workspaceId: string;
	taskId: string;
}): Promise<RestorationDeferredHarnessGeneratedPrompt[]> {
	return await enqueueWrite(input.workspaceId, async () => {
		const records = await readRawDeferredPrompts(input.workspaceId);
		const consumed = records.filter((record) => record.taskId === input.taskId);
		if (consumed.length === 0) {
			return [];
		}
		await writeDeferredPrompts(
			input.workspaceId,
			records.filter((record) => record.taskId !== input.taskId),
		);
		return consumed;
	});
}

// 超额裁剪一律「记录时间最旧的先掉」，而不是 slice(-N) 那种按数组尾部截断。两者对 defer 等价
// （新记录必然排在最后），但对回滚不等价：回滚写回的是一批**旧**记录，按追加顺序裁剪会把
// consume 之后刚到达的新通知挤掉。返回值保持入参的相对顺序。
function retainNewestDeferredPromptsByReceivedAt(
	records: readonly RestorationDeferredHarnessGeneratedPrompt[],
	maxRetainedRecordCount: number,
): RestorationDeferredHarnessGeneratedPrompt[] {
	if (records.length <= maxRetainedRecordCount) {
		return [...records];
	}
	const droppedRecords = new Set(
		[...records]
			.sort((left, right) => left.receivedAt - right.receivedAt)
			.slice(0, records.length - maxRetainedRecordCount),
	);
	return records.filter((record) => !droppedRecords.has(record));
}

// 回滚专用入口：把一次 consume 取走的整批记录原样写回。与 defer 刻意分开，因为语义本就不同——
// defer 说的是「又新到了一条」，回滚说的是「刚才那一批当作没取过」。逐条复用 defer 会有三个错：
//   1. 占 N 次 workspace 写队列操作，中间可能插进并发到达的新通知，顺序被打乱；
//   2. 每条都按 slice(-(MAX-1)) 裁剪，写回满 20 条旧记录会把 consume 之后新到的那条挤掉；
//   3. 工作区满载时按数组尾部截断，挤掉的是位置上靠前的记录而不是时间上最旧的记录。
// 这里整批只占一次队列操作，按 receivedAt 归位与裁剪，因此顺序、receivedAt 与新到达的通知都保得住。
export async function restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration(input: {
	workspaceId: string;
	restoredRecords: readonly RestorationDeferredHarnessGeneratedPrompt[];
}): Promise<void> {
	if (input.restoredRecords.length === 0) {
		return;
	}
	await enqueueWrite(input.workspaceId, async () => {
		const currentRecords = await readRawDeferredPrompts(input.workspaceId);
		const restoredTaskIds = new Set(input.restoredRecords.map((record) => record.taskId));
		const untouchedTaskRecords = currentRecords.filter((record) => !restoredTaskIds.has(record.taskId));
		const restoredTaskRecords = [...restoredTaskIds].flatMap((taskId) =>
			retainNewestDeferredPromptsByReceivedAt(
				// Array.prototype.sort 是稳定排序：receivedAt 相同时保持「写回的旧记录在前、
				// consume 之后新到的在后」，与真实到达顺序一致。
				[
					...input.restoredRecords.filter((record) => record.taskId === taskId),
					...currentRecords.filter((record) => record.taskId === taskId),
				].sort((left, right) => left.receivedAt - right.receivedAt),
				MAX_DEFERRED_PROMPTS_PER_TASK,
			),
		);
		await writeDeferredPrompts(
			input.workspaceId,
			retainNewestDeferredPromptsByReceivedAt(
				[...untouchedTaskRecords, ...restoredTaskRecords],
				MAX_DEFERRED_PROMPTS_PER_WORKSPACE,
			),
		);
	});
}
