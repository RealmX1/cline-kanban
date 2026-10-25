import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	buildCodexNativeAgentTurnExecutionIdentity,
	type CodexNativeAgentTurnExecutionObservation,
} from "../core/codex-native-agent-turn-execution-observation";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";

const loadedPageSchema = z.object({ data: z.array(z.string()), nextCursor: z.string().nullish() });
const latestTurnPageSchema = z.object({
	data: z.array(z.object({ id: z.string(), status: z.string(), startedAt: z.number().nullish() })),
});
const threadStateSchema = z.object({
	thread: z.object({
		id: z.string(),
		status: z.object({ type: z.string(), activeFlags: z.array(z.string()).optional() }),
		canAcceptDirectInput: z.boolean().optional(),
	}),
});

// 活动读取、静默扫描与回收前补证共享并发预算和同身份在途查询，不各自放大连接数。
let concurrentNativeObservationReadCount = 0;
const pendingNativeObservationReads: Array<() => void> = [];
const inFlightNativeExecutionReads = new Map<string, Promise<CodexNativeAgentTurnExecutionObservation | null>>();

export async function withCodexNativeObservationReadSlot<T>(operation: () => Promise<T>): Promise<T> {
	await new Promise<void>((resolve) => {
		const enter = () => {
			concurrentNativeObservationReadCount += 1;
			resolve();
		};
		if (concurrentNativeObservationReadCount < 4) enter();
		else pendingNativeObservationReads.push(enter);
	});
	try {
		return await operation();
	} finally {
		concurrentNativeObservationReadCount -= 1;
		pendingNativeObservationReads.shift()?.();
	}
}

export function readCodexNativeAgentTurnExecution(input: {
	workspaceId: string;
	summary: RuntimeTaskSessionSummary;
	observedAtMs: number;
	signal?: AbortSignal;
}): Promise<CodexNativeAgentTurnExecutionObservation | null> {
	const { summary } = input;
	const identity = summary.agentNativeConversationSessionIdentity;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (
		input.signal?.aborted ||
		summary.agentId !== "codex" ||
		identity?.sourceAgentId !== "codex" ||
		!identity.nativeSessionId ||
		!summary.runtimeSessionIncarnationId ||
		endpoint?.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return Promise.resolve(null);
	const key = buildCodexNativeAgentTurnExecutionIdentity(summary);
	const existing = inFlightNativeExecutionReads.get(key);
	if (existing) return existing;
	const nativeSessionId = identity.nativeSessionId;
	const incarnation = summary.runtimeSessionIncarnationId;
	const read = withCodexNativeObservationReadSlot(async () => {
		if (input.signal?.aborted) return null;
		return withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				let cursor: string | null = null;
				const seenCursors = new Set<string>();
				let loaded = false;
				for (let pageCount = 0; pageCount < 8; pageCount += 1) {
					const page = loadedPageSchema.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
					loaded = page.data.includes(nativeSessionId);
					if (loaded || !page.nextCursor) break;
					if (seenCursors.has(page.nextCursor)) return null;
					cursor = page.nextCursor;
					seenCursors.add(cursor);
				}
				if (!loaded) return null;
				// 仅取最新回合的轻量状态；超长消息页、历史游标和工具投影都不能挡住这条证据。
				const turns = latestTurnPageSchema.parse(
					await port.request("thread/turns/list", {
						threadId: nativeSessionId,
						cursor: null,
						limit: 1,
						sortDirection: "desc",
						itemsView: "summary",
					}),
				);
				const state = threadStateSchema.safeParse(
					await port.request("thread/read", { threadId: nativeSessionId, includeTurns: false }),
				);
				if (!state.success || state.data.thread.id !== nativeSessionId) return null;
				const thread = state.data.thread;
				const turn = turns.data[0];
				const activeFlags = thread.status.activeFlags ?? [];
				let executionStatus: CodexNativeAgentTurnExecutionObservation["executionStatus"] = "unknown";
				if (thread.status.type === "active" && turn?.status === "inProgress") {
					if (activeFlags.some((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)))
						executionStatus = "waiting_for_user";
					else if (activeFlags.length === 0) executionStatus = "running";
				} else if (
					thread.status.type === "idle" &&
					(!turn || ["completed", "interrupted", "failed"].includes(turn.status))
				)
					executionStatus = "finished";
				return {
					workspaceId: input.workspaceId,
					conversationSessionId: summary.taskId,
					runtimeSessionIncarnationId: incarnation,
					nativeSessionId,
					nativeTurnId: turn?.id ?? null,
					nativeTurnStartedAtMs: turn?.startedAt == null ? null : turn.startedAt * 1_000,
					observedAtMs: input.observedAtMs,
					threadStatus: thread.status.type,
					nativeTurnStatus: turn?.status ?? null,
					activeFlags,
					canAcceptDirectInput: thread.canAcceptDirectInput ?? null,
					executionStatus,
				};
			},
			{
				socketPath: endpoint.socketPath,
				clientName: "kanban_native_agent_turn_execution_observer",
				requestTimeoutMs: 2_000,
				signal: input.signal,
			},
		);
	});
	inFlightNativeExecutionReads.set(key, read);
	void read.finally(() => inFlightNativeExecutionReads.delete(key)).catch(() => {});
	return read;
}
