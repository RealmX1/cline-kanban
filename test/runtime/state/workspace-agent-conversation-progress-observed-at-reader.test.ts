import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sessions.json 落在 ~/.cline/kanban/workspaces/<id>/ 之下，路径由 workspace-state 解析。测试把解析点
// 重定向到临时目录，而不是去动 homedir()（与 exploratory-findings-store 测试同一手法）。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getPersistedWorkspaceSessionsFilePathById: (workspaceId: string) =>
		join(testRuntimeHome.path, "workspaces", workspaceId, "sessions.json"),
}));

const { loadWorkspaceAgentConversationProgressObservedAtByTaskId } = await import(
	"../../../src/state/workspace-agent-conversation-progress-observed-at-reader"
);

// 读取器按 workspaceId 做模块级缓存：每个用例用自己的 id，免得上一个用例的缓存串进来。
let WORKSPACE_ID = "";
let workspaceIdSequence = 0;

function sessionsFilePath(): string {
	return join(testRuntimeHome.path, "workspaces", WORKSPACE_ID, "sessions.json");
}

async function writeSessionsFile(contents: string): Promise<void> {
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
	await writeFile(sessionsFilePath(), contents, "utf8");
}

describe("loadWorkspaceAgentConversationProgressObservedAtByTaskId", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-agent-conversation-progress-reader-"));
		workspaceIdSequence += 1;
		WORKSPACE_ID = `workspace-agent-conversation-progress-${workspaceIdSequence}`;
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("returns an empty map when the workspace never wrote a sessions file", async () => {
		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(new Map());
	});

	it("extracts each task's observed instant and skips summaries without one", async () => {
		await writeSessionsFile(
			JSON.stringify({
				"task-progressed": {
					taskId: "task-progressed",
					state: "awaiting_review",
					lastConversationProgressObservation: {
						observedAtMs: 1_700_000_000_000,
						evidenceKind: "persisted_agent_transcript",
					},
				},
				"task-never-progressed": { taskId: "task-never-progressed", state: "idle" },
				"task-explicitly-null": {
					taskId: "task-explicitly-null",
					lastConversationProgressObservation: null,
				},
			}),
		);

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(
			new Map([["task-progressed", 1_700_000_000_000]]),
		);
	});

	it("drops only the malformed summary instead of the whole workspace", async () => {
		// 这是纯排序 / 展示用的量：一条形状不对的历史摘要不该连累同项目其它任务的推进时刻。
		await writeSessionsFile(
			JSON.stringify({
				"task-good": { lastConversationProgressObservation: { observedAtMs: 42, evidenceKind: "x" } },
				"task-bad-instant": { lastConversationProgressObservation: { observedAtMs: "yesterday" } },
				"task-not-an-object": 7,
			}),
		);

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(
			new Map([["task-good", 42]]),
		);
	});

	it("throws on a corrupt sessions file so the caller can warn and degrade", async () => {
		await writeSessionsFile("{ not json");

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).rejects.toThrow();
	});

	it("throws when the sessions file is not a task-keyed record", async () => {
		await writeSessionsFile(JSON.stringify(["not", "a", "record"]));

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).rejects.toThrow();
	});

	it("reuses the previous parse while the file's mtime and size are unchanged, and re-reads once either moves", async () => {
		// 缓存命中的直证：内容换了、字节数与 mtime 却被刻意钉成原样 → 仍返回旧解析结果（没有重新读盘）。
		const firstContents = JSON.stringify({
			"task-a": { lastConversationProgressObservation: { observedAtMs: 111 } },
		});
		const sameSizeContents = JSON.stringify({
			"task-a": { lastConversationProgressObservation: { observedAtMs: 999 } },
		});
		expect(sameSizeContents.length).toBe(firstContents.length);
		await writeSessionsFile(firstContents);
		// 先钉一个整秒 mtime：文件系统的 mtime 带亚毫秒精度，从 stat 读回的 Date 只到毫秒，原样写回会对不上。
		const originalModifiedAt = new Date(1_700_000_000_000);
		await utimes(sessionsFilePath(), originalModifiedAt, originalModifiedAt);

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(
			new Map([["task-a", 111]]),
		);

		await writeSessionsFile(sameSizeContents);
		await utimes(sessionsFilePath(), originalModifiedAt, originalModifiedAt);
		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(
			new Map([["task-a", 111]]),
		);

		// mtime 一动就重读。
		const laterModifiedAt = new Date(originalModifiedAt.getTime() + 5_000);
		await utimes(sessionsFilePath(), laterModifiedAt, laterModifiedAt);
		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(
			new Map([["task-a", 999]]),
		);
	});

	it("forgets the cached parse once the sessions file disappears", async () => {
		await writeSessionsFile(
			JSON.stringify({ "task-a": { lastConversationProgressObservation: { observedAtMs: 5 } } }),
		);
		await loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID);

		await rm(sessionsFilePath());

		await expect(loadWorkspaceAgentConversationProgressObservedAtByTaskId(WORKSPACE_ID)).resolves.toEqual(new Map());
	});
});
