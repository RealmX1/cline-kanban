import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimePostDeployVerificationState } from "../../src/core/api-contract";
import {
	getPostDeployVerificationStatePath,
	markTaskVerified,
} from "../../src/deployment/post-deploy-verification-state";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { recordPostDeployVerificationPassedObservationWithoutBlocking } from "../../src/inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { createDeploymentApi } from "../../src/trpc/deployment-api";
import type * as TaskCommitIntegrationProvenanceModule from "../../src/workspace/task-commit-integration-provenance";
import { createTempDir } from "../utilities/temp-dir";

// PDV 观测在追加前先在后台读原始落地快照。个别用例把这一步卡住，模拟「读快照期间本实例开始停机、随后又激活了新实例」；
// 未武装时原样透传。
const landingSnapshotReadHeldForInFlightPostDeployVerificationRecording = vi.hoisted(() => ({
	readHeldUntilReleased: null as Promise<void> | null,
	signalReadEnteredWhileHeld: (): void => {},
}));

vi.mock("../../src/workspace/task-commit-integration-provenance", async (importOriginal) => {
	const original = await importOriginal<typeof TaskCommitIntegrationProvenanceModule>();
	return {
		...original,
		readRawTaskCommitLandingSnapshotForRelationLedgerEvent: async (workspaceId: string, taskId: string) => {
			const heldUntilReleased =
				landingSnapshotReadHeldForInFlightPostDeployVerificationRecording.readHeldUntilReleased;
			if (heldUntilReleased) {
				landingSnapshotReadHeldForInFlightPostDeployVerificationRecording.signalReadEnteredWhileHeld();
				await heldUntilReleased;
			}
			return await original.readRawTaskCommitLandingSnapshotForRelationLedgerEvent(workspaceId, taskId);
		},
	};
});

// 「终会发生」的单档等待：首次提交要等账本 Worker 线程冷启动并加载 better-sqlite3，vi.waitFor 默认 1s
// 在高负载下不够。放宽不损失判别力——断言判的是「最终落了几条、内容对不对」，不是多快。
const LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START = { timeout: 15_000 };

