import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeExploratorySessionMapCollection } from "../../../src/core/api-contract";

// store 落在 ~/.cline/kanban/workspaces 之下，路径由 workspace-state 解析。测试把解析点
// 重定向到临时目录，而不是去动 homedir()（与 prompt-library-store 测试同一手法）。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	EXPLORATORY_SESSION_MAP_SCHEMA_VERSION,
	mutateExploratorySessionMapState,
	readExploratorySessionMapCollection,
	readExploratorySessionMapState,
} = await import("../../../src/state/exploratory-session-map-store");

const WORKSPACE_ID = "workspace-exploratory";

function mapsFilePath(): string {
	return join(testRuntimeHome.path, "workspaces", WORKSPACE_ID, "exploratory-session-maps.json");
}

function makeCollection(
	overrides: Partial<RuntimeExploratorySessionMapCollection> = {},
): RuntimeExploratorySessionMapCollection {
	return {
		sourceTurnProjectionSignature: "3:task-1-1700000000003-abc3:17",
		mapNodes: [
			{
				mapNodeId: "session-1:T1:milestone",
				anchorConversationSessionTaskId: "session-1",
				anchorTurnNumber: 1,
				anchorTurnCheckpointCommit: null,
				anchorTurnUserMessagePreview: "第一轮问题",
				nodeKind: "milestone",
				nodeTitle: "定下方向",
				nodeSummaryMarkdown: null,
				referencedFindingId: null,
				nodeGenerationSource: "agent_live_session_maintenance",
				createdAt: 1_000,
				updatedAt: 1_000,
			},
		],
		mapStaleReason: null,
		lastMaintenanceJobCompletedAt: null,
		updatedAt: 1_000,
		...overrides,
	};
}

describe("exploratory-session-map-store", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "exploratory-session-map-store-test-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
		testRuntimeHome.path = "";
	});

	it("文件不存在 → 读为空 state / collection 为 null", async () => {
		const state = await readExploratorySessionMapState(WORKSPACE_ID);
		expect(state.schemaVersion).toBe(EXPLORATORY_SESSION_MAP_SCHEMA_VERSION);
		expect(state.mapCollectionsByConversationSessionTaskId).toEqual({});
		expect(await readExploratorySessionMapCollection(WORKSPACE_ID, "session-1")).toBeNull();
	});

	it("mutate 写入后可读回；同一会话集合幂等覆盖", async () => {
		await mutateExploratorySessionMapState(WORKSPACE_ID, (state) => ({
			...state,
			mapCollectionsByConversationSessionTaskId: {
				...state.mapCollectionsByConversationSessionTaskId,
				"session-1": makeCollection(),
			},
		}));
		const collection = await readExploratorySessionMapCollection(WORKSPACE_ID, "session-1");
		expect(collection?.mapNodes).toHaveLength(1);
		expect(collection?.mapNodes[0]?.nodeTitle).toBe("定下方向");

		const updated = makeCollection({ updatedAt: 2_000, mapStaleReason: "turn_projection_signature_drift" });
		await mutateExploratorySessionMapState(WORKSPACE_ID, (state) => ({
			...state,
			mapCollectionsByConversationSessionTaskId: {
				...state.mapCollectionsByConversationSessionTaskId,
				"session-1": updated,
			},
		}));
		const reread = await readExploratorySessionMapCollection(WORKSPACE_ID, "session-1");
		expect(reread?.mapStaleReason).toBe("turn_projection_signature_drift");
	});

	it("mutator 返回 null → 无操作（不落盘）", async () => {
		const result = await mutateExploratorySessionMapState(WORKSPACE_ID, () => null);
		expect(result).toBeNull();
		const state = await readExploratorySessionMapState(WORKSPACE_ID);
		expect(state.mapCollectionsByConversationSessionTaskId).toEqual({});
	});

	it("损坏 JSON / schema 非法 → 读为空 state（损坏容错）", async () => {
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true }),
		);
		await writeFile(mapsFilePath(), "{ not json", "utf8");
		expect((await readExploratorySessionMapState(WORKSPACE_ID)).mapCollectionsByConversationSessionTaskId).toEqual(
			{},
		);

		await writeFile(mapsFilePath(), JSON.stringify({ schemaVersion: "nope" }), "utf8");
		expect((await readExploratorySessionMapState(WORKSPACE_ID)).mapCollectionsByConversationSessionTaskId).toEqual(
			{},
		);
	});

	it("路径遍历守卫：workspaceId 越出 workspaces 根即拒绝", async () => {
		await expect(readExploratorySessionMapState("../escape")).rejects.toThrow(/outside workspaces root/);
	});

	it("会话集合数超上限 → 丢最旧 updatedAt 的集合", async () => {
		await mutateExploratorySessionMapState(WORKSPACE_ID, (state) => {
			const collections: Record<string, RuntimeExploratorySessionMapCollection> = {};
			for (let index = 0; index < 101; index += 1) {
				collections[`session-${index}`] = makeCollection({ updatedAt: 1_000 + index });
			}
			return { ...state, mapCollectionsByConversationSessionTaskId: collections };
		});
		const state = await readExploratorySessionMapState(WORKSPACE_ID);
		const keys = Object.keys(state.mapCollectionsByConversationSessionTaskId);
		expect(keys).toHaveLength(100);
		// 最旧的 session-0（updatedAt=1000）被裁掉。
		expect(keys).not.toContain("session-0");
		expect(keys).toContain("session-100");
	});

	it("并发 mutate 经串行写队列按序应用", async () => {
		const [first, second] = await Promise.all([
			mutateExploratorySessionMapState(WORKSPACE_ID, (state) => ({
				...state,
				mapCollectionsByConversationSessionTaskId: {
					...state.mapCollectionsByConversationSessionTaskId,
					"session-a": makeCollection({ updatedAt: 1_000 }),
				},
			})),
			mutateExploratorySessionMapState(WORKSPACE_ID, (state) => ({
				...state,
				mapCollectionsByConversationSessionTaskId: {
					...state.mapCollectionsByConversationSessionTaskId,
					"session-b": makeCollection({ updatedAt: 2_000 }),
				},
			})),
		]);
		expect(Object.keys(first ?? {})).not.toContain("session-b");
		const state = second ?? (await readExploratorySessionMapState(WORKSPACE_ID));
		expect(Object.keys(state.mapCollectionsByConversationSessionTaskId).sort()).toEqual(["session-a", "session-b"]);
	});

	it("mutate 结果过 schema 校验：非法集合直接抛错、不落盘", async () => {
		await expect(
			mutateExploratorySessionMapState(WORKSPACE_ID, (state) => ({
				...state,
				mapCollectionsByConversationSessionTaskId: {
					...state.mapCollectionsByConversationSessionTaskId,
					// 缺 sourceTurnProjectionSignature 的畸形集合。
					"session-bad": { mapNodes: [] } as unknown as RuntimeExploratorySessionMapCollection,
				},
			})),
		).rejects.toThrow();
		const raw = await readFile(mapsFilePath(), "utf8").catch(() => null);
		expect(raw).toBeNull();
	});
});
