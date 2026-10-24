import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	RuntimeCodexConversationStorageOperationRequest,
	RuntimeCodexConversationStorageOperationResponse,
} from "../core/codex-conversation-storage-api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	resolveCanonicalUserCodexHomeForManagedStorage,
	resolveMigratedCodexConversationHome,
	resolveRecordedCodexConversationHome,
} from "./codex-conversation-storage-home";
import {
	migrateStoppedCodexConversationStorage,
	readCodexConversationStorageMigrationRecord,
	rollbackStoppedCodexConversationStorage,
} from "./codex-conversation-storage-migration";

export async function operateCodexConversationStorage(
	input: RuntimeCodexConversationStorageOperationRequest,
	dependencies: {
		listKnownSummaries: () => Promise<RuntimeTaskSessionSummary[]>;
		resolveMigrationOwnership?: (
			summary: RuntimeTaskSessionSummary,
		) => Promise<{ rejectionReason: string | null; taskCardCreatedAtMs?: number }>;
	},
): Promise<RuntimeCodexConversationStorageOperationResponse> {
	const summaries = await dependencies.listKnownSummaries();
	const candidates = input.conversationSessionId
		? summaries.filter((summary) => summary.taskId === input.conversationSessionId)
		: summaries.filter((summary) => summary.agentId === "codex");
	if (input.conversationSessionId && !candidates.length) throw new Error("当前工作区不存在指定会话。");
	const entries: RuntimeCodexConversationStorageOperationResponse["entries"] = [];
	for (const summary of candidates) {
		const identity = summary.agentNativeConversationSessionIdentity;
		const entry: RuntimeCodexConversationStorageOperationResponse["entries"][number] = {
			conversationSessionId: summary.taskId,
			agentProcessId: summary.pid ?? null,
			nativeSessionId: identity?.nativeSessionId ?? null,
			homeDirectoryPath: null,
			status: "refused",
			message: "缺少可核验的 Codex 原生身份。",
		};
		entries.push(entry);
		if (summary.agentId !== "codex" || identity?.sourceAgentId !== "codex" || !summary.workspacePath) continue;
		entry.homeDirectoryPath = resolveRecordedCodexConversationHome({
			...summary,
			transcriptPath: identity.transcriptPath,
		});
		const assertSessionStillStopped = async () => {
			const current = await dependencies.listKnownSummaries();
			const own = current.find((candidate) => candidate.taskId === summary.taskId);
			if (!own || own.agentNativeConversationSessionIdentity?.nativeSessionId !== identity.nativeSessionId)
				throw new Error("会话身份已变化，保留原绑定。");
			const owningTaskId = summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId;
			if (
				current.some(
					(candidate) =>
						(candidate.agentNativeConversationSessionIdentity?.nativeSessionId === identity.nativeSessionId ||
							(candidate.taskConversationSessionMetadata?.workspaceTaskId ?? candidate.taskId) ===
								owningTaskId) &&
						resolveSessionFacets(candidate).liveness === "live",
				)
			)
				throw new Error("Task 的会话或共享原生会话仍在运行，已延后；空闲或本轮停止生成不构成迁移条件。");
		};
		try {
			await assertSessionStillStopped();
		} catch (error) {
			entry.status = "active_deferred";
			entry.message = error instanceof Error ? error.message : String(error);
			continue;
		}
		const ownership = await dependencies.resolveMigrationOwnership?.(summary);
		if (ownership?.rejectionReason) {
			entry.message = ownership.rejectionReason;
			continue;
		}
		entry.homeDirectoryPath = await resolveMigratedCodexConversationHome(
			entry.homeDirectoryPath,
			identity.nativeSessionId,
		);
		if (input.operation === "status") {
			entry.status =
				entry.homeDirectoryPath === getManagedCodexConversationStorageHomeDirectoryPath() ? "isolated" : "eligible";
			entry.message = "仅列出已停止的已知会话；实际迁移还须取得原生写锁并核验数据库。";
			continue;
		}
		try {
			const sourceHomeDirectoryPath = await resolveCanonicalUserCodexHomeForManagedStorage(entry.homeDirectoryPath);
			if (
				input.operation === "migrate_stopped" &&
				entry.homeDirectoryPath === getManagedCodexConversationStorageHomeDirectoryPath()
			) {
				const previous = await readCodexConversationStorageMigrationRecord(
					sourceHomeDirectoryPath,
					identity.nativeSessionId,
				);
				if (!previous || previous.stage === "source_archived") {
					entry.status = "isolated";
					entry.message = "已使用专用目录，无需再次迁移。";
					continue;
				}
			}
			const operation =
				input.operation === "rollback_stopped"
					? rollbackStoppedCodexConversationStorage
					: migrateStoppedCodexConversationStorage;
			const result = await operation({
				sourceHomeDirectoryPath,
				nativeSessionId: identity.nativeSessionId,
				workingDirectoryPath: summary.workspacePath,
				assertSessionStillStopped,
				taskCardCreatedAtMs: ownership?.taskCardCreatedAtMs,
			});
			entry.homeDirectoryPath =
				input.operation === "rollback_stopped" ? sourceHomeDirectoryPath : result.targetHomeDirectoryPath;
			entry.status = input.operation === "rollback_stopped" ? "rolled_back" : "migrated";
			entry.message = "目录绑定已持久保存；下次按原生 ID 续接，不自动重启会话。";
		} catch (error) {
			entry.status = "refused";
			entry.message = error instanceof Error ? error.message : String(error);
		}
	}
	return { entries };
}