describe("inter-work-unit relation ledger post-deploy verification passed observation", () => {
	it("records one passed observation with the raw landing snapshot when verifiedAt is first set, and none on an idempotent repeat", async () => {
		const sandbox = createTempDir("kanban-post-deploy-verification-passed-observation-");
		const previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
		const deploymentId = randomUUID();
		const state: RuntimePostDeployVerificationState = {
			deploymentGroups: [
				{
					deploymentId,
					workspaceId: "workspace-post-deploy-verification",
					deployedSourceCommit: "deployed-source-commit",
					previousDeployedSourceCommit: null,
					deployedAtIso: "2026-01-01T00:00:00.000Z",
					foldedAtIso: null,
					tasks: [
						{
							taskId: "p0001",
							columnIdAtMatch: "review",
							matchedCommits: ["matched-commit"],
							inclusionReason: "commit_correlation",
							checklist: [],
							verifiedAt: null,
							boardMovedToDoneAt: null,
							pendingConfirmation: null,
							droppedReason: null,
						},
					],
				},
			],
		};
		mkdirSync(dirname(getPostDeployVerificationStatePath()), { recursive: true });
		writeFileSync(getPostDeployVerificationStatePath(), JSON.stringify(state, null, 2), "utf8");

		const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			// CLI 完成动词在 CLI 进程里核对、移列后，经这个 runtime 入口写 verifiedAt。
			const deploymentApi = createDeploymentApi({
				loadBoardTasksForWorkspace: async () => [],
				loadTaskAgentResponsePreview: async () => null,
			});
			const markedFromAnotherWorkspace =
				await deploymentApi.markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone(
					{ workspaceId: "another-workspace", workspacePath: "/tmp/another" },
					{
						deploymentId,
						taskId: "p0001",
						forcedCompletionWithoutAllVerificationsPassed: true,
						confirmedAcknowledgements: ["skip_validation"],
					},
				);
			expect(markedFromAnotherWorkspace.ok).toBe(false);
			const marked = await deploymentApi.markPostDeployVerificationTaskVerifiedAfterKanbanCliMovedItToDone(
				{ workspaceId: "workspace-post-deploy-verification", workspacePath: "/tmp/repo" },
				{
					deploymentId,
					taskId: "p0001",
					forcedCompletionWithoutAllVerificationsPassed: true,
					confirmedAcknowledgements: ["skip_validation"],
				},
			);
			expect(marked.ok).toBe(true);
			const verifiedAt = marked.task?.verifiedAt;
			expect((await markTaskVerified(deploymentId, "p0001", "2026-06-02T00:00:00.000Z")).ok).toBe(true);

			await vi.waitFor(async () => {
				const passedObservations = (await activatedLiveCapture.ledgerClient.listCommittedEvents({})).filter(
					(event) => event.eventKind === "post_deploy_verification_passed_observed",
				);
				expect(passedObservations).toHaveLength(1);
				expect(passedObservations[0]?.subjectWorkspaceId).toBe("workspace-post-deploy-verification");
				expect(passedObservations[0]?.subjectTaskId).toBe("p0001");
				expect(passedObservations[0]?.eventPayload).toMatchObject({
					deploymentId,
					verifiedAt,
					postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
					inclusionReason: "commit_correlation",
					matchedCommits: ["matched-commit"],
					forcedCompletionWithoutAllVerificationsPassed: true,
					confirmedAcknowledgements: ["skip_validation"],
					rawTaskCommitLandingSnapshotAtVerification: {
						lastKnownTaskHeadCommit: null,
						taskOwnedNonMergeCommitsReachableFromLastKnownTaskHead: null,
					},
				});
			}, LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START);
		} finally {
			await activatedLiveCapture.deactivate();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			sandbox.cleanup();
		}
		// 用例超时覆盖：账本提交等待 15s + 激活与停用 Worker。
	}, 45_000);

	it("读快照期间发起实例停用、随后激活了新实例：观测仍落到发起时的实例，且在它关 worker 之前；新实例收不到", async () => {
		const sandbox = createTempDir("kanban-post-deploy-verification-passed-observation-drain-");
		const previousHome = process.env.HOME;
		process.env.HOME = sandbox.path;
		const olderActivatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		let newerActivatedLiveCapture: ReturnType<
			typeof activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture
		> | null = null;
		let releaseHeldLandingSnapshotRead: () => void = () => {};
		try {
			await olderActivatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const olderAppendCommittedEventsSpy = vi.spyOn(
				olderActivatedLiveCapture.ledgerClient,
				"appendCommittedEvents",
			);
			const olderCloseSpy = vi.spyOn(olderActivatedLiveCapture.ledgerClient, "close");
			landingSnapshotReadHeldForInFlightPostDeployVerificationRecording.readHeldUntilReleased = new Promise(
				(resolve) => {
					releaseHeldLandingSnapshotRead = resolve;
				},
			);
			const heldLandingSnapshotReadEntered = new Promise<void>((resolve) => {
				landingSnapshotReadHeldForInFlightPostDeployVerificationRecording.signalReadEnteredWhileHeld = resolve;
			});
			const inFlightTaskId = `pdv-in-flight-${randomUUID()}`;
			recordPostDeployVerificationPassedObservationWithoutBlocking({
				workspaceId: "workspace-post-deploy-verification-drain",
				deploymentId: randomUUID(),
				deployedSourceCommit: "deployed-source-commit",
				verifiedPostDeployVerificationTask: {
					taskId: inFlightTaskId,
					columnIdAtMatch: "review",
					matchedCommits: [],
					inclusionReason: "commit_correlation",
					checklist: [],
					verifiedAt: "2026-06-01T00:00:00.000Z",
					boardMovedToDoneAt: null,
					pendingConfirmation: null,
					droppedReason: null,
				},
				completionEvidence: {
					postDeployVerificationCompletionPath: "kanban_cli_post_deploy_verification_completion_verb",
					forcedCompletionWithoutAllVerificationsPassed: false,
					confirmedAcknowledgements: [],
				},
			});
			await heldLandingSnapshotReadEntered;

			const olderDeactivation = olderActivatedLiveCapture.deactivate();
			newerActivatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			const newerAppendCommittedEventsSpy = vi.spyOn(
				newerActivatedLiveCapture.ledgerClient,
				"appendCommittedEvents",
			);
			// 让出一个完整的宏任务：停用若不等在途的后台记录，此时旧 worker 已经关闭。
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(olderCloseSpy).not.toHaveBeenCalled();
			releaseHeldLandingSnapshotRead();
			await olderDeactivation;
			await newerActivatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;

			const isInFlightPassedObservationDraft = (eventDraft: { eventKind: string; subjectTaskId: string | null }) =>
				eventDraft.eventKind === "post_deploy_verification_passed_observed" &&
				eventDraft.subjectTaskId === inFlightTaskId;
			const olderAppendInvocationOrdersCarryingTheObservation = olderAppendCommittedEventsSpy.mock.calls.flatMap(
				([appendInput], callIndex) =>
					appendInput.eventDrafts.some(isInFlightPassedObservationDraft)
						? [olderAppendCommittedEventsSpy.mock.invocationCallOrder[callIndex] ?? Number.POSITIVE_INFINITY]
						: [],
			);
			expect(olderAppendInvocationOrdersCarryingTheObservation).toHaveLength(1);
			expect(olderCloseSpy).toHaveBeenCalledTimes(1);
			const [olderCloseInvocationOrder] = olderCloseSpy.mock.invocationCallOrder;
			expect(olderAppendInvocationOrdersCarryingTheObservation[0]).toBeLessThan(olderCloseInvocationOrder ?? 0);
			expect(
				newerAppendCommittedEventsSpy.mock.calls.some(([appendInput]) =>
					appendInput.eventDrafts.some(isInFlightPassedObservationDraft),
				),
			).toBe(false);

			const persistedPassedObservations = (
				await newerActivatedLiveCapture.ledgerClient.listCommittedEvents({ subjectTaskId: inFlightTaskId })
			).filter((event) => event.eventKind === "post_deploy_verification_passed_observed");
			expect(persistedPassedObservations).toHaveLength(1);
			const [olderAppendCallCarryingTheObservation] = olderAppendCommittedEventsSpy.mock.calls.filter(
				([appendInput]) => appendInput.eventDrafts.some(isInFlightPassedObservationDraft),
			);
			expect(persistedPassedObservations[0]?.capturingKanbanRuntimeInstance).toEqual(
				olderAppendCallCarryingTheObservation?.[0].eventDrafts[0]?.capturingKanbanRuntimeInstance,
			);
		} finally {
			landingSnapshotReadHeldForInFlightPostDeployVerificationRecording.readHeldUntilReleased = null;
			releaseHeldLandingSnapshotRead();
			await olderActivatedLiveCapture.deactivate();
			await newerActivatedLiveCapture?.deactivate();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			sandbox.cleanup();
		}
	});
});
