// dd2db 1b Relations 面板的浏览器侧传输助手。把 tRPC 细节（procedure 路径、错误码）挡在这里，
// hook 只管状态编排（镜像 conversation-turn-projection-query.ts / findings-query.ts 的同款分层）。
//
// 数据源：
// - workUnit.getRelationNeighborhoodSummary：一张卡的一度记录型关系邻域（只读 query）。关系账本只在 runtime 内
//   打开，读失败一律如实分类上抛；调用方绝不能把读失败显示成「没有关系」。
// - workUnit.setRecordedRelationPresentationMutePreference：静音 / 取消静音一条记录型关系（只改展示，不改事实）。
//   这是决策类 procedure（R3）：**只能由显式的用户点击处理器调用**，绝不能放进 effect、hook 自动流程或自动化模块。
//   runtime 要求请求带已校验的页面 nonce（否则 FORBIDDEN）；getRuntimeTrpcClient 会自动带上 nonce 头。

import type {
	GetRelationNeighborhoodSummaryResponse,
	SetRecordedRelationPresentationMutePreferenceResponse,
} from "@runtime-work-unit-relation-read-api-contract";
import { TRPCClientError } from "@trpc/client";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

// 不传 relationNeighborhoodDepth：runtime 缺省就是一度邻域，面板只展示一度。
export async function fetchWorkUnitRelationNeighborhoodSummaryOfKanbanBoardCard(input: {
	workspaceId: string;
	kanbanBoardCardTaskId: string;
}): Promise<GetRelationNeighborhoodSummaryResponse> {
	const trpcClient = getRuntimeTrpcClient(input.workspaceId);
	return await trpcClient.workUnit.getRelationNeighborhoodSummary.query({
		workUnit: {
			workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
			bareTaskId: input.kanbanBoardCardTaskId,
			// 显式带 workspaceId：裸 id 跨 project 会撞号，带上就不会落进 CONFLICT。
			workspaceId: input.workspaceId,
		},
	});
}

// 只给显式的用户点击处理器调用（见文件头）。
export async function setRecordedRelationPresentationMutePreferenceFromExplicitUserClick(input: {
	workspaceId: string;
	relationId: string;
	recordedRelationMutedInPresentation: boolean;
}): Promise<SetRecordedRelationPresentationMutePreferenceResponse> {
	const trpcClient = getRuntimeTrpcClient(input.workspaceId);
	return await trpcClient.workUnit.setRecordedRelationPresentationMutePreference.mutate({
		relationId: input.relationId,
		recordedRelationMutedInPresentation: input.recordedRelationMutedInPresentation,
	});
}

function readTrpcErrorCodeOfRelationApiFailure(error: unknown): string | null {
	if (!(error instanceof TRPCClientError)) {
		return null;
	}
	const errorData = error.data as { code?: unknown } | null | undefined;
	return typeof errorData?.code === "string" ? errorData.code : null;
}

function readFailureReasonMessageOfRelationApiFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type WorkUnitRelationNeighborhoodSummaryReadFailureKind =
	// SERVICE_UNAVAILABLE：关系账本没打开 / 打不开（runtime 侧 InterWorkUnitRelationLedgerUnavailableError）。
	| "inter_work_unit_relation_ledger_unavailable"
	// NOT_FOUND：账本不认识这张卡（例如激活之前就已删除、或刚建卡事件还没落账）。
	| "kanban_board_card_not_known_to_inter_work_unit_relation_ledger"
	// CONFLICT：裸 id 命中多张卡。面板总带 workspaceId，正常不会出现；出现了也如实报。
	| "bare_task_id_matches_more_than_one_kanban_board_card"
	// 其余：网络断开、runtime 离线、未预期的服务端错误。
	| "unexpected_relation_neighborhood_read_failure";

export interface WorkUnitRelationNeighborhoodSummaryReadFailure {
	readFailureKind: WorkUnitRelationNeighborhoodSummaryReadFailureKind;
	// 原样转述服务端（或网络层）给出的原因，面板直接展示给用户。
	readFailureReasonMessage: string;
}

export function classifyWorkUnitRelationNeighborhoodSummaryReadFailure(
	error: unknown,
): WorkUnitRelationNeighborhoodSummaryReadFailure {
	const readFailureReasonMessage = readFailureReasonMessageOfRelationApiFailure(error);
	switch (readTrpcErrorCodeOfRelationApiFailure(error)) {
		case "SERVICE_UNAVAILABLE":
			return { readFailureKind: "inter_work_unit_relation_ledger_unavailable", readFailureReasonMessage };
		case "NOT_FOUND":
			return {
				readFailureKind: "kanban_board_card_not_known_to_inter_work_unit_relation_ledger",
				readFailureReasonMessage,
			};
		case "CONFLICT":
			return { readFailureKind: "bare_task_id_matches_more_than_one_kanban_board_card", readFailureReasonMessage };
		default:
			return { readFailureKind: "unexpected_relation_neighborhood_read_failure", readFailureReasonMessage };
	}
}

export type RecordedRelationPresentationMutePreferenceWriteFailureKind =
	// SERVICE_UNAVAILABLE：关系账本不可用，偏好事件没落账。
	| "inter_work_unit_relation_ledger_unavailable"
	// FORBIDDEN：请求没带 runtime 认可的页面 nonce（例如 runtime 重启后 nonce 重取也失败）。
	| "web_ui_page_load_request_origin_nonce_not_verified_by_runtime"
	// NOT_FOUND：账本里没有这条关系（例如投影表版本变了、关系 id 不再存在）。
	| "recorded_relation_not_found_in_inter_work_unit_relation_ledger"
	| "unexpected_recorded_relation_presentation_mute_preference_write_failure";

export interface RecordedRelationPresentationMutePreferenceWriteFailure {
	writeFailureKind: RecordedRelationPresentationMutePreferenceWriteFailureKind;
	writeFailureReasonMessage: string;
}

export function classifyRecordedRelationPresentationMutePreferenceWriteFailure(
	error: unknown,
): RecordedRelationPresentationMutePreferenceWriteFailure {
	const writeFailureReasonMessage = readFailureReasonMessageOfRelationApiFailure(error);
	switch (readTrpcErrorCodeOfRelationApiFailure(error)) {
		case "SERVICE_UNAVAILABLE":
			return { writeFailureKind: "inter_work_unit_relation_ledger_unavailable", writeFailureReasonMessage };
		case "FORBIDDEN":
			return {
				writeFailureKind: "web_ui_page_load_request_origin_nonce_not_verified_by_runtime",
				writeFailureReasonMessage,
			};
		case "NOT_FOUND":
			return {
				writeFailureKind: "recorded_relation_not_found_in_inter_work_unit_relation_ledger",
				writeFailureReasonMessage,
			};
		default:
			return {
				writeFailureKind: "unexpected_recorded_relation_presentation_mute_preference_write_failure",
				writeFailureReasonMessage,
			};
	}
}
