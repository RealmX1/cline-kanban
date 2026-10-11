import { describe, expect, it } from "vitest";

import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationTask,
} from "../../../src/core/api-contract";
import {
	assemblePostDeployVerificationTaskForDeploymentGroup,
	buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults,
	GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID,
	isPostDeployVerificationTaskAwaitingVerification,
	mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem,
	reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock,
} from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";

function buildAuthoredItem(
	verificationId: string,
	overrides: Partial<RuntimePostDeployVerificationChecklistItem> = {},
): RuntimePostDeployVerificationChecklistItem {
	return {
		id: `authored:${verificationId}`,
		label: `断言 ${verificationId}`,
		checked: false,
		source: "authored",
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: { mode: "manual", assetsDir: null, manualSteps: [] },
		...overrides,
	};
}

function buildCarriedTask(overrides: Partial<RuntimePostDeployVerificationTask>): RuntimePostDeployVerificationTask {
	return {
		taskId: "task-1",
		columnIdAtMatch: "validation",
		matchedCommits: [],
		inclusionReason: "validation_column",
		checklist: [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: null,
		droppedReason: null,
		...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
		...overrides,
	};
}

const AUTOMATED_SCRIPT = { entrypoint: "verify.sh", interpreter: "bash", timeoutMs: 60000 } as const;
const PASSED_RUN = {
	status: "passed",
	exitCode: 0,
	startedAtIso: "2026-10-01T00:00:00.000Z",
	finishedAtIso: "2026-10-01T00:00:01.000Z",
	outputExcerpt: "ok",
} as const;

describe("assemblePostDeployVerificationTaskForDeploymentGroup", () => {
	it("没有任何具体验证项时补通用兜底项；有 authored 项时不补", () => {
		const withoutAuthored = assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: "task-1",
			columnIdAtMatch: "validation",
			inclusionReason: "validation_column",
			deploymentId: "deployment-2",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
			authoredChecklistItems: [],
			taskDeploymentAttributionComputation: null,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		});
		expect(withoutAuthored.task.checklist.map((item) => item.id)).toEqual([
			GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID,
		]);

		const withAuthored = assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: "task-1",
			columnIdAtMatch: "validation",
			inclusionReason: "validation_column",
			deploymentId: "deployment-2",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
			authoredChecklistItems: [buildAuthoredItem("a")],
			taskDeploymentAttributionComputation: null,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		});
		expect(withAuthored.task.checklist.map((item) => item.id)).toEqual(["authored:a"]);
		expect(withAuthored.appendedAuthoredItemCount).toBe(1);
	});

	it("跨部署延续：勾选与脚本结果保留，定义字段按最新注册刷新，未勾的兜底项去掉，首次上线与历经部署沿用", () => {
		const carried = buildCarriedTask({
			checklist: [
				buildAuthoredItem("a", { checked: true, label: "旧标签" }),
				{
					id: GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID,
					label: "在已部署 build 上手工验证",
					checked: false,
					source: "commit",
					kind: "guided_manual",
					guidance: null,
					script: null,
					run: null,
					cleanup: null,
				},
			],
			firstDeployedInDeploymentId: "deployment-1",
			firstDeployedAtIso: "2026-10-01T00:00:00.000Z",
			deploymentIdsRecordedWhileTaskAwaitingVerification: ["deployment-1"],
		});

		const { task } = assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: "task-1",
			columnIdAtMatch: "validation",
			inclusionReason: "validation_column",
			deploymentId: "deployment-2",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: carried,
			authoredChecklistItems: [buildAuthoredItem("a", { label: "新标签" }), buildAuthoredItem("b")],
			taskDeploymentAttributionComputation: {
				taskDeploymentAttribution: {
					taskDeploymentAttributionZone: "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
					matchedDeployedCommitsInThisDeploymentDelta: [],
					taskDeploymentUnattributableReason: null,
					attributionComputedAtIso: "2026-10-02T00:00:00.000Z",
				},
				firstDeployedInDeploymentId: "deployment-0",
				firstDeployedAtIso: "2026-09-30T00:00:00.000Z",
				firstDeploymentPredatesRetainedDeploymentRecords: false,
			},
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		});

		expect(task.checklist.map((item) => [item.id, item.label, item.checked])).toEqual([
			["authored:a", "新标签", true],
			["authored:b", "断言 b", false],
		]);
		expect(task.firstDeployedInDeploymentId).toBe("deployment-1");
		expect(task.deploymentIdsRecordedWhileTaskAwaitingVerification).toEqual(["deployment-1", "deployment-2"]);
		expect(task.taskDeploymentAttribution?.taskDeploymentAttributionZone).toBe(
			"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
		);
		// 延续不改动上一组里的原对象。
		expect(carried.checklist[0]?.label).toBe("旧标签");
	});

	it("同 id 重注册把已勾的 guided 项改成 automated_script：清回未核对，不会变成「从未运行却已勾选」的自动项", () => {
		const carried = buildCarriedTask({ checklist: [buildAuthoredItem("a", { checked: true })] });

		const { task } = assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: "task-1",
			columnIdAtMatch: "validation",
			inclusionReason: "validation_column",
			deploymentId: "deployment-2",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: carried,
			authoredChecklistItems: [buildAuthoredItem("a", { kind: "automated_script", script: AUTOMATED_SCRIPT })],
			taskDeploymentAttributionComputation: null,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		});

		expect(task.checklist).toHaveLength(1);
		expect(task.checklist[0]).toMatchObject({ kind: "automated_script", checked: false, run: null });
		expect(task.checklist.every((item) => item.checked)).toBe(false);
	});
});

