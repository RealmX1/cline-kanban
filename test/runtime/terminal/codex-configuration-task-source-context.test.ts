import { describe, expect, it, vi } from "vitest";
import { codexConfigurationTaskSourceIdentityKey } from "../../../src/codex-configuration-sync/codex-configuration-change-presentation";
import { readCodexConfigurationTaskSourceContext } from "../../../src/codex-configuration-sync/codex-configuration-task-source-context";

const lookups = vi.hoisted(() => ({
	state: vi.fn(),
	projection: vi.fn(),
	store: vi.fn(async () => ({ writers: {} })),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	loadPersistedWorkspaceStateById: lookups.state,
	listWorkspaceIndexEntries: async () => [],
}));
vi.mock("../../../src/codex-configuration-sync/codex-configuration-sync-store", () => ({
	readCodexConfigurationSyncStore: lookups.store,
}));
vi.mock(
	"../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation",
	() => ({ readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture: lookups.projection }),
);

describe("配置来源任务身份核验", () => {
	it("侧会话按持久归属找到主任务，代次不符或任务 ID 复用时保留未知", async () => {
		const binding = {
			writerId: "writer",
			workspaceId: "project",
			conversationSessionId: "side",
			runtimeSessionIncarnationId: "original-incarnation",
			createdAt: 100,
		};
		const state = {
			board: { columns: [{ cards: [{ id: "owner", title: "原任务", createdAt: 42 }] }] },
			sessions: {
				side: {
					taskId: "side",
					runtimeSessionIncarnationId: "original-incarnation",
					taskConversationSessionMetadata: { workspaceTaskId: "owner" },
					codexConfigurationWriterBinding: binding,
				},
			},
		};
		lookups.state.mockResolvedValue(state);
		lookups.projection.mockRejectedValue(new Error("账本暂不可读"));
		const first = await readCodexConfigurationTaskSourceContext([
			{ workspaceId: "project", workspacePath: "/project" },
		]);
		expect(first.writerTasks.writer).toMatchObject({
			taskId: "owner",
			taskTitle: "原任务",
			conversationSessionId: "side",
			taskIncarnationCreatedAtEpochMs: 42,
		});
		state.sessions.side.runtimeSessionIncarnationId = "new-incarnation";
		expect(
			(await readCodexConfigurationTaskSourceContext([{ workspaceId: "project", workspacePath: "/project" }]))
				.writerTasks,
		).toEqual({});
		state.sessions.side.runtimeSessionIncarnationId = "original-incarnation";
		state.board.columns[0].cards[0].createdAt = 200;
		expect(
			(await readCodexConfigurationTaskSourceContext([{ workspaceId: "project", workspacePath: "/project" }]))
				.writerTasks,
		).toEqual({});
	});
	it("迁移链接需账本别名与目标 incarnation 同时成立，删除或复用后不导航", async () => {
		const original = { workspaceId: "source-project", taskId: "same-task", taskIncarnationCreatedAtEpochMs: 42 };
		const current = { ...original, workspaceId: "target-project" };
		const state = {
			board: { columns: [{ cards: [{ id: current.taskId, title: "迁移任务", createdAt: 42 }] }] },
			sessions: {},
		};
		lookups.state.mockResolvedValue(state);
		lookups.projection.mockImplementation(async (read: (reader: unknown) => unknown) =>
			read({
				projectionState: {
					kanbanBoardCardIdentityProjectionState: {
						projectionsByKanbanBoardCardWorkUnitKey: new Map([
							[
								"identity",
								{
									kanbanBoardCard: original,
									currentWorkspaceId: "target-project",
									workspaceIdsUsedByCard: ["source-project", "target-project"],
									permanentlyRemovedFromBoardAt: null,
								},
							],
						]),
					},
				},
			}),
		);
		const first = await readCodexConfigurationTaskSourceContext([
			{ workspaceId: "target-project", workspacePath: "/target" },
		]);
		expect(first.taskLinks[codexConfigurationTaskSourceIdentityKey(original)]).toEqual(current);
		state.board.columns[0].cards[0].createdAt = 999;
		expect(
			(await readCodexConfigurationTaskSourceContext([{ workspaceId: "target-project", workspacePath: "/target" }]))
				.taskLinks[codexConfigurationTaskSourceIdentityKey(original)],
		).toBeUndefined();
		state.board.columns[0].cards = [];
		expect(
			(await readCodexConfigurationTaskSourceContext([{ workspaceId: "target-project", workspacePath: "/target" }]))
				.taskLinks,
		).toEqual({});
	});
	it("单个项目不可读不阻塞其他项目，恢复后下一次读取自动补证", async () => {
		let available = false;
		lookups.state.mockImplementation(async (path: string) => {
			if (path === "b" && !available) throw new Error("暂不可读");
			return { board: { columns: [{ cards: [{ id: "task", title: "任务", createdAt: 1 }] }] }, sessions: {} };
		});
		lookups.projection.mockRejectedValue(new Error("账本暂不可读"));
		const workspaces = [
			{ workspaceId: "a", workspacePath: "/available" },
			{ workspaceId: "b", workspacePath: "/unavailable" },
		];
		expect(Object.keys((await readCodexConfigurationTaskSourceContext(workspaces)).taskLinks)).toHaveLength(1);
		available = true;
		expect(Object.keys((await readCodexConfigurationTaskSourceContext(workspaces)).taskLinks)).toHaveLength(2);
	});
	it("其他项目的同名会话不能补证本项目恢复 writer 的任务 incarnation", async () => {
		const binding = {
			writerId: "replacement-writer",
			workspaceId: "project",
			conversationSessionId: "side",
			runtimeSessionIncarnationId: "replacement-runtime",
			createdAt: 100,
		};
		lookups.store.mockResolvedValue({
			writers: {
				"foreign-writer": {
					binding: { writerId: "foreign-writer", workspaceId: "other-project", conversationSessionId: "side" },
					sourceTaskSnapshot: {
						workspaceId: "other-project",
						taskId: "owner",
						taskIncarnationCreatedAtEpochMs: 80,
					},
				},
				"original-writer": {
					binding: { writerId: "original-writer", workspaceId: "project", conversationSessionId: "side" },
					sourceTaskSnapshot: { workspaceId: "project", taskId: "owner", taskIncarnationCreatedAtEpochMs: 42 },
				},
			},
		});
		lookups.state.mockResolvedValue({
			board: { columns: [{ cards: [{ id: "owner", title: "同 ID 替代任务", createdAt: 80 }] }] },
			sessions: {
				side: {
					taskId: "side",
					runtimeSessionIncarnationId: "replacement-runtime",
					taskConversationSessionMetadata: { workspaceTaskId: "owner" },
					codexConfigurationWriterBinding: binding,
				},
			},
		});
		lookups.projection.mockRejectedValue(new Error("账本暂不可读"));
		expect(
			(await readCodexConfigurationTaskSourceContext([{ workspaceId: "project", workspacePath: "/project" }]))
				.writerTasks,
		).toEqual({});
	});
	it("恢复 writer 缺少原 incarnation 证据时不接合同 ID 替代卡", async () => {
		const binding = {
			writerId: "replacement-writer",
			workspaceId: "project",
			conversationSessionId: "side",
			runtimeSessionIncarnationId: "replacement-runtime",
			createdAt: 100,
		};
		const originalWriter = {
			binding: { writerId: "original-writer", workspaceId: "project", conversationSessionId: "side" },
			sourceTaskSnapshot: undefined as { taskId: string; taskIncarnationCreatedAtEpochMs: number } | undefined,
		};
		lookups.store.mockResolvedValue({ writers: { "original-writer": originalWriter } });
		lookups.state.mockResolvedValue({
			board: { columns: [{ cards: [{ id: "owner", title: "替代任务", createdAt: 80 }] }] },
			sessions: {
				side: {
					taskId: "side",
					runtimeSessionIncarnationId: "replacement-runtime",
					taskConversationSessionMetadata: { workspaceTaskId: "owner" },
					codexConfigurationWriterBinding: binding,
				},
			},
		});
		lookups.projection.mockRejectedValue(new Error("账本暂不可读"));
		const workspaces = [{ workspaceId: "project", workspacePath: "/project" }];
		expect((await readCodexConfigurationTaskSourceContext(workspaces)).writerTasks).toEqual({});
		originalWriter.sourceTaskSnapshot = { taskId: "owner", taskIncarnationCreatedAtEpochMs: 42 };
		expect((await readCodexConfigurationTaskSourceContext(workspaces)).writerTasks).toEqual({});
		originalWriter.sourceTaskSnapshot.taskIncarnationCreatedAtEpochMs = 80;
		expect(
			(await readCodexConfigurationTaskSourceContext(workspaces)).writerTasks["replacement-writer"],
		).toMatchObject({
			taskId: "owner",
			taskTitle: "替代任务",
			taskIncarnationCreatedAtEpochMs: 80,
		});
	});
});
