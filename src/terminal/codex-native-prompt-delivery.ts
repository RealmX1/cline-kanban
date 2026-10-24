import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { CodexNativePromptDeliveryEvidence, RuntimeTaskSessionSummary } from "../core/api-contract";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import type { CodexAppServerRequestPort } from "../rvf-automatic-closeout/codex-native-conversation-prefix";

export type { CodexNativePromptDeliveryEvidence };

const CONFIRMATION_BUDGET_MS = 15_000;
const CONFIRMATION_RECHECK_MS = 250;
const loadedPageSchema = z.object({ data: z.array(z.string()), nextCursor: z.string().nullable() });
const nativeMessageSchema = z.object({
	id: z.string().min(1),
	type: z.string(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
});
const nativeTurnsPageSchema = z.object({
	data: z.array(
		z.object({
			id: z.string().min(1),
			status: z.enum(["completed", "inProgress", "interrupted", "failed"]),
			items: z.array(nativeMessageSchema),
		}),
	),
	nextCursor: z.string().nullable(),
});
const threadIdentitySchema = z.object({ thread: z.object({ id: z.string(), cwd: z.string() }) });
const submittedTurnSchema = z.object({ turn: z.object({ id: z.string() }) });

async function isThreadAlreadyLoaded(
	port: CodexAppServerRequestPort,
	threadId: string,
	mayContinuePreflight: () => boolean,
): Promise<boolean> {
	let cursor: string | null = null;
	const seenCursors = new Set<string>();
	do {
		const page = loadedPageSchema.parse(await port.request("thread/loaded/list", { cursor, limit: 100 }));
		if (page.data.includes(threadId)) return true;
		cursor = page.nextCursor;
		if (cursor !== null) {
			if (seenCursors.has(cursor)) return false;
			seenCursors.add(cursor);
		}
	} while (cursor !== null && seenCursors.size < 100 && mayContinuePreflight());
	return false;
}

async function canonicalWorkingDirectory(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

export type CodexNativePromptDeliveryResult =
	| { status: "confirmed"; evidence: CodexNativePromptDeliveryEvidence }
	| { status: "unavailable" | "not_ready" | "cancelled" }
	| { status: "unconfirmed" };

export interface CodexNativePromptDeliveryInput {
	summary: RuntimeTaskSessionSummary;
	workspaceId: string;
	text: string;
	clientUserMessageId: string;
	isCurrent: () => boolean;
	beforeSubmit: () => Promise<boolean>;
	onRequestAttempted: (observation?: { predecessorNativeTurnId: string | null }) => void | Promise<void>;
	// 只改变等待策略；真实 userMessage 核验与“不重复 turn/start”仍由本模块负责。
	confirmationDeadlineAtEpochMs?: () => Promise<number>;
	onNativeTurnStarted?: (nativeTurnId: string) => Promise<void>;
	previouslySubmitted?: { predecessorNativeTurnId: string | null; nativeTurnId: string | null };
	now?: () => number;
	waitMilliseconds?: (milliseconds: number) => Promise<void>;
}

export async function deliverCodexNativePromptWithoutChangingComposer(
	input: CodexNativePromptDeliveryInput,
): Promise<CodexNativePromptDeliveryResult> {
	const { summary } = input;
	const workingDirectoryPath = summary.workspacePath;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	const identity = summary.agentNativeConversationSessionIdentity;
	if (
		summary.agentId !== "codex" ||
		!workingDirectoryPath ||
		identity?.sourceAgentId !== "codex" ||
		!identity.nativeSessionId ||
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return { status: "unavailable" };
	const nativeSessionId = identity.nativeSessionId;
	const now = input.now ?? Date.now;
	const waitMilliseconds =
		input.waitMilliseconds ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
	let requestAttempted = input.previouslySubmitted !== undefined;
	let returnedTurnId: string | null = input.previouslySubmitted?.nativeTurnId ?? null;
	let previousTurnId: string | null = input.previouslySubmitted?.predecessorNativeTurnId ?? null;
	let currentDeliveryPhaseDeadlineEpochMs = now() + CONFIRMATION_BUDGET_MS;
	const currentDeadline = async () =>
		requestAttempted && input.confirmationDeadlineAtEpochMs ? await input.confirmationDeadlineAtEpochMs() : currentDeliveryPhaseDeadlineEpochMs;
	const readRecentTurns = async (port: CodexAppServerRequestPort) =>
		nativeTurnsPageSchema.parse(
			await port.request("thread/turns/list", {
				threadId: nativeSessionId,
				cursor: null,
				limit: 10,
				sortDirection: "desc",
				itemsView: "full",
			}),
		).data;
	const findAcceptance = (turns: z.infer<typeof nativeTurnsPageSchema>["data"]) => {
		for (const turn of turns) {
			for (const item of turn.items) {
				const content = item.content ?? [];
				if (
					item.type !== "userMessage" ||
					!content.length ||
					content.some((part) => !["text", "input_text"].includes(part.type) || part.text === undefined) ||
					content.map((part) => part.text).join("") !== input.text
				)
					continue;
				if (item.id !== input.clientUserMessageId && !(returnedTurnId === turn.id && turn.id !== previousTurnId))
					continue;
				return {
					clientUserMessageId: input.clientUserMessageId,
					nativeSessionId,
					nativeTurnId: turn.id,
					nativeUserMessageId: item.id,
				};
			}
		}
		return null;
	};
	// 热重启先核对一次当前接受事实，即使停机已跨过截止；没有证据时立即收口，不重新发请求。
	let needsRestartAcceptanceObservation = input.previouslySubmitted !== undefined;
	while (needsRestartAcceptanceObservation || now() < (await currentDeadline())) {
		if (!input.isCurrent()) return { status: requestAttempted ? "unconfirmed" : "cancelled" };
		let needsOneAcceptanceRead = needsRestartAcceptanceObservation;
		needsRestartAcceptanceObservation = false;
		try {
			return await withRunningCodexAppServerControlSocketConnection<CodexNativePromptDeliveryResult>(
				async (port) => {
					if (
						!(await isThreadAlreadyLoaded(
							port,
							nativeSessionId,
							() => input.isCurrent() && (requestAttempted || now() < currentDeliveryPhaseDeadlineEpochMs),
						))
					)
						return { status: requestAttempted ? "unconfirmed" : "unavailable" };
					const thread = threadIdentitySchema.parse(
						await port.request("thread/read", { threadId: nativeSessionId, includeTurns: false }),
					).thread;
					if (
						thread.id !== nativeSessionId ||
						(await canonicalWorkingDirectory(thread.cwd)) !==
							(await canonicalWorkingDirectory(workingDirectoryPath))
					)
						return { status: requestAttempted ? "unconfirmed" : "unavailable" };
					if (!requestAttempted) {
						const turns = await readRecentTurns(port);
						const alreadyAccepted = findAcceptance(turns);
						if (alreadyAccepted && input.isCurrent()) return { status: "confirmed", evidence: alreadyAccepted };
						if (turns.some((turn) => turn.status === "inProgress")) return { status: "not_ready" };
						previousTurnId = turns[0]?.id ?? null;
						if (!input.isCurrent() || !(await input.beforeSubmit()) || !input.isCurrent())
							return { status: "cancelled" };
						// 提交前的持久查询等待由原意图 TTL 约束，不占用实际提交后的确认预算。
						currentDeliveryPhaseDeadlineEpochMs = now() + CONFIRMATION_BUDGET_MS;
						// 一旦开始调用，超时、断线、协议错误都只能读回核对。绝不重发，也不切回 PTY。
						requestAttempted = true;
						await input.onRequestAttempted({ predecessorNativeTurnId: previousTurnId });
						try {
							returnedTurnId = submittedTurnSchema.parse(
								await port.request("turn/start", {
									threadId: nativeSessionId,
									// 声明由独立 UserMessage 开启；token 与账本仍保留程序化来源。
									turnTrigger: "user",
									clientUserMessageId: input.clientUserMessageId,
									input: [{ type: "text", text: input.text, text_elements: [] }],
								}),
							).turn.id;
							await input.onNativeTurnStarted?.(returnedTurnId);
						} catch {
							// 原生调用可能已经提交；下方只查语义接受记录。
						}
					}
					while ((needsOneAcceptanceRead || now() < (await currentDeadline())) && input.isCurrent()) {
						needsOneAcceptanceRead = false;
						const evidence = findAcceptance(await readRecentTurns(port));
						if (evidence && input.isCurrent()) return { status: "confirmed", evidence };
						await waitMilliseconds(CONFIRMATION_RECHECK_MS);
					}
					return { status: "unconfirmed" };
				},
				{ socketPath: endpoint.socketPath, clientName: "kanban_native_prompt_delivery", requestTimeoutMs: 2_000 },
			);
		} catch {
			if (!requestAttempted) return { status: "unavailable" };
			// 只重建查询连接，保留 requestAttempted，避免连接失败退化成第二次 turn/start。
			await waitMilliseconds(CONFIRMATION_RECHECK_MS);
		}
	}
	return { status: "unconfirmed" };
}
