import { resolveLastEffectiveAgentConversationActivityObservation } from "../core/agent-conversation-activity-observation";
import {
	runtimeLastConversationProgressObservationSchema,
	runtimeLastEffectiveAgentConversationActivityObservationSchema,
	runtimeLastMainAgentConversationModelRequestDispatchObservationSchema,
} from "../core/api-contract";
import {
	getPersistedWorkspaceSessionsFilePathById,
	getWorkspaceStateSnapshotReadFingerprintById,
	loadPersistedWorkspaceSessionsJsonTextById,
} from "./workspace-state";

// sessions.json 是 taskId → 会话摘要的 record。这里只抽活动时间与最小归属事实：不走完整的 workspaceSessionsSchema
// （含 facet superRefine）+ backfillSessionFacets，只校验活动观测字段，不为整条摘要跑 zod——跨项目索引一次要读全部注册项目的
// sessions.json（实测 26 个项目合计约 28MB），按条 zod 解析比手写收窄慢约 10 倍（~40ms 对 ~4ms），
// 整条摘要的校验与回填在这里纯属白算，还会因为某条与本字段无关的历史畸形摘要把整个项目的推进时刻一起丢掉。

/**
 * 每个 workspace 上一次解析的结果，同时核对 commitId、提交日志与投影文件身份。
 *
 * 读盘 + JSON.parse 才是大头（28MB 实测约 200ms + 180ms，串行合计），而大多数项目没在跑会话、sessions.json
 * 长期不变：命中缓存时只核对小型 meta 与文件指纹。读取期间发生提交时不填入缓存，
 * 不会把旧内容挂在新 mtime 下。键是 workspaceId，被移除项目的条目不清理——每项目只保留会话活动时间与owner两张小表。
 */
export interface WorkspaceAgentConversationProgressAndOwnershipSnapshot {
	agentConversationProgressObservedAtByTaskId: ReadonlyMap<string, number>;
	// 无条目表示无metadata的legacy会话；null表示metadata存在但缺有效owner，必须拒绝归属。
	workspaceTaskIdByConversationSessionId: ReadonlyMap<string, string | null>;
}

interface CachedWorkspaceAgentConversationProgressObservedAtByTaskId {
	workspaceSnapshotReadFingerprint: string;
	snapshot: WorkspaceAgentConversationProgressAndOwnershipSnapshot;
}

const cachedAgentConversationProgressObservedAtByTaskIdByWorkspaceId = new Map<
	string,
	CachedWorkspaceAgentConversationProgressObservedAtByTaskId
>();

const EMPTY_AGENT_CONVERSATION_PROGRESS_AND_OWNERSHIP_SNAPSHOT: WorkspaceAgentConversationProgressAndOwnershipSnapshot =
	{
		agentConversationProgressObservedAtByTaskId: new Map(),
		workspaceTaskIdByConversationSessionId: new Map(),
	};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只读取统一有效活动，兼容旧推进观测；从不回落到可能被重播刷新的实质输出时间。 */
function extractAgentConversationProgressObservedAtMs(rawSessionSummary: unknown): number | null {
	if (!isPlainRecord(rawSessionSummary)) return null;
	// 仅校验三个小观测，不运行整条 summary 的 facet 回填；信任与迁移规则复用同一 resolver。
	if (rawSessionSummary.lastEffectiveAgentConversationActivityObservation !== undefined) {
		const parsed = runtimeLastEffectiveAgentConversationActivityObservationSchema.safeParse(
			rawSessionSummary.lastEffectiveAgentConversationActivityObservation,
		);
		return parsed.success
			? (resolveLastEffectiveAgentConversationActivityObservation({
					lastEffectiveAgentConversationActivityObservation: parsed.data,
				})?.observedAtMs ?? null)
			: null;
	}
	const progress = runtimeLastConversationProgressObservationSchema.safeParse(
		rawSessionSummary.lastConversationProgressObservation,
	);
	const request = runtimeLastMainAgentConversationModelRequestDispatchObservationSchema.safeParse(
		rawSessionSummary.lastMainAgentConversationModelRequestDispatchObservation,
	);
	return (
		resolveLastEffectiveAgentConversationActivityObservation({
			lastConversationProgressObservation: progress.success ? progress.data : null,
			lastMainAgentConversationModelRequestDispatchObservation: request.success ? request.data : null,
		})?.observedAtMs ?? null
	);
}

