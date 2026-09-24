// 内存中的 ACP 会话账本：taskId → entry，外加 summary / message 两路监听器扇出。
// 历史由 agent 持有，经 session/load 重播；原生身份随宿主 summary 持久化。
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
