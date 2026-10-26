import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { type QueuedTaskPromptDeliveryEntry, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { isQueuedTaskPromptDeliveryAwaitingDispatch } from "../../../src/core/queued-task-prompt-delivery-dispatch-eligibility";
import { buildRuntimeQueuedTaskPromptDeliveryProjection } from "../../../src/core/queued-task-prompt-delivery-projection";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart,
} from "../../../src/core/task-message-injection-ledger";
import { createQueuedTaskPromptDeliveryDispatcher } from "../../../src/server/queued-task-prompt-delivery-dispatcher";
import {
	applyQueuedTaskPromptDeliveryMutation,
	getWorkspaceQueuedTaskPromptDeliveriesPath,
	settleExpiredQueuedTaskPromptDeliveries,
	settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
	withExpiredAndOverflowingEntriesPruned,
} from "../../../src/state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

const workspaceId = "retired-workflow-history",
	taskId = "card",
	now = 1_700_000_000_000;
function historicalEntry(state: QueuedTaskPromptDeliveryEntry["deliveryState"]): QueuedTaskPromptDeliveryEntry {
	const snapshot = applyQueuedTaskPromptDeliveryMutation(
		{ entriesByTaskId: {} },
		{
			kind: "enqueue_prompt_for_delivery_after_current_turn",
			taskId,
			queueEntryId: state,
			text: `原始历史 ${state}`,
		},
		now,
	);
	return {
		...snapshot.entriesByTaskId[taskId][0],
		deliveryState: state,
		expiresAt: now + 5000,
		dispatchIdempotencyKey: state,
		programmaticInjectionLedgerReceiptLink: {
			injectionLedgerIdempotencyKey: state,
			injectionSource: "rvf_automatic_closeout",
			settledTerminalDeliveryReceipt: null,
		},
	};
}
afterEach(() => vi.unstubAllEnvs());

it.each(["queued", "claimed_for_dispatch", "handed_to_transport", "settled_failed", "settled_delivered"] as const)(
	"旧消息 %s 保留原状态，不进入调度、过期、重试与重排",
	(state) => {
		const entry = historicalEntry(state);
		const snapshot = { entriesByTaskId: { [taskId]: [entry] } };
		expect(isQueuedTaskPromptDeliveryAwaitingDispatch(entry, now + 1)).toBe(false);
		expect(withExpiredAndOverflowingEntriesPruned(snapshot, now + 1_000_000_000).entriesByTaskId[taskId]).toEqual([
			entry,
		]);
		expect(
			applyQueuedTaskPromptDeliveryMutation(
				snapshot,
				{
					kind: "retry_settled_failed_queued_prompt_delivery",
					taskId,
					queueEntryId: state,
					replacementQueueEntryId: "must-not-exist",
				},
				now + 1_000_000,
			),
		).toEqual(snapshot);
		const projection = buildRuntimeQueuedTaskPromptDeliveryProjection(entry, {
			nowEpochMs: now + 1_000_000,
			resolveDispatchBlockReasonForQueuedEntry: () => null,
			currentPromptLibraryEntryTextSha256ByEntryId: null,
		});
		expect(projection.deliveryState).toBe(state);
		expect(projection.isReadOnlyHistoricalDelivery).toBe(true);
	},
);

it("隔离的两次重启与队列 sweep 均不发送旧消息、不改写旧队列或账本", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const directory = getWorkspaceDirectoryPath(workspaceId);
	await mkdir(directory, { recursive: true });
	const entries = [
		historicalEntry("queued"),
		historicalEntry("handed_to_transport"),
		historicalEntry("settled_failed"),
	];
	const snapshot = { entriesByTaskId: { [taskId]: entries } };
	const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(workspaceId);
	const ledgerPath = getTaskMessageInjectionLedgerPath(directory);
	const originalQueue = JSON.stringify(snapshot, null, 2);
	const originalLedger = JSON.stringify(
		entries.map((entry) => ({
			...createPendingTaskMessageInjectionRecord({
				taskId,
				source: "rvf_automatic_closeout",
				idempotencyKey: entry.queueEntryId,
				promptSha256: "historical-hash",
				nowIso: new Date(now).toISOString(),
			}),
			nativeCompactionAwareConfirmation: { original: "不再执行的旧快照" },
		})),
		null,
		2,
	);
	await writeFile(queuePath, originalQueue);
	await writeFile(ledgerPath, originalLedger);
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId,
		agentId: "codex",
		state: "awaiting_review",
		workspacePath: fixture.fixtureRootDirectoryPath,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
	});
	const send = vi.fn(async () => ({ ok: true, summary: null }));
	const readNative = vi.fn();
	for (let restart = 1; restart <= 2; restart++) {
		await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId,
			runtimeProcessStartedAtEpochMs: now + restart * 10_000,
			sweepingRuntimeProcessInstanceId: `restart-${restart}`,
			liveRuntimeProcessInstanceIds: new Set(),
			nowEpochMs: now + restart * 10_000,
		});
		const stranded = await settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart({
			workspaceId,
			inFlightSettlementBudgetMs: 1,
			strandedDeliveryFailureNote: "不得改写历史",
			nowEpochMs: now + 1_000_000,
		});
		expect(stranded.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs).toBeNull();
		await settleExpiredQueuedTaskPromptDeliveries({ workspaceId, nowEpochMs: now + 1_000_000 });
		const ledgerSweep = await sweepStalePendingTaskMessageInjectionsAfterRuntimeRestart({
			ledgerPath,
			nowIso: new Date(now + 1_000_000).toISOString(),
			stalePendingThresholdMs: 1,
		});
		expect(ledgerSweep.earliestSkippedPendingBecomesStaleAtEpochMs).toBeNull();
		const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
			getTaskSessionSummary: () => summary,
			hasPendingProgrammaticTaskChatInputDelivery: () => false,
			resolveWorkspaceScope: () => ({ workspaceId, workspacePath: fixture.fixtureRootDirectoryPath }),
			sendThroughTaskChatTransports: send,
			cancelProgrammaticTerminalDelivery: vi.fn(),
			readPromptLibraryEntryTextSha256ByEntryId: async () => null,
			onProjectedQueueChanged: () => {},
			readNativeConversationTurns: readNative,
			now: () => now + 1_000_000,
		});
		try {
			await dispatcher.notifyQueueMutated(workspaceId, taskId, snapshot);
			await dispatcher.runFallbackSweep();
			await dispatcher.whenIdle();
		} finally {
			dispatcher.stop();
		}
		expect(await readFile(queuePath, "utf8")).toBe(originalQueue);
		expect(await readFile(ledgerPath, "utf8")).toBe(originalLedger);
	}
	expect(send).not.toHaveBeenCalled();
	expect(readNative).not.toHaveBeenCalled();
});