function parseAgentConversationProgressAndOwnershipSnapshot(
	sessionsPath: string,
	rawSessionsFileText: string,
): WorkspaceAgentConversationProgressAndOwnershipSnapshot {
	const persistedWorkspaceSessionsRecord: unknown = JSON.parse(rawSessionsFileText);
	if (!isPlainRecord(persistedWorkspaceSessionsRecord)) {
		throw new Error(`Expected a task-keyed session summary record in ${sessionsPath}.`);
	}
	const agentConversationProgressObservedAtByTaskId = new Map<string, number>();
	const workspaceTaskIdByConversationSessionId = new Map<string, string | null>();
	for (const [taskId, rawSessionSummary] of Object.entries(persistedWorkspaceSessionsRecord)) {
		if (isPlainRecord(rawSessionSummary) && rawSessionSummary.taskConversationSessionMetadata !== undefined) {
			const metadata = rawSessionSummary.taskConversationSessionMetadata;
			workspaceTaskIdByConversationSessionId.set(
				taskId,
				isPlainRecord(metadata) &&
					typeof metadata.workspaceTaskId === "string" &&
					metadata.workspaceTaskId.length > 0
					? metadata.workspaceTaskId
					: null,
			);
		}
		const observedAtMs = extractAgentConversationProgressObservedAtMs(rawSessionSummary);
		if (observedAtMs !== null) {
			agentConversationProgressObservedAtByTaskId.set(taskId, observedAtMs);
		}
	}
	return { agentConversationProgressObservedAtByTaskId, workspaceTaskIdByConversationSessionId };
}

/**
 * 读盘上 sessions.json，返回同一版本的会话活动时间与声明owner快照。
 *
 * - 文件不存在（项目从没起过会话）→ 空表；
 * - 单条摘要缺这个量或形状不对 → 只跳过那一条（纯展示 / 排序用的量，不值得为一条坏数据丢掉整个项目）；
 * - 文件读不了、JSON 坏掉、顶层不是 record → throw，由调用方决定降级方式（跨项目索引：告警 + 按空表继续）。
 *
 * 只读、无锁：提交日志优先，读取围栏排除投影期间的混合版本。已加载项目的权威是内存摘要，调用方须用它覆盖本表
 * （见 all-projects-task-search-index-projection 的 overlay），本表只是未加载项目与内存缺条目时的回落。
 * 返回值可能是缓存里的同一张表，调用方只能读、不能改。
 */
export async function loadWorkspaceAgentConversationProgressAndOwnershipSnapshot(
	workspaceId: string,
): Promise<WorkspaceAgentConversationProgressAndOwnershipSnapshot> {
	const sessionsPath = getPersistedWorkspaceSessionsFilePathById(workspaceId);
	const workspaceSnapshotReadFingerprint = await getWorkspaceStateSnapshotReadFingerprintById(workspaceId);
	const cachedEntry = cachedAgentConversationProgressObservedAtByTaskIdByWorkspaceId.get(workspaceId);
	if (cachedEntry?.workspaceSnapshotReadFingerprint === workspaceSnapshotReadFingerprint) return cachedEntry.snapshot;
	const rawSessionsFileText = await loadPersistedWorkspaceSessionsJsonTextById(workspaceId);
	if (rawSessionsFileText === null) {
		cachedAgentConversationProgressObservedAtByTaskIdByWorkspaceId.delete(workspaceId);
		return EMPTY_AGENT_CONVERSATION_PROGRESS_AND_OWNERSHIP_SNAPSHOT;
	}
	const snapshot = parseAgentConversationProgressAndOwnershipSnapshot(sessionsPath, rawSessionsFileText);
	if (workspaceSnapshotReadFingerprint === (await getWorkspaceStateSnapshotReadFingerprintById(workspaceId))) {
		cachedAgentConversationProgressObservedAtByTaskIdByWorkspaceId.set(workspaceId, {
			workspaceSnapshotReadFingerprint,
			snapshot,
		});
	}
	return snapshot;
}

/** 兼容旧调用者；与归属snapshot共用同一次读取及快照版本缓存。 */
export async function loadWorkspaceAgentConversationProgressObservedAtByTaskId(
	workspaceId: string,
): Promise<ReadonlyMap<string, number>> {
	return (await loadWorkspaceAgentConversationProgressAndOwnershipSnapshot(workspaceId))
		.agentConversationProgressObservedAtByTaskId;
}
