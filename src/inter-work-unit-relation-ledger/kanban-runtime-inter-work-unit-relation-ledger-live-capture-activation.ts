import type {
	CapturingKanbanRuntimeInstanceIdentity,
	FactObservedByKanbanRuntimeKind,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	buildTaskMutationIntentForKanbanRuntimeSystemComponent,
	getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { listWorkspaceIndexEntries, mutateWorkspaceState, resolveWorkspacePath } from "../state/workspace-state";
import { scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess } from "../terminal/kanban-task-agent-session-work-unit-identity-environment";
import {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	InterWorkUnitRelationLedgerUnavailableError,
	resolveInterWorkUnitRelationLedgerStorageRootDirectory,
} from "./inter-work-unit-relation-ledger-database-worker-client";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "./workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";

// 本 runtime 实例已接线的 live 捕获能力。随 1a 各增量落地逐项追加；读侧据此区分「没发生」与「当时还没在记」。
const KANBAN_RUNTIME_LIVE_CAPTURE_CAPABILITIES_ACTIVATED_BY_THIS_CODE_VERSION = [
	"task_mutation_event_capture_within_runtime_persistence_funnel",
	"task_mutation_detection_by_board_diff_outside_runtime_persistence_funnel",
	// 1a.2b：`kanban task` create/update/start/trash/delete 经 runtime procedure 落盘，行动者按 CLI 声明头解析。
	"kanban_cli_task_board_write_verbs_captured_within_runtime_persistence_funnel_with_resolved_actor",
	"board_state_baseline_observation_at_first_capture_of_each_workspace",
	// 激活后立即（不阻塞启动）为工作区索引里每个既有 workspace 建立基线，部署后首次漏斗通过前的漏斗外变更也能被检出。
	"board_state_baseline_eagerly_established_for_every_indexed_workspace_right_after_activation",
	"inherited_work_unit_identity_environment_scrubbed_at_runtime_start",
	"acp_task_agent_process_work_unit_identity_environment_injection",
	"user_terminal_input_submission_observation_rate_limited_per_session",
] as const;

// EXPERIMENT_NODE: 终端输入提交观测每会话 60s 至多一条——够判定「用户介入过」，又不把按键频率写进账本。
const USER_TERMINAL_INPUT_SUBMISSION_OBSERVATION_MINIMUM_INTERVAL_PER_SESSION_MS = 60_000;

const EAGER_BOARD_STATE_BASELINE_ESTABLISHMENT_SYSTEM_COMPONENT_NAME =
	"kanban_runtime_inter_work_unit_relation_ledger_live_capture_activation_eager_board_state_baseline_establishment";

export interface ActivatedKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture {
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
	// 急切基线任务的完成信号（永不 reject；单个 workspace 失败只记告警）。runtime 不等它，测试与关停用它对齐。
	eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion: Promise<void>;
	deactivate(): Promise<void>;
}

interface ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState {
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	lastUserTerminalInputSubmissionObservationAtBySessionKey: Map<string, number>;
	eagerBoardStateBaselineEstablishmentCancelledByDeactivation: boolean;
}

let activeLiveCaptureState: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState | null = null;

// runtime 观测到的事实（族 3），由系统组件记账。不阻塞调用方；账本不可用时只记告警。
function recordFactObservedByKanbanRuntimeWithoutBlocking(input: {
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState;
	observedFactKind: FactObservedByKanbanRuntimeKind;
	observingKanbanRuntimeSystemComponentName: string;
	subjectWorkspaceId: string | null;
	subjectTaskId: string | null;
	eventPayload: Record<string, unknown>;
}): void {
	void input.state.ledgerClient
		.appendCommittedEvents({
			eventDrafts: [
				{
					eventFamily: "fact_observed_by_kanban_runtime_event",
					eventKind: input.observedFactKind,
					occurredAt: Date.now(),
					actor: {
						kanbanActorKind: "kanban_runtime_system_component",
						kanbanRuntimeSystemComponentName: input.observingKanbanRuntimeSystemComponentName,
					},
					actorNativeConversationSessionIdentity: null,
					actorKanbanTaskConversationSessionId: null,
					actorRepositoryIdentityAtEventTime: null,
					onBehalfOfInitiatingWorkUnit: null,
					causedBySystemExecutedCause: null,
					recordCaptureChannel: "live_runtime_capture",
					capturingKanbanRuntimeInstance: input.state.capturingKanbanRuntimeInstance,
					invokingKanbanCliCodeVersion: null,
					occurredAtConversationTurnReference: null,
					idempotencyKey: null,
					subjectWorkspaceId: input.subjectWorkspaceId,
					subjectTaskId: input.subjectTaskId,
					eventPayload: { observedFactKind: input.observedFactKind, ...input.eventPayload },
				},
			],
		})
		.catch((error: unknown) => {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`could not record ${input.observedFactKind}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
}

// 终端里用户提交了一次输入（含 CR/LF）。不记内容，只记「此会话此刻有人工提交」；供门条件与义务判定区分人工介入。
export function recordUserTerminalInputSubmissionObservedForSessionWithoutBlocking(input: {
	workspaceId: string;
	kanbanTaskConversationSessionId: string;
}): void {
	const state = activeLiveCaptureState;
	if (!state) {
		return;
	}
	const sessionKey = `${input.workspaceId}\u0000${input.kanbanTaskConversationSessionId}`;
	const now = Date.now();
	const lastObservedAt = state.lastUserTerminalInputSubmissionObservationAtBySessionKey.get(sessionKey);
	if (
		lastObservedAt !== undefined &&
		now - lastObservedAt < USER_TERMINAL_INPUT_SUBMISSION_OBSERVATION_MINIMUM_INTERVAL_PER_SESSION_MS
	) {
		return;
	}
	state.lastUserTerminalInputSubmissionObservationAtBySessionKey.set(sessionKey, now);
	recordFactObservedByKanbanRuntimeWithoutBlocking({
		state,
		observedFactKind: "user_terminal_input_submission_observed_for_session",
		observingKanbanRuntimeSystemComponentName: "terminal_session_manager_user_input_observer",
		subjectWorkspaceId: input.workspaceId,
		subjectTaskId: input.kanbanTaskConversationSessionId,
		eventPayload: {
			kanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
			observationRateLimitIntervalMs: USER_TERMINAL_INPUT_SUBMISSION_OBSERVATION_MINIMUM_INTERVAL_PER_SESSION_MS,
		},
	});
}

// 激活基线原本要等某 workspace 第一次过 runtime 持久化漏斗才写；在那之前仍直接写盘的 CLI 动词（task link/unlink）
// 或手改 board.json 会被吞进基线，而不是被检出为漏斗外发生。所以激活后立刻为索引里每个既有 workspace 走一次
// 「不保存」的漏斗通过：在 board 锁内对账（无基线则写基线、有基线则检出漏斗外 diff），不改 board、不推进 revision、不写盘。
// 逐个串行：漏斗内的 git 探测是同步子进程，串行把事件循环的阻塞摊薄成若干小段。
async function establishBoardStateBaselineForEveryIndexedWorkspaceWithoutBoardWrite(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
): Promise<void> {
	let indexedWorkspaces: Awaited<ReturnType<typeof listWorkspaceIndexEntries>>;
	try {
		indexedWorkspaces = await listWorkspaceIndexEntries();
	} catch (error) {
		logInterWorkUnitRelationLedgerDiagnosticWarning(
			`could not list indexed workspaces for eager board state baseline: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	const taskMutationIntentForBaselineOnlyFunnelPass = buildTaskMutationIntentForKanbanRuntimeSystemComponent(
		"board_state_baseline_only_funnel_pass_without_board_write_at_live_capture_activation",
		EAGER_BOARD_STATE_BASELINE_ESTABLISHMENT_SYSTEM_COMPONENT_NAME,
	);
	for (const indexedWorkspace of indexedWorkspaces) {
		if (state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation) {
			return;
		}
		try {
			// 漏斗按 cwd 解析工作区且会自动注册未知仓库；仓库路径已漂移（移动/软链变化）时跳过，绝不顺手注册新项目。
			const currentlyResolvedRepositoryPath = await resolveWorkspacePath(indexedWorkspace.repoPath);
			if (currentlyResolvedRepositoryPath !== indexedWorkspace.repoPath) {
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`skipped eager board state baseline for workspace ${indexedWorkspace.workspaceId}: repository path ${indexedWorkspace.repoPath} now resolves to ${currentlyResolvedRepositoryPath}`,
				);
				continue;
			}
			if (state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation) {
				return;
			}
			await mutateWorkspaceState(
				indexedWorkspace.repoPath,
				taskMutationIntentForBaselineOnlyFunnelPass,
				(currentWorkspaceState) => ({ board: currentWorkspaceState.board, value: null, save: false }),
			);
		} catch (error) {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`could not establish eager board state baseline for workspace ${indexedWorkspace.workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

interface WorkspaceBoardPersistenceFunnelTaskMutationEventCaptureThatFailsClosedAfterDeactivation {
	capture: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture;
	// 置停用标志并等已在途的账本调用落定；之后 reconcile / recordPending 一律以账本不可用拒绝。
	deactivateAndWaitForInFlightLedgerCalls(): Promise<void>;
}

// 停用后的进程内 board 写入必须 fail-closed（board 只读），绝不能退回「未注册进程」的直接写盘：
// 停机期间仍在进入的 tRPC mutation 若看到 capture=null 就会写三份 JSON 而不建 pending 批次，原行动者永久丢失。
// 所以停用不注销捕获，而是让同一个捕获对象从此拒写；停用前已在途的调用先等它们落定，再关 worker——
// worker client 关闭后再发请求会悄悄重开一个新 worker，不能让在途调用的后半段落到那里。
function wrapCaptureSoItFailsClosedAfterDeactivation(
	liveCaptureBackedByRelationLedger: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
): WorkspaceBoardPersistenceFunnelTaskMutationEventCaptureThatFailsClosedAfterDeactivation {
	let liveCaptureDeactivated = false;
	const inFlightLedgerCalls = new Set<Promise<unknown>>();
	const rejectBecauseLiveCaptureDeactivated = (): never => {
		throw new InterWorkUnitRelationLedgerUnavailableError(
			"the live capture of this Kanban runtime instance was deactivated (runtime is shutting down)",
		);
	};
	const trackInFlightLedgerCall = async <T>(ledgerCall: Promise<T>): Promise<T> => {
		inFlightLedgerCalls.add(ledgerCall);
		try {
			return await ledgerCall;
		} finally {
			inFlightLedgerCalls.delete(ledgerCall);
		}
	};
	return {
		capture: {
			reconcileLedgerWithPersistedBoardWithinBoardLock: async (input) => {
				if (liveCaptureDeactivated) rejectBecauseLiveCaptureDeactivated();
				return await trackInFlightLedgerCall(
					liveCaptureBackedByRelationLedger.reconcileLedgerWithPersistedBoardWithinBoardLock(input),
				);
			},
			recordPendingTaskMutationEventsBeforeBoardFileWrite: async (input) => {
				if (liveCaptureDeactivated) rejectBecauseLiveCaptureDeactivated();
				return await trackInFlightLedgerCall(
					liveCaptureBackedByRelationLedger.recordPendingTaskMutationEventsBeforeBoardFileWrite(input),
				);
			},
			// 三个 JSON 已写完、board 变更已成事实，提交按约定不抛：停用后不再提交，批次保持 pending，
			// 下一次 runtime 启动后首个漏斗通过时按盘上 board 哈希结算（Y-EVENT-2 第 1 步），行动者不丢。
			commitPendingTaskMutationEventsAfterBoardFileWrite: async (input) => {
				if (liveCaptureDeactivated) {
					logInterWorkUnitRelationLedgerDiagnosticWarning(
						`pending task mutation event batch ${input.pendingBatchId} was left pending because live capture was deactivated; it will be resolved on the next persistence funnel pass`,
					);
					return;
				}
				await trackInFlightLedgerCall(
					liveCaptureBackedByRelationLedger.commitPendingTaskMutationEventsAfterBoardFileWrite(input),
				);
			},
			recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking: (input) => {
				if (liveCaptureDeactivated) {
					logInterWorkUnitRelationLedgerDiagnosticWarning(
						`native conversation session identity observation for ${input.kanbanTaskConversationSessionId} was not recorded because live capture was deactivated`,
					);
					return;
				}
				liveCaptureBackedByRelationLedger.recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking(
					input,
				);
			},
		},
		deactivateAndWaitForInFlightLedgerCalls: async () => {
			liveCaptureDeactivated = true;
			await Promise.allSettled([...inFlightLedgerCalls]);
		},
	};
}

// 关系账本只在 runtime 进程内打开（dd2db §R3 Y-EVENT-1）。注册之后，本进程每一次 board 写入都先过账本；
// 账本打不开时漏斗拒写（board 只读），这里只记告警、不阻塞 runtime 启动。
// 能力激活标记不 await：worker 按消息顺序处理，标记在本函数返回前已同步入队，必然排在任何漏斗事件之前。
export function activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture(): ActivatedKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture {
	const inheritedWorkUnitIdentityEnvironmentVariableNamesScrubbedAtRuntimeStart =
		scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess(process.env);
	const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
		resolveInterWorkUnitRelationLedgerStorageRootDirectory(),
	);
	const state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState = {
		ledgerClient,
		capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
		lastUserTerminalInputSubmissionObservationAtBySessionKey: new Map(),
		eagerBoardStateBaselineEstablishmentCancelledByDeactivation: false,
	};
	activeLiveCaptureState = state;
	const captureThatFailsClosedAfterDeactivation = wrapCaptureSoItFailsClosedAfterDeactivation(
		createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
			ledgerClient,
			capturingKanbanRuntimeInstance: state.capturingKanbanRuntimeInstance,
		}),
	);
	// 同进程先后激活多个实例（测试）时，本实例停用后把注册还给激活前的那一个，而不是清空成 null。
	const captureRegisteredBeforeThisActivation = getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture();
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureThatFailsClosedAfterDeactivation.capture);
	recordFactObservedByKanbanRuntimeWithoutBlocking({
		state,
		observedFactKind: "runtime_instance_live_capture_capabilities_activated",
		observingKanbanRuntimeSystemComponentName:
			"kanban_runtime_inter_work_unit_relation_ledger_live_capture_activation",
		subjectWorkspaceId: null,
		subjectTaskId: null,
		eventPayload: {
			inheritedWorkUnitIdentityEnvironmentVariableNamesScrubbedAtRuntimeStart,
			activatedLiveCaptureCapabilities: [...KANBAN_RUNTIME_LIVE_CAPTURE_CAPABILITIES_ACTIVATED_BY_THIS_CODE_VERSION],
		},
	});
	// 不 await：急切基线在能力激活标记入队之后才开始发账本消息，顺序天然在标记之后。
	const eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion =
		establishBoardStateBaselineForEveryIndexedWorkspaceWithoutBoardWrite(state).catch((error: unknown) => {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`eager board state baseline establishment failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	return {
		ledgerClient,
		eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion,
		deactivate: async () => {
			if (activeLiveCaptureState === state) {
				activeLiveCaptureState = null;
			}
			state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation = true;
			// 同步置停用：从这一刻起进程内新的 board 写入一律以账本不可用拒绝（fail-closed），绝不退回直接写盘。
			const drainOfLedgerCallsInFlightAtDeactivation =
				captureThatFailsClosedAfterDeactivation.deactivateAndWaitForInFlightLedgerCalls();
			// 关 worker 前要等两类在途工作收尾——client 关闭后再收到请求会悄悄重开 worker：
			// 急切基线任务单独等（它在下一个检查点因取消标志退出，或撞上 fail-closed 只记告警，永不 reject），
			// 其余漏斗调用（停机期间仍在执行的 tRPC mutation）由 drain 覆盖。
			await eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			await drainOfLedgerCallsInFlightAtDeactivation;
			// 只在注册的仍是本实例时才替换：之后激活的实例的捕获不能被旧实例停用清掉。
			// 激活前没有任何注册（真实 runtime 进程）时，保留本实例已停用的捕获：此后进程内 board 写入一律拒写。
			if (
				getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture() ===
					captureThatFailsClosedAfterDeactivation.capture &&
				captureRegisteredBeforeThisActivation !== null
			) {
				registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureRegisteredBeforeThisActivation);
			}
			await ledgerClient.close();
		},
	};
}
