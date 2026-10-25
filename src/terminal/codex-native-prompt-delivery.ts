import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type {
	CodexNativePromptAcceptanceHistoryQueryProgress,
	CodexNativePromptDeliveryEvidence,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import type {
	CodexNativePromptDeliveryJournal,
	CodexNativePromptDeliveryJournalState,
} from "../core/codex-native-prompt-delivery-journal";
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
	deliveryJournal?: CodexNativePromptDeliveryJournal;
	reconcileAcceptanceOnly?: boolean;
	expectedHistoricalPromptSha256?: string;
	historicalNativeConversation?: { nativeSessionId: string; workingDirectoryPath: string };
	confirmationBudgetMs?: number;
	now?: () => number;
	waitMilliseconds?: (milliseconds: number) => Promise<void>;
}

export async function deliverCodexNativePromptWithoutChangingComposer(
	input: CodexNativePromptDeliveryInput,
): Promise<CodexNativePromptDeliveryResult> {
	const { summary } = input;
	const workingDirectoryPath = input.historicalNativeConversation?.workingDirectoryPath ?? summary.workspacePath;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	const identity = summary.agentNativeConversationSessionIdentity;
	if ((input.expectedHistoricalPromptSha256 || input.historicalNativeConversation) && !input.reconcileAcceptanceOnly)
		return { status: "unconfirmed" };
	const requestedNativeSessionId = input.historicalNativeConversation?.nativeSessionId ?? identity?.nativeSessionId;
	let persisted: CodexNativePromptDeliveryJournalState | undefined;
	if (input.deliveryJournal) {
		if (!workingDirectoryPath || !requestedNativeSessionId) return { status: "unconfirmed" };
		try {
			persisted = await input.deliveryJournal.prepare({
				clientUserMessageId: input.clientUserMessageId,
				workspaceId: input.workspaceId,
				conversationSessionId: summary.taskId,
				nativeSessionId: requestedNativeSessionId,
				workingDirectoryPath: await canonicalWorkingDirectory(workingDirectoryPath),
				text: input.text,
				...(input.expectedHistoricalPromptSha256
					? { historicalPromptSha256: input.expectedHistoricalPromptSha256 }
					: {}),
			});
		} catch {
			return { status: "unconfirmed" };
		}
	}
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
		return { status: persisted?.requestMayHaveBeenSent ? "unconfirmed" : "unavailable" };
	const nativeSessionId = requestedNativeSessionId ?? identity.nativeSessionId;
	const now = input.now ?? Date.now;
	const waitMilliseconds =
		input.waitMilliseconds ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
	const clientUserMessageId = persisted?.clientUserMessageId ?? input.clientUserMessageId;
	let requestAttempted = Boolean(persisted?.requestMayHaveBeenSent) || input.previouslySubmitted !== undefined;
	let returnedTurnId: string | null = persisted?.returnedTurnId ?? input.previouslySubmitted?.nativeTurnId ?? null;
	let previousTurnId: string | null =
		persisted?.previousTurnId ?? input.previouslySubmitted?.predecessorNativeTurnId ?? null;
	let acceptanceHistoryQueryProgress = requestAttempted ? persisted?.acceptanceHistoryQueryProgress : undefined;
	const rememberAcceptanceHistoryQueryProgress = async (progress: CodexNativePromptAcceptanceHistoryQueryProgress) => {
		await input.deliveryJournal?.recordAcceptanceHistoryQueryProgress(progress);
		acceptanceHistoryQueryProgress = progress;
	};
	let currentDeliveryPhaseDeadlineEpochMs = now() + (input.confirmationBudgetMs ?? CONFIRMATION_BUDGET_MS);
	const currentDeadline = async () =>
		requestAttempted && input.confirmationDeadlineAtEpochMs
			? await input.confirmationDeadlineAtEpochMs()
			: currentDeliveryPhaseDeadlineEpochMs;
	const readTurnsPage = async (port: CodexAppServerRequestPort, cursor: string | null) =>
		nativeTurnsPageSchema.parse(
			await port.request("thread/turns/list", {
				threadId: nativeSessionId,
				cursor,
				limit: 10,
				sortDirection: "desc",
				itemsView: "full",
			}),
		);
	const findAcceptance = (turns: z.infer<typeof nativeTurnsPageSchema>["data"]) => {
		for (const turn of turns) {
			for (const item of turn.items) {
				const content = item.content ?? [];
				if (
					item.type !== "userMessage" ||
					!content.length ||
					content.some((part) => !["text", "input_text"].includes(part.type) || part.text === undefined) ||
					(input.expectedHistoricalPromptSha256
						? createHash("sha256")
								.update(content.map((part) => part.text).join(""))
								.digest("hex") !== input.expectedHistoricalPromptSha256
						: content.map((part) => part.text).join("") !== input.text)
				)
					continue;
				if (item.id !== clientUserMessageId && !(returnedTurnId === turn.id && turn.id !== previousTurnId))
					continue;
				return {
					clientUserMessageId,
					nativeSessionId,
					nativeTurnId: turn.id,
					nativeUserMessageId: item.id,
				};
			}
		}
		return null;
	};
	const queryAcceptance = async (port: CodexAppServerRequestPort, observationDeadlineEpochMs?: number) => {
		// 续查状态属于已提交的原 operation；提交前仍必须重新读取最新页来判断发送资格。
		let cursor = requestAttempted ? (acceptanceHistoryQueryProgress?.nextCursor ?? null) : null;
		let latestTurns: z.infer<typeof nativeTurnsPageSchema>["data"] = [];
		const seen = new Set(cursor === null ? [] : acceptanceHistoryQueryProgress?.queriedCursorSha256s);
		let queriedPageCount = 0;
		do {
			let page: z.infer<typeof nativeTurnsPageSchema>;
			try {
				page = await readTurnsPage(port, cursor);
			} catch (error) {
				if (!requestAttempted) throw error;
				// cursor 可能在原生历史变更后失效；只重置查询进度，当前结果仍是未知。
				await rememberAcceptanceHistoryQueryProgress({
					nextCursor: null,
					queriedCursorSha256s: [],
					lastQueryStatus: "cursor_read_failed",
				});
				return { evidence: null, latestTurns, complete: false };
			}
			queriedPageCount += 1;
			if (cursor === null) latestTurns = page.data;
			const evidence = findAcceptance(page.data);
			if (evidence) {
				await input.deliveryJournal?.recordAcceptance(evidence);
				return { evidence, latestTurns, complete: true };
			}
			if (cursor !== null) seen.add(createHash("sha256").update(cursor).digest("hex"));
			cursor = page.nextCursor;
			if (cursor !== null && seen.has(createHash("sha256").update(cursor).digest("hex"))) {
				if (requestAttempted)
					await rememberAcceptanceHistoryQueryProgress({
						nextCursor: null,
						queriedCursorSha256s: [],
						lastQueryStatus: "cursor_cycle_detected",
					});
				return { evidence: null, latestTurns, complete: false };
			}
			if (requestAttempted)
				await rememberAcceptanceHistoryQueryProgress({
					nextCursor: cursor,
					queriedCursorSha256s: cursor === null ? [] : [...seen],
					lastQueryStatus: cursor === null ? "history_exhausted" : "pending",
				});
			if (cursor !== null) {
				if (queriedPageCount >= 1000 || now() >= (observationDeadlineEpochMs ?? (await currentDeadline())))
					return { evidence: null, latestTurns, complete: false };
			}
		} while (cursor !== null && input.isCurrent());
		return { evidence: null, latestTurns, complete: cursor === null };
	};
	// 停机跨过确认截止也补查历史接受；只扩大有界查询预算，不重新取得发送资格。
	let needsRestartAcceptanceObservation = requestAttempted;
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
						const queried = await queryAcceptance(port);
						const alreadyAccepted = queried.evidence;
						if (alreadyAccepted && input.isCurrent()) return { status: "confirmed", evidence: alreadyAccepted };
						if (!queried.complete || input.reconcileAcceptanceOnly) return { status: "unconfirmed" };
						const turns = queried.latestTurns;
						if (turns.some((turn) => turn.status === "inProgress")) return { status: "not_ready" };
						previousTurnId = turns[0]?.id ?? null;
						if (!input.isCurrent() || !(await input.beforeSubmit()) || !input.isCurrent())
							return { status: "cancelled" };
						// 提交前的持久查询等待由原意图 TTL 约束，不占用实际提交后的确认预算。
						currentDeliveryPhaseDeadlineEpochMs = now() + (input.confirmationBudgetMs ?? CONFIRMATION_BUDGET_MS);
						// 一旦开始调用，超时、断线、协议错误都只能读回核对。绝不重发，也不切回 PTY。
						requestAttempted = true;
						await input.deliveryJournal?.recordRequestIntent(previousTurnId);
						await input.onRequestAttempted({ predecessorNativeTurnId: previousTurnId });
						if (!input.isCurrent()) return { status: "unconfirmed" };
						try {
							const pendingResponse = port
								.request("turn/start", {
									threadId: nativeSessionId,
									// 声明由独立 UserMessage 开启；token 与账本仍保留程序化来源。
									turnTrigger: "user",
									clientUserMessageId,
									input: [{ type: "text", text: input.text, text_elements: [] }],
								})
								.then(
									(response) => ({ response }),
									() => ({ response: null }),
								);
							await input.deliveryJournal?.recordRequestInvoked();
							returnedTurnId = submittedTurnSchema.parse((await pendingResponse).response).turn.id;
							await input.deliveryJournal?.recordReturnedTurn(returnedTurnId);
							await input.onNativeTurnStarted?.(returnedTurnId);
						} catch {
							// 原生调用可能已经提交；下方只查语义接受记录。
						}
					}
					while ((needsOneAcceptanceRead || now() < (await currentDeadline())) && input.isCurrent()) {
						const observationDeadlineEpochMs = needsOneAcceptanceRead
							? now() + Math.min(input.confirmationBudgetMs ?? 2_000, 2_000)
							: undefined;
						needsOneAcceptanceRead = false;
						const evidence = (await queryAcceptance(port, observationDeadlineEpochMs)).evidence;
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
