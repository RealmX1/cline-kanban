import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexNativePromptDeliveryJournal } from "../../../src/core/codex-native-prompt-delivery-journal";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";

describe("原生投递持久意图与接受历史", () => {
	let directory: string;
	let ledgerPath: string;
	const text = "独立程序化消息\n中文😀";
	const identity = {
		clientUserMessageId: "first-client-id",
		workspaceId: "workspace",
		conversationSessionId: "conversation",
		nativeSessionId: "native-thread",
		workingDirectoryPath: "/workspace",
		text,
	};
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "kanban-native-prompt-journal-"));
		ledgerPath = getTaskMessageInjectionLedgerPath(directory);
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({
			records: [
				createPendingTaskMessageInjectionRecord({
					taskId: "card",
					attemptId: "conversation",
					source: "rvf",
					idempotencyKey: "stable-key",
					promptSha256: createHash("sha256").update(text).digest("hex"),
					nowIso: new Date().toISOString(),
				}),
			],
			result: undefined,
		}));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const binding = () => ({ ledgerPath, ledgerTaskId: "card", idempotencyKey: "stable-key" });

	it("意图落盘后崩溃，重启沿用客户端身份并禁止再次发送", async () => {
		const journal = createCodexNativePromptDeliveryJournal(binding());
		await journal.prepare(identity);
		await journal.recordRequestIntent("previous-turn");
		const restarted = createCodexNativePromptDeliveryJournal(binding());
		const state = await restarted.prepare({ ...identity, clientUserMessageId: "new-process-proposal" });
		expect(state).toEqual({
			clientUserMessageId: "first-client-id",
			requestMayHaveBeenSent: true,
			previousTurnId: "previous-turn",
			returnedTurnId: null,
		});
		await expect(restarted.recordRequestIntent("previous-turn")).rejects.toThrow("只允许补证");
		for (let i = 0; i < 20; i++) await restarted.prepare(identity);
		expect(
			(await readTaskMessageInjectionLedger(ledgerPath))[0]?.codex_native_prompt_delivery_operation
				?.actualSendAttemptCount,
		).toBe(0);
	});

	it("失败后的迟到接受追加历史证据，保留原失败与实际发送计数", async () => {
		const journal = createCodexNativePromptDeliveryJournal(binding());
		await journal.prepare(identity);
		await journal.recordRequestIntent("previous-turn");
		await journal.recordRequestInvoked();
		await recordTaskMessageTerminalDeliveryOutcome({
			...binding(),
			taskId: "card",
			status: "delivery_failed",
			failureReason: "codex_native_prompt_delivery_unconfirmed",
			nowIso: new Date().toISOString(),
		});
		await createCodexNativePromptDeliveryJournal(binding()).recordAcceptance({
			clientUserMessageId: "first-client-id",
			nativeSessionId: "native-thread",
			nativeTurnId: "accepted-turn",
			nativeUserMessageId: "native-message",
		});
		const record = (await readTaskMessageInjectionLedger(ledgerPath))[0];
		expect(record?.terminal_delivery_status).toBe("delivery_failed");
		expect(record?.terminal_delivery_failure_reason).toBe("codex_native_prompt_delivery_unconfirmed");
		expect(record?.codex_native_prompt_delivery_operation?.actualSendAttemptCount).toBe(1);
		expect(record?.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence?.nativeTurnId).toBe(
			"accepted-turn",
		);
	});

	it("并发登记只产生一个稳定消息身份", async () => {
		const results = await Promise.all(
			["proposal-a", "proposal-b"].map(async (clientUserMessageId) =>
				createCodexNativePromptDeliveryJournal(binding()).prepare({ ...identity, clientUserMessageId }),
			),
		);
		expect(new Set(results.map((result) => result.clientUserMessageId)).size).toBe(1);
	});

	it("正文、原生身份或目标会话变化分别拒绝，不继承旧发送资格", async () => {
		const journal = createCodexNativePromptDeliveryJournal(binding());
		await journal.prepare(identity);
		await expect(journal.prepare({ ...identity, text: "外部修改" })).rejects.toThrow();
		await expect(journal.prepare({ ...identity, nativeSessionId: "different-native-thread" })).rejects.toThrow();
		await expect(journal.prepare({ ...identity, conversationSessionId: "other-conversation" })).rejects.toThrow();
	});

	it("分页进度绑定原 operation 并在重建 journal 后恢复，不消耗发送次数", async () => {
		const journal = createCodexNativePromptDeliveryJournal(binding());
		await journal.prepare(identity);
		await journal.recordRequestIntent("previous-turn");
		const progress = {
			nextCursor: "older-native-page",
			queriedCursorSha256s: [createHash("sha256").update("previous-page").digest("hex")],
			lastQueryStatus: "pending" as const,
		};
		await journal.recordAcceptanceHistoryQueryProgress(progress);
		const restarted = createCodexNativePromptDeliveryJournal(binding());
		expect((await restarted.prepare(identity)).acceptanceHistoryQueryProgress).toEqual(progress);
		await expect(restarted.prepare({ ...identity, nativeSessionId: "other-native-thread" })).rejects.toThrow();
		await expect(restarted.prepare({ ...identity, workspaceId: "other-workspace" })).rejects.toThrow();
		await expect(restarted.prepare({ ...identity, text: "其他正文" })).rejects.toThrow();
		expect(
			(await readTaskMessageInjectionLedger(ledgerPath))[0]?.codex_native_prompt_delivery_operation
				?.actualSendAttemptCount,
		).toBe(0);
	});

	it("明确取消终止发送资格；普通回合结束不修改已登记授权", async () => {
		const journal = createCodexNativePromptDeliveryJournal(binding());
		await journal.prepare(identity);
		await recordTaskMessageTerminalDeliveryOutcome({
			...binding(),
			taskId: "card",
			status: "delivery_failed",
			failureReason: "cancelled_before_delivery",
			nowIso: new Date().toISOString(),
		});
		await expect(journal.recordRequestIntent(null)).rejects.toThrow("只允许补证");
		expect((await journal.prepare(identity)).requestMayHaveBeenSent).toBe(true);
	});
});
