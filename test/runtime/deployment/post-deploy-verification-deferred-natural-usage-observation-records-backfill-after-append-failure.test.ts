import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
} from "../../../src/core/api-contract";
import {
	getPostDeployVerificationDeferredNaturalUsageObservationRecordsPath,
	listPostDeployVerificationDeferredNaturalUsageObservationRecords,
} from "../../../src/deployment/post-deploy-verification-deferred-natural-usage-observation-records";
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import {
	getPostDeployVerificationStatePath,
	markTaskVerified,
} from "../../../src/deployment/post-deploy-verification-state";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";

// RVF-004：带原因结案在状态锁内持久化并引用了待观察记录 id，锁外 append 待观察记录却失败（只告警）。
// 之后的结案路径都跳过已结案任务，所以由 runtime 的 PDV 状态轮询对账按结案快照补写，且补写幂等。
describe.sequential("带原因结案后写待观察记录失败，由 runtime 对账补写", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	const NOW_ISO = "2026-10-11T12:00:00.000Z";
	const LATER_POLL_ISO = "2026-10-11T12:00:30.000Z";
	const WORKSPACE_ID = "ws-1";
	const DEPLOYED_SOURCE_COMMIT = "b".repeat(40);

	beforeEach(() => {
		sandbox = createTempDir("kanban-deferred-observation-records-backfill-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = sandbox.path;
		process.env.USERPROFILE = sandbox.path;
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

	function buildTaskWithOneUncheckedAuthoredItem(
		taskId: string,
		verificationId: string,
	): RuntimePostDeployVerificationTask {
		return {
			taskId,
			columnIdAtMatch: "validation",
			matchedCommits: [],
			inclusionReason: "validation_column",
			checklist: [
				{
					id: `authored:${verificationId}`,
					label: "只在跨项目切换时偶发的断言",
					checked: false,
					source: "authored",
					kind: "guided_manual",
					guidance: null,
					script: null,
					run: null,
					cleanup: { mode: "manual", assetsDir: null, manualSteps: [] },
				},
			],
			verifiedAt: null,
			boardMovedToDoneAt: null,
			pendingConfirmation: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
		};
	}

	function readClosedTask(taskId: string): RuntimePostDeployVerificationTask | undefined {
		const state = JSON.parse(
			readFileSync(getPostDeployVerificationStatePath(), "utf8"),
		) as RuntimePostDeployVerificationState;
		return state.deploymentGroups.flatMap((group) => group.tasks).find((task) => task.taskId === taskId);
	}

	it("注入一次 append 失败：结案照常持久化、记录缺失；下一轮对账补写，再一轮不重复", async () => {
		const deploymentId = randomUUID();
		const verificationId = randomUUID();
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: WORKSPACE_ID,
					deployedSourceCommit: DEPLOYED_SOURCE_COMMIT,
					previousDeployedSourceCommit: "a".repeat(40),
					deployedAtIso: NOW_ISO,
					foldedAtIso: null,
					tasks: [buildTaskWithOneUncheckedAuthoredItem("t1", verificationId)],
				},
			],
		};
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), JSON.stringify(state, null, 2), "utf8");

		// 注入暂时的写失败：记录文件路径被一个目录占着，读改写读到 EISDIR 抛错。
		const deferredRecordsPath = getPostDeployVerificationDeferredNaturalUsageObservationRecordsPath();
		mkdirSync(deferredRecordsPath, { recursive: true });

		const closed = await markTaskVerified(
			deploymentId,
			"t1",
			NOW_ISO,
			{
				postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				confirmedAcknowledgements: [],
			},
			[
				{
					checklistItemId: `authored:${verificationId}`,
					uncheckedChecklistItemClosureReasonCode:
						"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
					uncheckedChecklistItemClosureReasonText: "只在跨项目切换时偶发",
				},
			],
		);
		expect(closed.ok).toBe(true);
		const referencedRecordIds =
			readClosedTask("t1")?.postDeployVerificationClosure?.deferredNaturalUsageObservationRecordIds ?? [];
		expect(referencedRecordIds).toHaveLength(1);

		// 失败解除，但结案路径不会再 append：记录仍然缺失。
		rmSync(deferredRecordsPath, { recursive: true, force: true });
		expect(await listPostDeployVerificationDeferredNaturalUsageObservationRecords({}, NOW_ISO)).toEqual([]);

		const deploymentApi = createDeploymentApi({
			loadBoardTasksForWorkspace: async () => [{ taskId: "t1", columnId: "trash" }],
			loadTaskAgentResponsePreview: async () => null,
		});
		await deploymentApi.getPostDeployVerificationState({ workspaceId: WORKSPACE_ID, workspacePath: "/tmp/ws-1" }, {});

		const backfilledRecords = await listPostDeployVerificationDeferredNaturalUsageObservationRecords(
			{ workspaceId: WORKSPACE_ID },
			LATER_POLL_ISO,
		);
		expect(backfilledRecords).toEqual([
			expect.objectContaining({
				deferredNaturalUsageObservationRecordId: referencedRecordIds[0],
				taskId: "t1",
				sourceDeploymentId: deploymentId,
				sourceDeployedSourceCommit: DEPLOYED_SOURCE_COMMIT,
				sourceChecklistItemId: `authored:${verificationId}`,
				sourceAuthoredVerificationId: verificationId,
				deferralReasonText: "只在跨项目切换时偶发",
				deferredAtIso: NOW_ISO,
				naturalUsageObservationStatus: "awaiting_natural_usage_observation",
			}),
		]);

		// 幂等：再轮询一次不重复追加。
		await deploymentApi.getPostDeployVerificationState(
			{ workspaceId: WORKSPACE_ID, workspacePath: "/tmp/ws-1" },
			{ activeOnly: true },
		);
		expect(
			await listPostDeployVerificationDeferredNaturalUsageObservationRecords(
				{ workspaceId: WORKSPACE_ID },
				LATER_POLL_ISO,
			),
		).toHaveLength(1);
	});
});
