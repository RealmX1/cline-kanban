// Stores the Kanban-side view of native Cline chat state.
// It combines live in-memory updates with hydration from persisted SDK
// session artifacts so the rest of the backend can read one repository shape.
import type { RuntimeTaskImage, RuntimeTaskSessionSummary, RuntimeTaskTurnCheckpoint } from "../core/api-contract";
import { applySessionFacets } from "../core/session-activity";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import type { ClinePersistedTaskSessionSnapshot } from "./cline-session-runtime";
import {
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	cloneMessage,
	cloneSummary,
	createDefaultSummary,
	createMessage,
	createMessageWithMeta,
	finishToolCallMessage,
	startToolCallMessage,
	updateSummary,
} from "./cline-session-state";
import type { ClineSdkPersistedMessage } from "./sdk-runtime-boundary";

export interface ClineMessageRepository {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	setTaskEntry(taskId: string, entry: ClineTaskSessionEntry): void;
	clearHydratedTaskMessages(taskId: string): void;
	getTaskEntry(taskId: string): ClineTaskSessionEntry | null;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	hydrateTaskMessages(
		taskId: string,
		loadPersistedSession: () => Promise<ClinePersistedTaskSessionSnapshot | null>,
	): Promise<ClineTaskMessage[]>;
	emitSummary(summary: RuntimeTaskSessionSummary): void;
	emitMessage(taskId: string, message: ClineTaskMessage): void;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): void;
}

// Own the in-memory task entries plus summary and message fanout, so future SDK-backed hydration can slot in behind one boundary.
export class InMemoryClineMessageRepository implements ClineMessageRepository {
	private readonly entries = new Map<string, ClineTaskSessionEntry>();
	private readonly hydratedMessagesByTaskId = new Map<string, ClineTaskMessage[]>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly messageListeners = new Set<(taskId: string, message: ClineTaskMessage) => void>();

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	setTaskEntry(taskId: string, entry: ClineTaskSessionEntry): void {
		this.entries.set(taskId, entry);
		this.hydratedMessagesByTaskId.delete(taskId);
	}

	clearHydratedTaskMessages(taskId: string): void {
		this.hydratedMessagesByTaskId.delete(taskId);
	}

	getTaskEntry(taskId: string): ClineTaskSessionEntry | null {
		return this.entries.get(taskId) ?? null;
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		const entry = this.entries.get(taskId);
		if (entry) {
			return entry.messages.map((message) => cloneMessage(message));
		}
		const hydratedMessages = this.hydratedMessagesByTaskId.get(taskId);
		return hydratedMessages ? hydratedMessages.map((message) => cloneMessage(message)) : [];
	}

	async hydrateTaskMessages(
		taskId: string,
		loadPersistedSession: () => Promise<ClinePersistedTaskSessionSnapshot | null>,
	): Promise<ClineTaskMessage[]> {
		const liveEntry = this.entries.get(taskId);
		if (liveEntry) {
			return liveEntry.messages.map((message) => cloneMessage(message));
		}
		const cachedMessages = this.hydratedMessagesByTaskId.get(taskId);
		if (cachedMessages) {
			return cachedMessages.map((message) => cloneMessage(message));
		}
		// Surface persisted-session read failures and empty hydrations. The previous
		// behavior silently returned [], which masked the "trash-resume comes back blank"
		// class of bugs because the caller could not distinguish "no session on disk"
		// from "read crashed" or "session present but empty".
		let persistedSession: ClinePersistedTaskSessionSnapshot | null = null;
		try {
			persistedSession = await loadPersistedSession();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logTuiFreezeError(`[tui-freeze] hydration-error taskId=${taskId} error=${JSON.stringify(message)}`, error);
			return [];
		}
		if (!persistedSession) {
			return [];
		}
		const hydratedMessages = hydratePersistedSessionMessages(taskId, persistedSession.messages);
		if (hydratedMessages.length === 0) {
			logTuiFreezeWarning(
				`[tui-freeze] hydration-empty taskId=${taskId} persistedMessageCount=${persistedSession.messages.length}`,
			);
		}
		this.hydratedMessagesByTaskId.set(taskId, hydratedMessages);
		return hydratedMessages.map((message) => cloneMessage(message));
	}

	emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}

	emitMessage(taskId: string, message: ClineTaskMessage): void {
		const snapshot = cloneMessage(message);
		for (const listener of this.messageListeners) {
			listener(taskId, snapshot);
		}
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		return updateSummary(entry, {
			latestTurnCheckpoint: checkpoint,
			previousTurnCheckpoint: entry.summary.latestTurnCheckpoint ?? null,
		});
	}

	dispose(): void {
		this.entries.clear();
		this.hydratedMessagesByTaskId.clear();
		this.summaryListeners.clear();
		this.messageListeners.clear();
	}
}

