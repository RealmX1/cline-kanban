import { describe, expect, it, vi } from "vitest";

import { createHomeAgentSessionId } from "../../../src/core/home-agent-session";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION,
} from "../../../src/core/kanban-cli-invocation-environment-actor-claims";
import {
	buildTaskMutationIntentFromResolvedKanbanActor,
	type KanbanActorResolutionLookups,
	type KanbanRequestOriginActorEvidence,
	resolveKanbanActorFromRequestOriginEvidence,
} from "../../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";

// 行动者解析（dd2db §R3 Y-EVENT-7）的纯单测：请求头按 CLI 真实路径编码 → runtime 解码 → 解析。
// lookups 用内存桩，不碰 workspace 索引与 board.json。

const ACTING_WORKSPACE_ID = "acting-workspace";
const ACTING_WORKSPACE_REPOSITORY_PATH = "/repositories/acting-workspace";
const ACTING_TASK_ID = "a1b2c";
const ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS = 1_700_000_000_000;
const INVOKING_KANBAN_CLI_CODE_VERSION = "9.9.9-test";

function createEvidenceFromCliInvocationEnvironment(
	environment: Record<string, string | undefined>,
): KanbanRequestOriginActorEvidence {
	const headerValue = encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
		collectKanbanCliInvocationEnvironmentActorClaims({
			environment,
			invokingKanbanCliCodeVersion: INVOKING_KANBAN_CLI_CODE_VERSION,
			invokingProcessWorkingDirectory: "/somewhere",
		}),
	);
	return {
		decodedCliActorClaimsRequestHeader:
			decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(headerValue),
	};
}

function createLookupsWithActingCardOnBoard() {
	return {
		findKanbanBoardCardIncarnationForActorResolution: vi.fn<
			KanbanActorResolutionLookups["findKanbanBoardCardIncarnationForActorResolution"]
		>(async (workspaceId, taskId) =>
			workspaceId === ACTING_WORKSPACE_ID && taskId === ACTING_TASK_ID
				? {
						taskIncarnationCreatedAtEpochMs: ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS,
						workspaceRepositoryPath: ACTING_WORKSPACE_REPOSITORY_PATH,
					}
				: null,
		),
		findWorkspaceIdByRepositoryPathForActorResolution: vi.fn<
			KanbanActorResolutionLookups["findWorkspaceIdByRepositoryPathForActorResolution"]
		>(async (repositoryPath) => (repositoryPath === ACTING_WORKSPACE_REPOSITORY_PATH ? ACTING_WORKSPACE_ID : null)),
	} satisfies KanbanActorResolutionLookups;
}

