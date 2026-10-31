import type { RuntimeTaskConversationSessionMetadata, RuntimeTaskSessionSummary } from "./api-contract";

export function isForkedTaskConversationSessionContext(
	metadata: RuntimeTaskConversationSessionMetadata | undefined,
): boolean {
	return (
		metadata?.taskConversationSessionContextSource === "forked_from_conversation_session" ||
		metadata?.taskConversationSessionContextSource === "forked_from_main_current_turn"
	);
}

export function isExplicitFreshTaskConversationSessionContext(
	metadata: RuntimeTaskConversationSessionMetadata | undefined,
): boolean {
	return metadata?.contextSourceSelectionAtCreation === "fresh";
}

export interface TaskConversationSessionContextSourceNativeIdentity {
	sourceAgentId: string;
	nativeSessionId: string;
	transcriptPath: string | null;
}

// 创建时来源可能尚未落下原生身份或转录路径。补证只填当时缺的字段，并只接受同一条来源会话后来出现的同一原生身份；
// 已经记下的另一个原生身份保持不变，避免把之后换掉的会话当成创建时复刻的历史。
export function resolveObservedTaskConversationSessionContextSourceIdentity(
	metadata: RuntimeTaskConversationSessionMetadata | undefined,
	liveContextSource: RuntimeTaskSessionSummary | undefined,
): TaskConversationSessionContextSourceNativeIdentity | null {
	const recorded = resolveRecordedTaskConversationSessionContextSource(metadata).nativeIdentity;
	const live = liveContextSource?.agentNativeConversationSessionIdentity;
	if (!recorded) {
		if (!live?.nativeSessionId || !live.sourceAgentId) return null;
		return {
			sourceAgentId: live.sourceAgentId,
			nativeSessionId: live.nativeSessionId,
			transcriptPath: live.transcriptPath ?? null,
		};
	}
	if (
		recorded.transcriptPath == null &&
		live?.nativeSessionId === recorded.nativeSessionId &&
		live.sourceAgentId === recorded.sourceAgentId &&
		live.transcriptPath
	) {
		return {
			sourceAgentId: recorded.sourceAgentId,
			nativeSessionId: recorded.nativeSessionId,
			transcriptPath: live.transcriptPath,
		};
	}
	return {
		sourceAgentId: recorded.sourceAgentId,
		nativeSessionId: recorded.nativeSessionId,
		transcriptPath: recorded.transcriptPath ?? null,
	};
}

export function resolveRecordedTaskConversationSessionContextSource(
	metadata: RuntimeTaskConversationSessionMetadata | undefined,
) {
	const nativeIdentity =
		metadata?.contextSourceNativeSessionIdentity ??
		(metadata?.sideSessionOriginMainNativeSessionId && metadata.sideSessionOriginMainAgentId
			? {
					sourceAgentId: metadata.sideSessionOriginMainAgentId,
					nativeSessionId: metadata.sideSessionOriginMainNativeSessionId,
					transcriptPath: metadata.sideSessionOriginMainTranscriptPath ?? null,
				}
			: null);
	return {
		taskConversationSessionId:
			metadata?.contextSourceTaskConversationSessionId ??
			metadata?.sideSessionOriginMainSessionId ??
			metadata?.parentTaskConversationSessionId ??
			null,
		nativeIdentity,
	};
}