export function createInMemoryClineMessageRepository(): ClineMessageRepository {
	return new InMemoryClineMessageRepository();
}

export function createTaskEntryFromPersistedSession(
	taskId: string,
	messages: ClineSdkPersistedMessage[],
	summaryPatch: Partial<RuntimeTaskSessionSummary> = {},
): ClineTaskSessionEntry {
	const entry = createHydrationEntry(taskId);
	for (const message of messages) {
		hydratePersistedMessage(entry, taskId, message);
	}
	// 经单一构造 applySessionFacets 重 stamp 双轴 facet：summaryPatch 常覆写 state/reviewReason
	// （resume/rebind 写 awaiting_review|failed），若仅 spread createDefaultSummary 的 idle facet 而不
	// 重派生，会得到「非 idle state + idle facet」的不一致 summary（projectLegacyState 投影回 idle）。
	entry.summary = applySessionFacets({
		...entry.summary,
		...summaryPatch,
		// Cline 的 summary 不跨进程重启持久化，重建后 lastSubstantiveOutputAt 会是 null，
		// 随后第一个 status 心跳就把它镜像成「刚刚」——卡片因此在重启后谎报 agent 刚响应过。
		// 从落盘消息里回捞真实的 agent 产出时间戳来重建它。优先级：调用方显式给的 > 落盘回捞 >
		// 默认（null）。回捞不到（旧盘无 ts）时保持 null——卡片隐去该段，宁可不显示也不显示错的。
		lastSubstantiveOutputAt:
			summaryPatch.lastSubstantiveOutputAt ??
			resolveLastAgentOutputMessageTimestamp(messages) ??
			entry.summary.lastSubstantiveOutputAt ??
			null,
		taskId,
		updatedAt: Date.now(),
	});
	return entry;
}

// 落盘消息里最后一条「agent 产出」消息的时间戳（毫秒），无可用 ts 时返回 null。
// 取 max 而非「最后一条的 ts」：落盘顺序理论上单调，但 max 对乱序 / 缺 ts 的条目天然稳健。
function resolveLastAgentOutputMessageTimestamp(messages: ClineSdkPersistedMessage[]): number | null {
	let latest: number | null = null;
	for (const message of messages) {
		if (!isPersistedAgentOutputMessage(message)) {
			continue;
		}
		const timestamp = message.ts;
		if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
			continue;
		}
		if (latest === null || timestamp > latest) {
			latest = timestamp;
		}
	}
	return latest;
}

// 该落盘消息记录的是不是「agent 侧产出」——回捞口径必须与 live 路径一致。
// assistant 消息（文本 / reasoning / tool_use）显然算。
// 工具执行结果同样算：live 的 tool-finished 事件只发 lastOutputAt，经 updateSummary 漏斗镜像推进
// lastSubstantiveOutputAt（见 cline-event-adapter.ts 的 tool-finished / content_end(tool) 分支），
// 而 SDK 把这条消息落盘成 role:"user" —— @clinebot/core 内部 role:"tool" 的 ModelMessage 在回写
// MessageWithMetadata 时被改写成 "user"、ts 取工具完成时刻的 createdAt。若只认 assistant，
// 「以工具完成收尾」的会话重启后会回捞到更早的时间、甚至整轮无 assistant 文本时回捞成 null。
// 反之，真正的用户发言（字符串正文，或含 text / image / file 块）不能算——那是「用户上次说话」。
// 判据取「纯 tool_result 载体」：SDK 的拆分保证工具结果不与用户正文同处一条消息
// （@clinebot/shared 的 MessageWithMetadata.role 只有 "user" | "assistant"），混合内容一律按用户
// 发言处理——宁可少报一次 agent 响应，也不把用户发言错认成 agent 响应。
function isPersistedAgentOutputMessage(message: ClineSdkPersistedMessage): boolean {
	if (message.role === "assistant") {
		return true;
	}
	if (typeof message.content === "string") {
		return false;
	}
	return message.content.length > 0 && message.content.every((block) => block.type === "tool_result");
}

function hydratePersistedSessionMessages(taskId: string, messages: ClineSdkPersistedMessage[]): ClineTaskMessage[] {
	const entry = createHydrationEntry(taskId);
	for (const message of messages) {
		hydratePersistedMessage(entry, taskId, message);
	}
	return entry.messages.map((message) => cloneMessage(message));
}

function createHydrationEntry(taskId: string): ClineTaskSessionEntry {
	return {
		summary: createDefaultSummary(taskId),
		messages: [],
		activeAssistantMessageId: null,
		activeReasoningMessageId: null,
		toolMessageIdByToolCallId: new Map<string, string>(),
		toolInputByToolCallId: new Map<string, unknown>(),
	};
}

function hydratePersistedMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	message: ClineSdkPersistedMessage,
): void {
	const persistedMetadata =
		message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
			? message.metadata
			: null;
	const persistedDisplayRole =
		typeof persistedMetadata?.displayRole === "string" ? persistedMetadata.displayRole.trim().toLowerCase() : "";
	const persistedReason = typeof persistedMetadata?.reason === "string" ? persistedMetadata.reason.trim() : null;
	const persistedMessageKind = typeof persistedMetadata?.kind === "string" ? persistedMetadata.kind.trim() : null;
	const hydratedRole =
		persistedDisplayRole === "system" || persistedDisplayRole === "status"
			? (persistedDisplayRole as "system" | "status")
			: message.role;

	if (typeof message.content === "string") {
		appendPersistedTextMessage(
			entry,
			taskId,
			hydratedRole,
			message.content,
			persistedMetadata,
			persistedReason,
			persistedMessageKind,
		);
		return;
	}

	const textParts: string[] = [];
	const images: RuntimeTaskImage[] = [];
	const flushRichMessage = () => {
		if (textParts.length === 0 && images.length === 0) {
			return;
		}
		appendPersistedTextMessage(
			entry,
			taskId,
			hydratedRole,
			textParts.join("\n"),
			persistedMetadata,
			persistedReason,
			persistedMessageKind,
			images,
		);
		textParts.length = 0;
		images.length = 0;
	};

	for (const block of message.content) {
		if (block.type === "text") {
			textParts.push(block.text);
			continue;
		}
		if (block.type === "file") {
			textParts.push(`Attached file: ${block.path}`);
			continue;
		}
		if (block.type === "image") {
			if (typeof block.data === "string" && typeof block.mediaType === "string") {
				images.push({
					id: `${taskId}-image-${images.length}-${Date.now()}`,
					data: block.data,
					mimeType: block.mediaType,
				});
			} else if (typeof block.mediaType === "string") {
				textParts.push(`Attached image: ${block.mediaType}`);
			}
			continue;
		}

		flushRichMessage();

		if (block.type === "thinking") {
			appendPersistedReasoningMessage(entry, taskId, block.thinking);
			continue;
		}
		if (block.type === "redacted_thinking") {
			appendPersistedReasoningMessage(entry, taskId, "[redacted reasoning]");
			continue;
		}
		if (block.type === "tool_use") {
			startToolCallMessage(entry, taskId, {
				toolName: block.name,
				toolCallId: block.id,
				input: block.input,
			});
			continue;
		}
		if (block.type === "tool_result") {
			const resultText = stringifyPersistedToolResult(block.content);
			finishToolCallMessage(entry, taskId, {
				toolName: readHydratedToolName(entry, block.tool_use_id),
				toolCallId: block.tool_use_id,
				output: block.is_error ? undefined : resultText,
				error: block.is_error ? resultText : null,
				durationMs: null,
			});
		}
	}

	flushRichMessage();
}

function appendPersistedTextMessage(
	entry: ClineTaskSessionEntry,
	taskId: string,
	role: "user" | "assistant" | "system" | "status",
	content: string,
	metadata?: Record<string, unknown> | null,
	reason?: string | null,
	messageKind?: string | null,
	images?: RuntimeTaskImage[],
): void {
	if (content.trim().length === 0 && (!images || images.length === 0)) {
		return;
	}
	const meta =
		metadata || reason || messageKind
			? {
					hookEventName: metadata ? "history_notice" : null,
					messageKind: messageKind ?? null,
					displayRole: typeof metadata?.displayRole === "string" ? metadata.displayRole : null,
					reason: reason ?? null,
				}
			: null;
	entry.messages.push(
		meta ? createMessageWithMeta(taskId, role, content, meta, images) : createMessage(taskId, role, content, images),
	);
}

function appendPersistedReasoningMessage(entry: ClineTaskSessionEntry, taskId: string, content: string): void {
	if (content.trim().length === 0) {
		return;
	}
	entry.messages.push(
		createMessageWithMeta(taskId, "reasoning", content, {
			streamType: "reasoning",
		}),
	);
}

function stringifyPersistedToolResult(
	content: string | Array<{ type: string; text?: string; path?: string; mediaType?: string }>,
): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") {
				return block.text;
			}
			if (block.type === "file" && typeof block.path === "string") {
				return `Attached file: ${block.path}`;
			}
			if (block.type === "image" && typeof block.mediaType === "string") {
				return `Attached image: ${block.mediaType}`;
			}
			try {
				return JSON.stringify(block, null, 2);
			} catch {
				return String(block);
			}
		})
		.filter((part) => part.trim().length > 0)
		.join("\n");
}

function readHydratedToolName(entry: ClineTaskSessionEntry, toolCallId: string): string | null {
	const messageId = entry.toolMessageIdByToolCallId.get(toolCallId);
	if (!messageId) {
		return null;
	}
	const existingMessage = entry.messages.find((message) => message.id === messageId);
	return existingMessage?.meta?.toolName ?? null;
}
