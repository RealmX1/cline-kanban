// 热重启接管记录：新 runtime 接管 agent session PTY host 里仍在跑的会话时，需要的 summary 快照与内存态。
//
// 为什么记录交给 host 保管、而不是读 sessions.json：sessions.json 只在 graceful shutdown 落盘，runtime 被
// kill -9 或崩溃后它是陈旧的；host 与会话同寿，runtime 每次状态变化都把最新记录推给它。
//
// ActiveProcessState 每个字段跨重启的处置在下表里**逐字段**声明，`satisfies Record<keyof ActiveProcessState, …>`
// 让「新增字段却没想过重启后怎么办」直接编译失败：
// - carried_in_adoption_record：随记录携带，接管时原样恢复；
// - taken_from_agent_session_pty_host：以 host 上报为准（句柄、尺寸、真实 spawn 时刻）；
// - rederived_on_adoption：按 agentId 与记录里的派生输入重新构造（检测器、输出反应引擎、协议过滤器……）；
// - reset_on_adoption：恢复为新会话的初值（定时器、计数器、在途投递）。在途的定时器与投递在重启窗口里丢失，
//   计划内 handover 会先排空它们（见计划 P4）。

import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../core/api-contract";
import type { ActiveProcessState } from "./terminal-session-active-process-state";

export type ActiveProcessStateFieldDispositionAcrossRuntimeRestart =
	| "carried_in_adoption_record"
	| "taken_from_agent_session_pty_host"
	| "rederived_on_adoption"
	| "reset_on_adoption";

export const ACTIVE_PROCESS_STATE_FIELD_DISPOSITION_ACROSS_RUNTIME_RESTART = {
	session: "taken_from_agent_session_pty_host",
	workspaceTrustBuffer: "carried_in_adoption_record",
	cols: "taken_from_agent_session_pty_host",
	rows: "taken_from_agent_session_pty_host",
	terminalProtocolFilter: "rederived_on_adoption",
	// 闭包不能跨进程；Codex 接管按本代端点读取持久启动描述，重建带 dev/ino 校验的强杀清理兜底。
	onSessionCleanup: "rederived_on_adoption",
	deferredStartupPromptText: "carried_in_adoption_record",
	detectOutputTransition: "rederived_on_adoption",
	shouldInspectOutputForTransition: "rederived_on_adoption",
	awaitingCodexPromptAfterEnter: "carried_in_adoption_record",
	autoConfirmedWorkspaceTrust: "carried_in_adoption_record",
	workspaceTrustConfirmTimer: "reset_on_adoption",
	startupReadinessDeadlineAt: "carried_in_adoption_record",
	// 接管后按携带的 startupReadinessDeadlineAt 重新武装。
	startupReadinessTimer: "reset_on_adoption",
	outputReactionEngine: "rederived_on_adoption",
	outputReactionSession: "rederived_on_adoption",
	outputReactionScanBuffer: "reset_on_adoption",
	outputReactionAttemptTimer: "reset_on_adoption",
	pendingOutputAnalysisText: "reset_on_adoption",
	outputAnalysisFlushTimer: "reset_on_adoption",
	lastUserInputAt: "carried_in_adoption_record",
	// 接管时用追赶后的屏幕内容预热：否则 resize 触发的整屏重绘会被当成「新的实质输出」，
	// 违反 lastSubstantiveOutputAt「默认不推进」。
	agentOutputSubstanceMemory: "rederived_on_adoption",
	lastSubstantiveOutputAnalysisAt: "reset_on_adoption",
	deferredSubstantiveOutputAnalysisText: "reset_on_adoption",
	deferredSubstantiveOutputAnalysisTimer: "reset_on_adoption",
	suppressSubstantiveOutputUntilContinues: "carried_in_adoption_record",
	taskChatInputDeliveryTimer: "reset_on_adoption",
	interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds: "carried_in_adoption_record",
	taskChatInputDeliveryGeneration: "reset_on_adoption",
	submitConfirmTimer: "reset_on_adoption",
	submitConfirmGeneration: "reset_on_adoption",
	ptyOutputChunkArrivalSequenceNumber: "reset_on_adoption",
	programmaticDeliveryReceipt: "reset_on_adoption",
	inputBoxOccupancyTracker: "reset_on_adoption",
	hasEverLocatedTerminalInputBoxOnScreen: "carried_in_adoption_record",
	// 新 runtime 里是新的一「代」：上一个 runtime 发给 API 调用方的令牌随进程一起失效。
	terminalSessionIncarnationToken: "reset_on_adoption",
	terminalSessionIncarnationSpawnedAtEpochMs: "taken_from_agent_session_pty_host",
	kanbanAssignedCursorAgentChatFirstPromptPersistenceWatch: "carried_in_adoption_record",
	recentlyAppliedHookEventDeliveryIdempotencyKeys: "carried_in_adoption_record",
} as const satisfies Record<keyof ActiveProcessState, ActiveProcessStateFieldDispositionAcrossRuntimeRestart>;

