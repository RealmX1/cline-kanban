import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
} from "../../../src/core/api-contract";
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	getActiveGroup,
	getPostDeployVerificationStatePath,
	type ReconcileGroupBoardTask,
	reconcileGroup,
	reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups,
} from "../../../src/deployment/post-deploy-verification-state";
import type * as PostDeployVerificationPassedObservationRecordingModule from "../../../src/inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";

// RVF-004 遗留：CLI 已授权并把卡移入 Done，补写 verifiedAt 的 runtime 调用却失败、又没人在 15 分钟内重跑命令。
// runtime 的 PDV 状态轮询凭 CLI 移列前写下的「已授权」在途完成记录自行补写；普通待确认 token 的行为不变。
// RVF-002：补写覆盖该 workspace 的全部部署组（活跃 + 已被新部署折叠），且没有活跃组时同样进行。

const recordedPostDeployVerificationPassedObservations = vi.hoisted(
	() =>
		[] as Array<{
			taskId: string;
			deploymentId: string;
			workspaceId: string;
			deployedSourceCommit: string;
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
				recordedPostDeployVerificationPassedObservations.push({
					taskId: input.verifiedPostDeployVerificationTask.taskId,
					deploymentId: input.deploymentId,
					workspaceId: input.workspaceId,
					deployedSourceCommit: input.deployedSourceCommit,
					...input.completionEvidence,
				});
			},
		};
	},
);

const NOW_ISO = "2026-06-01T00:10:00.000Z";
const AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO = "2026-06-01T00:08:00.000Z";
const AUTHORIZED_TEN_SECONDS_BEFORE_NOW_ISO = "2026-06-01T00:09:50.000Z";
const ALREADY_EXPIRED_ISO = "2026-06-01T00:05:00.000Z";
const NOT_YET_EXPIRED_ISO = "2026-06-01T00:24:50.000Z";
const FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT = "a".repeat(40);
const ACTIVE_GROUP_DEPLOYED_SOURCE_COMMIT = "b".repeat(40);
const RUNTIME_FINALIZATION_COMPLETION_PATH =
	"kanban_runtime_reconciliation_finalizing_kanban_cli_completion_authorized_but_left_in_flight";

function buildTask(
	taskId: string,
	pendingConfirmation: RuntimePostDeployVerificationPendingConfirmation | null,
): RuntimePostDeployVerificationTask {
	return {
		taskId,
		columnIdAtMatch: "review",
		matchedCommits: [],
		inclusionReason: "commit_correlation",
		checklist: [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation,
		droppedReason: null,
		...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
	};
}

function buildKanbanCliInFlightCompletionRecord(input: {
	authorizedAtIso: string;
	expiresAtIso: string;
}): RuntimePostDeployVerificationPendingConfirmation {
	return {
		token: randomUUID(),
		expiresAtIso: input.expiresAtIso,
		requiredAcknowledgements: ["skip_validation"],
		columnIdAtIssuance: "review",
		kanbanCliCompletionAuthorizedBeforeMoveIntoDone: {
			authorizedAtIso: input.authorizedAtIso,
			forcedCompletionWithoutAllVerificationsPassed: true,
		},
	};
}

// 已被后一次部署折叠的旧组（foldedAtIso 已置位）。
function buildFoldedDeploymentGroup(
	deploymentId: string,
	tasks: RuntimePostDeployVerificationTask[],
): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId,
		workspaceId: "ws-1",
		deployedSourceCommit: FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT,
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-06-01T00:00:00.000Z",
		foldedAtIso: "2026-06-01T00:09:00.000Z",
		tasks,
	};
}

function buildActiveDeploymentGroup(
	deploymentId: string,
	tasks: RuntimePostDeployVerificationTask[],
): RuntimePostDeployVerificationDeploymentGroup {
	return {
		deploymentId,
		workspaceId: "ws-1",
		deployedSourceCommit: ACTIVE_GROUP_DEPLOYED_SOURCE_COMMIT,
		previousDeployedSourceCommit: FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT,
		deployedAtIso: "2026-06-01T00:09:00.000Z",
		foldedAtIso: null,
		tasks,
	};
}

