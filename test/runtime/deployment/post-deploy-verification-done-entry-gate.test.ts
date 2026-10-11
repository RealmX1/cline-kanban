import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
} from "../../../src/core/api-contract";
import {
	listAuthoredVerificationDefinitions,
	upsertAuthoredVerificationDefinition,
} from "../../../src/deployment/authored-verification-definitions";
import { listPostDeployVerificationDeferredNaturalUsageObservationRecords } from "../../../src/deployment/post-deploy-verification-deferred-natural-usage-observation-records";
import {
	assemblePostDeployVerificationTaskForDeploymentGroup,
	buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults,
} from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone,
	evaluatePostDeployVerificationDoneEntryGateForTask,
	finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone,
	listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure,
	revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed,
} from "../../../src/deployment/post-deploy-verification-done-entry-gate";
import {
	consumePendingConfirmationAndMarkVerified,
	createDeploymentGroup,
	getPostDeployVerificationStatePath,
	markTaskVerified,
	reconcileGroup,
	setPendingConfirmation,
	updateTaskChecklist,
} from "../../../src/deployment/post-deploy-verification-state";
import type { TaskDeploymentAttributionComputation } from "../../../src/deployment/task-deployment-attribution-from-commit-integration-provenance";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import type * as PostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationRecordingModule from "../../../src/inter-work-unit-relation-ledger/post-deploy-verification-closed-into-done-with-unchecked-items-reasoned-observation-recording";
import type * as PostDeployVerificationPassedObservationRecordingModule from "../../../src/inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording";
import { createTempDir } from "../../utilities/temp-dir";

// 结案进账本的完成证据（完成路径、是否 --force）：截获两种结案事件的记账调用，原实现其余部分照旧。
const recordedPostDeployVerificationClosureObservations = vi.hoisted(
	() =>
		[] as Array<{
			observedFactKind: "passed" | "closed_into_done_with_unchecked_items_reasoned";
			taskId: string;
			postDeployVerificationCompletionPath: string;
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
			confirmedAcknowledgements: string[];
		}>,
);

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording",
	async (importOriginal) => {
		const original = await importOriginal<typeof PostDeployVerificationPassedObservationRecordingModule>();
		return {
			...original,
			recordPostDeployVerificationPassedObservationWithoutBlocking: (
				input: Parameters<typeof original.recordPostDeployVerificationPassedObservationWithoutBlocking>[0],
			) => {
				recordedPostDeployVerificationClosureObservations.push({
					observedFactKind: "passed",
					taskId: input.verifiedPostDeployVerificationTask.taskId,
					...input.completionEvidence,
				});
			},
		};
	},
);

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/post-deploy-verification-closed-into-done-with-unchecked-items-reasoned-observation-recording",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof PostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationRecordingModule
			>();
		return {
			...original,
			recordPostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationWithoutBlocking: (
				input: Parameters<
					typeof original.recordPostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationWithoutBlocking
				>[0],
			) => {
				recordedPostDeployVerificationClosureObservations.push({
					observedFactKind: "closed_into_done_with_unchecked_items_reasoned",
					taskId: input.closedPostDeployVerificationTask.taskId,
					...input.completionEvidence,
				});
			},
		};
	},
);