type ActiveProcessStateFieldNameCarriedInAdoptionRecord = {
	[FieldName in keyof typeof ACTIVE_PROCESS_STATE_FIELD_DISPOSITION_ACROSS_RUNTIME_RESTART]: (typeof ACTIVE_PROCESS_STATE_FIELD_DISPOSITION_ACROSS_RUNTIME_RESTART)[FieldName] extends "carried_in_adoption_record"
		? FieldName
		: never;
}[keyof typeof ACTIVE_PROCESS_STATE_FIELD_DISPOSITION_ACROSS_RUNTIME_RESTART];

export type ActiveProcessStateFieldsCarriedInAdoptionRecord = Pick<
	ActiveProcessState,
	ActiveProcessStateFieldNameCarriedInAdoptionRecord
>;

// 「rederived_on_adoption」字段需要、但无法只从 agentId 推出的启动期事实。
export interface TerminalSessionAdoptionRederivationInputs {
	suppressScrollbackErasure: boolean;
	suppressDeviceAttributeQueries: boolean;
	outputReactionEngineWasActive: boolean;
	terminalModesAreKnown?: boolean;
}

// 新 runtime 必须能读旧 runtime 写的记录：改结构就升版本；读到不认识的版本时退回「合成三元组」那一级，绝不因此杀会话。
// 只增可选字段不升版本（旧 runtime 读到会忽略，新 runtime 读旧记录按缺省处理）。
export const TERMINAL_SESSION_ADOPTION_RECORD_SCHEMA_VERSION = 1;

// 计划内 handover 时的屏幕 checkpoint：mirror 的完整序列化（含 scrollback）与它覆盖到的输出偏移。
// 下一个 runtime 先把它写进新 mirror，再从这个偏移续流——屏幕与 scrollback 原样延续，不必从环形缓冲起点重放
// （环形缓冲只有 2 MiB，长会话的 scrollback 早被覆盖），也不必让 TUI 整屏重绘。
// 偏移已不在 host 环形缓冲的保留区间里（runtime 缺席期间输出超过了缓冲容量）时不可用，退回崩溃路径。
export interface PlannedHandoverTerminalMirrorCheckpoint {
	serializedTerminalMirrorSnapshot: string;
	cols: number;
	rows: number;
	outputByteOffsetCoveredBySnapshot: number;
	terminalModesAreKnown?: boolean;
}

export interface TerminalSessionAdoptionRecord {
	terminalSessionAdoptionRecordSchemaVersion: typeof TERMINAL_SESSION_ADOPTION_RECORD_SCHEMA_VERSION;
	recordedAtEpochMs: number;
	summary: RuntimeTaskSessionSummary;
	carriedActiveProcessStateFields: ActiveProcessStateFieldsCarriedInAdoptionRecord;
	rederivationInputs: TerminalSessionAdoptionRederivationInputs;
	// 只有计划内 handover 推的最终记录带它；接管后下一次推送即不再携带。
	plannedHandoverTerminalMirrorCheckpoint?: PlannedHandoverTerminalMirrorCheckpoint;
}

