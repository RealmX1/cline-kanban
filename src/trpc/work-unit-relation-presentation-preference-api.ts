import { TRPCError } from "@trpc/server";

import type {
	CapturingKanbanRuntimeInstanceIdentity,
	InterWorkUnitRelationLedgerEventDraft,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	SetRecordedRelationPresentationMutePreferenceRequest,
	SetRecordedRelationPresentationMutePreferenceResponse,
} from "../core/work-unit-relation-read-api-contract";
import { InterWorkUnitRelationLedgerUnavailableError } from "../inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import type { RecordedInterWorkUnitRelationProjectionReader } from "../inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import type { RuntimeTrpcContext } from "./app-router";

// dd2db 1b：记录型关系的静音（族 7 `relation_presentation_preference_event`）。记录型关系是事实、不可撤回，
// 静音只让它不再出现在邻域摘要与会话启动注入里（d-vocab §2.3）。R3.4：静音只在 Web UI、没有 CLI——
// 所以必须带已校验的页面加载 nonce，CLI 与裸 tRPC 调用一律 FORBIDDEN。

export interface CreateWorkUnitRelationPresentationPreferenceApiDependencies {
	readRecordedInterWorkUnitRelationProjection: <T>(
		read: (reader: RecordedInterWorkUnitRelationProjectionReader) => Promise<T> | T,
	) => Promise<T>;
	appendCommittedEventsIntoLedgerAndWaitForCommit: (
		buildEventDrafts: (
			capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity,
		) => InterWorkUnitRelationLedgerEventDraft[],
	) => Promise<void>;
}

function translateLedgerUnavailability(error: unknown): never {
	if (error instanceof InterWorkUnitRelationLedgerUnavailableError) {
		throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error.message });
	}
	throw error;
}

export function createWorkUnitRelationPresentationPreferenceApi(
	deps: CreateWorkUnitRelationPresentationPreferenceApiDependencies,
): RuntimeTrpcContext["workUnitRelationPresentationPreferenceApi"] {
	// 进程内串行边界：「读当前静音状态 → 已在目标状态就不写 → 否则追加并等待提交」必须整段串行，否则并发的相同请求
	// （多标签页、重试）会都读到旧状态、各追加一条不可撤回的族 7 事件。账本只由 runtime 进程写，进程内串行即足够；
	// 静音是低频用户手势，全局串行即可。追加会等到提交、下一次读先追上账本游标，所以后到者在串行区内必能看到前一条事件。
	// 尾指针恒为已落定（吞掉失败）的 promise：前一个请求失败不会毒化后续请求。
	let tailOfSerializedRecordedRelationMutePreferenceSettingsSettled: Promise<unknown> = Promise.resolve();
	const runAfterPreviousRecordedRelationMutePreferenceSettingSettles = <T>(
		mutePreferenceSettingOperation: () => Promise<T>,
	): Promise<T> => {
		const mutePreferenceSettingOutcome =
			tailOfSerializedRecordedRelationMutePreferenceSettingsSettled.then(mutePreferenceSettingOperation);
		tailOfSerializedRecordedRelationMutePreferenceSettingsSettled = mutePreferenceSettingOutcome.catch(
			() => undefined,
		);
		return mutePreferenceSettingOutcome;
	};

	return {
		setRecordedRelationPresentationMutePreference: async (
			input: SetRecordedRelationPresentationMutePreferenceRequest,
			kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
		): Promise<SetRecordedRelationPresentationMutePreferenceResponse> => {
			// 来源校验留在串行区之外最前面：被拒的请求不排队、不读也不写。
			if (kanbanRequestOriginActorEvidence.webUiPageLoadRequestOriginNonceVerificationStatus !== "verified") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Muting a recorded relation is a Web UI-only user decision; the request needs a verified Web UI page-load nonce.",
				});
			}
			return await runAfterPreviousRecordedRelationMutePreferenceSettingSettles(() =>
				readCurrentMuteStateAndAppendPresentationPreferenceEventWhenItDiffers(input),
			);
		},
	};

	async function readCurrentMuteStateAndAppendPresentationPreferenceEventWhenItDiffers(
		input: SetRecordedRelationPresentationMutePreferenceRequest,
	): Promise<SetRecordedRelationPresentationMutePreferenceResponse> {
		const currentRelationPresentation = await deps
			.readRecordedInterWorkUnitRelationProjection((reader) => {
				const relation = reader.projectionState.recordedRelationsByRelationId.get(input.relationId);
				return relation
					? {
							relation,
							currentlyMutedInPresentation: reader.projectionState.presentationMuteStateByRelationId.has(
								input.relationId,
							),
						}
					: null;
			})
			.catch(translateLedgerUnavailability);
		if (!currentRelationPresentation) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: `No recorded relation with id ${input.relationId} is known.`,
			});
		}
		if (currentRelationPresentation.currentlyMutedInPresentation === input.recordedRelationMutedInPresentation) {
			return { ...input, relationPresentationPreferenceEventRecorded: false };
		}
		const { relation } = currentRelationPresentation;
		const subjectWorkUnit = relation.relationStatementSubjectWorkUnitRef;
		await deps
			.appendCommittedEventsIntoLedgerAndWaitForCommit((capturingKanbanRuntimeInstance) => [
				{
					eventFamily: "relation_presentation_preference_event",
					eventKind: input.recordedRelationMutedInPresentation
						? "recorded_relation_muted_in_presentation_by_user"
						: "recorded_relation_unmuted_in_presentation_by_user",
					occurredAt: Date.now(),
					actor: { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" },
					actorNativeConversationSessionIdentity: null,
					actorKanbanTaskConversationSessionId: null,
					actorRepositoryIdentityAtEventTime: null,
					onBehalfOfInitiatingWorkUnit: null,
					causedBySystemExecutedCause: null,
					recordCaptureChannel: "live_runtime_capture",
					capturingKanbanRuntimeInstance,
					invokingKanbanCliCodeVersion: null,
					occurredAtConversationTurnReference: null,
					idempotencyKey: null,
					subjectWorkspaceId:
						subjectWorkUnit.workUnitType === "kanban_board_card" ? subjectWorkUnit.workspaceId : null,
					subjectTaskId: subjectWorkUnit.workUnitType === "kanban_board_card" ? subjectWorkUnit.taskId : null,
					eventPayload: {
						relationId: relation.relationId,
						relationKind: relation.relationKind,
						relationStatementSubjectWorkUnitRef: relation.relationStatementSubjectWorkUnitRef,
						relationStatementAnchorWorkUnitRef: relation.relationStatementAnchorWorkUnitRef,
					},
				},
			])
			.catch(translateLedgerUnavailability);
		return { ...input, relationPresentationPreferenceEventRecorded: true };
	}
}
