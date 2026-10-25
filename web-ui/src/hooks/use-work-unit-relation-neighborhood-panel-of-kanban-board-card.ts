// dd2db 1b Relations 面板的状态编排 hook：读一张卡的一度关系邻域、整理成展示模型、提供邻居卡的打开入口，
// 以及「静音 / 取消静音」的点击处理器。
//
// 读：进详情 / 切卡即拉一次；手动刷新与静音切换成功后重拉。结果按「workspace + 卡 id」打标签，
// 切卡那一帧不会把上一张卡的邻域当成这张卡的渲染。读失败（含 SERVICE_UNAVAILABLE）如实落成失败态，
// 绝不降级成空邻域——「关系暂不可用」和「没有关系」是两回事。
//
// 写：静音与撤销断言都是决策类 procedure（R3），本 hook 只**造**点击处理器
// （createRecordedRelationMuteToggleButtonClickHandler / createEffectiveRelationAssertionRevocationChoiceClickHandler），
// 不在任何 effect / 自动流程里调用它们；处理器只能绑在按钮的 onClick 上（撤销还要把这次点击事件交给传输层，
// runtime 据此拒绝脚本合成的点击）。

import type { RelationAssertionRevocationReason } from "@runtime-inter-work-unit-relation-assertion-lifecycle-event-contract";
import type { GetRelationNeighborhoodSummaryResponse } from "@runtime-work-unit-relation-read-api-contract";
import { type MouseEventHandler, useCallback, useEffect, useMemo, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	buildWorkUnitAssertedRelationNeighborhoodPresentation,
	type WorkUnitAssertedRelationNeighborhoodPresentation,
} from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";
import {
	buildWorkUnitRelationNeighborhoodPanelPresentation,
	type KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel,
	type WorkUnitRelationNeighborhoodPanelPresentation,
} from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import {
	classifyInterWorkUnitRelationAssertionWriteFailure,
	type InterWorkUnitRelationAssertionWriteFailure,
	revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture,
} from "@/runtime/work-unit-relation-assertion-write-query";
import {
	classifyRecordedRelationPresentationMutePreferenceWriteFailure,
	classifyWorkUnitRelationNeighborhoodSummaryReadFailure,
	fetchWorkUnitRelationNeighborhoodSummaryOfKanbanBoardCard,
	type RecordedRelationPresentationMutePreferenceWriteFailure,
	setRecordedRelationPresentationMutePreferenceFromExplicitUserClick,
	type WorkUnitRelationNeighborhoodSummaryReadFailure,
} from "@/runtime/work-unit-relation-neighborhood-summary-query";

export type WorkUnitRelationNeighborhoodPanelReadState =
	| { relationNeighborhoodReadPhase: "no_subject_kanban_board_card" }
	| { relationNeighborhoodReadPhase: "loading_relation_neighborhood" }
	| {
			relationNeighborhoodReadPhase: "relation_neighborhood_read_failed";
			relationNeighborhoodReadFailure: WorkUnitRelationNeighborhoodSummaryReadFailure;
	  }
	| {
			relationNeighborhoodReadPhase: "relation_neighborhood_loaded";
			relationNeighborhoodPanelPresentation: WorkUnitRelationNeighborhoodPanelPresentation;
			assertedRelationNeighborhoodPresentation: WorkUnitAssertedRelationNeighborhoodPresentation;
	  };

export interface WorkUnitRelationNeighborhoodPanelController {
	relationNeighborhoodReadState: WorkUnitRelationNeighborhoodPanelReadState;
	// 同一张卡的重拉进行中（首次读取走 loading 态，不算在这里）。
	isRelationNeighborhoodRefetchInFlight: boolean;
	refetchRelationNeighborhood: () => void;
	// null = 没有跨项目打开宿主（单测 / 独立挂载）：邻居只展示。
	openNeighborKanbanBoardCardInItsProject: ((workspaceId: string, taskId: string) => void) | null;
	relationIdsWithPresentationMuteToggleInFlight: ReadonlySet<string>;
	// 只能绑在按钮的 onClick 上（见文件头）。
	createRecordedRelationMuteToggleButtonClickHandler: (
		relationId: string,
		nextRecordedRelationMutedInPresentation: boolean,
	) => MouseEventHandler<HTMLButtonElement>;
	relationIdsWithAssertionRevocationInFlight: ReadonlySet<string>;
	// 只能绑在撤销选项按钮的 onClick 上（见文件头）；点击事件原样交给传输层。
	createEffectiveRelationAssertionRevocationChoiceClickHandler: (
		relationId: string,
		relationAssertionRevocationReason: RelationAssertionRevocationReason,
	) => MouseEventHandler<HTMLButtonElement>;
}

