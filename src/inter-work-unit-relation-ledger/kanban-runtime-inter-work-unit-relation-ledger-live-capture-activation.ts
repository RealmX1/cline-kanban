import { homedir } from "node:os";
import { join } from "node:path";

import type {
	CapturingKanbanRuntimeInstanceIdentity,
	FactObservedByKanbanRuntimeKind,
	InterWorkUnitRelationLedgerEventDraft,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	buildTaskMutationIntentForKanbanRuntimeSystemComponent,
	getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import {
	getTaskWorktreesHomePath,
	listWorkspaceIndexEntries,
	mutateWorkspaceState,
	resolveWorkspacePath,
} from "../state/workspace-state";
import { scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess } from "../terminal/kanban-task-agent-session-work-unit-identity-environment";
import { collectTaskIdReservationSeedingResultFromExistingLocalTraces } from "./global-task-identity-registry-task-id-reservation-seeding-from-existing-local-traces";
import {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	InterWorkUnitRelationLedgerUnavailableError,
	resolveInterWorkUnitRelationLedgerStorageRootDirectory,
} from "./inter-work-unit-relation-ledger-database-worker-client";
import { logInterWorkUnitRelationLedgerDiagnosticWarning } from "./inter-work-unit-relation-ledger-diagnostics-logger";
import {
	RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger,
	type RecordedInterWorkUnitRelationProjectionReader,
} from "./recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
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
	"cline_sdk_bash_tool_executor_work_unit_identity_environment_injection",
	"user_terminal_input_submission_observation_rate_limited_per_session",
	// Y-EVENT-12：id 只由 runtime 分配；激活时把本机痕迹里出现过的 id 占住，漏斗锁内拒绝已占用 id 的新卡。
	"task_id_allocation_by_runtime_unique_against_global_task_identity_registry",
	"task_id_reservation_seeded_from_existing_local_traces_at_activation",
	// 播种是分配的就绪屏障：播种成功之前分配一律等待，播种失败则分配以账本不可用拒绝（fail-closed）。
	"task_id_allocation_withheld_until_task_id_reservation_seeding_from_existing_local_traces_succeeds",
	// Y-EVENT-14：sendTaskChatMessage（CLI `task message` 与 Web UI 聊天）记族 1 message 事件：撰写者、幂等键、正文哈希。
	"task_message_delivery_request_capture_with_body_authorship_idempotency_key_and_body_sha256",
	// Y-PHASE-3：删 worktree 不再连带删 provenance；最终探测拿不到 live 快照时记族 3 事件。
	"task_commit_integration_provenance_retained_after_worktree_deletion_with_final_probe_failure_observation",
] as const;

// EXPERIMENT_NODE: 终端输入提交观测每会话 60s 至多一条——够判定「用户介入过」，又不把按键频率写进账本。
const USER_TERMINAL_INPUT_SUBMISSION_OBSERVATION_MINIMUM_INTERVAL_PER_SESSION_MS = 60_000;

const EAGER_BOARD_STATE_BASELINE_ESTABLISHMENT_SYSTEM_COMPONENT_NAME =
	"kanban_runtime_inter_work_unit_relation_ledger_live_capture_activation_eager_board_state_baseline_establishment";

export interface ActivatedKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture {
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
	// 急切基线任务的完成信号（排在首次 id 播种尝试之后；永不 reject；播种或单个 workspace 失败只记告警）。
	// runtime 不等它，测试与关停用它对齐。id 分配只等播种、不等它（见就绪屏障）。
	eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion: Promise<void>;
	deactivate(): Promise<void>;
}

// live capture 的停用生命周期。只向前推进：激活 → 停用 drain 中 → worker client 已关闭。
type KanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureLifecyclePhase =
	| "live_capture_active"
	// 停用已开始：新的后台账本记录一律拒绝（只记告警）；发起于此之前、仍在途的记录与漏斗调用先落定。
	| "deactivation_draining_in_flight_ledger_calls_before_closing_ledger_worker_client"
	// drain 已结束、worker client 已（正在）关闭：经本状态的任何账本追加一律拒绝——client 关闭后再发请求会悄悄重开 worker。
	| "ledger_worker_client_closed_after_deactivation";