describe.sequential("runtime finalization of authorized Kanban CLI completions left in flight", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-post-deploy-verification-cli-completion-left-in-flight-");
		previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
		recordedPostDeployVerificationPassedObservations.length = 0;
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		sandbox.cleanup();
	});

	function writeStateWithDeploymentGroups(deploymentGroups: RuntimePostDeployVerificationDeploymentGroup[]): void {
		const state: RuntimePostDeployVerificationState = { deploymentGroups };
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), JSON.stringify(state, null, 2), "utf8");
	}

	function writeStateWithTasks(deploymentId: string, tasks: RuntimePostDeployVerificationTask[]): void {
		writeStateWithDeploymentGroups([
			{
				deploymentId,
				workspaceId: "ws-1",
				deployedSourceCommit: FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT,
				previousDeployedSourceCommit: null,
				deployedAtIso: "2026-06-01T00:00:00.000Z",
				foldedAtIso: null,
				tasks,
			},
		]);
	}

	function readTaskInDeploymentGroup(
		deploymentId: string,
		taskId: string,
	): RuntimePostDeployVerificationTask | undefined {
		const state = JSON.parse(
			readFileSync(getPostDeployVerificationStatePath(), "utf8"),
		) as RuntimePostDeployVerificationState;
		return state.deploymentGroups
			.find((group) => group.deploymentId === deploymentId)
			?.tasks.find((task) => task.taskId === taskId);
	}

	// 与 deployment-api 的 getPostDeployVerificationState 每次轮询的顺序一致：先对活跃组 reconcileGroup，再跨全部组补写。
	async function runRuntimePostDeployVerificationStatePollingReconciliation(input: {
		activeDeploymentId: string | null;
		currentBoardTasks: ReconcileGroupBoardTask[];
	}): Promise<void> {
		if (input.activeDeploymentId !== null) {
			await reconcileGroup({
				deploymentId: input.activeDeploymentId,
				workspaceId: "ws-1",
				currentBoardTasks: input.currentBoardTasks,
				nowIso: NOW_ISO,
			});
		}
		await reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups({
			workspaceId: "ws-1",
			currentBoardTasks: input.currentBoardTasks,
			nowIso: NOW_ISO,
		});
	}

	it("finalizes an authorized completion already in Done after the grace period even though its record expired, and records it as runtime reconciliation", async () => {
		const deploymentId = randomUUID();
		writeStateWithTasks(deploymentId, [
			buildTask(
				"authorized-in-done",
				buildKanbanCliInFlightCompletionRecord({
					authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
					expiresAtIso: ALREADY_EXPIRED_ISO,
				}),
			),
		]);
		// 普通读取会做过期回收：已授权的在途记录必须熬过它。
		await getActiveGroup("ws-1", NOW_ISO);
		expect(readTaskInDeploymentGroup(deploymentId, "authorized-in-done")?.pendingConfirmation).not.toBeNull();

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId: deploymentId,
			currentBoardTasks: [{ taskId: "authorized-in-done", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(deploymentId, "authorized-in-done")).toMatchObject({
			verifiedAt: NOW_ISO,
			boardMovedToDoneAt: NOW_ISO,
			pendingConfirmation: null,
			droppedReason: null,
			postDeployVerificationClosure: expect.objectContaining({
				postDeployVerificationClosureOutcome: "all_checklist_items_checked",
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
			}),
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([
			{
				taskId: "authorized-in-done",
				deploymentId,
				workspaceId: "ws-1",
				deployedSourceCommit: FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT,
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				confirmedAcknowledgements: ["skip_validation"],
			},
		]);
	});

	it("leaves the CLI its own window inside the grace period", async () => {
		const deploymentId = randomUUID();
		writeStateWithTasks(deploymentId, [
			buildTask(
				"authorized-just-now",
				buildKanbanCliInFlightCompletionRecord({
					authorizedAtIso: AUTHORIZED_TEN_SECONDS_BEFORE_NOW_ISO,
					expiresAtIso: NOT_YET_EXPIRED_ISO,
				}),
			),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId: deploymentId,
			currentBoardTasks: [{ taskId: "authorized-just-now", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(deploymentId, "authorized-just-now")).toMatchObject({
			verifiedAt: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
		});
		expect(readTaskInDeploymentGroup(deploymentId, "authorized-just-now")?.pendingConfirmation).not.toBeNull();
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	it("drops an expired authorized record whose card never reached Done, without verifying it", async () => {
		const deploymentId = randomUUID();
		writeStateWithTasks(deploymentId, [
			buildTask(
				"authorized-but-move-failed",
				buildKanbanCliInFlightCompletionRecord({
					authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
					expiresAtIso: ALREADY_EXPIRED_ISO,
				}),
			),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId: deploymentId,
			currentBoardTasks: [{ taskId: "authorized-but-move-failed", columnId: "review" }],
		});

		expect(readTaskInDeploymentGroup(deploymentId, "authorized-but-move-failed")).toMatchObject({
			verifiedAt: null,
			pendingConfirmation: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	it("never treats an ordinary confirmation token as authorization, even when its card sits in Done", async () => {
		const deploymentId = randomUUID();
		writeStateWithTasks(deploymentId, [
			buildTask("token-not-yet-confirmed", {
				token: randomUUID(),
				expiresAtIso: ALREADY_EXPIRED_ISO,
				requiredAcknowledgements: ["skip_validation"],
				columnIdAtIssuance: "review",
			}),
		]);

		// 原有行为：第一次 reconcile 时 token 仍在（过期回收在写盘前归一化里做），第二次才按手动移出处理。
		for (let reconcilePass = 0; reconcilePass < 2; reconcilePass += 1) {
			await runRuntimePostDeployVerificationStatePollingReconciliation({
				activeDeploymentId: deploymentId,
				currentBoardTasks: [{ taskId: "token-not-yet-confirmed", columnId: "trash" }],
			});
		}

		expect(readTaskInDeploymentGroup(deploymentId, "token-not-yet-confirmed")).toMatchObject({
			verifiedAt: null,
			pendingConfirmation: null,
			droppedReason: "moved_out_manually",
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	it("finalizes an authorized completion whose deployment group was folded by a newer deployment, recording it against the folded group's own deployment", async () => {
		const foldedDeploymentId = randomUUID();
		const activeDeploymentId = randomUUID();
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				buildTask(
					"authorized-in-done-in-folded-group",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
						expiresAtIso: ALREADY_EXPIRED_ISO,
					}),
				),
			]),
			buildActiveDeploymentGroup(activeDeploymentId, []),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId,
			currentBoardTasks: [{ taskId: "authorized-in-done-in-folded-group", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(foldedDeploymentId, "authorized-in-done-in-folded-group")).toMatchObject({
			verifiedAt: NOW_ISO,
			boardMovedToDoneAt: NOW_ISO,
			pendingConfirmation: null,
			droppedReason: null,
			postDeployVerificationClosure: expect.objectContaining({
				postDeployVerificationClosureOutcome: "all_checklist_items_checked",
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
			}),
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([
			{
				taskId: "authorized-in-done-in-folded-group",
				deploymentId: foldedDeploymentId,
				workspaceId: "ws-1",
				deployedSourceCommit: FOLDED_GROUP_DEPLOYED_SOURCE_COMMIT,
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				confirmedAcknowledgements: ["skip_validation"],
			},
		]);
	});

	it("drops expired authorized records in a folded group whose card never reached Done or is gone from the board, without verifying them", async () => {
		const foldedDeploymentId = randomUUID();
		const activeDeploymentId = randomUUID();
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				buildTask(
					"authorized-but-move-failed-in-folded-group",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
						expiresAtIso: ALREADY_EXPIRED_ISO,
					}),
				),
				buildTask(
					"authorized-but-card-deleted-in-folded-group",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
						expiresAtIso: ALREADY_EXPIRED_ISO,
					}),
				),
			]),
			buildActiveDeploymentGroup(activeDeploymentId, []),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId,
			currentBoardTasks: [{ taskId: "authorized-but-move-failed-in-folded-group", columnId: "review" }],
		});

		for (const taskId of [
			"authorized-but-move-failed-in-folded-group",
			"authorized-but-card-deleted-in-folded-group",
		]) {
			expect(readTaskInDeploymentGroup(foldedDeploymentId, taskId)).toMatchObject({
				verifiedAt: null,
				boardMovedToDoneAt: null,
				pendingConfirmation: null,
			});
		}
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	it("finalizes authorized completions left in flight even when the workspace has no active deployment group", async () => {
		const foldedDeploymentId = randomUUID();
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				buildTask(
					"authorized-in-done-without-active-group",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
						expiresAtIso: ALREADY_EXPIRED_ISO,
					}),
				),
			]),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId: null,
			currentBoardTasks: [{ taskId: "authorized-in-done-without-active-group", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(foldedDeploymentId, "authorized-in-done-without-active-group")).toMatchObject({
			verifiedAt: NOW_ISO,
			pendingConfirmation: null,
			droppedReason: null,
			postDeployVerificationClosure: expect.objectContaining({
				postDeployVerificationClosureOutcome: "all_checklist_items_checked",
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
			}),
		});
		expect(recordedPostDeployVerificationPassedObservations.map((observation) => observation.deploymentId)).toEqual([
			foldedDeploymentId,
		]);
	});

	it("leaves an ordinary confirmation token in a folded group untouched", async () => {
		const foldedDeploymentId = randomUUID();
		const activeDeploymentId = randomUUID();
		const ordinaryConfirmationToken = randomUUID();
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				buildTask("ordinary-token-in-folded-group", {
					token: ordinaryConfirmationToken,
					expiresAtIso: NOT_YET_EXPIRED_ISO,
					requiredAcknowledgements: ["skip_validation"],
					columnIdAtIssuance: "review",
				}),
			]),
			buildActiveDeploymentGroup(activeDeploymentId, []),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId,
			currentBoardTasks: [{ taskId: "ordinary-token-in-folded-group", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(foldedDeploymentId, "ordinary-token-in-folded-group")).toMatchObject({
			verifiedAt: null,
			boardMovedToDoneAt: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
			pendingConfirmation: { token: ordinaryConfirmationToken },
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	it("never records a runtime finalization for a folded group that the same write trims away by folded-group retention", async () => {
		const trimmedFoldedDeploymentId = randomUUID();
		const newerFoldedDeploymentGroups = Array.from({ length: 20 }, (_, index) => ({
			...buildFoldedDeploymentGroup(randomUUID(), []),
			deployedAtIso: new Date(Date.parse("2026-06-01T00:01:00.000Z") + index * 1000).toISOString(),
		}));
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(trimmedFoldedDeploymentId, [
				buildTask(
					"authorized-in-done-in-trimmed-folded-group",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
						expiresAtIso: ALREADY_EXPIRED_ISO,
					}),
				),
			]),
			...newerFoldedDeploymentGroups,
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId: null,
			currentBoardTasks: [{ taskId: "authorized-in-done-in-trimmed-folded-group", columnId: "trash" }],
		});

		expect(readTaskInDeploymentGroup(trimmedFoldedDeploymentId, "authorized-in-done-in-trimmed-folded-group")).toBe(
			undefined,
		);
		expect(recordedPostDeployVerificationPassedObservations).toEqual([]);
	});

	// 授权写下后 checklist 仍可被改：对账补完按当前 checklist 重新核验，证明不了任何结局的不冒充通过、也不再永远卡在待核对。
	it("re-verifies authorizations left in flight against the current checklist and settles unprovable ones as moved out manually instead of leaving them stuck", async () => {
		const foldedDeploymentId = randomUUID();
		const activeDeploymentId = randomUUID();
		const uncheckedGuidedManualItem = {
			id: "unchecked-after-authorization",
			label: "授权后被取消勾选的断言",
			checked: false,
			source: "authored" as const,
			kind: "guided_manual" as const,
			guidance: null,
			script: null,
			run: null,
			cleanup: null,
		};
		const doneEntryAuthorizationAnticipatingPass = {
			authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
			expiresAtIso: NOT_YET_EXPIRED_ISO,
			anticipatedPostDeployVerificationClosureOutcome: "all_checklist_items_checked" as const,
			uncheckedChecklistItemClosureReasons: [],
			confirmedAcknowledgements: [],
			postDeployVerificationCompletionPath:
				"kanban_runtime_task_card_action_move_into_done_through_post_deploy_verification_done_entry_gate",
		};
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				{
					...buildTask(
						"kanban-cli-record-whose-reasons-no-longer-cover",
						buildKanbanCliInFlightCompletionRecord({
							authorizedAtIso: AUTHORIZED_TWO_MINUTES_BEFORE_NOW_ISO,
							expiresAtIso: ALREADY_EXPIRED_ISO,
						}),
					),
					checklist: [uncheckedGuidedManualItem],
				},
				{
					...buildTask("done-entry-authorization-whose-checklist-changed", null),
					checklist: [uncheckedGuidedManualItem],
					doneEntryClosureAuthorizationInFlight: doneEntryAuthorizationAnticipatingPass,
				},
			]),
			buildActiveDeploymentGroup(activeDeploymentId, [
				{
					...buildTask("done-entry-authorization-from-kanban-cli-with-force", null),
					doneEntryClosureAuthorizationInFlight: {
						...doneEntryAuthorizationAnticipatingPass,
						confirmedAcknowledgements: ["skip_validation"],
						postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
						confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
					},
				},
			]),
		]);

		await runRuntimePostDeployVerificationStatePollingReconciliation({
			activeDeploymentId,
			currentBoardTasks: [
				{ taskId: "kanban-cli-record-whose-reasons-no-longer-cover", columnId: "trash" },
				{ taskId: "done-entry-authorization-whose-checklist-changed", columnId: "trash" },
				{ taskId: "done-entry-authorization-from-kanban-cli-with-force", columnId: "trash" },
			],
		});

		for (const taskId of [
			"kanban-cli-record-whose-reasons-no-longer-cover",
			"done-entry-authorization-whose-checklist-changed",
		]) {
			expect(readTaskInDeploymentGroup(foldedDeploymentId, taskId)).toMatchObject({
				verifiedAt: null,
				postDeployVerificationClosure: null,
				pendingConfirmation: null,
				doneEntryClosureAuthorizationInFlight: null,
				droppedReason: "moved_out_manually",
			});
		}
		expect(
			readTaskInDeploymentGroup(activeDeploymentId, "done-entry-authorization-from-kanban-cli-with-force"),
		).toMatchObject({
			verifiedAt: NOW_ISO,
			postDeployVerificationClosure: expect.objectContaining({
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
			}),
		});
		expect(recordedPostDeployVerificationPassedObservations).toEqual([
			{
				taskId: "done-entry-authorization-from-kanban-cli-with-force",
				deploymentId: activeDeploymentId,
				workspaceId: "ws-1",
				deployedSourceCommit: ACTIVE_GROUP_DEPLOYED_SOURCE_COMMIT,
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				confirmedAcknowledgements: ["skip_validation"],
			},
		]);
	});

	it("is driven by every getPostDeployVerificationState poll, including when the workspace has no active deployment group", async () => {
		const foldedDeploymentId = randomUUID();
		const realNowMs = Date.now();
		writeStateWithDeploymentGroups([
			buildFoldedDeploymentGroup(foldedDeploymentId, [
				buildTask(
					"authorized-in-done-seen-by-runtime-poll",
					buildKanbanCliInFlightCompletionRecord({
						authorizedAtIso: new Date(realNowMs - 2 * 60_000).toISOString(),
						expiresAtIso: new Date(realNowMs - 60_000).toISOString(),
					}),
				),
			]),
		]);
		const deploymentApi = createDeploymentApi({
			loadBoardTasksForWorkspace: async () => [
				{ taskId: "authorized-in-done-seen-by-runtime-poll", columnId: "trash" },
			],
			loadTaskAgentResponsePreview: async () => null,
		});

		const response = await deploymentApi.getPostDeployVerificationState(
			{ workspaceId: "ws-1", workspacePath: "/tmp/ws-1" },
			{},
		);

		expect(response.activeDeploymentId).toBeNull();
		const finalizedTask = response.deploymentGroups
			.find((group) => group.deploymentId === foldedDeploymentId)
			?.tasks.find((task) => task.taskId === "authorized-in-done-seen-by-runtime-poll");
		expect(finalizedTask?.verifiedAt).not.toBeNull();
		expect(finalizedTask?.pendingConfirmation).toBeNull();
		expect(recordedPostDeployVerificationPassedObservations).toMatchObject([
			{
				taskId: "authorized-in-done-seen-by-runtime-poll",
				deploymentId: foldedDeploymentId,
				postDeployVerificationCompletionPath: RUNTIME_FINALIZATION_COMPLETION_PATH,
			},
		]);
	});
});
