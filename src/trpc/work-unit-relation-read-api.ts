import { TRPCError } from "@trpc/server";
import type { InterWorkUnitRelationWorkUnitReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	GetRelationNeighborhoodSummaryRequest,
	GetRelationNeighborhoodSummaryResponse,
	GetWorkUnitContextRequest,
	GetWorkUnitContextResponse,
	ListConversationSessionOwnershipPeriodsRequest,
	ListConversationSessionOwnershipPeriodsResponse,
	ResolveKanbanBoardCardIdentityByBareTaskIdRequest,
	ResolveKanbanBoardCardIdentityByBareTaskIdResponse,
	WorkUnitDisplayEntry,
	WorkUnitSelectorForRelationRead,
} from "../core/work-unit-relation-read-api-contract";
import { listConversationSessionOwnershipPeriodsOfWorkUnit } from "../inter-work-unit-relation-ledger/conversation-session-ownership-period-projection-from-ledger-events";
import { InterWorkUnitRelationLedgerUnavailableError } from "../inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import {
	type KanbanBoardCardIdentityProjection,
	listKanbanBoardCardIdentityProjectionsByBareTaskId,
} from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import {
	getPermanentlyDeletedTaskPromptVersions,
	listPermanentlyDeletedTaskCards,
} from "../inter-work-unit-relation-ledger/permanently-deleted-task-history";
import type { RecordedInterWorkUnitRelationProjectionState } from "../inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "../inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import {
	assembleRecordedRelationNeighborhoodSummaryOfWorkUnit,
	buildKanbanBoardCardIdentityResolutionCandidates,
	buildWorkUnitDisplayEntries,
} from "../inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";
import { getNotificationLifecycleArchive } from "../notifications/notification-lifecycle-archive";
import {
	readReferenceRelationModelingEditorDraft,
	saveReferenceRelationModelingEditorDraft,
} from "../state/reference-relation-modeling-editor-drafts";
import type { RuntimeTrpcContext } from "./app-router";
import { buildRelationModelingPreview } from "./work-unit-relation-modeling-preview";

// dd2db 1b 读侧（`workUnit.*` procedure 的 runtime 实现）：跨 project 解析裸 id、一度邻域、会话归属时段、
// 上下文端口（1b 只有 L1 兜底的 global recap）。全部读同一份记录型关系投影，账本不可用时如实报 SERVICE_UNAVAILABLE。

export interface CreateWorkUnitRelationReadApiDependencies {
	suggestReferenceRelationsForTaskModeling?: RuntimeTrpcContext["workUnitRelationReadApi"]["suggestReferenceRelationsForTaskModeling"];
	readRecordedInterWorkUnitRelationProjection: <T>(
		read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
	) => Promise<T>;
	getWorkspacePathById: (workspaceId: string) => string | null;
	// L1 兜底的第三个部件；读不到（没有通知、档案不可用）返回 null。
	readLatestNotificationSummaryTextOfTaskCard: (
		workspaceId: string,
		taskId: string,
	) => Promise<{ summaryText: string; triggeredAt: number } | null>;
}

function describeKanbanBoardCardCandidateLocations(projections: KanbanBoardCardIdentityProjection[]): string {
	return projections
		.map(
			(projection) =>
				`${projection.kanbanBoardCard.workspaceId}${projection.permanentlyRemovedFromBoardAt !== null ? " (permanently removed)" : ""}`,
		)
		.join(", ");
}

// 裸 id → 唯一一世（Y-EVENT-12）：仍在 board 上的唯一一张优先；没有活卡时只剩一张墓碑也可读；其余一律 fail closed。
export function resolveWorkUnitSelectorAgainstRecordedRelationProjection(
	projectionState: RecordedInterWorkUnitRelationProjectionState,
	selector: WorkUnitSelectorForRelationRead,
): InterWorkUnitRelationWorkUnitReference {
	if (selector.workUnitSelectorKind === "kanban_unmanaged_standalone_agent_conversation_session") {
		return {
			workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId: selector.conversationSessionHostKanbanAgentId,
			nativeConversationSessionId: selector.nativeConversationSessionId,
		};
	}
	const candidates = listKanbanBoardCardIdentityProjectionsByBareTaskId(
		projectionState.kanbanBoardCardIdentityProjectionState,
		selector.bareTaskId,
	).filter((projection) => !selector.workspaceId || projection.kanbanBoardCard.workspaceId === selector.workspaceId);
	if (candidates.length === 0) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `No Kanban task card with id ${selector.bareTaskId}${selector.workspaceId ? ` in workspace ${selector.workspaceId}` : ""} is known to the relation ledger (cards permanently removed before relation capture was activated are not known yet).`,
		});
	}
	const liveCandidates = candidates.filter((projection) => projection.permanentlyRemovedFromBoardAt === null);
	const uniqueCandidate =
		liveCandidates.length === 1
			? liveCandidates[0]
			: liveCandidates.length === 0 && candidates.length === 1
				? candidates[0]
				: null;
	if (!uniqueCandidate) {
		throw new TRPCError({
			code: "CONFLICT",
			message: `Task id ${selector.bareTaskId} matches more than one Kanban task card (${describeKanbanBoardCardCandidateLocations(candidates)}); pass the workspace id to choose one.`,
		});
	}
	return uniqueCandidate.kanbanBoardCard;
}

