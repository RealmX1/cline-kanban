// 内存中的 ACP 会话账本：taskId → entry，外加 summary / message 两路监听器扇出。
// 与 Cline 侧的 message-repository 对位，但没有「从磁盘水合历史」那一层——ACP 的
// session/load 续跑不在本期范围，会话历史由 agent 自己持有。
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type AcpTaskMessage,
	type AcpTaskSessionEntry,
	cloneAcpMessage,
	cloneAcpSummary,
	createAcpTaskSessionEntry,
} from "./acp-session-state";

export type AcpSummaryListener = (summary: RuntimeTaskSessionSummary) => void;
export type AcpMessageListener = (taskId: string, message: AcpTaskMessage) => void;

export class AcpTaskSessionRegistry {
	private readonly entriesByTaskId = new Map<string, AcpTaskSessionEntry>();
	private readonly summaryListeners = new Set<AcpSummaryListener>();
	private readonly messageListeners = new Set<AcpMessageListener>();

	ensureEntry(taskId: string, agentId: RuntimeAgentId): AcpTaskSessionEntry {
		const existing = this.entriesByTaskId.get(taskId);
		if (existing) {
			return existing;
		}
		const created = createAcpTaskSessionEntry(taskId, agentId);
		this.entriesByTaskId.set(taskId, created);
		return created;
	}

	getEntry(taskId: string): AcpTaskSessionEntry | null {
		return this.entriesByTaskId.get(taskId) ?? null;
	}

	deleteEntry(taskId: string): void {
		this.entriesByTaskId.delete(taskId);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entriesByTaskId.get(taskId);
		return entry ? cloneAcpSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return [...this.entriesByTaskId.values()].map((entry) => cloneAcpSummary(entry.summary));
	}

	listMessages(taskId: string): AcpTaskMessage[] {
		const entry = this.entriesByTaskId.get(taskId);
		return entry ? entry.messages.map((message) => cloneAcpMessage(message)) : [];
	}

	onSummary(listener: AcpSummaryListener): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	onMessage(listener: AcpMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	emitSummary(summary: RuntimeTaskSessionSummary): void {
		for (const listener of this.summaryListeners) {
			listener(cloneAcpSummary(summary));
		}
	}

	emitMessage(taskId: string, message: AcpTaskMessage): void {
		for (const listener of this.messageListeners) {
			listener(taskId, cloneAcpMessage(message));
		}
	}
}