type TaggedRelationNeighborhoodReadOutcome =
	| {
			readSubjectKey: string;
			readOutcomeKind: "loaded";
			relationNeighborhoodSummary: GetRelationNeighborhoodSummaryResponse;
	  }
	| {
			readSubjectKey: string;
			readOutcomeKind: "failed";
			relationNeighborhoodReadFailure: WorkUnitRelationNeighborhoodSummaryReadFailure;
	  };

function buildRelationNeighborhoodReadSubjectKey(
	workspaceId: string,
	kanbanBoardCardTaskId: string,
	incarnation?: number,
): string {
	return `${workspaceId}\u0000${kanbanBoardCardTaskId}\u0000${incarnation ?? "current"}`;
}

export function describeRecordedRelationPresentationMutePreferenceWriteFailureForToast(
	writeFailure: RecordedRelationPresentationMutePreferenceWriteFailure,
	nextRecordedRelationMutedInPresentation: boolean,
): string {
	const attemptedActionLabel = nextRecordedRelationMutedInPresentation ? "静音" : "取消静音";
	const reasonSuffix = writeFailure.writeFailureReasonMessage ? `（${writeFailure.writeFailureReasonMessage}）` : "";
	switch (writeFailure.writeFailureKind) {
		case "inter_work_unit_relation_ledger_unavailable":
			return `${attemptedActionLabel}没有保存：关系账本暂不可用${reasonSuffix}`;
		case "web_ui_page_load_request_origin_nonce_not_verified_by_runtime":
			return `${attemptedActionLabel}没有保存：runtime 没有认可这个页面的请求来源，请刷新页面后重试${reasonSuffix}`;
		case "recorded_relation_not_found_in_inter_work_unit_relation_ledger":
			return `${attemptedActionLabel}没有保存：关系账本里找不到这条关系，请刷新关系面板${reasonSuffix}`;
		default:
			return `${attemptedActionLabel}没有保存${reasonSuffix}`;
	}
}

// 断言写入（撤销 / 添加关系）失败的提示：runtime 给的那句人话原样转述，前面只补一句它属于哪类失败。
export function describeInterWorkUnitRelationAssertionWriteFailureForUser(
	writeFailure: InterWorkUnitRelationAssertionWriteFailure,
	attemptedActionLabel: string,
): string {
	const runtimeSentence = writeFailure.writeFailureHumanReadableSentence;
	switch (writeFailure.writeFailureKind) {
		case "inter_work_unit_relation_ledger_unavailable":
			return `${attemptedActionLabel}没有保存：关系账本暂不可用（${runtimeSentence}）`;
		case "web_ui_user_decision_request_origin_rejected_by_runtime":
			return `${attemptedActionLabel}没有保存：runtime 没有把这次操作认作你的决定（${runtimeSentence}）`;
		case "relation_assertion_write_kept_conflicting_with_concurrent_writes":
			return `${attemptedActionLabel}没有保存：与并发写入冲突，可以直接重试（${runtimeSentence}）`;
		default:
			return `${attemptedActionLabel}没有保存：${runtimeSentence}`;
	}
}

