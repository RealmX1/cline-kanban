import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeExploratoryFindingEntry } from "../../../src/core/api-contract";
import type { WorkspaceExploratoryFindingsState } from "../../../src/state/exploratory-findings-store";

// store 落在 ~/.cline/kanban/workspaces 之下，路径由 workspace-state 解析。测试把解析点
// 重定向到临时目录，而不是去动 homedir()（与 exploratory-session-map-store 测试同一手法）。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	EXPLORATORY_FINDINGS_SCHEMA_VERSION,
	ExploratoryFindingsCapOverflowError,
	mutateExploratoryFindingsState,
	readExploratoryFindingEntries,
	readExploratoryFindingsState,
} = await import("../../../src/state/exploratory-findings-store");

const WORKSPACE_ID = "workspace-exploratory";

function findingsFilePath(): string {
	return join(testRuntimeHome.path, "workspaces", WORKSPACE_ID, "exploratory-findings.json");
}

function makeEntry(overrides: Partial<RuntimeExploratoryFindingEntry> = {}): RuntimeExploratoryFindingEntry {
	return {
		findingId: "finding-1",
		findingTitle: "定下方向",
		findingBodyMarkdown: "正文",
		findingStatus: "active",
		supersededByFindingId: null,
		findingGenerationSource: "user_saved",
		provenanceLinks: [
			{
				linkKind: "turn_anchor",
				conversationSessionTaskId: "session-1",
				turnNumber: 1,
				turnCheckpointCommit: null,
			},
		],
		originConversationSessionTaskId: "session-1",
		createdAt: 1_000,
		updatedAt: 1_000,
		...overrides,
	};
}

function insertEntries(
	entries: RuntimeExploratoryFindingEntry[],
): (state: WorkspaceExploratoryFindingsState) => WorkspaceExploratoryFindingsState {
	return (state) => ({
		...state,
		findingsById: { ...state.findingsById, ...Object.fromEntries(entries.map((entry) => [entry.findingId, entry])) },
	});
}

