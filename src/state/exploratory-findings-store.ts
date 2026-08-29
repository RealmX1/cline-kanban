// Exploratory findings 的 per-workspace 持久化 store：每个 workspace 一份
// exploratory-findings.json（与 board.json / sessions.json / exploratory-session-maps.json 同级）。
//
// 设计蓝图：.plan/docs/exploratory-mode-session-map-and-findings-store.md §D。
// finding 存「会话过程沉淀的结论资产」（标题 + 正文 + provenance 链接 + 状态机）；
// session map 节点只持 referencedFindingId 引用，正文真相唯一在本 store（蓝图 §B.4）。
//
// 为什么不进 sessions.json：终端会话仅 shutdown 落盘，而 finding 资产必须独立于会话
// 生命周期存活（2h 宽限回收只杀会话进程，不动这份资产）——与 session map store 同理。
//
// 骨架（串行写队列 / 原子写 / 损坏容错 / 上限裁剪 / 路径遍历守卫）镜像
// exploratory-session-map-store.ts（其自身对齐 agent-raised-pending-user-decision-store.ts）。
//
// 写入纪律：全部写入（人工保存 saveFinding、确认/拒绝/归档、agent 建议 ingest）都落在
// 本模块的 mutate 原语之上；状态机裁决与 provenance 校验在 tRPC handler 层完成
// （src/trpc/exploratory-api.ts），store 只做形状校验与容量治理。

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type RuntimeExploratoryFindingEntry, runtimeExploratoryFindingEntrySchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "./workspace-state";

const EXPLORATORY_FINDINGS_FILENAME = "exploratory-findings.json";

// finding 条数上限（每 workspace）。裁剪序（cap-and-trim）：先丢最旧 archived（按 updatedAt
// 升序），仍超限再丢最旧 superseded，再仍超限丢最旧 updatedAt 的其余非 pending 条目；
// suggested_pending_confirmation 永不静默裁——它等人拍板，悄悄丢掉 = agent 的建议无声消失。
// 这条三级裁剪序是蓝图 §D.1「丢最旧 archived」的扩展裁决（蓝图只写了第一级）。
//
// 「pending 永不静默裁」的代价（容量取舍，蓝图 M2 实施注记 (1)）：容量被 pending 占满时
// cap 无可裁候选，此时唯一不丢数据的选择是显式拒绝让超限更糟的写入——抛
// ExploratoryFindingsCapOverflowError、不落盘、不广播，而不是放行让 pending 无界增长，
// 更不是「返回成功但 finding 消失」。注意判据是「仍超限且比写入前更多」：让总量回落的
// 写入（reject 物理删除等）即使结果仍超限也必须放行，否则存量超限（历史遗留）的
// workspace 会被堵死清理路径。另一条沉默路径（cap 裁掉本次操作刚写入/刚更新的非 pending
// 目标条目）由 mutate 原语的 postCapGuard 钩子兜住——store 只做容量治理、不知道哪个条目
// 是操作目标，目标存活断言由调用方经钩子在写盘前的原子区内执行（见 mutate 注释）。
const MAX_FINDINGS_PER_WORKSPACE = 500;

// 容量超限的可识别错误：只在「cap 后仍超限且条数比写入前更多」时抛出（可裁候选已枯竭、
// pending 占满上限）。tRPC handler 凭 instanceof 识别并翻译为业务拒绝
// （ingestFindingCandidate → rejectionReason "findings_cap_overflow"），绝不以
// 「返回成功但 finding 消失」收尾。
export class ExploratoryFindingsCapOverflowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExploratoryFindingsCapOverflowError";
	}
}

export const EXPLORATORY_FINDINGS_SCHEMA_VERSION = 1;

// 文件级包裹（schemaVersion 迁移位）；条目形状复用 api-contract 的 canonical schema。
const workspaceExploratoryFindingsStateFileSchema = z.object({
	schemaVersion: z.number().int().nonnegative(),
	findingsById: z.record(z.string(), runtimeExploratoryFindingEntrySchema),
});

export interface WorkspaceExploratoryFindingsState {
	schemaVersion: number;
	findingsById: Record<string, RuntimeExploratoryFindingEntry>;
}

function createEmptyExploratoryFindingsState(): WorkspaceExploratoryFindingsState {
	return {
		schemaVersion: EXPLORATORY_FINDINGS_SCHEMA_VERSION,
		findingsById: {},
	};
}

function getExploratoryFindingsPath(workspaceId: string): string {
	// 防路径遍历：与 exploratory-session-map-store 同一守卫（workspace 目录必须是 workspaces
	// 根的直接子目录）。本 store 的入口经 tRPC 从客户端 input 拿 workspaceId，故这条守卫是
	// 必需的、不是形式主义。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(`Refusing exploratory findings access outside workspaces root for workspaceId: ${workspaceId}`);
	}
	return join(workspaceDirectory, EXPLORATORY_FINDINGS_FILENAME);
}

