import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { createCodexRvfCloseoutCompactionAwareConfirmation } from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import { rvfAutomaticCloseoutRecordSchema } from "../../../src/core/rvf-automatic-closeout-contract";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
} from "../../../src/core/task-message-injection-ledger";
import { buildRvfAutomaticCloseoutPrompt } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-prompt";
import {
	getRvfAutomaticCloseoutStorePath,
	updateRvfAutomaticCloseoutRecords,
} from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

export async function createRvfCloseoutCompactionConfirmationIsolatedFixture() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const workspaceId = "isolated-compaction";
	const workspaceDirectory = getWorkspaceDirectoryPath(workspaceId);
	await mkdir(workspaceDirectory, { recursive: true });
	const handoffPath = join(fixture.fixtureRootDirectoryPath, "bound-handoff.md");
	const handoffText = "隔离测试的唯一绑定交接\n";
	await writeFile(handoffPath, handoffText);
	const sha = (text: string) => createHash("sha256").update(text).digest("hex");
	const record = rvfAutomaticCloseoutRecordSchema.parse({
		workspaceId,
		taskId: "card",
		conversationSessionId: "conversation",
		preReviewTurnIds: ["old-turn"],
		status: "submitting_closeout_prompt",
		createdAt: 1,
		updatedAt: 1,
		runId: "isolated-run",
		runDirectory: fixture.fixtureRootDirectoryPath,
		handoffPath,
		handoffSha256: sha(handoffText),
		restoredNativeSessionId: "native",
		restoredTranscriptPath: join(fixture.fixtureRootDirectoryPath, "native.jsonl"),
		restoreWorkspaceStateSha256: null,
		nativeIdentitySwitchStartedAt: null,
		nativeForkAttemptStartedAt: null,
		pauseReason: null,
		promptDeliveryIdempotencyKey: "isolated-closeout",
		receipt: {
			schema: "rvf-independent-user-turn-boundary/v1",
			decision_token: "0123456789abcdef",
			session_id: "source-native",
			worktree: fixture.fixtureRootDirectoryPath,
			native_user_message_id: "boundary-message",
			native_turn_id: "boundary-turn",
			transcript_path: join(fixture.fixtureRootDirectoryPath, "source-native.jsonl"),
			boundary_message_sha256: sha("fixture"),
			candidate_fingerprint: sha("candidate"),
			worktree_head_commit_sha: "1".repeat(40),
			checkpoint_commit: "2".repeat(40),
			checkpoint_tree: "3".repeat(40),
			comparison_base_tip: null,
			comparison_base_ref: null,
			comparison_base_ref_tip: null,
			source: "rvf_automatic_decision_message",
			kanban_task_id: "card",
			idempotency_key: "boundary-key",
		},
	});
	const storePath = getRvfAutomaticCloseoutStorePath(workspaceId);
	await updateRvfAutomaticCloseoutRecords(storePath, () => ({ records: [record], value: null }));
	const promptText = buildRvfAutomaticCloseoutPrompt(record);
	const ledgerPath = getTaskMessageInjectionLedgerPath(workspaceDirectory);
	await writeFile(
		ledgerPath,
		JSON.stringify([
			createPendingTaskMessageInjectionRecord({
				taskId: "card",
				attemptId: "conversation",
				source: "rvf_automatic_closeout",
				idempotencyKey: record.promptDeliveryIdempotencyKey,
				promptSha256: sha(promptText),
				nowIso: new Date(100_000).toISOString(),
			}),
		]),
	);
	const incarnation = "e96aa879-02a4-480e-bbd6-97b7e5e83843";
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "conversation",
		agentId: "codex",
		workspacePath: fixture.fixtureRootDirectoryPath,
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		state: "running",
		reviewReason: null,
		exitCode: null,
		runtimeSessionIncarnationId: incarnation,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: record.restoredTranscriptPath,
			observedAt: 1,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId,
			conversationSessionId: "conversation",
			runtimeSessionIncarnationId: incarnation,
			socketPath: join(fixture.fixtureRootDirectoryPath, "isolated-control.sock"),
		},
	});
	const initialSnapshot = createCodexRvfCloseoutCompactionAwareConfirmation({
		binding: {
			workspaceId,
			taskId: "card",
			conversationSessionId: "conversation",
			decisionToken: record.receipt.decision_token,
			runId: "isolated-run",
			handoffSha256: record.handoffSha256 ?? "",
			idempotencyKey: record.promptDeliveryIdempotencyKey,
			promptSha256: sha(promptText),
			nativeSessionId: "native",
			runtimeSessionIncarnationId: incarnation,
			controlHostSocketPath: summary.codexNativeSessionControlEndpoint?.socketPath ?? "",
			terminalSessionSpawnedAtEpochMs: 1,
		},
		firstSubmissionAtEpochMs: 100_000,
		submissionTransport: "codex_native_request",
		clientUserMessageId: "client-message",
		predecessorNativeTurnId: "old-turn",
		lastHumanInputAtSubmission: null,
	});
	return { fixture, workspaceId, storePath, ledgerPath, record, promptText, summary, initialSnapshot };
}