describe("mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem 同 id 重注册时的勾选依据", () => {
	function mergeSingleRedefinition(
		existing: RuntimePostDeployVerificationChecklistItem,
		redefined: RuntimePostDeployVerificationChecklistItem,
	): RuntimePostDeployVerificationChecklistItem | undefined {
		const checklist = [existing];
		mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem(checklist, [redefined]);
		return checklist[0];
	}

	it("automated_script 的 script 定义变了：旧的 passed 运行作废，清回未运行", () => {
		const existing = buildAuthoredItem("a", {
			kind: "automated_script",
			script: AUTOMATED_SCRIPT,
			checked: true,
			run: { ...PASSED_RUN },
		});
		for (const changedScript of [
			{ ...AUTOMATED_SCRIPT, entrypoint: "verify-v2.sh" },
			{ ...AUTOMATED_SCRIPT, interpreter: "node" as const },
			{ ...AUTOMATED_SCRIPT, timeoutMs: 5000 },
		]) {
			const merged = mergeSingleRedefinition(
				structuredClone(existing),
				buildAuthoredItem("a", { kind: "automated_script", script: changedScript }),
			);
			expect(merged).toMatchObject({ script: changedScript, checked: false, run: null });
		}
	});

	it("automated_script 只改 label / cleanup：保留勾选与运行结果", () => {
		const merged = mergeSingleRedefinition(
			buildAuthoredItem("a", {
				kind: "automated_script",
				script: AUTOMATED_SCRIPT,
				checked: true,
				run: { ...PASSED_RUN },
			}),
			buildAuthoredItem("a", {
				kind: "automated_script",
				script: { ...AUTOMATED_SCRIPT },
				label: "改过的标签",
				cleanup: { mode: "automatic", assetsDir: null, manualSteps: [] },
			}),
		);
		expect(merged).toMatchObject({ label: "改过的标签", checked: true, run: PASSED_RUN });
	});

	it("automated_script 改成 guided_manual：脚本通过不等于人工核对过，勾选与运行结果作废", () => {
		const merged = mergeSingleRedefinition(
			buildAuthoredItem("a", {
				kind: "automated_script",
				script: AUTOMATED_SCRIPT,
				checked: true,
				run: { ...PASSED_RUN },
			}),
			buildAuthoredItem("a", { kind: "guided_manual" }),
		);
		expect(merged).toMatchObject({ kind: "guided_manual", checked: false, run: null });
	});

	it("guided_manual：只改 label / failureSignature / anchor 保留勾选；steps 或 expectedObservation 变了勾选作废", () => {
		const guidance = {
			steps: ["打开看板", "点开任务卡"],
			expectedObservation: "看到绿色徽标",
			failureSignature: "徽标缺失",
			anchor: null,
		};
		const checkedGuidedItem = buildAuthoredItem("a", { checked: true, guidance });

		const wordingOnly = mergeSingleRedefinition(
			structuredClone(checkedGuidedItem),
			buildAuthoredItem("a", {
				label: "改过的标签",
				guidance: { ...guidance, failureSignature: "徽标不显示", anchor: { view: "board" } },
			}),
		);
		expect(wordingOnly).toMatchObject({ label: "改过的标签", checked: true });

		for (const changedGuidance of [
			{ ...guidance, steps: ["打开看板", "点开任务详情"] },
			{ ...guidance, expectedObservation: "看到红色徽标" },
			null,
		]) {
			const merged = mergeSingleRedefinition(
				structuredClone(checkedGuidedItem),
				buildAuthoredItem("a", { guidance: changedGuidance }),
			);
			expect(merged?.checked).toBe(false);
		}
	});
});