interface ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState {
	ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	lastUserTerminalInputSubmissionObservationAtBySessionKey: Map<string, number>;
	eagerBoardStateBaselineEstablishmentCancelledByDeactivation: boolean;
	liveCaptureLifecyclePhase: KanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureLifecyclePhase;
	// 不阻塞调用方的后台账本记录（族 3 事实、message 事件、PDV 观测……）中仍在途的整段工作（含追加前的异步读取）。
	// 停用 drain 等它们全部落定之后才关 worker；落定后自行移出。
	backgroundLedgerEventRecordingsInFlight: Set<Promise<void>>;
	// dd2db 1b 读侧：本实例的记录型关系投影（内存态，随实例生灭）与在途的投影读取（停用 drain 同样等它们）。
	recordedInterWorkUnitRelationProjection: RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger;
	recordedInterWorkUnitRelationProjectionReadsInFlight: Set<Promise<unknown>>;
}

// 最近一次激活的实例状态。停用后**不清空**：保留已停用的状态，入口才能区分「本进程从未激活」（CLI 进程、单测：静默跳过）
// 与「已停用」（拒绝并告警）。同进程先后激活多个实例（测试）时指向最后激活的那一个。
let activeLiveCaptureState: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState | null = null;

function buildFactObservedByKanbanRuntimeEventDraft(input: {
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState;
	observedFactKind: FactObservedByKanbanRuntimeKind;
	observingKanbanRuntimeSystemComponentName: string;
	subjectWorkspaceId: string | null;
	subjectTaskId: string | null;
	eventPayload: Record<string, unknown>;
}): InterWorkUnitRelationLedgerEventDraft {
	return {
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
	};
}

type FactObservedByKanbanRuntimeObservation = Omit<
	Parameters<typeof buildFactObservedByKanbanRuntimeEventDraft>[0],
	"state"
>;

// 后台记录**发起时**绑定的那一个实例：账本 client 与本实例身份都取自发起时刻，绝不在异步读取之后重读全局状态——
// 否则停用期间的记录会被丢掉，或记到随后激活的另一个实例名下。追加只经这里，worker client 已关闭则拒绝（绝不重开 worker）。
export interface KanbanRuntimeLiveCaptureBoundAtBackgroundLedgerEventRecordingInitiation {
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	appendCommittedEventsIntoLedgerOfBoundLiveCapture(input: {
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
	}): Promise<void>;
	appendFactObservedByKanbanRuntimeIntoLedgerOfBoundLiveCapture(
		observation: FactObservedByKanbanRuntimeObservation,
	): Promise<void>;
}

function bindLiveCaptureStateForBackgroundLedgerEventRecording(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
): KanbanRuntimeLiveCaptureBoundAtBackgroundLedgerEventRecordingInitiation {
	// 不能在调用 client 之前 await：同步发起的记录（能力激活标记等）靠「本函数返回前请求已同步入队」保序。
	const appendCommittedEventsIntoLedgerOfBoundLiveCapture = (input: {
		eventDrafts: InterWorkUnitRelationLedgerEventDraft[];
	}): Promise<void> => {
		if (state.liveCaptureLifecyclePhase === "ledger_worker_client_closed_after_deactivation") {
			return Promise.reject(
				new InterWorkUnitRelationLedgerUnavailableError(
					"the ledger worker client of this Kanban runtime instance was already closed by deactivation",
				),
			);
		}
		return state.ledgerClient.appendCommittedEvents(input);
	};
	return {
		capturingKanbanRuntimeInstance: state.capturingKanbanRuntimeInstance,
		appendCommittedEventsIntoLedgerOfBoundLiveCapture,
		appendFactObservedByKanbanRuntimeIntoLedgerOfBoundLiveCapture: (observation) =>
			appendCommittedEventsIntoLedgerOfBoundLiveCapture({
				eventDrafts: [buildFactObservedByKanbanRuntimeEventDraft({ ...observation, state })],
			}),
	};
}

