import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import type { TaskMutationIntentWithResolvedActor } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

// 测试直接调用 board 持久化漏斗时使用的意图。单测进程不注册关系账本捕获，这个意图只用来满足必填参数。
export const TASK_MUTATION_INTENT_FOR_TEST_FIXTURE: TaskMutationIntentWithResolvedActor = {
	taskMutationIntentKind: "test_fixture_direct_workspace_state_persistence_funnel_call",
	resolvedKanbanActor: { kanbanActorKind: "unresolved_actor", unresolvedActorReason: "test_fixture" },
};

// 测试直接调用 runtime api 方法时的请求发起方证据：没有 CLI 行动者声明头（等同今天的 Web UI 请求），
// 解析结果是 direct_runtime_trpc_caller，且不会触发任何 lookups（不读 workspace 索引与 board.json）。
export const KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE: KanbanRequestOriginActorEvidence =
	{
		decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
	};
