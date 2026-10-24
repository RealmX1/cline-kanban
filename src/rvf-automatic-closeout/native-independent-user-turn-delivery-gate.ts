import { z } from "zod";
import type { QueuedTaskPromptDeliveryEntry, RuntimeTaskSessionSummary } from "../core/api-contract";
import { CodexAppServerControlSocketRequestError } from "./codex-app-server-control-socket-request-connection";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import { type CodexNativeConversationTurn, readCodexConversationTurns } from "./codex-native-conversation-prefix";

export type NativeIndependentUserTurnDeliveryFailureReason =
	| "native_independent_user_turn_capability_unavailable"
	| "native_independent_user_turn_session_replaced";

export class NativeIndependentUserTurnDeliveryError extends Error {
	constructor(
		public readonly reason: NativeIndependentUserTurnDeliveryFailureReason,
		message: string,
		public readonly recovery: { retryableQueryFailure: boolean } = { retryableQueryFailure: false },
	) {
		super(message);
	}
}

// 此结果只表示该条正文已进入新原生回合，不替代 capture 的唯一消息/checkpoint/nonce 门禁。
export class NativeIndependentUserTurnMessageAlreadyAccepted extends Error {}

// 仅终止本 runtime 的只读等待；原队列和回执由新托管者或截止收敛继续负责。
export class NativeIndependentUserTurnSubmissionRecoverySuspended extends Error {}

export class NativeIndependentUserTurnDeliveryCancelledBeforeSubmission extends Error {}

export async function readCurrentTuiNativeConversationTurns(input: {
	workspaceId: string;
	entry: QueuedTaskPromptDeliveryEntry;
	getSummary: () => RuntimeTaskSessionSummary | null;
}): Promise<CodexNativeConversationTurn[]> {
	const { entry } = input;
	const summary = input.getSummary();
	const endpoint = summary?.codexNativeSessionControlEndpoint
		? { ...summary.codexNativeSessionControlEndpoint }
		: null;
	const observedStartedAt = summary?.startedAt;
	const observedIncarnationId = summary?.runtimeSessionIncarnationId;
	const observedTranscriptPath = summary?.agentNativeConversationSessionIdentity?.transcriptPath;
	const requiredNativeSessionId = entry.requiredNativeIndependentUserTurnSessionId;
	if (
		!requiredNativeSessionId ||
		!summary ||
		summary.agentId !== "codex" ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !==
			entry.requiredNativeIndependentUserTurnSessionId ||
		summary.runtimeSessionIncarnationId !== entry.requiredNativeIndependentUserTurnSessionIncarnationId
	)
		throw new NativeIndependentUserTurnDeliveryError(
			"native_independent_user_turn_session_replaced",
			"要求独立回合的原生会话或代次已改变，未投递。",
		);
	if (
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== entry.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		throw new NativeIndependentUserTurnDeliveryError(
			"native_independent_user_turn_capability_unavailable",
			"本代 TUI 缺少与当前会话绑定的实时控制面，未投递。",
		);
	let turns: CodexNativeConversationTurn[];
	try {
		turns = await withRunningCodexAppServerControlSocketConnection(
			async (port) => {
				let cursor: string | null = null;
				const seen = new Set<string>();
				let loaded = false;
				do {
					const page = z
						.object({ data: z.array(z.string()), nextCursor: z.string().nullable().optional() })
						.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
					loaded ||= page.data.includes(requiredNativeSessionId);
					cursor = page.nextCursor ?? null;
					if (cursor && seen.has(cursor)) throw new Error("原生已加载会话分页循环。");
					if (cursor) seen.add(cursor);
				} while (cursor);
				if (!loaded) throw new Error("当前 TUI 没有加载要求的原生会话。");
				return readCodexConversationTurns(port, requiredNativeSessionId);
			},
			{ socketPath: endpoint.socketPath },
		);
	} catch (error) {
		throw new NativeIndependentUserTurnDeliveryError(
			"native_independent_user_turn_capability_unavailable",
			`无法读取当前 TUI 原生回合，未投递：${error instanceof Error ? error.message : String(error)}`,
			{
				retryableQueryFailure:
					error instanceof CodexAppServerControlSocketRequestError &&
					["request_timeout", "connection_timeout", "connection_error", "connection_closed"].includes(
						error.outcome,
					),
			},
		);
	}
	const latest = input.getSummary();
	if (
		!latest ||
		latest.startedAt !== observedStartedAt ||
		latest.runtimeSessionIncarnationId !== observedIncarnationId ||
		latest.agentNativeConversationSessionIdentity?.nativeSessionId !==
			entry.requiredNativeIndependentUserTurnSessionId ||
		latest.agentNativeConversationSessionIdentity?.transcriptPath !== observedTranscriptPath ||
		latest.codexNativeSessionControlEndpoint?.socketPath !== endpoint.socketPath ||
		latest.codexNativeSessionControlEndpoint?.runtimeSessionIncarnationId !== endpoint.runtimeSessionIncarnationId
	)
		throw new NativeIndependentUserTurnDeliveryError(
			"native_independent_user_turn_session_replaced",
			"查询期间原生会话或控制面已替换，未投递。",
		);
	return turns;
}

export function assertIndependentUserTurnImmediatelyBeforeTerminalWrite(input: {
	turns: CodexNativeConversationTurn[];
	predecessorTurnId: string;
	text: string;
}): void {
	const latest = input.turns.at(-1);
	if (latest?.id === input.predecessorTurnId && latest.status === "completed") return;
	const predecessorIndex = input.turns.findIndex((turn) => turn.id === input.predecessorTurnId);
	const successors = input.turns.slice(predecessorIndex + 1);
	const users = successors.flatMap((turn) => turn.items.filter((item) => item.type === "userMessage"));
	if (
		predecessorIndex >= 0 &&
		successors.length === 1 &&
		users.length === 1 &&
		users[0].content?.every((part) => ["text", "input_text"].includes(part.type) && typeof part.text === "string") &&
		users[0].content?.map((part) => part.text).join("") === input.text
	)
		throw new NativeIndependentUserTurnMessageAlreadyAccepted("本条消息已进入后继原生回合，停止补发回车。");
	throw new NativeIndependentUserTurnDeliveryError(
		"native_independent_user_turn_session_replaced",
		"提交前原生回合已推进或回退，未继续写入。",
	);
}
