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
