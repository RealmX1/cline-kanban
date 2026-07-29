// 「agent 会话停止生成响应后固定宽限期回收」的期限账本：每个 workspace 一个
// agent-session-reclamation-deadlines.json（与 board.json / notifications.json 同级）。
//
// 为什么不复用 sessions.json：那个文件在本仓现场已有 677 条 / 1.59 MB，且**只在 graceful shutdown
// 写**。把「每次进入/离开非生成态」改成往它上面落盘 = 每次状态边沿重写 1.6 MB 并抢 lockedFileSystem
// 的跨进程锁，直接撞上 AGENTS.md 记录的「锁 compromise → uncaughtException → 全服退出」放大器。
// 故另起一个小文件：写入频率是人类尺度事件（分钟级），条目是每 workspace 几十条。
//
// 骨架（串行写队列 / 原子写 / 损坏容错 / 上限裁剪 / 路径遍历守卫）刻意逐字对齐
// notification-log-store.ts —— 那条路径已被验证「落库发生在 runtime-state-hub 的 0 客户端提前返回
// 之前」，即与 viewer 是否在看完全无关，正是本机制的硬性要求。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	type RuntimeAgentResponseGenerationStopSignalConfidence,
	type RuntimeAgentSessionTransport,
	runtimeAgentIdSchema,
	runtimeAgentResponseGenerationStopSignalConfidenceSchema,
	runtimeAgentSessionTransportSchema,
} from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath, listWorkspaceIndexEntries } from "./workspace-state";

const AGENT_SESSION_RECLAMATION_DEADLINE_FILENAME = "agent-session-reclamation-deadlines.json";

// 每 workspace 上限。终态记录（reclaimed / superseded）留作审计轨迹，超限丢最旧。
const MAX_RECORDS_PER_WORKSPACE = 200;

export const AGENT_SESSION_RECLAMATION_DEADLINE_SCHEMA_VERSION = 1;

// 计时锚点的来源。两条轨道刻意分开命名，因为它们的到期语义与用户可见措辞都不同：
//   - agent_response_generation_stopped：agent 结束了这一轮（含「等人回答」），走统一宽限期；
//   - session_parked_awaiting_dispatched_background_work：主 agent 在等自己派发的后台工作，
//     走 park 独立兜底上限，到期记为 park_abandoned。
export const agentSessionRetentionAnchorKindSchema = z.enum([
	"agent_response_generation_stopped",
	"session_parked_awaiting_dispatched_background_work",
]);
export type AgentSessionRetentionAnchorKind = z.infer<typeof agentSessionRetentionAnchorKindSchema>;

export const agentSessionReclamationStateSchema = z.enum([
	// 宽限期计时中（唯一的「live」状态，每 task 至多一条）。
	"grace_running",
	// 回收执行中。进程重启后扫描看到它 ⇒ 回收过程中崩溃过，需重跑幂等回收。
	"reclaiming",
	// 已确认回收（终态）。
	"reclaimed",
	// 回收失败，等退避重试（仍是 live 状态：nextReclaimRetryAt 到点会再试）。
	"reclaim_failed",
	// 会话在到期前继续跑了 / 被更新的记录取代（终态）。
	"superseded",
]);
export type AgentSessionReclamationState = z.infer<typeof agentSessionReclamationStateSchema>;

// 「仍需调度器关注」的状态集合。终态（reclaimed / superseded）之外的都算。
const LIVE_RECLAMATION_STATES: readonly AgentSessionReclamationState[] = [
	"grace_running",
	"reclaiming",
	"reclaim_failed",
];

export function isLiveAgentSessionReclamationState(state: AgentSessionReclamationState): boolean {
	return LIVE_RECLAMATION_STATES.includes(state);
}

const persistedAgentSessionReclamationDeadlineRecordSchema = z.object({
	// 稳定记录 id = `${taskId}:${runtimeSessionIncarnationId}:${agentResponseGenerationTurnSequence}`。
	// 同一活体同一轮重复观测到停止事件时据此幂等，不追加第二条。
	recordId: z.string(),
	taskId: z.string(),
	agentId: runtimeAgentIdSchema.nullable(),
	sessionTransport: runtimeAgentSessionTransportSchema,
	runtimeSessionIncarnationId: z.string(),
	agentResponseGenerationTurnSequence: z.number().int().nonnegative(),
	retentionAnchorKind: agentSessionRetentionAnchorKindSchema,
	// 计时起点（epoch ms）：停止事件时刻，或 park 置位时刻。
	retentionAnchorAt: z.number(),
	// 仅 agent_response_generation_stopped 轨道有意义；park 轨道为 null。
	responseGenerationStopSignalConfidence: runtimeAgentResponseGenerationStopSignalConfidenceSchema.nullable(),
	// 可回收时刻（绝对 epoch ms）。null = 显式无期限（park --no-expiry）⇒ 永不到期。
	reclamationEligibleAt: z.number().nullable(),
	reclamationState: agentSessionReclamationStateSchema,
	reclamationAttemptCount: z.number().int().nonnegative(),
	nextReclaimRetryAt: z.number().nullable(),
	lastReclaimFailureReason: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	schemaVersion: z.number().int().nonnegative(),
});
export type PersistedAgentSessionReclamationDeadlineRecord = z.infer<
	typeof persistedAgentSessionReclamationDeadlineRecordSchema