async function readProjectionTranslatingLedgerUnavailability<T>(
	deps: CreateWorkUnitRelationReadApiDependencies,
	read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
): Promise<T> {
	try {
		return await deps.readRecordedInterWorkUnitRelationProjection(read);
	} catch (error) {
		if (error instanceof InterWorkUnitRelationLedgerUnavailableError) {
			throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error.message });
		}
		throw error;
	}
}

export function createWorkUnitRelationReadApi(
	deps: CreateWorkUnitRelationReadApiDependencies,
): RuntimeTrpcContext["workUnitRelationReadApi"] {
	return {
		listPermanentlyDeletedTaskCards: (input) =>
			readProjectionTranslatingLedgerUnavailability(deps, (reader) =>
				listPermanentlyDeletedTaskCards(reader, input, deps.getWorkspacePathById),
			),
		getPermanentlyDeletedTaskPromptVersions: (input) =>
			readProjectionTranslatingLedgerUnavailability(deps, (reader) =>
				getPermanentlyDeletedTaskPromptVersions(reader, input),
			),
		readRelationModelingEditorDraft: readReferenceRelationModelingEditorDraft,
		saveRelationModelingEditorDraft: saveReferenceRelationModelingEditorDraft,
		getRelationModelingPreview: async (input) =>
			await readProjectionTranslatingLedgerUnavailability(deps, (reader) =>
				buildRelationModelingPreview(
					reader,
					input.workUnit
						? resolveWorkUnitSelectorAgainstRecordedRelationProjection(reader.projectionState, input.workUnit)
						: null,
					input,
					deps.getWorkspacePathById,
				),
			),
		suggestReferenceRelationsForTaskModeling:
			deps.suggestReferenceRelationsForTaskModeling ??
			(async () => ({
				availability: "unavailable" as const,
				unavailableReason: "项目级关系建议服务尚未接入（a0401）。",
				contextAsOf: null,
				contextCompleteness: ["project_task_indexing_agent_not_implemented"],
				candidates: [],
			})),
		resolveKanbanBoardCardIdentityByBareTaskId: async (
			input: ResolveKanbanBoardCardIdentityByBareTaskIdRequest,
		): Promise<ResolveKanbanBoardCardIdentityByBareTaskIdResponse> =>
			await readProjectionTranslatingLedgerUnavailability(deps, async (reader) => ({
				kanbanBoardCardIdentityCandidates: await buildKanbanBoardCardIdentityResolutionCandidates(
					reader,
					listKanbanBoardCardIdentityProjectionsByBareTaskId(
						reader.projectionState.kanbanBoardCardIdentityProjectionState,
						input.bareTaskId,
					),
					deps.getWorkspacePathById,
				),
			})),
		getRelationNeighborhoodSummary: async (
			input: GetRelationNeighborhoodSummaryRequest,
		): Promise<GetRelationNeighborhoodSummaryResponse> =>
			await readProjectionTranslatingLedgerUnavailability(
				deps,
				async (reader) =>
					await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
						reader,
						resolveWorkUnitSelectorAgainstRecordedRelationProjection(reader.projectionState, input.workUnit),
						deps.getWorkspacePathById,
						input.relationNeighborhoodDepth ?? 1,
					),
			),
		listConversationSessionOwnershipPeriods: async (
			input: ListConversationSessionOwnershipPeriodsRequest,
		): Promise<ListConversationSessionOwnershipPeriodsResponse> =>
			await readProjectionTranslatingLedgerUnavailability(deps, async (reader) => {
				const subjectWorkUnit = resolveWorkUnitSelectorAgainstRecordedRelationProjection(
					reader.projectionState,
					input.workUnit,
				);
				const [subjectDisplayEntry] = await buildWorkUnitDisplayEntries(
					reader,
					[subjectWorkUnit],
					deps.getWorkspacePathById,
				);
				if (!subjectDisplayEntry) {
					throw new Error("Subject work unit display entry is missing.");
				}
				return {
					subjectWorkUnit: subjectDisplayEntry,
					conversationSessionOwnershipPeriods: listConversationSessionOwnershipPeriodsOfWorkUnit(
						reader.projectionState.conversationSessionOwnershipProjectionState,
						subjectWorkUnit,
					).map((period) => ({
						...period,
						observedInKanbanTaskConversationSessionIds: [...period.observedInKanbanTaskConversationSessionIds],
					})),
				};
			}),
		getWorkUnitContext: async (input: GetWorkUnitContextRequest): Promise<GetWorkUnitContextResponse> => {
			const subjectDisplayEntry = await readProjectionTranslatingLedgerUnavailability(deps, async (reader) => {
				const subjectWorkUnit = resolveWorkUnitSelectorAgainstRecordedRelationProjection(
					reader.projectionState,
					input.workUnit,
				);
				const [displayEntry] = await buildWorkUnitDisplayEntries(
					reader,
					[subjectWorkUnit],
					deps.getWorkspacePathById,
				);
				if (!displayEntry) {
					throw new Error("Subject work unit display entry is missing.");
				}
				return displayEntry;
			});
			return await buildLevelOneFallbackGlobalRecapOfWorkUnit(deps, subjectDisplayEntry, input.workUnitContextLevel);
		},
	};
}

