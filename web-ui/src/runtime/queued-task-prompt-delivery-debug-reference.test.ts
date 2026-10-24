import { describe, expect, it } from "vitest";

import { buildQueuedTaskPromptDeliveryDebugReference } from "@/runtime/queued-task-prompt-delivery-debug-reference";
import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeTaskPromptDeliveryQueueResponse,
} from "@/runtime/types";

const projection: RuntimeQueuedTaskPromptDeliveryProjection = {
	queueEntryId: "queue-entry-1",
	taskId: "independent-conversation-session",
	deliveryState: "queued",
	textPreview: "不应复制的正文预览",
	textLength: 10,
	deliverTogetherWithNextQueuedEntry: false,
	dispatchBlockReason: "agent_still_generating",
	awaitsHumanReconfirmationAfterRuntimeRestart: false,
	deliveryAttemptCount: 1,
	lastAttemptedAt: 1,
	lastDeliveryFailureNote: "上次没有发送成功",
	sourcePromptLibraryEntryId: null,
	sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
	enqueuedAt: 0,
	expiresAt: 86_400_000,
	settledAt: null,
};

function makeEntry(overrides: Partial<QueuedTaskPromptDeliveryEntry> = {}): QueuedTaskPromptDeliveryEntry {
	return {
		queueEntryId: projection.queueEntryId,
		taskId: projection.taskId,
		workspaceTaskId: "owning-board-task",
		text: "不应复制的完整正文",
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		deliveryState: "queued",
		deliveryAttemptCount: 1,
		lastAttemptedAt: 1,
		settledAt: null,
		dispatchIdempotencyKey: null,
		claimedForSessionIncarnationId: null,
		claimedAtTurnSequence: null,
		enqueuedAt: 0,
		expiresAt: 86_400_000,
		lastDeliveryFailureNote: "上次没有发送成功",
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		...overrides,
	};
}

function makeResponse(entry = makeEntry()): RuntimeTaskPromptDeliveryQueueResponse {
	return {
		ok: true,
		queue: { entriesByTaskId: { [projection.taskId]: [entry] } },
		projectedEntriesByTaskId: { [projection.taskId]: [projection] },
		queuedTaskPromptDeliveryDebugReferenceContext: {
			workspaceId: "project-a",
			workspaceProjectPath: "/projects/project-a",
			queuedTaskPromptDeliveriesFilePath: "/isolated-home/workspaces/project-a/queued-task-prompt-deliveries.json",
			taskMessageInjectionLedgerFilePath: "/isolated-home/workspaces/project-a/task-message-injections.json",
		},
	};
}

const baseInput = {
	workspaceId: "project-a",
	workspaceTaskId: "owning-board-task",
	projection,
	capturedAtEpochMs: Date.parse("2026-10-24T12:34:56Z"),
};

describe("Prompt Queue 调试引用", () => {
	it("区分项目、看板任务和会话，使用服务端真实路径并给出精确检索指导", () => {
		const reference = buildQueuedTaskPromptDeliveryDebugReference({
			...baseInput,
			queueReadResponse: makeResponse(),
		});
		expect(reference.notice).toBeNull();
		for (const value of [
			"project-a",
			"owning-board-task",
			projection.taskId,
			projection.queueEntryId,
			"/isolated-home/workspaces/project-a/queued-task-prompt-deliveries.json",
			"entriesByTaskId",
			"检索指导",
			"2026-10-24T12:34:56.000Z",
			"1970-01-01T00:00:00.000Z",
		]) {
			expect(reference.text).toContain(value);
		}
		expect(reference.text).not.toContain("不应复制");
		expect(reference.text).not.toContain("~/.cline");
	});

	it("程序化条目复制可用的 dispatch 和 ledger key，账本所属任务不与目标会话混淆", () => {
		const entry = makeEntry({
			dispatchIdempotencyKey: "dispatch-key-for-current-attempt",
			programmaticInjectionLedgerReceiptLink: {
				injectionLedgerIdempotencyKey: "automation-idempotency-key",
				injectionLedgerTaskId: "automation-caller-task",
				injectionSource: "rvf_automatic_closeout",
				settledTerminalDeliveryReceipt: null,
			},
		});
		const { text } = buildQueuedTaskPromptDeliveryDebugReference({
			...baseInput,
			queueReadResponse: makeResponse(entry),
		});
		for (const value of [
			"dispatch-key-for-current-attempt",
			"automation-idempotency-key",
			"automation-caller-task",
			"rvf_automatic_closeout",
			"task-message-injections.json",
			"idempotency_key",
		])
			expect(text).toContain(value);
	});

	it("条目已移除时保留已知引用并如实提示，不能使用其他会话下的同名条目", () => {
		const response = makeResponse();
		response.queue = {
			entriesByTaskId: {
				"unrelated-session": [
					makeEntry({ taskId: "unrelated-session", dispatchIdempotencyKey: "wrong-session-key" }),
				],
			},
		};
		const reference = buildQueuedTaskPromptDeliveryDebugReference({ ...baseInput, queueReadResponse: response });
		expect(reference.notice).toContain("已从当前队列移除");
		expect(reference.text).toContain(projection.queueEntryId);
		expect(reference.text).not.toContain("wrong-session-key");
	});

	it("读取失败和旧 runtime 缺少路径时仍可复制已知引用，不编造默认路径", () => {
		for (const queueReadResponse of [
			null,
			{ ...makeResponse(), queuedTaskPromptDeliveryDebugReferenceContext: undefined },
		]) {
			const reference = buildQueuedTaskPromptDeliveryDebugReference({ ...baseInput, queueReadResponse });
			expect(reference.notice).not.toBeNull();
			expect(reference.text).toContain(projection.queueEntryId);
			expect(reference.text).toContain(projection.taskId);
			expect(reference.text).not.toContain("~/.cline");
		}
	});

	it("跨项目响应不能泄漏到当前引用", () => {
		const response = makeResponse(makeEntry({ dispatchIdempotencyKey: "other-project-key" }));
		if (response.queuedTaskPromptDeliveryDebugReferenceContext)
			response.queuedTaskPromptDeliveryDebugReferenceContext.workspaceId = "different-project";
		const reference = buildQueuedTaskPromptDeliveryDebugReference({ ...baseInput, queueReadResponse: response });
		expect(reference.notice).toContain("项目");
		expect(reference.text).not.toContain("other-project-key");
		expect(reference.text).not.toContain("/isolated-home");
	});
});