async function readRawState(workspaceId: string): Promise<WorkspaceExploratoryFindingsState> {
	const path = getExploratoryFindingsPath(workspaceId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return createEmptyExploratoryFindingsState();
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch {
		// 损坏容错：不让一份坏文件炸掉整个读路径。代价是该 workspace 的 findings 不可见
		// （UI 降级为空列表）——比「把一份过期集合当真相」更安全的失败方向。
		return createEmptyExploratoryFindingsState();
	}
	const parsed = workspaceExploratoryFindingsStateFileSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : createEmptyExploratoryFindingsState();
}

async function writeState(workspaceId: string, state: WorkspaceExploratoryFindingsState): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getExploratoryFindingsPath(workspaceId), state, { lock: null });
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

function capFindings(state: WorkspaceExploratoryFindingsState): WorkspaceExploratoryFindingsState {
	const entries = Object.entries(state.findingsById);
	if (entries.length <= MAX_FINDINGS_PER_WORKSPACE) {
		return state;
	}
	// 裁剪序（注释见 MAX_FINDINGS_PER_WORKSPACE）：archived → superseded → 其余非 pending，
	// 各档内按 updatedAt 升序（最旧先丢）；pending 永不进候选。
	const removalCandidateIdsByStatus = (statuses: ReadonlyArray<RuntimeExploratoryFindingEntry["findingStatus"]>) =>
		entries
			.filter(([, entry]) => statuses.includes(entry.findingStatus))
			.sort((left, right) => left[1].updatedAt - right[1].updatedAt)
			.map(([findingId]) => findingId);
	const removalOrder = [
		...removalCandidateIdsByStatus(["archived"]),
		...removalCandidateIdsByStatus(["superseded"]),
		...removalCandidateIdsByStatus(["active"]),
	];
	const removedIds = new Set(removalOrder.slice(0, entries.length - MAX_FINDINGS_PER_WORKSPACE));
	return {
		...state,
		findingsById: Object.fromEntries(entries.filter(([findingId]) => !removedIds.has(findingId))),
	};
}

export async function readExploratoryFindingsState(workspaceId: string): Promise<WorkspaceExploratoryFindingsState> {
	return await readRawState(workspaceId);
}

export async function readExploratoryFindingEntries(workspaceId: string): Promise<RuntimeExploratoryFindingEntry[]> {
	const state = await readRawState(workspaceId);
	return Object.values(state.findingsById);
}

// 通用写原语（唯一写点）：读 → mutator → schema 校验 → 条数裁剪 → 超限拒绝闸 → 原子写。
// mutator 返回 null = 无操作（跳过写盘）。人工保存/确认/拒绝/归档与 agent 建议 ingest
// 全部建立在本原语之上（状态机裁决与 provenance 校验在 handler 层，蓝图 §D.2）。
//
// postCapGuard：cap 后、写盘前的校验钩子（串行写队列原子区内同步执行），抛错 = 整体放弃
// 写入（不落盘）。存在理由：「操作目标在 cap-and-trim 后仍存活」这类断言必须在本原子区内
// 做——在 mutate 返回后再查，裁剪结果早已落盘提交，报错路径会伴随静默删除（存量超限且
// pending 占满时，confirm/archive 先把目标变成可裁状态、cap 随即裁掉它）。store 仍然只做
// 容量治理、不知道哪个条目是操作目标；目标语义由调用方经钩子自带。
export async function mutateExploratoryFindingsState(
	workspaceId: string,
	mutator: (state: WorkspaceExploratoryFindingsState) => WorkspaceExploratoryFindingsState | null,
	postCapGuard?: (next: WorkspaceExploratoryFindingsState) => void,
): Promise<WorkspaceExploratoryFindingsState | null> {
	return await enqueueWrite(workspaceId, async () => {
		const current = await readRawState(workspaceId);
		const mutated = mutator(current);
		if (mutated === null) {
			return null;
		}
		const parsed = workspaceExploratoryFindingsStateFileSchema.parse(mutated);
		const next = capFindings(parsed);
		const nextCount = Object.keys(next.findingsById).length;
		if (nextCount > MAX_FINDINGS_PER_WORKSPACE && nextCount > Object.keys(current.findingsById).length) {
			// cap 后仍超限且比写入前更多 = 可裁候选（非 pending）已枯竭、pending 占满上限。
			// 显式拒绝本次写入（不落盘），容量取舍见 MAX_FINDINGS_PER_WORKSPACE 注释。
			throw new ExploratoryFindingsCapOverflowError(
				`Exploratory findings cap (${MAX_FINDINGS_PER_WORKSPACE}) exceeded for workspace "${workspaceId}": suggested_pending_confirmation entries are never trimmed silently and no trimmable entries remain. Confirm or reject some pending findings before adding more.`,
			);
		}
		postCapGuard?.(next);
		await writeState(workspaceId, next);
		return next;
	});
}
