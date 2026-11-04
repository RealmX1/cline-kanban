// 计划内 handover（以及信号触发的保活停止）时，为每条 hosted 会话存一份屏幕 checkpoint；下一个 runtime 接管时
// 优先从它恢复（见 terminal-session-adoption-record-for-runtime-restart.ts 的 PlannedHandoverTerminalMirrorCheckpoint）。
//
// 对齐：checkpoint 必须与「mirror 已经吃下的字节」严格对应。调用方先冻结链路（此后不再有输出送进句柄），
// 句柄报告的偏移就是已交付的终点；协议过滤器里还压着的半截转义序列（pendingChunk）没进 mirror，要从偏移里减掉，
// mirror 增量 UTF-8 解码器未组成字符的尾字节也未进入快照，一并回退；下一个 runtime 从 host 环形缓冲重新读取。

import type { ActiveProcessState } from "./terminal-session-active-process-state";
import type {
	PlannedHandoverTerminalMirrorCheckpoint,
	TerminalSessionAdoptionRecord,
} from "./terminal-session-adoption-record-for-runtime-restart";
import type { TerminalStateMirror } from "./terminal-state-mirror";

// EXPERIMENT_NODE: checkpoint 序列化结果的 JSON UTF-8 字节上限。它随最终接管记录经 UDS 发给 host（单帧上限 16 MiB）并留在
// host 内存里；2 万行 scrollback 的满屏 TUI 通常在 1–3 MB。超限就不带 checkpoint，接管退回环形缓冲重放。
export const PLANNED_HANDOVER_TERMINAL_MIRROR_CHECKPOINT_MAXIMUM_SERIALIZED_JSON_BYTE_LENGTH = 8 * 1024 * 1024;

export type PlannedHandoverTerminalMirrorCheckpointCaptureOutcome =
	| { kind: "captured"; checkpoint: PlannedHandoverTerminalMirrorCheckpoint }
	| {
			kind: "not_captured";
			reason:
				| "no_terminal_state_mirror"
				| "pty_handle_does_not_report_output_byte_offset"
				| "serialized_snapshot_exceeds_maximum_json_byte_length";
	  };

export async function capturePlannedHandoverTerminalMirrorCheckpoint(input: {
	terminalStateMirror: TerminalStateMirror | null;
	active: ActiveProcessState;
}): Promise<PlannedHandoverTerminalMirrorCheckpointCaptureOutcome> {
	if (input.terminalStateMirror === null) {
		return { kind: "not_captured", reason: "no_terminal_state_mirror" };
	}
	const outputByteOffsetAfterLastDeliveredChunk = input.active.session.outputByteOffsetAfterLastDeliveredChunk;
	if (outputByteOffsetAfterLastDeliveredChunk === undefined) {
		return { kind: "not_captured", reason: "pty_handle_does_not_report_output_byte_offset" };
	}
	const bytesHeldBackByTerminalProtocolFilter = input.active.terminalProtocolFilter.pendingChunk?.byteLength ?? 0;
	// mirror 的写入是排队异步应用的；getSnapshot 排在此前全部写入之后。
	const snapshot = await input.terminalStateMirror.getSnapshot();
	if (
		Buffer.byteLength(JSON.stringify(snapshot.snapshot), "utf8") >
		PLANNED_HANDOVER_TERMINAL_MIRROR_CHECKPOINT_MAXIMUM_SERIALIZED_JSON_BYTE_LENGTH
	) {
		return { kind: "not_captured", reason: "serialized_snapshot_exceeds_maximum_json_byte_length" };
	}
	return {
		kind: "captured",
		checkpoint: {
			serializedTerminalMirrorSnapshot: snapshot.snapshot,
			cols: snapshot.cols,
			rows: snapshot.rows,
			outputByteOffsetCoveredBySnapshot: Math.max(
				0,
				outputByteOffsetAfterLastDeliveredChunk -
					bytesHeldBackByTerminalProtocolFilter -
					(snapshot.pendingUtf8InputByteLength ?? 0),
			),
			...(snapshot.terminalModesAreKnown === false ? { terminalModesAreKnown: false } : {}),
		},
	};
}

// checkpoint 的偏移必须仍在 host 环形缓冲的保留区间里：否则 checkpoint 与当前之间缺了一段，续流拼不上。
export function resolvePlannedHandoverTerminalMirrorCheckpointUsableForAdoption(input: {
	adoptionRecord: TerminalSessionAdoptionRecord | null;
	retainedOutputStartByteOffset: number;
	outputEndByteOffset: number;
}): PlannedHandoverTerminalMirrorCheckpoint | null {
	const checkpoint = input.adoptionRecord?.plannedHandoverTerminalMirrorCheckpoint;
	if (
		checkpoint === undefined ||
		checkpoint.terminalModesAreKnown === false ||
		input.adoptionRecord?.rederivationInputs.terminalModesAreKnown === false
	) {
		return null;
	}
	if (
		checkpoint.outputByteOffsetCoveredBySnapshot < input.retainedOutputStartByteOffset ||
		checkpoint.outputByteOffsetCoveredBySnapshot > input.outputEndByteOffset
	) {
		return null;
	}
	return checkpoint;
}