export function captureActiveProcessStateFieldsCarriedInAdoptionRecord(
	active: ActiveProcessState,
): ActiveProcessStateFieldsCarriedInAdoptionRecord {
	return {
		workspaceTrustBuffer: active.workspaceTrustBuffer,
		deferredStartupPromptText: active.deferredStartupPromptText,
		awaitingCodexPromptAfterEnter: active.awaitingCodexPromptAfterEnter,
		autoConfirmedWorkspaceTrust: active.autoConfirmedWorkspaceTrust,
		startupReadinessDeadlineAt: active.startupReadinessDeadlineAt,
		lastUserInputAt: active.lastUserInputAt,
		suppressSubstantiveOutputUntilContinues: active.suppressSubstantiveOutputUntilContinues,
		interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds:
			active.interceptRestorationHarnessGeneratedTaskNotificationsUntilFirstExplicitUserTurnEnds,
		hasEverLocatedTerminalInputBoxOnScreen: active.hasEverLocatedTerminalInputBoxOnScreen,
		kanbanAssignedCursorAgentChatFirstPromptPersistenceWatch:
			active.kanbanAssignedCursorAgentChatFirstPromptPersistenceWatch,
		recentlyAppliedHookEventDeliveryIdempotencyKeys: [...active.recentlyAppliedHookEventDeliveryIdempotencyKeys],
	};
}

// 只增字段的读侧兼容：P0–P2 的 runtime 写的记录没有这个字段（schema 版本不变，缺省即空）。
export function readRecentlyAppliedHookEventDeliveryIdempotencyKeysFromCarriedFields(
	carriedActiveProcessStateFields: ActiveProcessStateFieldsCarriedInAdoptionRecord | null,
): string[] {
	const carriedKeys: unknown = carriedActiveProcessStateFields?.recentlyAppliedHookEventDeliveryIdempotencyKeys;
	if (!Array.isArray(carriedKeys)) {
		return [];
	}
	return carriedKeys.filter((carriedKey): carriedKey is string => typeof carriedKey === "string");
}

export function buildTerminalSessionAdoptionRecord(input: {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState;
	recordedAtEpochMs: number;
	plannedHandoverTerminalMirrorCheckpoint?: PlannedHandoverTerminalMirrorCheckpoint;
	terminalModesAreKnown?: boolean;
}): TerminalSessionAdoptionRecord {
	return {
		terminalSessionAdoptionRecordSchemaVersion: TERMINAL_SESSION_ADOPTION_RECORD_SCHEMA_VERSION,
		recordedAtEpochMs: input.recordedAtEpochMs,
		summary: input.summary,
		carriedActiveProcessStateFields: captureActiveProcessStateFieldsCarriedInAdoptionRecord(input.active),
		rederivationInputs: {
			suppressScrollbackErasure: input.active.terminalProtocolFilter.suppressScrollbackErasure,
			suppressDeviceAttributeQueries: input.active.terminalProtocolFilter.suppressDeviceAttributeQueries,
			outputReactionEngineWasActive: input.active.outputReactionEngine !== null,
			...(input.terminalModesAreKnown !== undefined ? { terminalModesAreKnown: input.terminalModesAreKnown } : {}),
		},
		...(input.plannedHandoverTerminalMirrorCheckpoint !== undefined
			? { plannedHandoverTerminalMirrorCheckpoint: input.plannedHandoverTerminalMirrorCheckpoint }
			: {}),
	};
}

