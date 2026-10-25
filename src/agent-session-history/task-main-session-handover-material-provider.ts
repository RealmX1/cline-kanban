import { isDeepStrictEqual } from "node:util";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type TaskMainSessionHandoverMaterial,
	taskMainSessionHandoverMaterialSchema,
} from "../core/task-main-session-handover-contract";
import { collectClaudeMainSessionHandoverMaterial } from "./claude-main-session-handover-material";
import { collectNativeHistoryMainSessionHandoverMaterial } from "./native-history-main-session-handover-material";

type UserIntentContext = NonNullable<TaskMainSessionHandoverMaterial["userIntentContext"]>;
// EXPERIMENT_NODE: 本地意图卷宗读取暂定两秒预算；超时交付原始材料，避免可选提供方阻断交接。
const USER_INTENT_CONTEXT_PROVIDER_READ_TIMEOUT_MS = 2_000;
export interface TaskMainSessionHandoverUserIntentContextProvider {
	readUserIntentContext(input: {
		workUnitReference: UserIntentContext["workUnitReference"];
		conversationSessionReferences: UserIntentContext["conversationSessionReferences"];
		readContextAsOf: number;
		signal: AbortSignal;
	}): Promise<UserIntentContext>;
}

export async function collectTaskMainSessionHandoverMaterial(
	input: Parameters<typeof collectNativeHistoryMainSessionHandoverMaterial>[0] & {
		workspaceId: string;
		conversationSessions?: readonly RuntimeTaskSessionSummary[];
		userIntentContextProvider?: TaskMainSessionHandoverUserIntentContextProvider;
	},
): Promise<TaskMainSessionHandoverMaterial> {
	const material = await (input.sourceSummary.agentId === "claude"
		? collectClaudeMainSessionHandoverMaterial
		: collectNativeHistoryMainSessionHandoverMaterial)(input);
	const workUnitReference = {
		workspaceId: input.workspaceId,
		taskId: input.card.id,
		taskIncarnationCreatedAtEpochMs: input.card.createdAt,
	};
	const conversationSessionReferences = (input.conversationSessions ?? [input.sourceSummary]).map((summary) => ({
		taskConversationSessionId: summary.taskId,
		agentId: summary.agentId,
		nativeConversationSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
	}));
	const readContextAsOf = Date.now();
	let userIntentContext: UserIntentContext = {
		providerName: "raw_task_and_native_history_without_intent_dossier",
		providerAvailability: "unavailable",
		asOf: readContextAsOf,
		workUnitReference,
		conversationSessionReferences,
		userIntentContextText: null,
		sourceReferences: [],
		missingContextParts: ["工作单元意图卷宗尚未接入；当前提供未分类原始材料，不是完整意图提取。"],
	};
	if (input.userIntentContextProvider) {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const provided = taskMainSessionHandoverMaterialSchema.shape.userIntentContext.unwrap().parse(
				await Promise.race([
					input.userIntentContextProvider.readUserIntentContext({
						workUnitReference,
						conversationSessionReferences,
						readContextAsOf,
						signal: controller.signal,
					}),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(() => {
							controller.abort();
							reject(new Error("意图卷宗提供方超过读取预算，保留原始材料。"));
						}, USER_INTENT_CONTEXT_PROVIDER_READ_TIMEOUT_MS);
					}),
				]),
			);
			if (
				!isDeepStrictEqual(provided.workUnitReference, workUnitReference) ||
				!isDeepStrictEqual(provided.conversationSessionReferences, conversationSessionReferences) ||
				provided.asOf > readContextAsOf
			)
				throw new Error("卷宗提供方返回的工作单元身份、会话归属或材料时间不符。");
			userIntentContext = provided;
		} catch (error) {
			userIntentContext.missingContextParts.push(
				`卷宗提供方暂不可用：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
	return {
		...material,
		userIntentContext,
		missingMaterialDescriptions: [...material.missingMaterialDescriptions, ...userIntentContext.missingContextParts],
	};
}
