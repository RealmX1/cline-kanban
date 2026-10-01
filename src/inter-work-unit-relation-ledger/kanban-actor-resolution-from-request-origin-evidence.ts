import { isHomeAgentSessionId } from "../core/home-agent-session";
import type {
	AgentConversationSessionIdentityKey,
	KanbanActor,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	type DecodedKanbanCliInvocationEnvironmentActorClaimsRequestHeader,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION,
	NATIVE_CONVERSATION_SESSION_ID_ENVIRONMENT_VARIABLE_NAME_TO_CONVERSATION_SESSION_HOST_KANBAN_AGENT_ID,
} from "../core/kanban-cli-invocation-environment-actor-claims";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

// 行动者解析（dd2db §R3 Y-EVENT-7 解析顺序第 2–4 步；第 1 步「进程内显式系统组件」不经请求，调用点直接构造）。
// 1a.2 只接 CLI 声明头；页面加载 nonce（第 3 步）在 1a.3 接入，会话归属登记（第 2 步的原生 id 查登记）在 1a.4 接入。

export interface KanbanRequestOriginActorEvidence {
	decodedCliActorClaimsRequestHeader: DecodedKanbanCliInvocationEnvironmentActorClaimsRequestHeader;
}

export interface KanbanActorResolutionLookups {
	findKanbanBoardCardIncarnationForActorResolution(
		workspaceId: string,
		taskId: string,
	): Promise<{ taskIncarnationCreatedAtEpochMs: number; workspaceRepositoryPath: string } | null>;
	findWorkspaceIdByRepositoryPathForActorResolution(repositoryPath: string): Promise<string | null>;
}

export interface ResolvedKanbanActorWithEventEnvelopeContext {
	resolvedKanbanActor: KanbanActor;
	actorNativeConversationSessionIdentity: AgentConversationSessionIdentityKey | null;
	actorKanbanTaskConversationSessionId: string | null;
	actorRepositoryIdentityAtEventTime: { workspaceId: string; repositoryPath: string } | null;
	invokingKanbanCliCodeVersion: string | null;
}

function resolveClaimedNativeConversationSessionIdentity(
	claimedEnvironmentVariableValuesByName: Record<string, string>,
): { identity: AgentConversationSessionIdentityKey | null; ambiguousVariableNames: string[] } {
	const claimedIdentities = Object.entries(
		NATIVE_CONVERSATION_SESSION_ID_ENVIRONMENT_VARIABLE_NAME_TO_CONVERSATION_SESSION_HOST_KANBAN_AGENT_ID,
	).flatMap(([variableName, conversationSessionHostKanbanAgentId]) => {
		const nativeConversationSessionId = claimedEnvironmentVariableValuesByName[variableName];
		return nativeConversationSessionId
			? [{ variableName, identity: { conversationSessionHostKanbanAgentId, nativeConversationSessionId } }]
			: [];
	});
	if (claimedIdentities.length === 1) {
		return { identity: claimedIdentities[0]?.identity ?? null, ambiguousVariableNames: [] };
	}
	// 嵌套 harness（例如 Codex 的工具 shell 里再起 Claude）会同时继承多个变量，无法判定最内层是谁。
	// EXPERIMENT_NODE: 多个原生会话变量并存时是否可按 harness 嵌套常见顺序推断最内层；当前一律判为无法解析。
	return {
		identity: null,
		ambiguousVariableNames:
			claimedIdentities.length > 1 ? claimedIdentities.map((claimed) => claimed.variableName) : [],
	};
}