function readPlannedHandoverTerminalMirrorCheckpoint(
	rawCheckpoint: unknown,
): PlannedHandoverTerminalMirrorCheckpoint | undefined {
	if (!isRecordObject(rawCheckpoint)) {
		return undefined;
	}
	const { serializedTerminalMirrorSnapshot, cols, rows, outputByteOffsetCoveredBySnapshot } = rawCheckpoint;
	if (
		typeof serializedTerminalMirrorSnapshot !== "string" ||
		!Number.isInteger(cols) ||
		!Number.isInteger(rows) ||
		!Number.isInteger(outputByteOffsetCoveredBySnapshot) ||
		(cols as number) <= 0 ||
		(rows as number) <= 0 ||
		(outputByteOffsetCoveredBySnapshot as number) < 0
	) {
		return undefined;
	}
	return {
		serializedTerminalMirrorSnapshot,
		cols: cols as number,
		rows: rows as number,
		outputByteOffsetCoveredBySnapshot: outputByteOffsetCoveredBySnapshot as number,
		...(rawCheckpoint.terminalModesAreKnown === false ? { terminalModesAreKnown: false } : {}),
	};
}

export type ParsedTerminalSessionAdoptionRecord =
	| { kind: "usable_adoption_record"; adoptionRecord: TerminalSessionAdoptionRecord }
	| { kind: "no_adoption_record" }
	| { kind: "unrecognized_adoption_record_schema_version"; schemaVersion: unknown }
	| { kind: "malformed_adoption_record"; reason: string };

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// summary 必须过 runtimeTaskSessionSummarySchema（含 facet 三元组完整性的 superRefine）；carried 字段只校验外形，
// 逐字段的类型由写入方（同仓库代码、同一 schema 版本）保证，读到缺失字段时按新会话初值处理。
export function parseTerminalSessionAdoptionRecord(rawAdoptionRecord: unknown): ParsedTerminalSessionAdoptionRecord {
	if (rawAdoptionRecord === null || rawAdoptionRecord === undefined) {
		return { kind: "no_adoption_record" };
	}
	if (!isRecordObject(rawAdoptionRecord)) {
		return { kind: "malformed_adoption_record", reason: "adoption record is not an object" };
	}
	const schemaVersion = rawAdoptionRecord.terminalSessionAdoptionRecordSchemaVersion;
	if (schemaVersion !== TERMINAL_SESSION_ADOPTION_RECORD_SCHEMA_VERSION) {
		return { kind: "unrecognized_adoption_record_schema_version", schemaVersion };
	}
	const parsedSummary = runtimeTaskSessionSummarySchema.safeParse(rawAdoptionRecord.summary);
	if (!parsedSummary.success) {
		return { kind: "malformed_adoption_record", reason: `summary failed validation: ${parsedSummary.error.message}` };
	}
	if (!isRecordObject(rawAdoptionRecord.carriedActiveProcessStateFields)) {
		return { kind: "malformed_adoption_record", reason: "carriedActiveProcessStateFields is not an object" };
	}
	if (!isRecordObject(rawAdoptionRecord.rederivationInputs)) {
		return { kind: "malformed_adoption_record", reason: "rederivationInputs is not an object" };
	}
	const recordedAtEpochMs = rawAdoptionRecord.recordedAtEpochMs;
	// checkpoint 形状不对只丢掉 checkpoint（退回崩溃路径的重放），不让整份记录作废。
	const plannedHandoverTerminalMirrorCheckpoint = readPlannedHandoverTerminalMirrorCheckpoint(
		rawAdoptionRecord.plannedHandoverTerminalMirrorCheckpoint,
	);
	return {
		kind: "usable_adoption_record",
		adoptionRecord: {
			terminalSessionAdoptionRecordSchemaVersion: TERMINAL_SESSION_ADOPTION_RECORD_SCHEMA_VERSION,
			recordedAtEpochMs: typeof recordedAtEpochMs === "number" ? recordedAtEpochMs : 0,
			summary: parsedSummary.data,
			carriedActiveProcessStateFields:
				rawAdoptionRecord.carriedActiveProcessStateFields as unknown as ActiveProcessStateFieldsCarriedInAdoptionRecord,
			rederivationInputs:
				rawAdoptionRecord.rederivationInputs as unknown as TerminalSessionAdoptionRederivationInputs,
			...(plannedHandoverTerminalMirrorCheckpoint !== undefined ? { plannedHandoverTerminalMirrorCheckpoint } : {}),
		},
	};
}