describe("exploratory-findings-store", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "exploratory-findings-store-test-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
		testRuntimeHome.path = "";
	});

	it("文件不存在 → 读为空 state / entries 为空数组", async () => {
		const state = await readExploratoryFindingsState(WORKSPACE_ID);
		expect(state.schemaVersion).toBe(EXPLORATORY_FINDINGS_SCHEMA_VERSION);
		expect(state.findingsById).toEqual({});
		expect(await readExploratoryFindingEntries(WORKSPACE_ID)).toEqual([]);
	});

	it("mutate 写入后可读回；同一 findingId 幂等覆盖", async () => {
		await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries([makeEntry()]));
		expect((await readExploratoryFindingsState(WORKSPACE_ID)).findingsById["finding-1"]?.findingTitle).toBe(
			"定下方向",
		);

		await mutateExploratoryFindingsState(
			WORKSPACE_ID,
			insertEntries([makeEntry({ findingStatus: "archived", updatedAt: 2_000 })]),
		);
		const reread = await readExploratoryFindingsState(WORKSPACE_ID);
		expect(Object.keys(reread.findingsById)).toEqual(["finding-1"]);
		expect(reread.findingsById["finding-1"]?.findingStatus).toBe("archived");
		expect(await readExploratoryFindingEntries(WORKSPACE_ID)).toHaveLength(1);
	});

	it("mutator 返回 null → 无操作（不落盘）", async () => {
		const result = await mutateExploratoryFindingsState(WORKSPACE_ID, () => null);
		expect(result).toBeNull();
		const state = await readExploratoryFindingsState(WORKSPACE_ID);
		expect(state.findingsById).toEqual({});
	});

	it("损坏 JSON / schema 非法 → 读为空 state（损坏容错）", async () => {
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true }),
		);
		await writeFile(findingsFilePath(), "{ not json", "utf8");
		expect((await readExploratoryFindingsState(WORKSPACE_ID)).findingsById).toEqual({});

		await writeFile(findingsFilePath(), JSON.stringify({ schemaVersion: "nope" }), "utf8");
		expect((await readExploratoryFindingsState(WORKSPACE_ID)).findingsById).toEqual({});
	});

	it("路径遍历守卫：workspaceId 越出 workspaces 根即拒绝", async () => {
		await expect(readExploratoryFindingsState("../escape")).rejects.toThrow(/outside workspaces root/);
	});

	it("并发 mutate 经串行写队列按序应用", async () => {
		const [first, second] = await Promise.all([
			mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries([makeEntry({ findingId: "finding-a" })])),
			mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries([makeEntry({ findingId: "finding-b" })])),
		]);
		expect(Object.keys(first?.findingsById ?? {})).not.toContain("finding-b");
		const state = second ?? (await readExploratoryFindingsState(WORKSPACE_ID));
		expect(Object.keys(state.findingsById).sort()).toEqual(["finding-a", "finding-b"]);
	});

	it("mutate 结果过 schema 校验：非法条目直接抛错、不落盘", async () => {
		await expect(
			mutateExploratoryFindingsState(
				WORKSPACE_ID,
				insertEntries([{ findingId: "finding-bad" } as unknown as RuntimeExploratoryFindingEntry]),
			),
		).rejects.toThrow();
		const raw = await readFile(findingsFilePath(), "utf8").catch(() => null);
		expect(raw).toBeNull();
	});

	describe("cap-and-trim（上限 500，archived → superseded → 非 pending 最旧；pending 永不裁）", () => {
		it("先丢最旧 archived（即便它不是全局最旧）", async () => {
			const entries: RuntimeExploratoryFindingEntry[] = [
				// archived 的 updatedAt 最新，仍应第一个被裁。
				makeEntry({ findingId: "archived-newest", findingStatus: "archived", updatedAt: 999_000 }),
				...Array.from({ length: 500 }, (_, index) =>
					makeEntry({ findingId: `active-${index}`, updatedAt: 1_000 + index }),
				),
			];
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(entries));
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(500);
			expect(state.findingsById["archived-newest"]).toBeUndefined();
		});

		it("archived 裁完仍超限 → 丢最旧 superseded", async () => {
			const entries: RuntimeExploratoryFindingEntry[] = [
				makeEntry({ findingId: "archived-1", findingStatus: "archived", updatedAt: 100 }),
				makeEntry({
					findingId: "superseded-newest",
					findingStatus: "superseded",
					supersededByFindingId: "active-0",
					updatedAt: 999_000,
				}),
				...Array.from({ length: 500 }, (_, index) =>
					makeEntry({ findingId: `active-${index}`, updatedAt: 1_000 + index }),
				),
			];
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(entries));
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(500);
			expect(state.findingsById["archived-1"]).toBeUndefined();
			expect(state.findingsById["superseded-newest"]).toBeUndefined();
		});

		it("无 archived/superseded 可裁 → 丢最旧 updatedAt 的 active", async () => {
			const entries: RuntimeExploratoryFindingEntry[] = Array.from({ length: 501 }, (_, index) =>
				makeEntry({ findingId: `active-${index}`, updatedAt: 1_000 + index }),
			);
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(entries));
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			const keys = Object.keys(state.findingsById);
			expect(keys).toHaveLength(500);
			expect(keys).not.toContain("active-0");
			expect(keys).toContain("active-500");
		});

		it("suggested_pending_confirmation 永不静默裁（它等人拍板）", async () => {
			const entries: RuntimeExploratoryFindingEntry[] = [
				// pending 的 updatedAt 最旧，仍必须保住。
				makeEntry({
					findingId: "pending-oldest",
					findingStatus: "suggested_pending_confirmation",
					findingGenerationSource: "agent_suggested",
					updatedAt: 1,
				}),
				...Array.from({ length: 500 }, (_, index) =>
					makeEntry({ findingId: `active-${index}`, updatedAt: 1_000 + index }),
				),
			];
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(entries));
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(500);
			expect(state.findingsById["pending-oldest"]).toBeDefined();
			expect(state.findingsById["active-0"]).toBeUndefined();
		});

		it("全 pending 达上限后再写入 pending → 显式拒绝（CapOverflowError），不落盘不增长", async () => {
			// 「pending 永不静默裁」的代价：pending 占满上限时 cap 无可裁候选，唯一不丢数据的
			// 选择是显式拒绝——而不是放行让 pending 无界增长。
			const pendingEntries = Array.from({ length: 500 }, (_, index) =>
				makeEntry({
					findingId: `pending-${index}`,
					findingStatus: "suggested_pending_confirmation",
					findingGenerationSource: "agent_suggested",
					updatedAt: 1_000 + index,
				}),
			);
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(pendingEntries));
			await expect(
				mutateExploratoryFindingsState(
					WORKSPACE_ID,
					insertEntries([
						makeEntry({
							findingId: "pending-500",
							findingStatus: "suggested_pending_confirmation",
							findingGenerationSource: "agent_suggested",
							updatedAt: 2_000,
						}),
					]),
				),
			).rejects.toThrow(ExploratoryFindingsCapOverflowError);
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(500);
			expect(state.findingsById["pending-500"]).toBeUndefined();
		});

		it("全 pending 占满时写入的非 pending 条目仍被 cap 裁掉（store 不拦未传 guard 的写入）", async () => {
			// 分层钉牢：store 只做容量治理、不知道哪个条目是操作目标——cap 把刚写入的 active
			// 裁掉后总量回到 500（未比写入前更多），超限拒绝闸不触发。未传 postCapGuard 的写入
			// （如 ingest 通道：pending 永不进裁剪候选）照裁照落盘；「返回成功但 finding 消失」
			// 的拦截由调用方经 postCapGuard 在原子区内断言（见下一条用例与 handler 层）。
			const pendingEntries = Array.from({ length: 500 }, (_, index) =>
				makeEntry({
					findingId: `pending-${index}`,
					findingStatus: "suggested_pending_confirmation",
					findingGenerationSource: "agent_suggested",
					updatedAt: 1_000 + index,
				}),
			);
			await mutateExploratoryFindingsState(WORKSPACE_ID, insertEntries(pendingEntries));
			const next = await mutateExploratoryFindingsState(
				WORKSPACE_ID,
				insertEntries([makeEntry({ findingId: "active-new", updatedAt: 999_000 })]),
			);
			expect(next).not.toBeNull();
			expect(Object.keys(next?.findingsById ?? {})).toHaveLength(500);
			expect(next?.findingsById["active-new"]).toBeUndefined();
		});

		it("postCapGuard 竞态回归：存量超限 pending + confirm 语义触发裁剪 → guard 抛错、整体放弃写入（不落盘）", async () => {
			// 直写 501 条全 pending 存量（历史遗留，同「清理路径不堵死」用例的手法）。confirm
			// 语义把目标 pending → active 后，它成为 cap 唯一可裁候选、刚确认就被裁掉（501→500，
			// 未比写入前更多，超限拒绝闸不触发）。postCapGuard 必须在写盘前的原子区内抛出——
			// 整个 mutate 失败、文件保持 501 条全 pending 不变，绝不「报错但已静默删除」。
			await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
			const legacyEntries = Array.from({ length: 501 }, (_, index) =>
				makeEntry({
					findingId: `pending-${index}`,
					findingStatus: "suggested_pending_confirmation",
					findingGenerationSource: "agent_suggested",
					updatedAt: 1_000 + index,
				}),
			);
			await writeFile(
				findingsFilePath(),
				JSON.stringify({
					schemaVersion: EXPLORATORY_FINDINGS_SCHEMA_VERSION,
					findingsById: Object.fromEntries(legacyEntries.map((entry) => [entry.findingId, entry])),
				}),
				"utf8",
			);
			const targetId = "pending-500";
			await expect(
				mutateExploratoryFindingsState(
					WORKSPACE_ID,
					(state) => {
						const target = state.findingsById[targetId];
						if (target === undefined) {
							return null;
						}
						// confirm 语义：pending → active（updatedAt 推进）。
						return {
							...state,
							findingsById: {
								...state.findingsById,
								[targetId]: { ...target, findingStatus: "active", updatedAt: 999_000 },
							},
						};
					},
					(next) => {
						// 镜像 handler 层 assertFindingSurvivedCap 的判据。
						if (next.findingsById[targetId] === undefined) {
							throw new Error(`Finding "${targetId}" could not be persisted within the cap.`);
						}
					},
				),
			).rejects.toThrow(/could not be persisted/);
			// 不落盘：文件仍是 501 条全 pending，目标状态未被改写。
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(501);
			expect(state.findingsById[targetId]?.findingStatus).toBe("suggested_pending_confirmation");
		});

		it("存量超限（历史遗留）时让总量回落的写入仍放行（清理路径不堵死）", async () => {
			// 直写 502 条全 pending 存量（模拟旧版无闸时期写出的文件；现版本已写不出这种文件）。
			await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
			const legacyEntries = Array.from({ length: 502 }, (_, index) =>
				makeEntry({
					findingId: `pending-${index}`,
					findingStatus: "suggested_pending_confirmation",
					findingGenerationSource: "agent_suggested",
					updatedAt: 1_000 + index,
				}),
			);
			await writeFile(
				findingsFilePath(),
				JSON.stringify({
					schemaVersion: EXPLORATORY_FINDINGS_SCHEMA_VERSION,
					findingsById: Object.fromEntries(legacyEntries.map((entry) => [entry.findingId, entry])),
				}),
				"utf8",
			);
			// reject 语义（物理删除一条）：结果仍超限（501）但总量在回落 → 必须放行，否则
			// 存量超限的 workspace 永远无法经 reject 清回上限内。
			await mutateExploratoryFindingsState(WORKSPACE_ID, (state) => ({
				...state,
				findingsById: Object.fromEntries(
					Object.entries(state.findingsById).filter(([findingId]) => findingId !== "pending-0"),
				),
			}));
			const state = await readExploratoryFindingsState(WORKSPACE_ID);
			expect(Object.keys(state.findingsById)).toHaveLength(501);
		});
	});
});
