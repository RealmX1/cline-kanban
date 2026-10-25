import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { createCodexNativePromptDeliveryJournal } from "../../../src/core/codex-native-prompt-delivery-journal";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import { reconcileWorkspaceCodexNativePromptDeliveryAcceptances } from "../../../src/server/codex-native-prompt-delivery-acceptance-reconciliation";
import type { deliverCodexNativePromptWithoutChangingComposer } from "../../../src/terminal/codex-native-prompt-delivery";

describe("运行时重启后的原生接受补证", () => {
	let directory: string;
	let ledgerPath: string;
	const text = "来自已授权 run 的接续消息";
	const evidence = {
		clientUserMessageId: "stable-client",
		nativeSessionId: "historical-native",
		nativeTurnId: "accepted-turn",
		nativeUserMessageId: "accepted-user-message",
	};
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: "conversation",
		agentId: "codex",
		workspacePath: "/workspace",
		pid: 1,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		exitCode: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		reviewReason: "hook",
		runtimeSessionIncarnationId: "e96aa879-02a4-480e-bbd6-97b7e5e83843",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "current-native",
			transcriptPath: null,
			observedAt: 2,
		},
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/native.sock",
			workspaceId: "workspace",
			conversationSessionId: "conversation",
			runtimeSessionIncarnationId: "e96aa879-02a4-480e-bbd6-97b7e5e83843",
		},
	});
	const binding = () => ({ ledgerPath, ledgerTaskId: "card", idempotencyKey: "wake-key" });
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "kanban-native-acceptance-reconciliation-"));
		ledgerPath = getTaskMessageInjectionLedgerPath(directory);
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
			records: [
				createPendingTaskMessageInjectionRecord({
					taskId: "card",
					attemptId: "conversation",
					source: "rvf",
					idempotencyKey: "wake-key",
					promptSha256: createHash("sha256").update(text).digest("hex"),
					nowIso: new Date().toISOString(),
				}),
			],
			result: undefined,
		}));
		const journal = createCodexNativePromptDeliveryJournal({
			...binding(),
			requestOriginRuntimeProcessInstanceId: "original-runtime",
		});
		await journal.prepare({
			clientUserMessageId: "stable-client",
			workspaceId: "workspace",
			conversationSessionId: "conversation",
			nativeSessionId: "historical-native",
			workingDirectoryPath: "/workspace",
			text,
		});
		await journal.recordRequestIntent("previous-turn");
		await journal.recordRequestInvoked();
		await recordTaskMessageTerminalDeliveryOutcome({
			...binding(),
			taskId: "card",
			status: "delivery_failed",
			failureReason: "runtime_restarted_before_confirmation",
			nowIso: new Date().toISOString(),
		});
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("当前原生分支改变仍可确认历史接受，保留失败和发送次数，重启不重复查询已确认记录", async () => {
		const deliver = vi.fn<typeof deliverCodexNativePromptWithoutChangingComposer>(async (input) => {
			expect(input.reconcileAcceptanceOnly).toBe(true);
			expect(input.historicalNativeConversation?.nativeSessionId).toBe("historical-native");
			expect(await input.beforeSubmit()).toBe(false);
			expect(() => input.onRequestAttempted()).toThrow("禁止发送");
			await input.deliveryJournal?.recordAcceptance(evidence);
			return { status: "confirmed", evidence };
		});
		const input = {
			workspaceId: "workspace",
			ledgerPath,
			getSummary: () => summary,
			deliver,
			reconcilerRuntimeProcessInstanceId: "restarted-runtime",
		};
		expect(await reconcileWorkspaceCodexNativePromptDeliveryAcceptances(input)).toEqual({
			confirmedCount: 1,
			unknownCount: 0,
		});
		expect((await readTaskMessageInjectionLedger(ledgerPath))[0]).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "runtime_restarted_before_confirmation",
			codex_native_prompt_delivery_operation: {
				requestOriginRuntimeProcessInstanceId: "original-runtime",
				lastAcceptanceReconciliationRuntimeProcessInstanceId: "restarted-runtime",
				actualSendAttemptCount: 1,
				historicalAcceptanceEvidence: evidence,
				currentExecutionQualification: "current_native_conversation_changed",
			},
		});
		await reconcileWorkspaceCodexNativePromptDeliveryAcceptances(input);
		expect(deliver).toHaveBeenCalledOnce();
	});

	it("本运行时不拥有该会话或账本 workspace 时不查询、不改写其历史", async () => {
		const before = await readFile(ledgerPath, "utf8");
		const deliver = vi.fn<typeof deliverCodexNativePromptWithoutChangingComposer>();
		await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
			workspaceId: "workspace",
			ledgerPath,
			getSummary: () => null,
			deliver,
		});
		await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
			workspaceId: "other-workspace",
			ledgerPath,
			getSummary: () => summary,
			deliver,
		});
		expect(deliver).not.toHaveBeenCalled();
		expect(await readFile(ledgerPath, "utf8")).toBe(before);
	});

	it("查询未知可继续重验，所有补证都不增加实际发送预算", async () => {
		const deliver = vi.fn<typeof deliverCodexNativePromptWithoutChangingComposer>(async () => ({
			status: "unconfirmed",
		}));
		for (let pass = 0; pass < 4; pass++) {
			expect(
				await reconcileWorkspaceCodexNativePromptDeliveryAcceptances({
					workspaceId: "workspace",
					ledgerPath,
					getSummary: () => summary,
					deliver,
				}),
			).toEqual({ confirmedCount: 0, unknownCount: 1 });
		}
		expect(
			(await readTaskMessageInjectionLedger(ledgerPath))[0]?.codex_native_prompt_delivery_operation
				?.actualSendAttemptCount,
		).toBe(1);
		expect(deliver).toHaveBeenCalledTimes(4);
	});
});