describe("isPostDeployVerificationTaskAwaitingVerification", () => {
	it("等核对的判定：已结案、已移除、只读、已延续的条目都不算", () => {
		expect(isPostDeployVerificationTaskAwaitingVerification(buildCarriedTask({}))).toBe(true);
		expect(isPostDeployVerificationTaskAwaitingVerification(buildCarriedTask({ verifiedAt: "x" }))).toBe(false);
		expect(
			isPostDeployVerificationTaskAwaitingVerification(
				buildCarriedTask({
					postDeployVerificationClosure: {
						postDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
						closedAtIso: "x",
						postDeployVerificationCompletionPath: "x",
						uncheckedChecklistItemClosureReasons: [],
						confirmedAcknowledgements: [],
						taskDeploymentAttributionZoneAtClosure: null,
						deferredNaturalUsageObservationRecordIds: [],
					},
				}),
			),
		).toBe(false);
		expect(
			isPostDeployVerificationTaskAwaitingVerification(buildCarriedTask({ droppedReason: "task_deleted" })),
		).toBe(false);
		expect(
			isPostDeployVerificationTaskAwaitingVerification(
				buildCarriedTask({ includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true }),
			),
		).toBe(false);
		expect(
			isPostDeployVerificationTaskAwaitingVerification(buildCarriedTask({ carriedForwardIntoDeploymentId: "d" })),
		).toBe(false);
	});
});

