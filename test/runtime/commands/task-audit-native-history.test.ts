import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditTaskNativeHistory } from "../../../src/commands/task-audit-native-history";
import type {
	RuntimeBoardCard,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";

const mocked = vi.hoisted(() => ({
	loadWorkspaceContext: vi.fn(),
	loadPersistedWorkspaceStateById: vi.fn(),
	loadPage: vi.fn(),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceContext: mocked.loadWorkspaceContext,
	loadPersistedWorkspaceStateById: mocked.loadPersistedWorkspaceStateById,
	getTaskWorktreesHomePath: () => "/tmp/kanban-worktrees",
}));
vi.mock("../../../src/projects/project-path", () => ({
	resolveProjectInputPath: (path: string) => path,
}));
vi.mock("../../../src/agent-session-history/task-conversation-history-page", () => ({
	loadTaskConversationHistoryPage: mocked.loadPage,
}));

const directories: string[] = [];
afterEach(async () => {
	vi.clearAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const card = {
	id: "task-1",
	title: "旧任务",
	prompt: "需求",
	createdAt: 10,
	updatedAt: 10,
	baseRef: "main",
	startInPlanMode: false,
} as RuntimeBoardCard;

function workspaceState(sessions: Record<string, RuntimeTaskSessionSummary>) {
	return { board: { columns: [{ id: "review", cards: [card] }] }, sessions };
}

function summary(): RuntimeTaskSessionSummary {
	return {
		taskId: "session-1",
		agentId: "codex",
		workspacePath: null,
		updatedAt: 2,
		taskConversationSessionMetadata: { workspaceTaskId: card.id },
	} as RuntimeTaskSessionSummary;
}

function historyPage(
	availability: RuntimeTaskConversationHistoryPageResponse["availability"],
	content: string,
	nextCursor: string | null,
	notice: string | null = null,
): RuntimeTaskConversationHistoryPageResponse {
	return {
		availability,
		messages: [{ id: content, role: "assistant", content, createdAt: 1 }],
		nextCursor,
		notice,
	};
}

describe("原生历史批量核验的缺口与归档摘要", () => {
	it("较晚的损坏页不会被报告成完整且已到末页", async () => {
		mocked.loadWorkspaceContext.mockResolvedValue({ workspaceId: "workspace-1", repoPath: "/repo" });
		mocked.loadPersistedWorkspaceStateById.mockResolvedValue(workspaceState({ "session-1": summary() }));
		mocked.loadPage.mockImplementation(async (input: { request: { cursor?: string | null } }) =>
			input.request.cursor
				? historyPage("partially_available", "旧", null, "部分会话记录损坏")
				: historyPage("available", "新", "older"),
		);
		const result = await auditTaskNativeHistory({ projectPath: "/repo", taskId: ["task-1"] });
		expect(result.rows[0]?.nativeHistory).toMatchObject({
			availability: "partially_available",
			pagination: "incomplete",
			pageCount: 2,
		});
		expect(result.rows[0]?.nativeHistory.notices.join("\n")).toContain("缺口");
	});

	it("走完完整分页时仍报告 available 与 end_reached", async () => {
		mocked.loadWorkspaceContext.mockResolvedValue({ workspaceId: "workspace-1", repoPath: "/repo" });
		mocked.loadPersistedWorkspaceStateById.mockResolvedValue(workspaceState({ "session-1": summary() }));
		mocked.loadPage.mockImplementation(async (input: { request: { cursor?: string | null } }) =>
			input.request.cursor ? historyPage("available", "旧", null) : historyPage("available", "新", "older"),
		);
		const result = await auditTaskNativeHistory({ projectPath: "/repo", taskId: ["task-1"] });
		expect(result.rows[0]?.nativeHistory).toMatchObject({
			availability: "available",
			pagination: "end_reached",
			messageCount: 2,
		});
	});

	it("默认全项目核验保留慢读后已核验的范围，时间用尽时报告当前任务及尚未读取的任务", async () => {
		vi.stubEnv("KANBAN_CLI_HARD_TIMEOUT_MS", "");
		vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
		const cards = Array.from({ length: 807 }, (_, index) => ({
			...card,
			id: `task-${String(index).padStart(3, "0")}`,
		}));
		const sessions = Object.fromEntries(
			cards
				.slice(0, 695)
				.map(({ id }) => [
					`session-${id}`,
					{ ...summary(), taskId: `session-${id}`, taskConversationSessionMetadata: { workspaceTaskId: id } },
				]),
		);
		mocked.loadWorkspaceContext.mockResolvedValue({ workspaceId: "workspace-1", repoPath: "/repo" });
		mocked.loadPersistedWorkspaceStateById.mockResolvedValue({ board: { columns: [{ cards }] }, sessions });
		mocked.loadPage.mockImplementation(
			async (input: { request: { workspaceTaskId: string; cursor: string | null } }) => {
				if (input.request.workspaceTaskId === "task-000") {
					await new Promise<void>((resolve) => setTimeout(resolve, 40_000));
					return historyPage("available", "已核验", null);
				}
				if (!input.request.cursor) return historyPage("available", "较新一页", "older");
				return new Promise<never>(() => {});
			},
		);
		const auditResult = auditTaskNativeHistory({ projectPath: "/repo" });
		await vi.advanceTimersByTimeAsync(600_000);
		const result = await auditResult;
		expect(
			result.rows.map(({ taskId, nativeHistory }) => [taskId, nativeHistory.pagination, nativeHistory.pageCount]),
		).toEqual([
			["task-000", "end_reached", 1],
			["task-001", "incomplete", 1],
		]);
		expect(result.rows[1]?.nativeHistory.notices).toContain("批量核验时间预算已用尽，剩余正文待验。");
		expect(result.auditTimeBudget).toMatchObject({
			status: "exhausted",
			workBudgetMs: 600_000,
			taskIdsWithUnverifiedAuditWork: cards.slice(1).map(({ id }) => id),
		});
		expect(mocked.loadPage).toHaveBeenCalledTimes(3);
	});

	it("显式硬超时前交付未读首屏的结果，不将其报告为无匹配原件", async () => {
		vi.stubEnv("KANBAN_CLI_HARD_TIMEOUT_MS", "120000");
		vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
		mocked.loadWorkspaceContext.mockResolvedValue({ workspaceId: "workspace-1", repoPath: "/repo" });
		mocked.loadPersistedWorkspaceStateById.mockResolvedValue(workspaceState({ "session-1": summary() }));
		mocked.loadPage.mockImplementation(() => new Promise<never>(() => {}));
		const auditResult = auditTaskNativeHistory({ projectPath: "/repo" });
		await vi.advanceTimersByTimeAsync(115_000);
		const result = await auditResult;
		expect(result.rows[0]?.nativeHistory).toMatchObject({ availability: "unavailable", pagination: "unavailable" });
		expect(result.rows[0]?.nativeHistory.searchStatus).toBeUndefined();
		expect(result.rows[0]?.nativeHistory.unresolvedCandidateCount).toBeUndefined();
		expect(result.auditTimeBudget).toMatchObject({
			status: "exhausted",
			workBudgetMs: 115_000,
			taskIdsWithUnverifiedAuditWork: [card.id],
		});
	});

	it("没有本地摘要时仍按来源清单核验并导出归档", async () => {
		const root = await mkdtemp(join(tmpdir(), "native-history-audit-"));
		directories.push(root);
		const digest = (value: string) => createHash("sha256").update(value).digest("hex");
		const identity = {
			sourceWorkspaceId: "workspace-1",
			sourceTaskId: card.id,
			sourceTaskIncarnationCreatedAtEpochMs: card.createdAt,
			sourceConversationSessionId: "archive-only",
			sourceAgentId: "claude" as const,
		};
		const archivedMessages = JSON.stringify([
			{ id: "archive-message", role: "assistant", content: "归档正文", createdAt: 1 },
		]);
		const archiveText = JSON.stringify({
			schemaVersion: 1,
			...identity,
			availability: "complete",
			sourceNativeSessionId: null,
			capturedAtEpochMs: 11,
			pageDigests: [digest(archivedMessages)],
			gaps: [],
		});
		const archiveDirectory = join(root, digest(archiveText));
		await mkdir(archiveDirectory, { recursive: true });
		await writeFile(join(archiveDirectory, "archive.json"), archiveText);
		await writeFile(join(archiveDirectory, "0.json"), archivedMessages);
		const manifestPath = join(root, "manifest.json");
		await writeFile(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				sourceInstanceId: "source-fixture",
				sessions: [{ ...identity, archiveDigest: digest(archiveText) }],
			}),
		);
		mocked.loadWorkspaceContext.mockResolvedValue({ workspaceId: "workspace-1", repoPath: "/repo" });
		mocked.loadPersistedWorkspaceStateById.mockResolvedValue(workspaceState({}));
		const result = await auditTaskNativeHistory({
			projectPath: "/repo",
			taskId: [card.id],
			archiveDirectory: root,
			archiveSourceManifest: manifestPath,
			archiveSourceInstanceId: "source-fixture",
			includeArchiveMessages: true,
		});
		expect(mocked.loadPage).not.toHaveBeenCalled();
		expect(result.tasksWithoutNativeSessions).toEqual([card.id]);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.archive).toMatchObject({
			status: "complete",
			messages: [{ content: "归档正文" }],
		});
	});
});