describe("resolveKanbanActorFromRequestOriginEvidence", () => {
	it("卡片会话里调用的 CLI：解析为带 incarnation 戳的看板卡片工作单元，并带上原生会话与仓库身份", async () => {
		const lookups = createLookupsWithActingCardOnBoard();
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_HOOK_WORKSPACE_ID: ACTING_WORKSPACE_ID,
				KANBAN_TASK_CONVERSATION_SESSION_ID: ACTING_TASK_ID,
				KANBAN_PROJECT_PATH: ACTING_WORKSPACE_REPOSITORY_PATH,
				CLAUDE_CODE_SESSION_ID: "claude-native-session-1",
			}),
			lookups,
		);

		expect(resolved).toEqual({
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_board_card_work_unit",
				actingKanbanBoardCardWorkUnit: {
					workUnitType: "kanban_board_card",
					workspaceId: ACTING_WORKSPACE_ID,
					taskId: ACTING_TASK_ID,
					taskIncarnationCreatedAtEpochMs: ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS,
				},
			},
			actorNativeConversationSessionIdentity: {
				conversationSessionHostKanbanAgentId: "claude",
				nativeConversationSessionId: "claude-native-session-1",
			},
			actorKanbanTaskConversationSessionId: ACTING_TASK_ID,
			actorRepositoryIdentityAtEventTime: {
				workspaceId: ACTING_WORKSPACE_ID,
				repositoryPath: ACTING_WORKSPACE_REPOSITORY_PATH,
			},
			invokingKanbanCliCodeVersion: INVOKING_KANBAN_CLI_CODE_VERSION,
		});
		// 声明了 workspace id 就不再按路径反查。
		expect(lookups.findWorkspaceIdByRepositoryPathForActorResolution).not.toHaveBeenCalled();
	});

	it("只声明了仓库路径（没有 workspace id）时，按路径反查 workspace 后照样解析出卡片", async () => {
		const lookups = createLookupsWithActingCardOnBoard();
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_PROJECT_PATH: ACTING_WORKSPACE_REPOSITORY_PATH,
			}),
			lookups,
		);

		expect(lookups.findWorkspaceIdByRepositoryPathForActorResolution).toHaveBeenCalledWith(
			ACTING_WORKSPACE_REPOSITORY_PATH,
		);
		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "kanban_board_card_work_unit",
			actingKanbanBoardCardWorkUnit: {
				workUnitType: "kanban_board_card",
				workspaceId: ACTING_WORKSPACE_ID,
				taskId: ACTING_TASK_ID,
				taskIncarnationCreatedAtEpochMs: ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS,
			},
		});
	});

	it("声明的卡片在声明的看板上找不到：未解析，不猜测", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: "gone1",
				KANBAN_HOOK_WORKSPACE_ID: ACTING_WORKSPACE_ID,
				CLAUDE_CODE_SESSION_ID: "claude-native-session-1",
			}),
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "unresolved_actor",
			unresolvedActorReason: "claimed_kanban_task_id_not_found_on_claimed_workspace_board",
		});
		// 卡片找不到时也不降级成「独立会话」：声明了卡片却对不上，本身就是需要人看的异常。
		expect(resolved.actorRepositoryIdentityAtEventTime).toBeNull();
	});

	it("声明了卡片却给不出可解析的 workspace：未解析", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_PROJECT_PATH: "/repositories/not-registered",
			}),
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "unresolved_actor",
			unresolvedActorReason: "claimed_kanban_task_id_without_resolvable_workspace",
		});
	});

	it("看板外独立 agent 会话里调用的 CLI：解析为独立会话工作单元", async () => {
		const lookups = createLookupsWithActingCardOnBoard();
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({ CODEX_THREAD_ID: "codex-thread-7" }),
			lookups,
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "kanban_unmanaged_standalone_agent_conversation_session_work_unit",
			actingStandaloneAgentConversationSession: {
				workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
				conversationSessionHostKanbanAgentId: "codex",
				nativeConversationSessionId: "codex-thread-7",
			},
		});
		expect(resolved.actorNativeConversationSessionIdentity).toEqual({
			conversationSessionHostKanbanAgentId: "codex",
			nativeConversationSessionId: "codex-thread-7",
		});
		expect(lookups.findKanbanBoardCardIncarnationForActorResolution).not.toHaveBeenCalled();
	});

	it("侧边栏 home agent 会话：解析为「不是工作单元」的侧边栏行动者，不去看板上找卡", async () => {
		const homeSidebarAgentSessionId = createHomeAgentSessionId(ACTING_WORKSPACE_ID, "claude");
		const lookups = createLookupsWithActingCardOnBoard();
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: homeSidebarAgentSessionId,
				KANBAN_HOOK_WORKSPACE_ID: ACTING_WORKSPACE_ID,
				CLAUDE_CODE_SESSION_ID: "claude-native-session-2",
			}),
			lookups,
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "kanban_home_sidebar_agent_session_not_a_work_unit",
			homeSidebarAgentSessionId,
		});
		expect(lookups.findKanbanBoardCardIncarnationForActorResolution).not.toHaveBeenCalled();
	});

	it("没有任何卡片或会话环境的 CLI 调用（人在自己的终端里敲）：列出缺失的全部环境变量", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({ PATH: "/usr/bin", HOME: "/home/someone" }),
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
			missingEnvironmentVariableNames: [
				...KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION,
			],
		});
		expect(resolved.invokingKanbanCliCodeVersion).toBe(INVOKING_KANBAN_CLI_CODE_VERSION);
	});

	it("行动者声明头损坏：是 CLI 请求但声明不可读，未解析（不当作「不是 CLI 请求」）", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			{
				decodedCliActorClaimsRequestHeader:
					decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue("this-is-not-base64url-json"),
			},
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "unresolved_actor",
			unresolvedActorReason: "kanban_cli_invocation_environment_actor_claims_request_header_malformed",
		});
		expect(resolved.invokingKanbanCliCodeVersion).toBeNull();
	});

	it("同时声明了多个 harness 的原生会话变量（嵌套 harness）：无法判定最内层，未解析并列出冲突变量", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				CLAUDE_CODE_SESSION_ID: "claude-native-session-3",
				CODEX_THREAD_ID: "codex-thread-8",
			}),
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "unresolved_actor",
			unresolvedActorReason:
				"multiple_native_conversation_session_environment_variables_claimed:CLAUDE_CODE_SESSION_ID,CODEX_THREAD_ID",
		});
		expect(resolved.actorNativeConversationSessionIdentity).toBeNull();
	});

	it("没有 CLI 声明头但带着已签发的页面 nonce：来自页面、未标注发起方（nonce 证明不了是用户手势）", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			{
				decodedCliActorClaimsRequestHeader:
					decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
				webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
			},
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind:
				"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
		});
	});

	it("CLI 声明头优先于页面 nonce：同时带两者时按 CLI 声明解析，永远不记为 Web UI 用户", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			{
				...createEvidenceFromCliInvocationEnvironment({
					KANBAN_TASK_ID: ACTING_TASK_ID,
					KANBAN_HOOK_WORKSPACE_ID: ACTING_WORKSPACE_ID,
				}),
				webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
			},
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor.kanbanActorKind).toBe("kanban_board_card_work_unit");
	});

	it("既没有 CLI 声明头也没有页面 nonce（裸 tRPC 调用方）：direct_runtime_trpc_caller", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			{
				decodedCliActorClaimsRequestHeader:
					decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
			},
			createLookupsWithActingCardOnBoard(),
		);

		expect(resolved.resolvedKanbanActor).toEqual({
			kanbanActorKind: "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce",
		});
	});
});

describe("buildTaskMutationIntentFromResolvedKanbanActor", () => {
	it("把解析结果连同事件信封上下文原样搬进漏斗意图", async () => {
		const resolved = await resolveKanbanActorFromRequestOriginEvidence(
			createEvidenceFromCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_HOOK_WORKSPACE_ID: ACTING_WORKSPACE_ID,
				KANBAN_TASK_CONVERSATION_SESSION_ID: ACTING_TASK_ID,
			}),
			createLookupsWithActingCardOnBoard(),
		);

		expect(buildTaskMutationIntentFromResolvedKanbanActor("kanban_cli_task_create", resolved)).toEqual({
			taskMutationIntentKind: "kanban_cli_task_create",
			resolvedKanbanActor: resolved.resolvedKanbanActor,
			actorNativeConversationSessionIdentity: null,
			actorKanbanTaskConversationSessionId: ACTING_TASK_ID,
			actorRepositoryIdentityAtEventTime: {
				workspaceId: ACTING_WORKSPACE_ID,
				repositoryPath: ACTING_WORKSPACE_REPOSITORY_PATH,
			},
			invokingKanbanCliCodeVersion: INVOKING_KANBAN_CLI_CODE_VERSION,
			idempotencyKey: null,
		});
	});
});