// RVF-002：record 无锁组装延续副本 → 进 state 锁写新组；两步之间旧副本可能被勾选 / 授权 / 结案。锁内按旧副本当前状态重新落定。
describe("reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock", () => {
	const ATTRIBUTION_INCLUDED_IN_THIS_DEPLOYMENT_DELTA = {
		taskDeploymentAttribution: {
			taskDeploymentAttributionZone: "task_commits_included_in_this_deployment_delta" as const,
			matchedDeployedCommitsInThisDeploymentDelta: [],
			taskDeploymentUnattributableReason: null,
			attributionComputedAtIso: "2026-10-11T00:00:00.000Z",
		},
		firstDeployedInDeploymentId: "deployment-2",
		firstDeployedAtIso: "2026-10-11T00:00:00.000Z",
		firstDeploymentPredatesRetainedDeploymentRecords: false,
	};

	function assembleFromUnlockedPreRead(
		preReadCopy: RuntimePostDeployVerificationTask,
		authoredChecklistItems: RuntimePostDeployVerificationChecklistItem[],
		taskDeploymentAttributionComputation: typeof ATTRIBUTION_INCLUDED_IN_THIS_DEPLOYMENT_DELTA | null = null,
	): RuntimePostDeployVerificationTask {
		return assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: preReadCopy.taskId,
			columnIdAtMatch: "validation",
			inclusionReason: "validation_column",
			deploymentId: "deployment-2",
			unclosedTaskCarriedForwardFromPreviousActiveGroup: preReadCopy,
			authoredChecklistItems,
			taskDeploymentAttributionComputation,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		}).task;
	}

	it("旧副本仍等核对、无在途结案：勾选进度取锁内当前值，新注册的 authored 项照常合并", () => {
		const preReadCopy = buildCarriedTask({
			checklist: [buildAuthoredItem("a", { checked: false }), buildAuthoredItem("b", { checked: false })],
			deploymentIdsRecordedWhileTaskAwaitingVerification: ["deployment-1"],
		});
		const assembled = assembleFromUnlockedPreRead(preReadCopy, [
			buildAuthoredItem("a", { label: "新标签" }),
			buildAuthoredItem("b"),
			buildAuthoredItem("c"),
		]);
		// 预读之后、写组之前：用户在面板上勾了 a；runtime 对账定下了首次上线。
		const previousCopyCurrentWithinStateLock = buildCarriedTask({
			checklist: [buildAuthoredItem("a", { checked: true }), buildAuthoredItem("b", { checked: false })],
			deploymentIdsRecordedWhileTaskAwaitingVerification: ["deployment-1"],
			firstDeployedInDeploymentId: "deployment-1",
			firstDeployedAtIso: "2026-10-01T00:00:00.000Z",
		});

		const reconciled = reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
			deploymentId: "deployment-2",
			taskAssembledFromUnlockedPreRead: assembled,
			previousCopyCurrentWithinStateLock,
		});

		if (
			reconciled.carriedForwardTaskReconciliationOutcome !==
			"carried_forward_with_previous_copy_current_progress_and_in_flight_closure"
		) {
			throw new Error(`意外结局：${reconciled.carriedForwardTaskReconciliationOutcome}`);
		}
		expect(reconciled.task.checklist.map((item) => [item.id, item.label, item.checked])).toEqual([
			["authored:a", "新标签", true],
			["authored:b", "断言 b", false],
			["authored:c", "断言 c", false],
		]);
		expect(reconciled.task.firstDeployedInDeploymentId).toBe("deployment-1");
		expect(reconciled.task.deploymentIdsRecordedWhileTaskAwaitingVerification).toEqual([
			"deployment-1",
			"deployment-2",
		]);
		expect(reconciled.task.pendingConfirmation).toBeNull();
		expect(reconciled.task.doneEntryClosureAuthorizationInFlight).toBeNull();
	});

	it("旧副本带在途授权与 CLI 在途完成记录：随副本搬到新组，checklist 原样冻结、不合并新注册的 authored 项", () => {
		const preReadCopy = buildCarriedTask({ checklist: [buildAuthoredItem("a", { checked: false })] });
		const assembled = assembleFromUnlockedPreRead(preReadCopy, [buildAuthoredItem("a"), buildAuthoredItem("late")]);
		const previousCopyCurrentWithinStateLock = buildCarriedTask({
			checklist: [buildAuthoredItem("a", { checked: false })],
			doneEntryClosureAuthorizationInFlight: {
				authorizedAtIso: "2026-10-11T00:00:00.000Z",
				expiresAtIso: "2026-10-11T00:15:00.000Z",
				anticipatedPostDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
				uncheckedChecklistItemClosureReasons: [
					{
						checklistItemId: "authored:a",
						uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
					},
				],
				confirmedAcknowledgements: [],
				postDeployVerificationCompletionPath:
					"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			},
			pendingConfirmation: {
				token: "cli-in-flight-token",
				expiresAtIso: "2026-10-11T00:15:00.000Z",
				requiredAcknowledgements: [],
				columnIdAtIssuance: "validation",
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
					authorizedAtIso: "2026-10-11T00:00:00.000Z",
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
					uncheckedChecklistItemClosureReasons: [],
				},
			},
		});

		const reconciled = reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
			deploymentId: "deployment-2",
			taskAssembledFromUnlockedPreRead: assembled,
			previousCopyCurrentWithinStateLock,
		});

		if (
			reconciled.carriedForwardTaskReconciliationOutcome !==
			"carried_forward_with_previous_copy_current_progress_and_in_flight_closure"
		) {
			throw new Error(`意外结局：${reconciled.carriedForwardTaskReconciliationOutcome}`);
		}
		expect(reconciled.task.checklist.map((item) => item.id)).toEqual(["authored:a"]);
		expect(reconciled.task.doneEntryClosureAuthorizationInFlight).toEqual(
			previousCopyCurrentWithinStateLock.doneEntryClosureAuthorizationInFlight,
		);
		expect(reconciled.task.pendingConfirmation).toEqual(previousCopyCurrentWithinStateLock.pendingConfirmation);
		// 搬过去的是副本，不与旧副本共享引用（调用方随后会清掉旧副本上的记录）。
		expect(reconciled.task.pendingConfirmation).not.toBe(previousCopyCurrentWithinStateLock.pendingConfirmation);
	});

	it("旧副本已结案：提交命中本次区间 → 只读展示；否则、或旧副本已被移除 → 不纳入", () => {
		const closure = {
			postDeployVerificationClosureOutcome: "all_checklist_items_checked" as const,
			closedAtIso: "2026-10-11T00:00:00.000Z",
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			uncheckedChecklistItemClosureReasons: [],
			confirmedAcknowledgements: [],
			taskDeploymentAttributionZoneAtClosure: null,
			deferredNaturalUsageObservationRecordIds: [],
		};
		const preReadCopy = buildCarriedTask({ checklist: [buildAuthoredItem("a", { checked: true })] });
		const closedCopy = buildCarriedTask({
			checklist: [buildAuthoredItem("a", { checked: true })],
			verifiedAt: "2026-10-11T00:00:00.000Z",
			postDeployVerificationClosure: closure,
		});

		const shippedInThisDeployment = reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
			deploymentId: "deployment-2",
			taskAssembledFromUnlockedPreRead: assembleFromUnlockedPreRead(
				preReadCopy,
				[buildAuthoredItem("a")],
				ATTRIBUTION_INCLUDED_IN_THIS_DEPLOYMENT_DELTA,
			),
			previousCopyCurrentWithinStateLock: closedCopy,
		});
		if (
			shippedInThisDeployment.carriedForwardTaskReconciliationOutcome !==
			"included_as_read_only_because_previous_copy_closed_into_done_before_deployment_group_written"
		) {
			throw new Error(`意外结局：${shippedInThisDeployment.carriedForwardTaskReconciliationOutcome}`);
		}
		expect(shippedInThisDeployment.task).toMatchObject({
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true,
			columnIdAtMatch: "trash",
			verifiedAt: null,
			postDeployVerificationClosure: null,
			deploymentIdsRecordedWhileTaskAwaitingVerification: ["deployment-2"],
		});
		// 只读展示不 seed authored 项（与 record 对 Done 卡一致）。
		expect(shippedInThisDeployment.task.checklist.map((item) => item.id)).toEqual([
			GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID,
		]);
		expect(isPostDeployVerificationTaskAwaitingVerification(shippedInThisDeployment.task)).toBe(false);

		expect(
			reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
				deploymentId: "deployment-2",
				taskAssembledFromUnlockedPreRead: assembleFromUnlockedPreRead(preReadCopy, [buildAuthoredItem("a")]),
				previousCopyCurrentWithinStateLock: closedCopy,
			}).carriedForwardTaskReconciliationOutcome,
		).toBe("excluded_because_previous_copy_no_longer_awaiting_verification_before_deployment_group_written");
		expect(
			reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock({
				deploymentId: "deployment-2",
				taskAssembledFromUnlockedPreRead: assembleFromUnlockedPreRead(
					preReadCopy,
					[buildAuthoredItem("a")],
					ATTRIBUTION_INCLUDED_IN_THIS_DEPLOYMENT_DELTA,
				),
				previousCopyCurrentWithinStateLock: buildCarriedTask({ droppedReason: "task_deleted" }),
			}).carriedForwardTaskReconciliationOutcome,
		).toBe("excluded_because_previous_copy_no_longer_awaiting_verification_before_deployment_group_written");
	});
});
