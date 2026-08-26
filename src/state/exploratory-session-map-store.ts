// Exploratory session map 的 per-workspace 持久化 store：每个 workspace 一份
// exploratory-session-maps.json（与 board.json / sessions.json 同级）。
//
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §B。
// map 存「锚点上的语义节点」（milestone / decision_point / open_question / digression /
// finding_reference），锚点基座（turn 序列与编号）的真相永远在服务端投影层——本 store
// 不另建 turn 编号体系、不存拓扑边。
//
// 为什么不进 sessions.json：终端会话仅 shutdown 落盘，而 map 资产必须独立于会话生命周期
// 存活（2h 宽限回收只杀会话进程，不动这份资产）。
//
// 骨架（串行写队列 / 原子写 / 损坏容错 / 上限裁剪 / 路径遍历守卫）镜像
// agent-raised-pending-user-decision-store.ts（其自身对齐 notification-log-store.ts）。
//
// 写入纪律：M0 只开放读路径与通用 mutate 漏斗；agent 写回通道（ingest + apply 漏斗
// 四道闸）属 M1，落在这里的 mutate 原语之上。节点数上限（200/会话）的「超限要求重整」
// 语义由 M1 的 apply 漏斗执行——store 原语不静默裁节点（那会丢叙事数据），只对
// 会话集合数做上限裁剪（丢最旧 updatedAt）。

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	type RuntimeExploratorySessionMapCollection,
	runtimeExploratorySessionMapCollectionSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "./workspace-state";

const EXPLORATORY_SESSION_MAPS_FILENAME = "exploratory-session-maps.json";

// 会话集合数上限（每 workspace）：超限丢最旧 updatedAt 的集合。
// 注意不是节点级裁剪——节点数上限（200/会话）的「超限要求重整」由 apply 漏斗执行（蓝图 §F）。
const MAX_SESSION_MAP_COLLECTIONS_PER_WORKSPACE = 100;

export const EXPLORATORY_SESSION_MAP_SCHEMA_VERSION = 1;

// 文件级包裹（schemaVersion 迁移位）；节点/集合形状复用 api-contract 的 canonical schema。
const workspaceExploratorySessionMapStateFileSchema = z.object({
	schemaVersion: z.number().int().nonnegative(),
	mapCollectionsByConversationSessionTaskId: z.record(z.string(), runtimeExploratorySessionMapCollectionSchema),
});

export interface WorkspaceExploratorySessionMapState {
	schemaVersion: number;
	mapCollectionsByConversationSessionTaskId: Record<string, RuntimeExploratorySessionMapCollection>;
}

function createEmptyExploratorySessionMapState(): WorkspaceExploratorySessionMapState {
	return {
		schemaVersion: EXPLORATORY_SESSION_MAP_SCHEMA_VERSION,
		mapCollectionsByConversationSessionTaskId: {},
	};
}

function getExploratorySessionMapsPath(workspaceId: string): string {
	// 防路径遍历：与 notification-log-store 同一守卫（workspace 目录必须是 workspaces 根的直接子目录）。
	// 本 store 的入口经 tRPC 从客户端 input 拿 workspaceId，故这条守卫是必需的、不是形式主义。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing exploratory session map access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, EXPLORATORY_SESSION_MAPS_FILENAME);
}

async function readRawState(workspaceId: string): Promise<WorkspaceExploratorySessionMapState> {
	const path = getExploratorySessionMapsPath(workspaceId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return createEmptyExploratorySessionMapState();
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch {
		// 损坏容错：不让一份坏文件炸掉整个读路径。代价是该 workspace 的 map 集合不可见
		// （UI 降级为裸投影骨架）——比「重复应用一份过期 map」更安全的失败方向。
		return createEmptyExploratorySessionMapState();
	}
	const parsed = workspaceExploratorySessionMapStateFileSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : createEmptyExploratorySessionMapState();
}

async function writeState(workspaceId: string, state: WorkspaceExploratorySessionMapState): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getExploratorySessionMapsPath(workspaceId), state, { lock: null });
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

function capSessionMapCollections(state: WorkspaceExploratorySessionMapState): WorkspaceExploratorySessionMapState {
	const entries = Object.entries(state.mapCollectionsByConversationSessionTaskId);
	if (entries.length <= MAX_SESSION_MAP_COLLECTIONS_PER_WORKSPACE) {
		return state;
	}
	const kept = entries
		.sort((left, right) => right[1].updatedAt - left[1].updatedAt)
		.slice(0, MAX_SESSION_MAP_COLLECTIONS_PER_WORKSPACE);
	return {
		...state,
		mapCollectionsByConversationSessionTaskId: Object.fromEntries(kept),
	};
}

export async function readExploratorySessionMapState(
	workspaceId: string,
): Promise<WorkspaceExploratorySessionMapState> {
	return await readRawState(workspaceId);
}

export async function readExploratorySessionMapCollection(
	workspaceId: string,
	conversationSessionTaskId: string,
): Promise<RuntimeExploratorySessionMapCollection | null> {
	const state = await readRawState(workspaceId);
	return state.mapCollectionsByConversationSessionTaskId[conversationSessionTaskId] ?? null;
}

// 通用写漏斗（M0 唯一写原语）：读 → mutator → schema 校验 → 集合数裁剪 → 原子写。
// mutator 返回 null = 无操作（跳过写盘）。M1 的 agent 写回 apply 漏斗（zod 白名单 →
// 锚点可解析性 → 签名对账 → user_manual_edit 冲突拒绝）建立在本原语之上。
export async function mutateExploratorySessionMapState(
	workspaceId: string,
	mutator: (state: WorkspaceExploratorySessionMapState) => WorkspaceExploratorySessionMapState | null,
): Promise<WorkspaceExploratorySessionMapState | null> {
	return await enqueueWrite(workspaceId, async () => {
		const current = await readRawState(workspaceId);
		const mutated = mutator(current);
		if (mutated === null) {
			return null;
		}
		const parsed = workspaceExploratorySessionMapStateFileSchema.parse(mutated);
		const next = capSessionMapCollections(parsed);
		await writeState(workspaceId, next);
		return next;
	});
}