export async function resolveKanbanActorFromRequestOriginEvidence(
	evidence: KanbanRequestOriginActorEvidence,
	lookups: KanbanActorResolutionLookups,
): Promise<ResolvedKanbanActorWithEventEnvelopeContext> {
	const decoded = evidence.decodedCliActorClaimsRequestHeader;
	const emptyContext = {
		actorNativeConversationSessionIdentity: null,
		actorKanbanTaskConversationSessionId: null,
		actorRepositoryIdentityAtEventTime: null,
		invokingKanbanCliCodeVersion: null,
	};
	if (decoded.cliActorClaimsRequestHeaderStatus === "absent") {
		// 今天的 Web UI 请求也落在这里（还没有页面加载 nonce）。
		// EXPERIMENT_NODE: 1a.3 接上页面加载 nonce 与逐卡标注后，Web UI 路径改按 nonce 解析，本兜底只剩裸 tRPC 调用方。
		return {
			...emptyContext,
			resolvedKanbanActor: {
				kanbanActorKind: "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce",
			},
		};
	}
	if (decoded.cliActorClaimsRequestHeaderStatus === "present_but_malformed") {
		return {
			...emptyContext,
			resolvedKanbanActor: {
				kanbanActorKind: "unresolved_actor",
				unresolvedActorReason: "kanban_cli_invocation_environment_actor_claims_request_header_malformed",
			},
		};
	}

	const claims = decoded.claims;
	const claimed = claims.claimedEnvironmentVariableValuesByName;
	const nativeSession = resolveClaimedNativeConversationSessionIdentity(claimed);
	const cliContext = {
		...emptyContext,
		actorNativeConversationSessionIdentity: nativeSession.identity,
		actorKanbanTaskConversationSessionId: claimed.KANBAN_TASK_CONVERSATION_SESSION_ID ?? null,
		invokingKanbanCliCodeVersion: claims.invokingKanbanCliCodeVersion,
	};
	const claimedKanbanTaskId = claimed.KANBAN_TASK_ID;

	if (claimedKanbanTaskId && isHomeAgentSessionId(claimedKanbanTaskId)) {
		return {
			...cliContext,
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_home_sidebar_agent_session_not_a_work_unit",
				homeSidebarAgentSessionId: claimedKanbanTaskId,
			},
		};
	}

	if (claimedKanbanTaskId) {
		const claimedWorkspaceId =
			claimed.KANBAN_HOOK_WORKSPACE_ID ??
			(claimed.KANBAN_PROJECT_PATH
				? await lookups.findWorkspaceIdByRepositoryPathForActorResolution(claimed.KANBAN_PROJECT_PATH)
				: null);
		const actingCard = claimedWorkspaceId
			? await lookups.findKanbanBoardCardIncarnationForActorResolution(claimedWorkspaceId, claimedKanbanTaskId)
			: null;
		if (!claimedWorkspaceId || !actingCard) {
			return {
				...cliContext,
				resolvedKanbanActor: {
					kanbanActorKind: "unresolved_actor",
					unresolvedActorReason: claimedWorkspaceId
						? "claimed_kanban_task_id_not_found_on_claimed_workspace_board"
						: "claimed_kanban_task_id_without_resolvable_workspace",
				},
			};
		}
		return {
			...cliContext,
			actorRepositoryIdentityAtEventTime: {
				workspaceId: claimedWorkspaceId,
				repositoryPath: actingCard.workspaceRepositoryPath,
			},
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_board_card_work_unit",
				actingKanbanBoardCardWorkUnit: {
					workUnitType: "kanban_board_card",
					workspaceId: claimedWorkspaceId,
					taskId: claimedKanbanTaskId,
					taskIncarnationCreatedAtEpochMs: actingCard.taskIncarnationCreatedAtEpochMs,
				},
			},
		};
	}

	if (nativeSession.identity) {
		// EXPERIMENT_NODE: 1a.4 接入会话归属登记后，先按事件时刻查登记（手动 resume 的卡片会话归卡片），查不到才是独立会话。
		return {
			...cliContext,
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_unmanaged_standalone_agent_conversation_session_work_unit",
				actingStandaloneAgentConversationSession: {
					workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
					...nativeSession.identity,
				},
			},
		};
	}

	if (nativeSession.ambiguousVariableNames.length > 0) {
		return {
			...cliContext,
			resolvedKanbanActor: {
				kanbanActorKind: "unresolved_actor",
				unresolvedActorReason: `multiple_native_conversation_session_environment_variables_claimed:${nativeSession.ambiguousVariableNames.join(",")}`,
			},
		};
	}

	return {
		...cliContext,
		resolvedKanbanActor: {
			kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
			missingEnvironmentVariableNames:
				KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION.filter(
					(variableName) => !claimed[variableName],
				),
		},
	};
}

export function buildTaskMutationIntentFromResolvedKanbanActor(
	taskMutationIntentKind: string,
	resolved: ResolvedKanbanActorWithEventEnvelopeContext,
	extras: Pick<TaskMutationIntentWithResolvedActor, "idempotencyKey"> = {},
): TaskMutationIntentWithResolvedActor {
	return {
		taskMutationIntentKind,
		resolvedKanbanActor: resolved.resolvedKanbanActor,
		actorNativeConversationSessionIdentity: resolved.actorNativeConversationSessionIdentity,
		actorKanbanTaskConversationSessionId: resolved.actorKanbanTaskConversationSessionId,
		actorRepositoryIdentityAtEventTime: resolved.actorRepositoryIdentityAtEventTime,
		invokingKanbanCliCodeVersion: resolved.invokingKanbanCliCodeVersion,
		idempotencyKey: extras.idempotencyKey ?? null,
	};
}