>;

const persistedAgentSessionReclamationDeadlineFileSchema = z.array(
	persistedAgentSessionReclamationDeadlineRecordSchema,
);

export interface RecordAgentSessionRetentionDeadlineInput {
	taskId: string;
	agentId: z.infer<typeof runtimeAgentIdSchema> | null;
	sessionTransport: RuntimeAgentSessionTransport;
	runtimeSessionIncarnationId: string;
	agentResponseGenerationTurnSequence: number;
	retentionAnchorKind: AgentSessionRetentionAnchorKind;
	retentionAnchorAt: number;
	responseGenerationStopSignalConfidence: RuntimeAgentResponseGenerationStopSignalConfidence | null;
	reclamationEligibleAt: number | null;
	recordedAt: number;
}

export interface UpdateAgentSessionReclamationProgressInput {
	reclamationState: AgentSessionReclamationState;
	updatedAt: number;
	incrementAttemptCount?: boolean;
	nextReclaimRetryAt?: number | null;
	lastReclaimFailureReason?: string | null;
}

export function buildAgentSessionReclamationDeadlineRecordId(input: {
	taskId: string;
	runtimeSessionIncarnationId: string;
	agentResponseGenerationTurnSequence: number;
}): string {
	return `${input.taskId}:${input.runtimeSessionIncarnationId}:${input.agentResponseGenerationTurnSequence}`;
}

function getAgentSessionReclamationDeadlinePath(workspaceId: string): string {
	// 防路径遍历：与 notification-log-store 同一守卫——要求 workspace 目录必须是 workspaces 根的
	// 直接子目录。本 store 的 workspaceId 目前只来自服务端内部，但守卫是 root-cause 型 choke point，
	// 未来若经 tRPC input 传入也不会开洞。
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	const workspacesRoot = resolve(getWorkspacesRootPath());
	if (dirname(workspaceDirectory) !== workspacesRoot) {
		throw new Error(
			`Refusing agent session reclamation deadline access outside workspaces root for workspaceId: ${workspaceId}`,
		);
	}
	return join(workspaceDirectory, AGENT_SESSION_RECLAMATION_DEADLINE_FILENAME);
}

async function readRawRecords(workspaceId: string): Promise<PersistedAgentSessionReclamationDeadlineRecord[]> {
	const path = getAgentSessionReclamationDeadlinePath(workspaceId);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw) as unknown;
	} catch {
		// fail-open：期限账本损坏时按「无待回收记录」处理，宁可少回收也不阻断启动、更不误杀。
		return [];
	}
	const parsed = persistedAgentSessionReclamationDeadlineFileSchema.safeParse(parsedJson);
	return parsed.success ? parsed.data : [];
}

async function writeRecords(
	workspaceId: string,
	records: PersistedAgentSessionReclamationDeadlineRecord[],
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getAgentSessionReclamationDeadlinePath(workspaceId), records, {
		lock: null,
	});
}

// 每工作区 in-process 串行队列（Promise 链），把 read-modify-write 串起来防并发写互覆盖。
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

function capRecords(
	records: PersistedAgentSessionReclamationDeadlineRecord[],
): PersistedAgentSessionReclamationDeadlineRecord[] {
	if (records.length <= MAX_RECORDS_PER_WORKSPACE) {
		return records;
	}
	return records.slice(records.length - MAX_RECORDS_PER_WORKSPACE);
}

export async function readAgentSessionReclamationDeadlineRecords(
	workspaceId: string,
): Promise<PersistedAgentSessionReclamationDeadlineRecord[]> {
	return await readRawRecords(workspaceId);
}

// 聚合全部 workspace（进程启动时的回收期限恢复扫描用）。只返回「有记录」的 workspace。
export async function readAllAgentSessionReclamationDeadlineRecords(): Promise<
	Record<string, PersistedAgentSessionReclamationDeadlineRecord[]>
> {
	const indexEntries = await listWorkspaceIndexEntries();
	const result: Record<string, PersistedAgentSessionReclamationDeadlineRecord[]> = {};
	await Promise.all(
		indexEntries.map(async (entry) => {
			const records = await readRawRecords(entry.workspaceId);
			if (records.length > 0) {
				result[entry.workspaceId] = records;
			}
		}),
	);
	return result;
}

// 纯函数：取某 task 当前唯一的 live 记录（不变量——每 task 至多一条，由下面的写入路径保证）。
export function findLiveAgentSessionReclamationDeadlineRecord(
	records: readonly PersistedAgentSessionReclamationDeadlineRecord[],
	taskId: string,
): PersistedAgentSessionReclamationDeadlineRecord | null {
	return (
		records.find(
			(record) => record.taskId === taskId && isLiveAgentSessionReclamationState(record.reclamationState),
		) ?? null
	);
}