// 停用开始后发起的新记录：拒绝并告警（与从未激活的静默跳过区分开）。返回 true 表示已拒绝。
function refuseBackgroundLedgerEventRecordingBecauseLiveCaptureWasDeactivated(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
	backgroundLedgerEventRecordingDescriptionForDiagnostics: string,
): boolean {
	if (state.liveCaptureLifecyclePhase === "live_capture_active") {
		return false;
	}
	logInterWorkUnitRelationLedgerDiagnosticWarning(
		`${backgroundLedgerEventRecordingDescriptionForDiagnostics} was not recorded because the live capture of this Kanban runtime instance was deactivated (runtime is shutting down)`,
	);
	return true;
}

interface BackgroundLedgerEventRecordingRequest {
	// 只用于告警文案，例如 "task message delivery request for r0002"。
	backgroundLedgerEventRecordingDescriptionForDiagnostics: string;
	// 整段后台工作：先做异步读取，再经绑定实例追加。抛错只记告警，绝不外溢成未处理 rejection。
	recordIntoLedgerOfBoundLiveCapture(
		boundLiveCapture: KanbanRuntimeLiveCaptureBoundAtBackgroundLedgerEventRecordingInitiation,
	): Promise<void>;
}

function startBackgroundLedgerEventRecordingBoundToLiveCaptureState(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
	request: BackgroundLedgerEventRecordingRequest,
): void {
	if (
		refuseBackgroundLedgerEventRecordingBecauseLiveCaptureWasDeactivated(
			state,
			request.backgroundLedgerEventRecordingDescriptionForDiagnostics,
		)
	) {
		return;
	}
	const boundLiveCapture = bindLiveCaptureStateForBackgroundLedgerEventRecording(state);
	// async IIFE 同步执行到第一个 await：不做前置读取的记录，其账本请求在本函数返回前已入队。永不 reject。
	const backgroundLedgerEventRecording = (async () => {
		try {
			await request.recordIntoLedgerOfBoundLiveCapture(boundLiveCapture);
		} catch (error) {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`could not record ${request.backgroundLedgerEventRecordingDescriptionForDiagnostics}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	})();
	state.backgroundLedgerEventRecordingsInFlight.add(backgroundLedgerEventRecording);
	void backgroundLedgerEventRecording.then(() => {
		state.backgroundLedgerEventRecordingsInFlight.delete(backgroundLedgerEventRecording);
	});
}

// 不阻塞调用方的后台账本记录的唯一公共入口（message 事件、PDV 观测等）：在**发起时**绑定当时激活的实例，
// 整段后台工作纳入该实例的停用 drain——停用开始后拒绝新记录只告警，已在途的先落定再关 worker。
// 本进程从未激活 live 捕获（CLI 进程、单测）时静默跳过。
export function startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking(
	request: BackgroundLedgerEventRecordingRequest,
): void {
	const state = activeLiveCaptureState;
	if (!state) {
		return;
	}
	startBackgroundLedgerEventRecordingBoundToLiveCaptureState(state, request);
}

// runtime 观测到的事实（族 3），由系统组件记账。不阻塞调用方；账本不可用时只记告警。请求在返回前同步入队。
function recordFactObservedByKanbanRuntimeWithoutBlocking(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
	observation: FactObservedByKanbanRuntimeObservation,
): void {
	startBackgroundLedgerEventRecordingBoundToLiveCaptureState(state, {
		backgroundLedgerEventRecordingDescriptionForDiagnostics: observation.observedFactKind,
		recordIntoLedgerOfBoundLiveCapture: (boundLiveCapture) =>
			boundLiveCapture.appendFactObservedByKanbanRuntimeIntoLedgerOfBoundLiveCapture(observation),
	});
}

// 其它 runtime 模块记族 3 事实的入口：调用即绑定当时激活的实例并同步入队；未激活 live 捕获（CLI 进程、单测）时静默跳过，
// 已停用时拒绝并告警。不阻塞调用方。
export function recordFactObservedByActiveKanbanRuntimeWithoutBlocking(
	observation: FactObservedByKanbanRuntimeObservation,
): void {
	const state = activeLiveCaptureState;
	if (!state) {
		return;
	}
	recordFactObservedByKanbanRuntimeWithoutBlocking(state, observation);
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
	// 先判停用再动限流表：停用后的提交既不记账，也不该占掉限流窗口。
	if (
		refuseBackgroundLedgerEventRecordingBecauseLiveCaptureWasDeactivated(
			state,
			`user_terminal_input_submission_observed_for_session for ${input.kanbanTaskConversationSessionId}`,
		)
	) {
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
	recordFactObservedByKanbanRuntimeWithoutBlocking(state, {
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

type TaskIdReservationSeedingFromExistingLocalTracesAttemptOutcome =
	| "task_id_reservations_seeded_from_existing_local_traces"
	| "task_id_reservation_seeding_abandoned_because_live_capture_was_deactivated";

// 工作区索引读不出、痕迹目录非 ENOENT/ENOTDIR 读失败、或写账本失败时抛出，由就绪屏障决定对外 fail-closed。
// 单个 workspace 的 board/sessions/meta 读不出只跳过该 workspace（收集时已告警），名单随播种事件留档，不阻断全局分配。
async function seedTaskIdReservationsFromExistingLocalTraces(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
): Promise<TaskIdReservationSeedingFromExistingLocalTracesAttemptOutcome> {
	const { seededTaskIdEntries, workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding } =
		await collectTaskIdReservationSeedingResultFromExistingLocalTraces({
			taskWorktreesHomePath: getTaskWorktreesHomePath(),
			claudeCodeProjectsDirectoryPath: join(homedir(), ".claude", "projects"),
		});
	if (state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation) {
		return "task_id_reservation_seeding_abandoned_because_live_capture_was_deactivated";
	}
	if (seededTaskIdEntries.length > 0) {
		await state.ledgerClient.seedTaskIdReservationsFromExistingLocalTraces({
			seededTaskIdEntries,
			seedingEventDraft: buildFactObservedByKanbanRuntimeEventDraft({
				state,
				observedFactKind: "task_id_reservation_seeded_from_existing_artifacts",
				observingKanbanRuntimeSystemComponentName: EAGER_BOARD_STATE_BASELINE_ESTABLISHMENT_SYSTEM_COMPONENT_NAME,
				subjectWorkspaceId: null,
				subjectTaskId: null,
				eventPayload: {
					taskIdReservationAssertsOnlyThatTheIdWasSeenNotTheIdentityBehindIt: true,
					// 这些 workspace 里卡片的 id 本次没占住；后续阶段（1b/2b）据此补齐。
					workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding,
				},
			}),
		});
	}
	return "task_id_reservations_seeded_from_existing_local_traces";
}

// Y-EVENT-12 的就绪屏障：本机痕迹 id 播种成功之前，runtime 不分配任何新 id。否则激活后立刻到来的分配会抢在播种之前
// 把痕迹里出现过、尚未播种的旧 id 占成「已分配」，播种随后看到它已登记就跳过，删卡留下的 id 从此被新卡复用、无法纠正。
// 只等播种这一步，不等急切基线：基线逐个 workspace 串行过漏斗可能很慢，而盘上卡片的 id 本来就由播种一并占住。
// 屏障只挡分配：runtime 内的建卡入口（Web UI 预取池、CLI create、快速添加）都先经分配取 id；漏斗对「从未登记的 id」
// 放行是留给外部 / 旧客户端自带 id 的兼容口（worker 锁内校验），不在这里拦，免得启动期所有 board 写入都排队等播种。
interface TaskIdAllocationReadinessGateBehindTaskIdReservationSeedingFromExistingLocalTraces {
	// 激活时发起的首次播种尝试已落定（成功、失败、因停用放弃都算；永不 reject）：急切基线排在它之后。
	firstTaskIdReservationSeedingAttemptSettled: Promise<void>;
	// 已播种成功则立即返回；有在途尝试就等它；上一次失败则单飞地重新播种一次。
	// 播种失败或 live capture 已停用时以账本不可用拒绝——与账本打不开时 board 只读同一语义，绝不带病分配。
	waitUntilTaskIdReservationsSeededOrRejectAsLedgerUnavailable(): Promise<void>;
}

function createTaskIdAllocationReadinessGateBehindTaskIdReservationSeedingFromExistingLocalTraces(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
): TaskIdAllocationReadinessGateBehindTaskIdReservationSeedingFromExistingLocalTraces {
	let taskIdReservationsSeededSuccessfully = false;
	let inFlightTaskIdReservationSeedingAttempt: Promise<void> | null = null;
	// 同一时刻至多一个在途尝试：新尝试只在上一个已落定（finally 清空在途引用）之后才可能发起。
	const startTaskIdReservationSeedingAttempt = (): Promise<void> => {
		const seedingAttempt = (async () => {
			let seedingAttemptOutcome: TaskIdReservationSeedingFromExistingLocalTracesAttemptOutcome;
			try {
				seedingAttemptOutcome = await seedTaskIdReservationsFromExistingLocalTraces(state);
			} catch (error) {
				const seedingFailureMessage = error instanceof Error ? error.message : String(error);
				logInterWorkUnitRelationLedgerDiagnosticWarning(
					`could not seed task id reservations from existing local traces; task id allocation stays closed until a later attempt succeeds: ${seedingFailureMessage}`,
				);
				throw new InterWorkUnitRelationLedgerUnavailableError(
					`task ids are not allocated because task id reservations from existing local traces could not be seeded: ${seedingFailureMessage}`,
				);
			} finally {
				inFlightTaskIdReservationSeedingAttempt = null;
			}
			if (seedingAttemptOutcome === "task_id_reservation_seeding_abandoned_because_live_capture_was_deactivated") {
				throw new InterWorkUnitRelationLedgerUnavailableError(
					"task ids are not allocated because the live capture of this Kanban runtime instance was deactivated before task id reservations were seeded",
				);
			}
			taskIdReservationsSeededSuccessfully = true;
		})();
		inFlightTaskIdReservationSeedingAttempt = seedingAttempt;
		return seedingAttempt;
	};
	const firstTaskIdReservationSeedingAttempt = startTaskIdReservationSeedingAttempt();
	return {
		firstTaskIdReservationSeedingAttemptSettled: firstTaskIdReservationSeedingAttempt.then(
			() => undefined,
			() => undefined,
		),
		waitUntilTaskIdReservationsSeededOrRejectAsLedgerUnavailable: async () => {
			if (taskIdReservationsSeededSuccessfully) {
				return;
			}
			if (inFlightTaskIdReservationSeedingAttempt) {
				await inFlightTaskIdReservationSeedingAttempt;
				return;
			}
			if (state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation) {
				throw new InterWorkUnitRelationLedgerUnavailableError(
					"task ids are not allocated because the live capture of this Kanban runtime instance was deactivated before task id reservations were seeded",
				);
			}
			// EXPERIMENT_NODE: 播种失败后按需重试（下一次分配触发、单飞）而非本 runtime 生命周期内永久拒绝——修好坏文件即可恢复，代价是持续失败时每次分配都重扫一遍痕迹。
			await startTaskIdReservationSeedingAttempt();
		},
	};
}

// 激活基线原本要等某 workspace 第一次过 runtime 持久化漏斗才写；在那之前直接写盘的进程（旧版 CLI、外部脚本）
// 或手改 board.json 会被吞进基线，而不是被检出为漏斗外发生。所以激活后立刻为索引里每个既有 workspace 走一次
// 「不保存」的漏斗通过：在 board 锁内对账（无基线则写基线、有基线则检出漏斗外 diff），不改 board、不推进 revision、不写盘。
// 逐个串行：漏斗内的 git 探测是同步子进程，串行把事件循环的阻塞摊薄成若干小段。
async function establishBoardStateBaselineForEveryIndexedWorkspaceWithoutBoardWrite(
	state: ActiveKanbanRuntimeInterWorkUnitRelationLedgerLiveCaptureState,
	firstTaskIdReservationSeedingAttemptSettled: Promise<void>,
): Promise<void> {
	// 先占住本机痕迹里的 id，再逐个建基线（基线会把盘上卡片绑定到各自已占位的 id）。
	// 播种失败不阻止建基线：基线只登记盘上已存在的卡，不放行任何分配；分配仍由就绪屏障拒绝。
	await firstTaskIdReservationSeedingAttemptSettled;
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
			allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry: async (input) => {
				if (liveCaptureDeactivated) rejectBecauseLiveCaptureDeactivated();
				return await trackInFlightLedgerCall(
					liveCaptureBackedByRelationLedger.allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry(input),
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

// dd2db 1b 读侧的唯一入口：读本实例的记录型关系投影（读之前先增量追上账本）。
// 从未激活（CLI 进程、单测）或停用已开始时抛 InterWorkUnitRelationLedgerUnavailableError——调用方据此如实回答「关系不可用」，
// 绝不退回空邻域冒充「没有关系」。在途的读纳入停用 drain：关 worker 之前等它们落定，否则后续分页请求会悄悄重开 worker。
export async function readRecordedInterWorkUnitRelationProjectionOfActiveKanbanRuntimeLiveCapture<T>(
	read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
): Promise<T> {
	const state = activeLiveCaptureState;
	if (!state || state.liveCaptureLifecyclePhase !== "live_capture_active") {
		throw new InterWorkUnitRelationLedgerUnavailableError(
			state
				? "the live capture of this Kanban runtime instance was deactivated (runtime is shutting down)"
				: "this process never activated the inter-work-unit relation ledger (only the Kanban runtime opens it)",
		);
	}
	const projectionRead = state.recordedInterWorkUnitRelationProjection.readCaughtUpProjection(read);
	state.recordedInterWorkUnitRelationProjectionReadsInFlight.add(projectionRead);
	try {
		return await projectionRead;
	} finally {
		state.recordedInterWorkUnitRelationProjectionReadsInFlight.delete(projectionRead);
	}
}

// 需要调用方等到落账的追加（例如 Web UI 的静音偏好：响应之后的下一次读必须看得到它）。与读共用在途集合，
// 同样纳入停用 drain；从未激活或停用已开始时抛 InterWorkUnitRelationLedgerUnavailableError，调用方如实报错。
export async function appendCommittedEventsIntoLedgerOfActiveKanbanRuntimeLiveCaptureAndWaitForCommit(
	buildEventDrafts: (
		capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity,
	) => InterWorkUnitRelationLedgerEventDraft[],
): Promise<void> {
	const state = activeLiveCaptureState;
	if (!state || state.liveCaptureLifecyclePhase !== "live_capture_active") {
		throw new InterWorkUnitRelationLedgerUnavailableError(
			state
				? "the live capture of this Kanban runtime instance was deactivated (runtime is shutting down)"
				: "this process never activated the inter-work-unit relation ledger (only the Kanban runtime opens it)",
		);
	}
	const ledgerAppend = state.ledgerClient.appendCommittedEvents({
		eventDrafts: buildEventDrafts(state.capturingKanbanRuntimeInstance),
	});
	state.recordedInterWorkUnitRelationProjectionReadsInFlight.add(ledgerAppend);
	try {
		await ledgerAppend;
	} finally {
		state.recordedInterWorkUnitRelationProjectionReadsInFlight.delete(ledgerAppend);
	}
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
		liveCaptureLifecyclePhase: "live_capture_active",
		backgroundLedgerEventRecordingsInFlight: new Set(),
		recordedInterWorkUnitRelationProjection: new RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger(
			ledgerClient,
		),
		recordedInterWorkUnitRelationProjectionReadsInFlight: new Set(),
	};
	activeLiveCaptureState = state;
	// 首次播种尝试随屏障创建立即发起、不 await（不阻塞 runtime 启动）。它的账本请求必然排在下面的能力激活标记之后：
	// 播种要先异步读完本机痕迹（workspace 索引、board、目录）才发账本请求，而标记在本函数返回前已同步入队。
	const taskIdAllocationReadinessGate =
		createTaskIdAllocationReadinessGateBehindTaskIdReservationSeedingFromExistingLocalTraces(state);
	const liveCaptureBackedByRelationLedger =
		createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
			ledgerClient,
			capturingKanbanRuntimeInstance: state.capturingKanbanRuntimeInstance,
		});
	// 等待播种发生在停用 wrapper 的在途追踪之内：停用时 drain 会连同「等播种 + 分配」一起等完，再关 worker。
	const captureThatFailsClosedAfterDeactivation = wrapCaptureSoItFailsClosedAfterDeactivation({
		...liveCaptureBackedByRelationLedger,
		allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry: async (input) => {
			await taskIdAllocationReadinessGate.waitUntilTaskIdReservationsSeededOrRejectAsLedgerUnavailable();
			return await liveCaptureBackedByRelationLedger.allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry(input);
		},
	});
	// 同进程先后激活多个实例（测试）时，本实例停用后把注册还给激活前的那一个，而不是清空成 null。
	const captureRegisteredBeforeThisActivation = getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture();
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureThatFailsClosedAfterDeactivation.capture);
	recordFactObservedByKanbanRuntimeWithoutBlocking(state, {
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
		establishBoardStateBaselineForEveryIndexedWorkspaceWithoutBoardWrite(
			state,
			taskIdAllocationReadinessGate.firstTaskIdReservationSeedingAttemptSettled,
		).catch((error: unknown) => {
			logInterWorkUnitRelationLedgerDiagnosticWarning(
				`eager board state baseline establishment failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	return {
		ledgerClient,
		eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion,
		deactivate: async () => {
			// activeLiveCaptureState 不清空：之后的入口据停用阶段拒绝并告警，而不是当成「从未激活」静默跳过。
			state.eagerBoardStateBaselineEstablishmentCancelledByDeactivation = true;
			// 阶段只向前推进：重复调用 deactivate 不得把「已关闭」退回「drain 中」。
			if (state.liveCaptureLifecyclePhase === "live_capture_active") {
				state.liveCaptureLifecyclePhase =
					"deactivation_draining_in_flight_ledger_calls_before_closing_ledger_worker_client";
			}
			// 同步置停用：从这一刻起进程内新的 board 写入一律以账本不可用拒绝（fail-closed），绝不退回直接写盘。
			const drainOfLedgerCallsInFlightAtDeactivation =
				captureThatFailsClosedAfterDeactivation.deactivateAndWaitForInFlightLedgerCalls();
			// 关 worker 前要等三类在途工作收尾——client 关闭后再收到请求会悄悄重开 worker：
			// 急切基线任务单独等（它在下一个检查点因取消标志退出，或撞上 fail-closed 只记告警，永不 reject），
			// 漏斗调用（停机期间仍在执行的 tRPC mutation）由 drain 覆盖，
			// 不阻塞的后台账本记录（message 事件、PDV 观测等追加前先做异步读取的）等它们整段落定。
			// 停用阶段已置位，后台记录集合此后只减不增，快照一次即可等全。
			await eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			await drainOfLedgerCallsInFlightAtDeactivation;
			await Promise.allSettled([...state.backgroundLedgerEventRecordingsInFlight]);
			await Promise.allSettled([...state.recordedInterWorkUnitRelationProjectionReadsInFlight]);
			// 只在注册的仍是本实例时才替换：之后激活的实例的捕获不能被旧实例停用清掉。
			// 激活前没有任何注册（真实 runtime 进程）时，保留本实例已停用的捕获：此后进程内 board 写入一律拒写。
			if (
				getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture() ===
					captureThatFailsClosedAfterDeactivation.capture &&
				captureRegisteredBeforeThisActivation !== null
			) {
				registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureRegisteredBeforeThisActivation);
			}
			state.liveCaptureLifecyclePhase = "ledger_worker_client_closed_after_deactivation";
			await ledgerClient.close();
		},
	};
}
