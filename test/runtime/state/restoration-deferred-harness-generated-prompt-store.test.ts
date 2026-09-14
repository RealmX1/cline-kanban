import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lockedFileSystem } from "../../../src/fs/locked-file-system";

// 账本落在 ~/.cline/kanban/workspaces/<id> 之下，路径由 workspace-state 解析。测试把这两个解析点重定向到
// 临时目录，而不是去动 homedir()——后者会让本套件在开发者真实的暂存账本上跑。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
	deferHarnessGeneratedPromptDuringAgentSessionRestoration,
	listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
	restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration,
} = await import("../../../src/state/restoration-deferred-harness-generated-prompt-store");

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
// 与 store 内的 MAX_DEFERRED_PROMPTS_PER_TASK 对齐。刻意在测试里重述一遍：这个数值正是回滚出错的边界，
// store 改动它时本用例必须跟着重新审视。
const MAX_DEFERRED_PROMPTS_PER_TASK = 20;

async function deferNotification(input: { taskId?: string; promptText: string; receivedAt: number }): Promise<void> {
	await deferHarnessGeneratedPromptDuringAgentSessionRestoration({
		workspaceId: WORKSPACE_ID,
		taskId: input.taskId ?? TASK_ID,
		sourceHarness: "claude",
		promptText: input.promptText,
		receivedAt: input.receivedAt,
	});
}

describe("restoration-deferred-harness-generated-prompt-store — consume 后的原子回滚", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-restoration-deferred-store-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("把整批 consume 掉的记录原样写回：正文、顺序与 receivedAt 都与 consume 前一致", async () => {
		for (const [index, receivedAt] of [1_000, 2_000, 3_000].entries()) {
			await deferNotification({ promptText: `通知 ${index + 1}`, receivedAt });
		}
		const beforeConsume = await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});
		const consumed = await consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});

		await restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			restoredRecords: consumed,
		});

		expect(
			await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
			}),
		).toEqual(beforeConsume);
	});

	// 这是缺陷的核心形态：consume 与回滚之间有一条新通知到达。逐条复用 defer 时，写回第 20 条旧记录会把
	// 这条新通知从队尾挤掉（slice(-(MAX-1)) 按追加顺序裁剪），于是「暂存」变成了「丢失」。
	it("回滚不得挤掉 consume 之后新到达的通知：满载时掉的是时间上最旧的那条", async () => {
		for (let index = 0; index < MAX_DEFERRED_PROMPTS_PER_TASK; index += 1) {
			await deferNotification({ promptText: `旧通知 ${index + 1}`, receivedAt: 1_000 + index });
		}
		const consumed = await consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});
		await deferNotification({ promptText: "回滚前刚到的新通知", receivedAt: 9_000 });

		await restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			restoredRecords: consumed,
		});

		const afterRestore = await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});
		expect(afterRestore).toHaveLength(MAX_DEFERRED_PROMPTS_PER_TASK);
		expect(afterRestore.map((record) => record.promptText)).toEqual([
			// 掉的是 receivedAt 最小的「旧通知 1」，新通知按到达时间排在最后。
			...Array.from({ length: MAX_DEFERRED_PROMPTS_PER_TASK - 1 }, (_unused, index) => `旧通知 ${index + 2}`),
			"回滚前刚到的新通知",
		]);
		expect(afterRestore.map((record) => record.receivedAt)).toEqual([
			...Array.from({ length: MAX_DEFERRED_PROMPTS_PER_TASK - 1 }, (_unused, index) => 1_001 + index),
			9_000,
		]);
	});

	it("不碰其他任务的记录", async () => {
		await deferNotification({ taskId: "task-other", promptText: "别的任务的通知", receivedAt: 500 });
		await deferNotification({ promptText: "本任务的通知", receivedAt: 1_000 });
		const consumed = await consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});

		await restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			restoredRecords: consumed,
		});

		expect(
			(
				await listHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
					workspaceId: WORKSPACE_ID,
					taskId: "task-other",
				})
			).map((record) => [record.promptText, record.receivedAt]),
		).toEqual([["别的任务的通知", 500]]);
	});

	// 写队列是 per-workspace 串行的：回滚占 N 次操作，就等于给并发到达的新通知开了 N 个插队窗口。
	// 整批只写一次，这个窗口才不存在。
	it("整批回滚只占一次写队列操作", async () => {
		for (const [index, receivedAt] of [1_000, 2_000, 3_000].entries()) {
			await deferNotification({ promptText: `通知 ${index + 1}`, receivedAt });
		}
		const consumed = await consumeHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
		});
		const writeJsonFileAtomicSpy = vi.spyOn(lockedFileSystem, "writeJsonFileAtomic");

		await restoreConsumedHarnessGeneratedPromptsDeferredDuringAgentSessionRestoration({
			workspaceId: WORKSPACE_ID,
			restoredRecords: consumed,
		});

		expect(writeJsonFileAtomicSpy).toHaveBeenCalledTimes(1);
	});
});