export function useWorkUnitRelationNeighborhoodPanelOfKanbanBoardCard(input: {
	workspaceId: string | null;
	kanbanBoardCardTaskId: string | null;
	taskIncarnationCreatedAtEpochMs?: number;
}): WorkUnitRelationNeighborhoodPanelController {
	const { workspaceId, kanbanBoardCardTaskId, taskIncarnationCreatedAtEpochMs } = input;
	const crossProjectTaskOpenHost = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const [taggedReadOutcome, setTaggedReadOutcome] = useState<TaggedRelationNeighborhoodReadOutcome | null>(null);
	const [isReadRequestInFlight, setIsReadRequestInFlight] = useState(false);
	// 递增即重拉（手动刷新、静音切换成功后）。
	const [relationNeighborhoodRefetchRequestSequence, setRelationNeighborhoodRefetchRequestSequence] = useState(0);
	const [relationIdsWithPresentationMuteToggleInFlight, setRelationIdsWithPresentationMuteToggleInFlight] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const [relationIdsWithAssertionRevocationInFlight, setRelationIdsWithAssertionRevocationInFlight] = useState<
		ReadonlySet<string>
	>(() => new Set());

	const currentReadSubjectKey =
		workspaceId && kanbanBoardCardTaskId
			? buildRelationNeighborhoodReadSubjectKey(workspaceId, kanbanBoardCardTaskId, taskIncarnationCreatedAtEpochMs)
			: null;

	useEffect(() => {
		if (!workspaceId || !kanbanBoardCardTaskId) {
			setIsReadRequestInFlight(false);
			return;
		}
		const readSubjectKey = buildRelationNeighborhoodReadSubjectKey(
			workspaceId,
			kanbanBoardCardTaskId,
			taskIncarnationCreatedAtEpochMs,
		);
		let isSupersededByLaterRead = false;
		setIsReadRequestInFlight(true);
		fetchWorkUnitRelationNeighborhoodSummaryOfKanbanBoardCard({
			workspaceId,
			kanbanBoardCardTaskId,
			...(taskIncarnationCreatedAtEpochMs === undefined ? {} : { taskIncarnationCreatedAtEpochMs }),
		}).then(
			(relationNeighborhoodSummary) => {
				if (isSupersededByLaterRead) {
					return;
				}
				setTaggedReadOutcome({ readSubjectKey, readOutcomeKind: "loaded", relationNeighborhoodSummary });
				setIsReadRequestInFlight(false);
			},
			(error: unknown) => {
				if (isSupersededByLaterRead) {
					return;
				}
				setTaggedReadOutcome({
					readSubjectKey,
					readOutcomeKind: "failed",
					relationNeighborhoodReadFailure: classifyWorkUnitRelationNeighborhoodSummaryReadFailure(error),
				});
				setIsReadRequestInFlight(false);
			},
		);
		return () => {
			isSupersededByLaterRead = true;
		};
	}, [
		workspaceId,
		kanbanBoardCardTaskId,
		taskIncarnationCreatedAtEpochMs,
		relationNeighborhoodRefetchRequestSequence,
	]);

	// 宿主值随通知日志等频繁换引用；这里只依赖项目列表本身。
	const knownKanbanProjectsFromHost = crossProjectTaskOpenHost?.projects ?? null;
	const knownKanbanProjectByWorkspaceId = useMemo<KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel>(() => {
		if (!knownKanbanProjectsFromHost) {
			return null;
		}
		return new Map(
			knownKanbanProjectsFromHost.map((project) => [
				project.id,
				{ kanbanProjectName: project.name, isKanbanProjectAvailable: project.availability.status === "available" },
			]),
		);
	}, [knownKanbanProjectsFromHost]);

	const relationNeighborhoodReadState = useMemo<WorkUnitRelationNeighborhoodPanelReadState>(() => {
		if (currentReadSubjectKey === null) {
			return { relationNeighborhoodReadPhase: "no_subject_kanban_board_card" };
		}
		if (!taggedReadOutcome || taggedReadOutcome.readSubjectKey !== currentReadSubjectKey) {
			return { relationNeighborhoodReadPhase: "loading_relation_neighborhood" };
		}
		if (taggedReadOutcome.readOutcomeKind === "failed") {
			return {
				relationNeighborhoodReadPhase: "relation_neighborhood_read_failed",
				relationNeighborhoodReadFailure: taggedReadOutcome.relationNeighborhoodReadFailure,
			};
		}
		const presentationInput = {
			relationNeighborhoodSummary: taggedReadOutcome.relationNeighborhoodSummary,
			currentKanbanProjectWorkspaceId: workspaceId,
			knownKanbanProjectByWorkspaceId,
		};
		return {
			relationNeighborhoodReadPhase: "relation_neighborhood_loaded",
			relationNeighborhoodPanelPresentation: buildWorkUnitRelationNeighborhoodPanelPresentation(presentationInput),
			assertedRelationNeighborhoodPresentation:
				buildWorkUnitAssertedRelationNeighborhoodPresentation(presentationInput),
		};
	}, [currentReadSubjectKey, knownKanbanProjectByWorkspaceId, taggedReadOutcome, workspaceId]);

	const refetchRelationNeighborhood = useCallback(() => {
		setRelationNeighborhoodRefetchRequestSequence((sequence) => sequence + 1);
	}, []);

	const createRecordedRelationMuteToggleButtonClickHandler = useCallback(
		(relationId: string, nextRecordedRelationMutedInPresentation: boolean): MouseEventHandler<HTMLButtonElement> =>
			() => {
				if (!workspaceId) {
					return;
				}
				setRelationIdsWithPresentationMuteToggleInFlight((current) => new Set(current).add(relationId));
				setRecordedRelationPresentationMutePreferenceFromExplicitUserClick({
					workspaceId,
					relationId,
					recordedRelationMutedInPresentation: nextRecordedRelationMutedInPresentation,
				})
					.then(
						() => {
							// 偏好已落账（或本来就是目标状态）：以 runtime 为准重拉邻域，不在本地乐观改。
							setRelationNeighborhoodRefetchRequestSequence((sequence) => sequence + 1);
						},
						(error: unknown) => {
							showAppToast({
								intent: "danger",
								message: describeRecordedRelationPresentationMutePreferenceWriteFailureForToast(
									classifyRecordedRelationPresentationMutePreferenceWriteFailure(error),
									nextRecordedRelationMutedInPresentation,
								),
								timeout: 7000,
							});
						},
					)
					.finally(() => {
						setRelationIdsWithPresentationMuteToggleInFlight((current) => {
							const next = new Set(current);
							next.delete(relationId);
							return next;
						});
					});
			},
		[workspaceId],
	);

	const createEffectiveRelationAssertionRevocationChoiceClickHandler = useCallback(
		(
			relationId: string,
			relationAssertionRevocationReason: RelationAssertionRevocationReason,
		): MouseEventHandler<HTMLButtonElement> =>
			(revocationChoiceClickEvent) => {
				if (!workspaceId) {
					return;
				}
				setRelationIdsWithAssertionRevocationInFlight((current) => new Set(current).add(relationId));
				revokeEffectiveRelationAssertionDirectlyAsWebUiUserFromExplicitUserGesture(revocationChoiceClickEvent, {
					workspaceId,
					relationId,
					relationAssertionRevocationReason,
				})
					.then(
						() => {
							// 已撤销（含「本来就已撤销」）：以 runtime 为准重拉邻域，不在本地乐观删行。
							setRelationNeighborhoodRefetchRequestSequence((sequence) => sequence + 1);
						},
						(error: unknown) => {
							showAppToast({
								intent: "danger",
								message: describeInterWorkUnitRelationAssertionWriteFailureForUser(
									classifyInterWorkUnitRelationAssertionWriteFailure(error),
									"撤销",
								),
								timeout: 7000,
							});
						},
					)
					.finally(() => {
						setRelationIdsWithAssertionRevocationInFlight((current) => {
							const next = new Set(current);
							next.delete(relationId);
							return next;
						});
					});
			},
		[workspaceId],
	);

	return {
		relationNeighborhoodReadState,
		isRelationNeighborhoodRefetchInFlight:
			isReadRequestInFlight &&
			relationNeighborhoodReadState.relationNeighborhoodReadPhase !== "loading_relation_neighborhood",
		refetchRelationNeighborhood,
		openNeighborKanbanBoardCardInItsProject: crossProjectTaskOpenHost?.onOpenTaskInProject ?? null,
		relationIdsWithPresentationMuteToggleInFlight,
		createRecordedRelationMuteToggleButtonClickHandler,
		relationIdsWithAssertionRevocationInFlight,
		createEffectiveRelationAssertionRevocationChoiceClickHandler,
	};
}