// 所有进 Done 的入口共用的门禁（2026-10-11）：受门禁 = 在该 workspace 活跃部署组里等核对；全勾 → 通过；
// 未勾项必须逐项有原因 → 带原因结案（不写 verifiedAt）；「转为在自然使用中观察」的项生成待观察记录、保留资产。
describe.sequential("Post-Deploy Verification 移入 Done 门禁与结案", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	const NOW_ISO = "2026-10-11T12:00:00.000Z";
	const WORKSPACE_ID = "cline-kanban";

	beforeEach(() => {
		sandbox = createTempDir("kanban-done-entry-gate-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = sandbox.path;
		process.env.USERPROFILE = sandbox.path;
		recordedPostDeployVerificationClosureObservations.length = 0;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		sandbox.cleanup();
	});

	function buildItem(
		id: string,
		checked: boolean,
		overrides: Partial<RuntimePostDeployVerificationChecklistItem> = {},
	): RuntimePostDeployVerificationChecklistItem {
		return {
			id,
			label: `断言 ${id}`,
			checked,
			source: "authored",
			kind: "guided_manual",
			guidance: null,
			script: null,
			run: null,
			cleanup: null,
			...overrides,
		};
	}

	function buildTask(
		taskId: string,
		checklist: RuntimePostDeployVerificationChecklistItem[],
	): RuntimePostDeployVerificationTask {
		return {
			taskId,
			columnIdAtMatch: "validation",
			matchedCommits: [],
			inclusionReason: "validation_column",
			checklist,
			verifiedAt: null,
			boardMovedToDoneAt: null,
			pendingConfirmation: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: "task_commits_included_in_this_deployment_delta",
				matchedDeployedCommitsInThisDeploymentDelta: [],
				taskDeploymentUnattributableReason: null,
				attributionComputedAtIso: NOW_ISO,
			},
		};
	}

	function writeActiveGroup(tasks: RuntimePostDeployVerificationTask[]): string {
		const deploymentId = randomUUID();
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: WORKSPACE_ID,
					deployedSourceCommit: "b".repeat(40),
					previousDeployedSourceCommit: "a".repeat(40),
					deployedAtIso: NOW_ISO,
					foldedAtIso: null,
					tasks,
				},
			],
		};
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), JSON.stringify(state, null, 2), "utf8");
		return deploymentId;
	}

	function readTask(taskId: string): RuntimePostDeployVerificationTask | undefined {
		const state = JSON.parse(
			readFileSync(getPostDeployVerificationStatePath(), "utf8"),
		) as RuntimePostDeployVerificationState;
		return state.deploymentGroups.flatMap((group) => group.tasks).find((task) => task.taskId === taskId);
	}

	it("未勾项缺原因时拒绝并列出缺原因的项；不同 workspace 的同号任务不受门禁", async () => {
		writeActiveGroup([buildTask("t1", [buildItem("authored:a", true), buildItem("authored:b", false)])]);

		const rejected = await authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId: "t1",
			boardColumnIdOfTaskCardBeforeMove: "validation",
			postDeployVerificationDoneEntryClosure: undefined,
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			nowIso: NOW_ISO,
		});
		expect(rejected).toEqual({
			postDeployVerificationDoneEntryGateDecision:
				"move_into_done_rejected_because_unchecked_items_lack_closure_reasons",
			uncheckedChecklistItemsMissingClosureReason: [
				{ checklistItemId: "authored:b", checklistItemLabel: "断言 authored:b" },
			],
		});
		expect(readTask("t1")?.doneEntryClosureAuthorizationInFlight).toBeNull();

		const otherWorkspace = await authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: "another-project",
			taskId: "t1",
			boardColumnIdOfTaskCardBeforeMove: "validation",
			postDeployVerificationDoneEntryClosure: undefined,
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			nowIso: NOW_ISO,
		});
		expect(otherWorkspace.postDeployVerificationDoneEntryGateDecision).toBe(
			"task_not_subject_to_post_deploy_verification_done_entry_gate",
		);
	});

	it("带原因结案：逐项原因优先、其余套用统一原因；不写 verifiedAt；转观察的项生成待观察记录并保留资产，其余 automatic 资产清理", async () => {
		const deferredVerificationId = randomUUID();
		const tediousVerificationId = randomUUID();
		const deferredAssetsDir = await ensureVerificationAssetsDir(deferredVerificationId);
		const tediousAssetsDir = await ensureVerificationAssetsDir(tediousVerificationId);
		for (const verificationId of [deferredVerificationId, tediousVerificationId]) {
			await upsertAuthoredVerificationDefinition(
				{
					verificationId,
					workspaceId: WORKSPACE_ID,
					taskId: "t1",
					kind: "automated_script",
					label: `脚本 ${verificationId}`,
					guidance: null,
					script: { entrypoint: "run.js", interpreter: "node", timeoutMs: 60000 },
					cleanup: { mode: "automatic", assetsDir: null, manualSteps: [] },
					createdAtIso: NOW_ISO,
				},
				NOW_ISO,
			);
		}
		const automaticCleanup = { mode: "automatic" as const, assetsDir: null, manualSteps: [] };
		writeActiveGroup([
			buildTask("t1", [
				buildItem("authored:checked", true),
				buildItem(`authored:${deferredVerificationId}`, false, {
					kind: "automated_script",
					cleanup: automaticCleanup,
				}),
				buildItem(`authored:${tediousVerificationId}`, false, {
					kind: "automated_script",
					cleanup: automaticCleanup,
				}),
			]),
		]);

		const authorized = await authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId: "t1",
			boardColumnIdOfTaskCardBeforeMove: "validation",
			postDeployVerificationDoneEntryClosure: {
				uncheckedChecklistItemClosureReasons: [
					{
						checklistItemId: `authored:${deferredVerificationId}`,
						uncheckedChecklistItemClosureReasonCode:
							"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
						uncheckedChecklistItemClosureReasonText: "只在跨项目切换时偶发",
					},
				],
				closureReasonAppliedToRemainingUncheckedChecklistItems: {
					uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
				},
			},
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			nowIso: NOW_ISO,
		});
		expect(authorized).toEqual({
			postDeployVerificationDoneEntryGateDecision: "move_into_done_authorized_with_closure_authorization_in_flight",
			anticipatedPostDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
		});
		expect(readTask("t1")?.doneEntryClosureAuthorizationInFlight?.uncheckedChecklistItemClosureReasons).toHaveLength(
			2,
		);
		// 卡还没进 Done：整板保存兜底不挡已授权的卡。
		expect(
			await listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure({
				workspaceId: WORKSPACE_ID,
				taskIdsNewlyEnteringDone: ["t1"],
				nowIso: NOW_ISO,
			}),
		).toEqual(new Set());

		const outcome = await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId: "t1",
			nowIso: NOW_ISO,
		});
		expect(outcome).toBe("closed_into_done_with_unchecked_items_reasoned");
		const closedTask = readTask("t1");
		expect(closedTask?.verifiedAt).toBeNull();
		expect(closedTask?.doneEntryClosureAuthorizationInFlight).toBeNull();
		expect(closedTask?.postDeployVerificationClosure).toMatchObject({
			postDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
			taskDeploymentAttributionZoneAtClosure: "task_commits_included_in_this_deployment_delta",
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: `authored:${deferredVerificationId}`,
					uncheckedChecklistItemClosureReasonCode:
						"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
				},
				{
					checklistItemId: `authored:${tediousVerificationId}`,
					uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value",
				},
			],
		});
		expect(closedTask?.postDeployVerificationClosure?.deferredNaturalUsageObservationRecordIds).toHaveLength(1);

		const deferredRecords = await listPostDeployVerificationDeferredNaturalUsageObservationRecords(
			{ workspaceId: WORKSPACE_ID },
			NOW_ISO,
		);
		expect(deferredRecords).toEqual([
			expect.objectContaining({
				taskId: "t1",
				sourceAuthoredVerificationId: deferredVerificationId,
				deferralReasonText: "只在跨项目切换时偶发",
				retainedVerificationAssetsDirectory: deferredAssetsDir,
				naturalUsageObservationStatus: "awaiting_natural_usage_observation",
			}),
		]);
		expect(existsSync(deferredAssetsDir)).toBe(true);
		expect(existsSync(tediousAssetsDir)).toBe(false);
		expect(
			(await listAuthoredVerificationDefinitions({ workspaceId: WORKSPACE_ID }, NOW_ISO)).map(
				(definition) => definition.verificationId,
			),
		).toEqual([deferredVerificationId]);

		// 已结案：不再受门禁；重复结案不重复写。
		expect(evaluatePostDeployVerificationDoneEntryGateForTask(closedTask ?? null)).toBe(
			"task_not_subject_to_post_deploy_verification_done_entry_gate",
		);
		expect(
			await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
				workspaceId: WORKSPACE_ID,
				taskId: "t1",
				nowIso: NOW_ISO,
			}),
		).toBeNull();
	});

	it("全勾放行并结案为通过（写 verifiedAt）；移列失败撤销授权；未授权的受门禁卡被整板保存兜底挡回", async () => {
		writeActiveGroup([
			buildTask("all-checked", [buildItem("authored:a", true)]),
			buildTask("move-fails", [buildItem("authored:b", true)]),
			buildTask("unauthorized", [buildItem("authored:c", false)]),
		]);
		const authorizeAllChecked = (taskId: string) =>
			authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
				workspaceId: WORKSPACE_ID,
				taskId,
				boardColumnIdOfTaskCardBeforeMove: "validation",
				postDeployVerificationDoneEntryClosure: undefined,
				postDeployVerificationCompletionPath:
					"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
				nowIso: NOW_ISO,
			});

		expect(await authorizeAllChecked("all-checked")).toMatchObject({
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked",
		});
		expect(
			await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
				workspaceId: WORKSPACE_ID,
				taskId: "all-checked",
				nowIso: NOW_ISO,
			}),
		).toBe("all_checklist_items_checked");
		expect(readTask("all-checked")?.verifiedAt).toBe(NOW_ISO);

		await authorizeAllChecked("move-fails");
		expect(readTask("move-fails")?.doneEntryClosureAuthorizationInFlight).not.toBeNull();
		await revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed({
			workspaceId: WORKSPACE_ID,
			taskId: "move-fails",
			nowIso: NOW_ISO,
		});
		expect(readTask("move-fails")?.doneEntryClosureAuthorizationInFlight).toBeNull();

		expect(
			await listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure({
				workspaceId: WORKSPACE_ID,
				taskIdsNewlyEnteringDone: ["unauthorized", "all-checked", "not-in-any-group"],
				nowIso: NOW_ISO,
			}),
		).toEqual(new Set(["unauthorized"]));
	});

	const FIFTEEN_MINUTES_AFTER_NOW_ISO = "2026-10-11T12:15:00.000Z";
	const ONE_MINUTE_BEFORE_NOW_ISO = "2026-10-11T11:59:00.000Z";
	const DONE_ENTRY_GATE_COMPLETION_PATH =
		"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate";

	function buildKanbanCliInFlightCompletionRecord(input: {
		expiresAtIso: string;
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
	}): RuntimePostDeployVerificationPendingConfirmation {
		return {
			token: randomUUID(),
			expiresAtIso: input.expiresAtIso,
			requiredAcknowledgements: ["skip_validation"],
			columnIdAtIssuance: "review",
			kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
				authorizedAtIso: NOW_ISO,
				forcedCompletionWithoutAllVerificationsPassed:
					input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
					input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
			},
		};
	}

	it("整板保存兜底只认已核验且未过期的在途授权：普通待确认 token、过期或时间不可解析的授权一律挡回", async () => {
		const unchecked = () => [buildItem("authored:unchecked", false)];
		const unexpiredDoneEntryAuthorization = {
			authorizedAtIso: NOW_ISO,
			expiresAtIso: FIFTEEN_MINUTES_AFTER_NOW_ISO,
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked" as const,
			uncheckedChecklistItemClosureReasons: [],
			confirmedAcknowledgements: [],
			postDeployVerificationCompletionPath: DONE_ENTRY_GATE_COMPLETION_PATH,
		};
		writeActiveGroup([
			// requestVerificationComplete 在未全勾、原因还没给时也会发这种 token（例如用户打开原因对话框后取消）。
			{
				...buildTask("ordinary-confirmation-token", unchecked()),
				pendingConfirmation: {
					token: randomUUID(),
					expiresAtIso: FIFTEEN_MINUTES_AFTER_NOW_ISO,
					requiredAcknowledgements: [],
					columnIdAtIssuance: "validation",
				},
			},
			{
				...buildTask("unexpired-done-entry-authorization", unchecked()),
				doneEntryClosureAuthorizationInFlight: unexpiredDoneEntryAuthorization,
			},
			{
				...buildTask("expired-done-entry-authorization", unchecked()),
				doneEntryClosureAuthorizationInFlight: {
					...unexpiredDoneEntryAuthorization,
					expiresAtIso: ONE_MINUTE_BEFORE_NOW_ISO,
				},
			},
			{
				...buildTask("unparsable-done-entry-authorization-expiry", unchecked()),
				doneEntryClosureAuthorizationInFlight: {
					...unexpiredDoneEntryAuthorization,
					expiresAtIso: "not-an-iso-timestamp",
				},
			},
			{
				...buildTask("unexpired-kanban-cli-in-flight-completion-record", unchecked()),
				pendingConfirmation: buildKanbanCliInFlightCompletionRecord({
					expiresAtIso: FIFTEEN_MINUTES_AFTER_NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				}),
			},
			{
				...buildTask("expired-kanban-cli-in-flight-completion-record", unchecked()),
				pendingConfirmation: buildKanbanCliInFlightCompletionRecord({
					expiresAtIso: ONE_MINUTE_BEFORE_NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				}),
			},
		]);

		expect(
			await listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure({
				workspaceId: WORKSPACE_ID,
				taskIdsNewlyEnteringDone: [
					"ordinary-confirmation-token",
					"unexpired-done-entry-authorization",
					"expired-done-entry-authorization",
					"unparsable-done-entry-authorization-expiry",
					"unexpired-kanban-cli-in-flight-completion-record",
					"expired-kanban-cli-in-flight-completion-record",
				],
				nowIso: NOW_ISO,
			}),
		).toEqual(
			new Set([
				"ordinary-confirmation-token",
				"expired-done-entry-authorization",
				"unparsable-done-entry-authorization-expiry",
				"expired-kanban-cli-in-flight-completion-record",
			]),
		);
	});

	async function authorizeMoveIntoDone(
		taskId: string,
		postDeployVerificationDoneEntryClosure?: Parameters<
			typeof authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone
		>[0]["postDeployVerificationDoneEntryClosure"],
	) {
		return await authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId,
			boardColumnIdOfTaskCardBeforeMove: "validation",
			postDeployVerificationDoneEntryClosure,
			postDeployVerificationCompletionPath: DONE_ENTRY_GATE_COMPLETION_PATH,
			nowIso: NOW_ISO,
		});
	}

	async function finalizeMoveIntoDone(taskId: string) {
		return await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId,
			nowIso: NOW_ISO,
		});
	}

	it("全勾时授权、随后取消勾选或新增未勾项：结案不冒充通过，按「未经结案进 Done」标 moved_out_manually、不记账", async () => {
		const deploymentId = writeActiveGroup([
			buildTask("unchecked-after-authorization", [buildItem("a", true), buildItem("b", true)]),
			buildTask("item-added-after-authorization", [buildItem("authored:c", true)]),
		]);
		expect(await authorizeMoveIntoDone("unchecked-after-authorization")).toMatchObject({
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked",
		});
		expect(await authorizeMoveIntoDone("item-added-after-authorization")).toMatchObject({
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked",
		});
		expect(
			await updateTaskChecklist(
				{
					operation: "toggle_checklist_item",
					deploymentId,
					taskId: "unchecked-after-authorization",
					itemId: "a",
					checked: false,
				},
				NOW_ISO,
			),
		).toMatchObject({ ok: true });
		expect(
			await updateTaskChecklist(
				{
					operation: "add_custom_checklist_item",
					deploymentId,
					taskId: "item-added-after-authorization",
					label: "授权后新增的断言",
				},
				NOW_ISO,
			),
		).toMatchObject({ ok: true });

		for (const taskId of ["unchecked-after-authorization", "item-added-after-authorization"]) {
			expect(await finalizeMoveIntoDone(taskId)).toBeNull();
			expect(readTask(taskId)).toMatchObject({
				verifiedAt: null,
				postDeployVerificationClosure: null,
				doneEntryClosureAuthorizationInFlight: null,
				droppedReason: "moved_out_manually",
			});
		}
		expect(recordedPostDeployVerificationClosureObservations).toEqual([]);
	});

	it("带原因授权后 checklist 变了：按当前 checklist 能证明的事实结案（全勾 → 通过；仍覆盖 → 只带当前未勾项的原因；出现无原因未勾项 → 不结案）", async () => {
		const deploymentId = writeActiveGroup([
			buildTask("reasoned-then-fully-checked", [buildItem("a", true), buildItem("b", false)]),
			buildTask("reasoned-then-one-reason-no-longer-needed", [buildItem("c", false), buildItem("d", false)]),
			buildTask("reasoned-then-checked-item-unchecked", [buildItem("e", true), buildItem("f", false)]),
		]);
		const closureReasonAppliedToAllUnchecked = {
			closureReasonAppliedToRemainingUncheckedChecklistItems: {
				uncheckedChecklistItemClosureReasonCode: "manual_reproduction_cost_exceeds_verification_value" as const,
			},
		};
		for (const taskId of [
			"reasoned-then-fully-checked",
			"reasoned-then-one-reason-no-longer-needed",
			"reasoned-then-checked-item-unchecked",
		]) {
			expect(await authorizeMoveIntoDone(taskId, closureReasonAppliedToAllUnchecked)).toMatchObject({
				anticipatedPostDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
			});
		}
		const toggle = async (taskId: string, itemId: string, checked: boolean) =>
			expect(
				await updateTaskChecklist(
					{ operation: "toggle_checklist_item", deploymentId, taskId, itemId, checked },
					NOW_ISO,
				),
			).toMatchObject({ ok: true });
		await toggle("reasoned-then-fully-checked", "b", true);
		await toggle("reasoned-then-one-reason-no-longer-needed", "c", true);
		await toggle("reasoned-then-checked-item-unchecked", "e", false);

		expect(await finalizeMoveIntoDone("reasoned-then-fully-checked")).toBe("all_checklist_items_checked");
		expect(readTask("reasoned-then-fully-checked")).toMatchObject({
			verifiedAt: NOW_ISO,
			postDeployVerificationClosure: {
				postDeployVerificationClosureOutcome: "all_checklist_items_checked",
				uncheckedChecklistItemClosureReasons: [],
			},
		});

		expect(await finalizeMoveIntoDone("reasoned-then-one-reason-no-longer-needed")).toBe(
			"closed_into_done_with_unchecked_items_reasoned",
		);
		const partlyCheckedTask = readTask("reasoned-then-one-reason-no-longer-needed");
		expect(partlyCheckedTask?.verifiedAt).toBeNull();
		expect(
			partlyCheckedTask?.postDeployVerificationClosure?.uncheckedChecklistItemClosureReasons.map(
				(reason) => reason.checklistItemId,
			),
		).toEqual(["d"]);

		expect(await finalizeMoveIntoDone("reasoned-then-checked-item-unchecked")).toBeNull();
		expect(readTask("reasoned-then-checked-item-unchecked")).toMatchObject({
			verifiedAt: null,
			postDeployVerificationClosure: null,
			droppedReason: "moved_out_manually",
		});

		expect(
			recordedPostDeployVerificationClosureObservations.map((observation) => [
				observation.taskId,
				observation.observedFactKind,
			]),
		).toEqual([
			["reasoned-then-fully-checked", "passed"],
			["reasoned-then-one-reason-no-longer-needed", "closed_into_done_with_unchecked_items_reasoned"],
		]);
	});

	it("CLI 完成动词移入 Done：完成路径与 --force 由服务端据 CLI 在途完成记录推导并进账本，网页移入照旧记门禁路径", async () => {
		writeActiveGroup([
			{
				...buildTask("moved-by-kanban-cli-with-force", [buildItem("authored:a", true)]),
				pendingConfirmation: buildKanbanCliInFlightCompletionRecord({
					expiresAtIso: FIFTEEN_MINUTES_AFTER_NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				}),
			},
			{
				...buildTask("moved-by-kanban-cli-with-reasons", [buildItem("authored:b", false)]),
				pendingConfirmation: {
					...buildKanbanCliInFlightCompletionRecord({
						expiresAtIso: FIFTEEN_MINUTES_AFTER_NOW_ISO,
						confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
					}),
					// 旧 CLI 只写历史字段：同样认出 --force。
					kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
						authorizedAtIso: NOW_ISO,
						forcedCompletionWithoutAllVerificationsPassed: true,
					},
				},
			},
			buildTask("moved-from-web-ui", [buildItem("authored:c", true)]),
		]);

		await authorizeMoveIntoDone("moved-by-kanban-cli-with-force");
		expect(readTask("moved-by-kanban-cli-with-force")?.doneEntryClosureAuthorizationInFlight).toMatchObject({
			postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
		});
		await authorizeMoveIntoDone("moved-by-kanban-cli-with-reasons", {
			closureReasonAppliedToRemainingUncheckedChecklistItems: {
				uncheckedChecklistItemClosureReasonCode: "assertion_already_covered_by_other_verification_evidence",
			},
			confirmedAcknowledgements: ["skip_validation"],
		});
		await authorizeMoveIntoDone("moved-from-web-ui");

		expect(await finalizeMoveIntoDone("moved-by-kanban-cli-with-force")).toBe("all_checklist_items_checked");
		expect(await finalizeMoveIntoDone("moved-by-kanban-cli-with-reasons")).toBe(
			"closed_into_done_with_unchecked_items_reasoned",
		);
		expect(await finalizeMoveIntoDone("moved-from-web-ui")).toBe("all_checklist_items_checked");

		expect(readTask("moved-by-kanban-cli-with-force")).toMatchObject({
			pendingConfirmation: null,
			postDeployVerificationClosure: {
				postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
			},
		});
		expect(recordedPostDeployVerificationClosureObservations).toEqual([
			{
				observedFactKind: "passed",
				taskId: "moved-by-kanban-cli-with-force",
				postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				confirmedAcknowledgements: [],
			},
			{
				observedFactKind: "closed_into_done_with_unchecked_items_reasoned",
				taskId: "moved-by-kanban-cli-with-reasons",
				postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				confirmedAcknowledgements: ["skip_validation"],
			},
			{
				observedFactKind: "passed",
				taskId: "moved-from-web-ui",
				postDeployVerificationCompletionPath: DONE_ENTRY_GATE_COMPLETION_PATH,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				confirmedAcknowledgements: [],
			},
		]);
	});

	// ---- RVF-002：`kanban deployment record` 与移入 Done 并发 ----
	// record 先无锁读 state、组装延续副本（可能要跑好几秒 git），再进 state 锁写新组。两步之间门禁可能已在旧副本上写授权或结案。
	const NEW_DEPLOYMENT_RECORDED_AT_ISO = "2026-10-11T12:05:00.000Z";

	function readTaskInDeployment(deploymentId: string, taskId: string): RuntimePostDeployVerificationTask | undefined {
		const state = JSON.parse(
			readFileSync(getPostDeployVerificationStatePath(), "utf8"),
		) as RuntimePostDeployVerificationState;
		return state.deploymentGroups
			.find((group) => group.deploymentId === deploymentId)
			?.tasks.find((task) => task.taskId === taskId);
	}

	function buildAttributionComputation(
		zone:
			| "task_commits_included_in_this_deployment_delta"
			| "task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
	): TaskDeploymentAttributionComputation {
		return {
			taskDeploymentAttribution: {
				taskDeploymentAttributionZone: zone,
				matchedDeployedCommitsInThisDeploymentDelta: [],
				taskDeploymentUnattributableReason: null,
				attributionComputedAtIso: NOW_ISO,
			},
			firstDeployedInDeploymentId: null,
			firstDeployedAtIso: null,
			firstDeploymentPredatesRetainedDeploymentRecords: false,
		};
	}

	// 模拟 record 的无锁阶段：读一次盘上 state，把上一活跃组里的副本组装成延续副本。
	function assembleCarriedForwardTasksFromUnlockedPreRead(
		previousDeploymentId: string,
		newDeploymentId: string,
		attributionByTaskId: Record<string, TaskDeploymentAttributionComputation | null>,
	): RuntimePostDeployVerificationTask[] {
		return Object.entries(attributionByTaskId).map(([taskId, attribution]) => {
			const preReadCopy = readTaskInDeployment(previousDeploymentId, taskId);
			if (!preReadCopy) {
				throw new Error(`预读里找不到任务 ${taskId}`);
			}
			return assemblePostDeployVerificationTaskForDeploymentGroup({
				taskId,
				columnIdAtMatch: "validation",
				inclusionReason: "validation_column",
				deploymentId: newDeploymentId,
				unclosedTaskCarriedForwardFromPreviousActiveGroup: preReadCopy,
				authoredChecklistItems: [],
				taskDeploymentAttributionComputation: attribution,
				includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
			}).task;
		});
	}

	// 模拟 record 的锁内阶段：用预读时组装好的副本写新组。
	async function recordNewDeploymentGroupFromUnlockedPreRead(
		previousDeploymentId: string,
		newDeploymentId: string,
		tasksAssembledFromUnlockedPreRead: RuntimePostDeployVerificationTask[],
	): Promise<void> {
		await createDeploymentGroup(
			{
				deploymentId: newDeploymentId,
				workspaceId: WORKSPACE_ID,
				deployedSourceCommit: "c".repeat(40),
				previousDeployedSourceCommit: "b".repeat(40),
				sourceCheckoutPath: sandbox.path,
				packageVersion: "0.0.0-test",
				tasks: tasksAssembledFromUnlockedPreRead,
				previousActiveGroupDeploymentIdObservedByUnlockedPreReadByCarriedForwardTaskId: new Map(
					tasksAssembledFromUnlockedPreRead.map((task) => [task.taskId, previousDeploymentId]),
				),
			},
			NEW_DEPLOYMENT_RECORDED_AT_ISO,
		);
	}

	const authorizeWithoutClosureReasons = (taskId: string) =>
		authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone({
			workspaceId: WORKSPACE_ID,
			taskId,
			boardColumnIdOfTaskCardBeforeMove: "validation",
			postDeployVerificationDoneEntryClosure: undefined,
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
			nowIso: NOW_ISO,
		});

	it("竞态一：授权写在旧组之后 record 建了新组——授权与锁内勾选进度随延续进活跃组，对账不误标 moved_out_manually，finalize 在活跃组结案", async () => {
		const previousDeploymentId = writeActiveGroup([
			buildTask("t1", [buildItem("manual:a", false, { source: "custom" })]),
		]);
		const newDeploymentId = randomUUID();
		// record 无锁预读：此时 a 还没勾、也没有授权。
		const tasksAssembledFromUnlockedPreRead = assembleCarriedForwardTasksFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			{
				t1: null,
			},
		);
		// 预读之后：用户勾上 a，门禁放行、在（仍是活跃组的）旧组写下在途授权。
		await updateTaskChecklist(
			{
				deploymentId: previousDeploymentId,
				taskId: "t1",
				operation: "toggle_checklist_item",
				itemId: "manual:a",
				checked: true,
			},
			NOW_ISO,
		);
		expect(await authorizeWithoutClosureReasons("t1")).toMatchObject({
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked",
		});

		await recordNewDeploymentGroupFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			tasksAssembledFromUnlockedPreRead,
		);

		const carriedCopy = readTaskInDeployment(newDeploymentId, "t1");
		expect(carriedCopy?.checklist.map((item) => [item.id, item.checked])).toEqual([["manual:a", true]]);
		expect(carriedCopy?.doneEntryClosureAuthorizationInFlight?.anticipatedPostDeployVerificationClosureOutcome).toBe(
			"all_checklist_items_checked",
		);
		const previousCopy = readTaskInDeployment(previousDeploymentId, "t1");
		expect(previousCopy?.doneEntryClosureAuthorizationInFlight).toBeNull();
		expect(previousCopy?.carriedForwardIntoDeploymentId).toBe(newDeploymentId);

		// 卡已移入 Done、finalize 还没跑时轮询对账：活跃组副本带着在途授权，不算手动移出。
		await reconcileGroup({
			deploymentId: newDeploymentId,
			workspaceId: WORKSPACE_ID,
			currentBoardTasks: [{ taskId: "t1", columnId: "trash" }],
			nowIso: NEW_DEPLOYMENT_RECORDED_AT_ISO,
		});
		expect(readTaskInDeployment(newDeploymentId, "t1")?.droppedReason).toBeNull();

		expect(
			await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
				workspaceId: WORKSPACE_ID,
				taskId: "t1",
				nowIso: NEW_DEPLOYMENT_RECORDED_AT_ISO,
			}),
		).toBe("all_checklist_items_checked");
		expect(readTaskInDeployment(newDeploymentId, "t1")?.verifiedAt).toBe(NEW_DEPLOYMENT_RECORDED_AT_ISO);
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.verifiedAt).toBeNull();
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.postDeployVerificationClosure).toBeNull();
	});

	it("竞态二：record 无锁读到仍等核对、之后门禁在旧组完成结案——不再以等核对延续：本次区间命中的改只读展示、其余不纳入，结案留在旧组", async () => {
		const previousDeploymentId = writeActiveGroup([
			buildTask("shipped-in-new-deployment", [buildItem("authored:a", true)]),
			buildTask("shipped-in-earlier-deployment", [buildItem("authored:b", true)]),
		]);
		const newDeploymentId = randomUUID();
		const tasksAssembledFromUnlockedPreRead = assembleCarriedForwardTasksFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			{
				"shipped-in-new-deployment": buildAttributionComputation("task_commits_included_in_this_deployment_delta"),
				"shipped-in-earlier-deployment": buildAttributionComputation(
					"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
				),
			},
		);
		for (const taskId of ["shipped-in-new-deployment", "shipped-in-earlier-deployment"]) {
			await authorizeWithoutClosureReasons(taskId);
			expect(
				await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
					workspaceId: WORKSPACE_ID,
					taskId,
					nowIso: NOW_ISO,
				}),
			).toBe("all_checklist_items_checked");
		}

		await recordNewDeploymentGroupFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			tasksAssembledFromUnlockedPreRead,
		);

		const shippedHereCopy = readTaskInDeployment(newDeploymentId, "shipped-in-new-deployment");
		expect(shippedHereCopy).toMatchObject({
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true,
			verifiedAt: null,
			postDeployVerificationClosure: null,
		});
		expect(readTaskInDeployment(newDeploymentId, "shipped-in-earlier-deployment")).toBeUndefined();
		for (const taskId of ["shipped-in-new-deployment", "shipped-in-earlier-deployment"]) {
			const previousCopy = readTaskInDeployment(previousDeploymentId, taskId);
			expect(previousCopy?.verifiedAt).toBe(NOW_ISO);
			expect(previousCopy?.carriedForwardIntoDeploymentId).toBeNull();
		}

		await reconcileGroup({
			deploymentId: newDeploymentId,
			workspaceId: WORKSPACE_ID,
			currentBoardTasks: [
				{ taskId: "shipped-in-new-deployment", columnId: "trash" },
				{ taskId: "shipped-in-earlier-deployment", columnId: "trash" },
			],
			nowIso: NEW_DEPLOYMENT_RECORDED_AT_ISO,
		});
		expect(readTaskInDeployment(newDeploymentId, "shipped-in-new-deployment")?.droppedReason).toBeNull();
		expect(
			await listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure({
				workspaceId: WORKSPACE_ID,
				taskIdsNewlyEnteringDone: ["shipped-in-new-deployment", "shipped-in-earlier-deployment"],
				nowIso: NEW_DEPLOYMENT_RECORDED_AT_ISO,
			}),
		).toEqual(new Set());
	});

	it("CLI 在途完成记录随延续进活跃组；CLI 用旧 deploymentId 补记结案时沿延续链幂等命中，不在折叠旧副本上再结案一次", async () => {
		const previousDeploymentId = writeActiveGroup([buildTask("t1", [buildItem("authored:a", true)])]);
		const newDeploymentId = randomUUID();
		const tasksAssembledFromUnlockedPreRead = assembleCarriedForwardTasksFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			{
				t1: null,
			},
		);
		await setPendingConfirmation(
			previousDeploymentId,
			"t1",
			{
				token: "cli-in-flight-completion-token",
				expiresAtIso: "2026-10-11T12:15:00.000Z",
				requiredAcknowledgements: [],
				columnIdAtIssuance: "validation",
				kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
					authorizedAtIso: NOW_ISO,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
					uncheckedChecklistItemClosureReasons: [],
				},
			},
			NOW_ISO,
		);
		await authorizeWithoutClosureReasons("t1");

		await recordNewDeploymentGroupFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			tasksAssembledFromUnlockedPreRead,
		);
		expect(
			readTaskInDeployment(newDeploymentId, "t1")?.pendingConfirmation
				?.kanbanCliCompletionAuthorizedBeforeMoveIntoDone,
		).toBeDefined();
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.pendingConfirmation).toBeNull();

		expect(
			await finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone({
				workspaceId: WORKSPACE_ID,
				taskId: "t1",
				nowIso: NEW_DEPLOYMENT_RECORDED_AT_ISO,
			}),
		).toBe("all_checklist_items_checked");
		const marked = await markTaskVerified(previousDeploymentId, "t1", "2026-10-11T12:06:00.000Z");
		expect(marked.ok).toBe(true);
		expect(marked.task?.verifiedAt).toBe(NEW_DEPLOYMENT_RECORDED_AT_ISO);
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.verifiedAt).toBeNull();
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.postDeployVerificationClosure).toBeNull();
	});

	it("面板发的待确认 token 随延续进活跃组；用旧 deploymentId confirm 时沿延续链在活跃组副本上消费并结案", async () => {
		const previousDeploymentId = writeActiveGroup([buildTask("t1", [buildItem("authored:a", true)])]);
		const newDeploymentId = randomUUID();
		const tasksAssembledFromUnlockedPreRead = assembleCarriedForwardTasksFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			{
				t1: null,
			},
		);
		await setPendingConfirmation(
			previousDeploymentId,
			"t1",
			{
				token: "web-panel-token",
				expiresAtIso: "2026-10-11T12:15:00.000Z",
				requiredAcknowledgements: [],
				columnIdAtIssuance: "validation",
			},
			NOW_ISO,
		);
		await recordNewDeploymentGroupFromUnlockedPreRead(
			previousDeploymentId,
			newDeploymentId,
			tasksAssembledFromUnlockedPreRead,
		);

		const consumed = await consumePendingConfirmationAndMarkVerified(
			previousDeploymentId,
			"t1",
			"web-panel-token",
			NEW_DEPLOYMENT_RECORDED_AT_ISO,
		);
		expect(consumed).toMatchObject({ ok: true });
		expect(readTaskInDeployment(newDeploymentId, "t1")?.verifiedAt).toBe(NEW_DEPLOYMENT_RECORDED_AT_ISO);
		expect(readTaskInDeployment(newDeploymentId, "t1")?.pendingConfirmation).toBeNull();
		expect(readTaskInDeployment(previousDeploymentId, "t1")?.verifiedAt).toBeNull();
	});
});