// 落一条新的计时记录。同 task 既有的 live 记录一律先置 superseded，以维持「每 task 至多一条 live」。
// 同 recordId（同活体同一轮）重复调用是幂等的：只刷新期限相关字段，不追加第二条。
export async function recordAgentSessionRetentionDeadline(
	workspaceId: string,
	input: RecordAgentSessionRetentionDeadlineInput,
): Promise<PersistedAgentSessionReclamationDeadlineRecord> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawRecords(workspaceId);
		const recordId = buildAgentSessionReclamationDeadlineRecordId(input);
		const existing = records.find((record) => record.recordId === recordId);
		if (existing !== undefined && isLiveAgentSessionReclamationState(existing.reclamationState)) {
			const refreshed: PersistedAgentSessionReclamationDeadlineRecord = {
				...existing,
				retentionAnchorKind: input.retentionAnchorKind,
				retentionAnchorAt: input.retentionAnchorAt,
				responseGenerationStopSignalConfidence: input.responseGenerationStopSignalConfidence,
				reclamationEligibleAt: input.reclamationEligibleAt,
				updatedAt: input.recordedAt,
			};
			await writeRecords(
				workspaceId,
				records.map((record) => (record.recordId === recordId ? refreshed : record)),
			);
			return refreshed;
		}
		const nextRecord: PersistedAgentSessionReclamationDeadlineRecord = {
			recordId,
			taskId: input.taskId,
			agentId: input.agentId,
			sessionTransport: input.sessionTransport,
			runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
			agentResponseGenerationTurnSequence: input.agentResponseGenerationTurnSequence,
			retentionAnchorKind: input.retentionAnchorKind,
			retentionAnchorAt: input.retentionAnchorAt,
			responseGenerationStopSignalConfidence: input.responseGenerationStopSignalConfidence,
			reclamationEligibleAt: input.reclamationEligibleAt,
			reclamationState: "grace_running",
			reclamationAttemptCount: 0,
			nextReclaimRetryAt: null,
			lastReclaimFailureReason: null,
			createdAt: input.recordedAt,
			updatedAt: input.recordedAt,
			schemaVersion: AGENT_SESSION_RECLAMATION_DEADLINE_SCHEMA_VERSION,
		};
		const withSuperseded = records.map((record) =>
			record.taskId === input.taskId &&
			record.recordId !== recordId &&
			isLiveAgentSessionReclamationState(record.reclamationState)
				? { ...record, reclamationState: "superseded" as const, updatedAt: input.recordedAt }
				: record,
		);
		await writeRecords(
			workspaceId,
			capRecords([...withSuperseded.filter((r) => r.recordId !== recordId), nextRecord]),
		);
		return nextRecord;
	});
}

// 会话在到期前继续跑了（用户提交 / agent 复生 / unpark）⇒ 作废该 task 的全部 live 期限记录。
// 返回被作废的记录数，便于调用方与测试断言「确实作废过」。
export async function supersedeAgentSessionRetentionDeadlinesForTask(
	workspaceId: string,
	taskId: string,
	supersededAt: number,
): Promise<number> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawRecords(workspaceId);
		let supersededCount = 0;
		const nextRecords = records.map((record) => {
			if (record.taskId === taskId && isLiveAgentSessionReclamationState(record.reclamationState)) {
				supersededCount += 1;
				return { ...record, reclamationState: "superseded" as const, updatedAt: supersededAt };
			}
			return record;
		});
		if (supersededCount === 0) {
			return 0;
		}
		await writeRecords(workspaceId, nextRecords);
		return supersededCount;
	});
}

// 推进单条记录的回收状态机（reclaiming / reclaimed / reclaim_failed / superseded）。
export async function updateAgentSessionReclamationProgress(
	workspaceId: string,
	recordId: string,
	input: UpdateAgentSessionReclamationProgressInput,
): Promise<PersistedAgentSessionReclamationDeadlineRecord | null> {
	return await enqueueWrite(workspaceId, async () => {
		const records = await readRawRecords(workspaceId);
		const existing = records.find((record) => record.recordId === recordId);
		if (existing === undefined) {
			return null;
		}
		const updated: PersistedAgentSessionReclamationDeadlineRecord = {
			...existing,
			reclamationState: input.reclamationState,
			reclamationAttemptCount:
				input.incrementAttemptCount === true
					? existing.reclamationAttemptCount + 1
					: existing.reclamationAttemptCount,
			nextReclaimRetryAt:
				input.nextReclaimRetryAt !== undefined ? input.nextReclaimRetryAt : existing.nextReclaimRetryAt,
			lastReclaimFailureReason:
				input.lastReclaimFailureReason !== undefined
					? input.lastReclaimFailureReason
					: existing.lastReclaimFailureReason,
			updatedAt: input.updatedAt,
		};
		await writeRecords(
			workspaceId,
			records.map((record) => (record.recordId === recordId ? updated : record)),
		);
		return updated;
	});
}

export async function clearAgentSessionReclamationDeadlineRecords(workspaceId: string): Promise<void> {
	await enqueueWrite(workspaceId, async () => {
		await writeRecords(workspaceId, []);
	});
}