// L1 兜底第三个部件的生产实现：通知生命周期档案里该卡最近一条非空摘要（不限面板可见性——清空面板不改变事实）。
export async function readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive(
	workspaceId: string,
	taskId: string,
): Promise<{ summaryText: string; triggeredAt: number } | null> {
	const page = await getNotificationLifecycleArchive().list({ workspaceId, taskId, limit: 10 });
	const latestEntryWithSummary = page.entries
		.filter((entry) => entry.summaryText.trim().length > 0)
		.sort((left, right) => right.triggeredAt - left.triggeredAt)[0];
	return latestEntryWithSummary
		? { summaryText: latestEntryWithSummary.summaryText.trim(), triggeredAt: latestEntryWithSummary.triggeredAt }
		: null;
}

// 端口的 L1 兜底提供方（Y-PHASE-4）：标题 + prompt 首段 + 最近一条通知 summaryText。
// 不读 Claude 的 away_summary（那归跨 harness 全局 recap 卡 9cc01），缺的部件如实列在 missingContextParts。
export const LEVEL_ONE_FALLBACK_GLOBAL_RECAP_PROVIDER_NAME = "cline_kanban_level_one_fallback_global_recap_provider";

async function buildLevelOneFallbackGlobalRecapOfWorkUnit(
	deps: CreateWorkUnitRelationReadApiDependencies,
	subjectWorkUnit: WorkUnitDisplayEntry,
	workUnitContextLevel: GetWorkUnitContextResponse["workUnitContextLevel"],
): Promise<GetWorkUnitContextResponse> {
	const asOf = Date.now();
	const card = subjectWorkUnit.workUnit;
	const identity = subjectWorkUnit.kanbanBoardCardIdentity;
	if (card.workUnitType !== "kanban_board_card" || !identity) {
		return {
			subjectWorkUnit,
			workUnitContextLevel,
			workUnitContextProviderName: LEVEL_ONE_FALLBACK_GLOBAL_RECAP_PROVIDER_NAME,
			workUnitContextProviderAvailability: "unavailable",
			workUnitContextUnavailableReason:
				"The level-one fallback recap provider only covers Kanban task cards; standalone sessions need the cross-harness global recap provider.",
			workUnitContextAsOf: asOf,
			workUnitContextCompleteness: { includedContextParts: [], missingContextParts: ["all"] },
			globalRecapText: null,
		};
	}
	const latestNotification = await deps
		.readLatestNotificationSummaryTextOfTaskCard(card.workspaceId, card.taskId)
		.catch(() => null);
	const includedContextParts: string[] = [];
	const missingContextParts: string[] = ["claude_away_summary_not_read_by_level_one_fallback"];
	const recapLines = [`Kanban ${subjectWorkUnit.workUnitDisplayLabel}`];
	if (identity.currentTitle) {
		includedContextParts.push("task_card_title");
	} else {
		missingContextParts.push("task_card_title");
	}
	if (identity.promptFirstParagraph) {
		includedContextParts.push("task_card_prompt_first_paragraph");
		recapLines.push(`Requirement (first paragraph of the task prompt): ${identity.promptFirstParagraph}`);
	} else {
		missingContextParts.push("task_card_prompt_first_paragraph");
	}
	if (latestNotification) {
		includedContextParts.push("latest_task_notification_summary_text");
		recapLines.push(
			`Latest notification (${new Date(latestNotification.triggeredAt).toISOString().slice(0, 16)}Z): ${latestNotification.summaryText}`,
		);
	} else {
		missingContextParts.push("latest_task_notification_summary_text");
	}
	return {
		subjectWorkUnit,
		workUnitContextLevel,
		workUnitContextProviderName: LEVEL_ONE_FALLBACK_GLOBAL_RECAP_PROVIDER_NAME,
		workUnitContextProviderAvailability: "available",
		workUnitContextUnavailableReason: null,
		workUnitContextAsOf: asOf,
		workUnitContextCompleteness: { includedContextParts, missingContextParts },
		globalRecapText: recapLines.join("\n"),
	};
}
