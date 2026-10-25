import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { isQueuedTaskPromptDeliveryAwaitingDispatch } from "../../../src/core/queued-task-prompt-delivery-dispatch-eligibility";
import { buildRuntimeQueuedTaskPromptDeliveryProjection } from "../../../src/core/queued-task-prompt-delivery-projection";
import {
	createPendingTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import {
	beginManagedTaskPromptDelivery,
	observeManagedTaskPromptDeliveryChanges,
	reconcileManagedTaskPromptDeliveryReceipts,
	settleManagedTaskPromptDeliveryWithoutBlocking,
} from "../../../src/state/managed-task-prompt-delivery-coordinator";
import {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	computeQueuedTaskPromptDeliveryTextSha256,
	isQueuedTaskPromptDeliveryQueueFullForTask,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
} from "../../../src/state/queued-task-prompt-delivery-store";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { sendTaskChatMessageAcrossSessionTransports } from "../../../src/trpc/task-chat-message-send-across-session-transports";

const isolatedRuntimeHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => isolatedRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(isolatedRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(isolatedRuntimeHome.path, "workspaces"),
}));

const summary: RuntimeTaskSessionSummary = {
	taskId: "session-1",
	agentId: "omp",
	sessionTransport: "acp_stdio_subprocess",
	workspacePath: "/isolated-repo",
	state: "running",
	turnOwner: "agent",
	liveness: "live",
	userTurnKind: null,
	pid: 1,
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: null,
	reviewReason: null,
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
	runtimeSessionIncarnationId: "incarnation-1",
};

beforeEach(async () => {
	isolatedRuntimeHome.path = await mkdtemp(join(tmpdir(), "managed-delivery-test-"));
});
afterEach(async () => {
	await rm(isolatedRuntimeHome.path, { recursive: true, force: true });
});

describe("所有主动投递使用统一记录", () => {
	it("保留原生投递失败的具体诊断，不只保存通用原因码", async () => {
		const { handle } = await beginManagedTaskPromptDelivery({
			workspaceId: "workspace",
			taskId: "session-1",
			text: "待确认的消息",
			origin: { messageType: "programmatic_injection" },
		});
		settleManagedTaskPromptDeliveryWithoutBlocking(handle, {
			status: "delivery_failed",
			reason: "codex_native_prompt_delivery_unconfirmed",
			failureNote: "第二次原生回合查询超时，尚未获得可靠接受证据。",
		});
		await vi.waitFor(async () => {
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
			expect(snapshot.entriesByTaskId["session-1"][0].lastDeliveryFailureNote).toBe(
				"第二次原生回合查询超时，尚未获得可靠接受证据。",
			);
		});
	});

	it("迟到的真实 transport 回执可补证未知状态，明确取消不会被覆盖", async () => {
		const { handle } = await beginManagedTaskPromptDelivery({
			workspaceId: "workspace",
			taskId: "session-1",
			text: "迟到的确认",
			origin: { messageType: "human_message" },
		});
		await handle.settle(
			{ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
			"确认预算耗尽",
		);
		await handle.settle({ status: "delivered_and_submit_confirmed", reason: null });
		const confirmed = (await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId[
			"session-1"
		][0];
		expect(confirmed.deliveryState).toBe("settled_delivered");
		expect(confirmed.managedDelivery?.previousUnconfirmedTerminalDeliveryReceipt?.reason).toBe(
			"submit_confirmation_budget_exhausted",
		);
		expect(confirmed.managedDelivery?.previousUnconfirmedDeliveryFailureNote).toBe("确认预算耗尽");
		const cancelled = await beginManagedTaskPromptDelivery({
			workspaceId: "workspace",
			taskId: "session-1",
			text: "已明确取消",
			origin: { messageType: "human_message" },
		});
		await cancelled.handle.settle({ status: "delivery_failed", reason: "cancelled_before_delivery" });
		await cancelled.handle.settle({ status: "delivered_and_submit_confirmed", reason: null });
		expect(
			(await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId["session-1"].find(
				(entry) => entry.queueEntryId === cancelled.handle.deliveryId,
			)?.deliveryState,
		).toBe("cancelled");
	});

	it.each(["完全匹配", "会话不同", "正文不同", "key 不同"])(
		"重启后补证校验完整身份：%s，保留原未知历史",
		async (matchKind) => {
			const matches = matchKind === "完全匹配";
			const { handle } = await beginManagedTaskPromptDelivery({
				workspaceId: "workspace",
				taskId: "session-1",
				text: "唯一正文",
				origin: { messageType: "programmatic_injection" },
				idempotencyKey: "recovery-key",
				injectionLedgerTaskId: "board-task",
			});
			let snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
			snapshot = await reconcileManagedTaskPromptDeliveryReceipts("workspace", snapshot, Date.now() + 310_000);
			expect(snapshot.entriesByTaskId["session-1"][0].deliveryState).toBe("settled_failed");
			const ledgerPath = getTaskMessageInjectionLedgerPath(
				join(isolatedRuntimeHome.path, "workspaces", "workspace"),
			);
			const record = createPendingTaskMessageInjectionRecord({
				taskId: "board-task",
				attemptId: matchKind === "会话不同" ? "other-session" : "session-1",
				source: "test",
				idempotencyKey: matchKind === "key 不同" ? "other-key" : "recovery-key",
				promptSha256: computeQueuedTaskPromptDeliveryTextSha256(
					matchKind === "正文不同" ? "另一条正文" : "唯一正文",
				),
				nowIso: new Date().toISOString(),
			});
			await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({ records: [record], result: null }));
			await recordTaskMessageTerminalDeliveryOutcome({
				ledgerPath,
				taskId: "board-task",
				idempotencyKey: record.idempotency_key,
				status: "delivered_and_submit_confirmed",
				nowIso: new Date().toISOString(),
			});
			snapshot = await reconcileManagedTaskPromptDeliveryReceipts("workspace", snapshot);
			const entry = snapshot.entriesByTaskId["session-1"].find(
				(candidate) => candidate.queueEntryId === handle.deliveryId,
			);
			expect(entry?.deliveryState).toBe(matches ? "settled_delivered" : "settled_failed");
			if (matches)
				expect(entry?.managedDelivery?.previousUnconfirmedTerminalDeliveryReceipt?.reason).toBe(
					"runtime_restarted_before_confirmation",
				);
		},
	);
	it.each(["另一条正文", "相同正文"])("同一请求 ID 的回执只补证所属会话，另一会话正文为 %s", async (secondText) => {
		for (const taskId of ["session-a", "session-b"])
			await beginManagedTaskPromptDelivery({
				workspaceId: "workspace",
				taskId,
				text: taskId === "session-a" ? "相同正文" : secondText,
				origin: { messageType: "programmatic_injection" },
				deliveryRequestId: "shared-request-id",
				idempotencyKey: "shared-ledger-key",
				injectionLedgerTaskId: "board-task",
			});
		const ledgerPath = getTaskMessageInjectionLedgerPath(join(isolatedRuntimeHome.path, "workspaces", "workspace"));
		const record = createPendingTaskMessageInjectionRecord({
			taskId: "board-task",
			attemptId: "session-a",
			source: "test",
			idempotencyKey: "shared-ledger-key",
			promptSha256: computeQueuedTaskPromptDeliveryTextSha256("相同正文"),
			nowIso: new Date().toISOString(),
		});
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({ records: [record], result: null }));
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "board-task",
			idempotencyKey: "shared-ledger-key",
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		const snapshot = await reconcileManagedTaskPromptDeliveryReceipts(
			"workspace",
			await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace"),
		);
		expect(snapshot.entriesByTaskId["session-a"][0].deliveryState).toBe("settled_delivered");
		expect(snapshot.entriesByTaskId["session-b"][0].deliveryState).toBe("handed_to_transport");
	});

	it("相同请求 ID 与正文必须绑定附件数量及内容，相同意图保持幂等", async () => {
		let currentSummary = summary;
		const acp = {
			getSummary: () => currentSummary,
			listMessages: () => [],
			sendTaskSessionInput: vi.fn(
				async (_task: string, _text: string, _images: unknown, onAcceptance?: (accepted: boolean) => void) => {
					onAcceptance?.(true);
					return summary;
				},
			),
		} as unknown as AcpTaskSessionService;
		const dependencies = {
			recordManagedTaskPromptDeliveries: true,
			getScopedAcpTaskSessionService: async () => acp,
			getScopedTerminalManager: async () => ({ getSummary: () => null }) as unknown as TerminalSessionManager,
			getScopedClineTaskSessionService: vi.fn(),
			loadScopedRuntimeConfig: vi.fn(),
			resolveClineTaskSessionLaunchConfig: vi.fn(),
		};
		const workspaceScope = { workspaceId: "workspace", workspacePath: "/isolated-repo" };
		const image = { id: "image-1", data: "AQID", mimeType: "image/png" };
		const request = {
			taskId: "session-1",
			text: "查看附件",
			deliveryRequestId: "image-delivery-id",
			images: [image],
		};
		expect((await sendTaskChatMessageAcrossSessionTransports(dependencies, workspaceScope, request)).ok).toBe(true);
		await vi.waitFor(async () =>
			expect(
				(await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId["session-1"][0]
					.deliveryState,
			).toBe("settled_delivered"),
		);
		currentSummary = { ...summary, runtimeSessionIncarnationId: "incarnation-2" };
		expect((await sendTaskChatMessageAcrossSessionTransports(dependencies, workspaceScope, request)).ok).toBe(true);
		for (const images of [[], [image, image], [{ ...image, data: "AQIE" }], [{ ...image, mimeType: "image/jpeg" }]]) {
			const response = await sendTaskChatMessageAcrossSessionTransports(dependencies, workspaceScope, {
				...request,
				images,
			});
			expect(response.ok).toBe(false);
			expect(response.error).toContain("投递标识");
		}
		expect(acp.sendTaskSessionInput).toHaveBeenCalledTimes(1);
		const entry = (await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId["session-1"][0];
		expect(entry.managedDelivery?.targetRuntimeSessionIncarnationId).toBe("incarnation-1");
		expect(entry.managedDelivery?.imageAttachmentContentsSha256).toMatch(/^[a-f0-9]{64}$/u);
		const projection = buildRuntimeQueuedTaskPromptDeliveryProjection(entry, {
			resolveDispatchBlockReasonForQueuedEntry: () => null,
			currentPromptLibraryEntryTextSha256ByEntryId: null,
			nowEpochMs: Date.now(),
		});
		expect(JSON.stringify(projection)).not.toContain(image.data);
	});

	it.each([false, true])("旧记录缺附件摘要时，只有空附件仍可证明幂等，有附件=%s", async (hasImages) => {
		const request = {
			workspaceId: "workspace",
			taskId: "session-1",
			text: "旧请求",
			origin: { messageType: "human_message" as const },
			deliveryRequestId: "legacy-request-id",
			imageAttachments: hasImages ? [{ data: "AQID", mimeType: "image/png" }] : [],
		};
		await beginManagedTaskPromptDelivery(request);
		await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
			"workspace",
			(current) => {
				const entries = current.entriesByTaskId["session-1"].map((entry) => {
					if (!entry.managedDelivery) return entry;
					const legacyMetadata = { ...entry.managedDelivery };
					delete legacyMetadata.imageAttachmentContentsSha256;
					return { ...entry, managedDelivery: legacyMetadata };
				});
				return { next: { entriesByTaskId: { "session-1": entries } }, result: null };
			},
			Date.now(),
			"legacy-image-metadata-test",
		);
		if (hasImages) await expect(beginManagedTaskPromptDelivery(request)).rejects.toThrow("投递标识");
		else expect((await beginManagedTaskPromptDelivery(request)).newlyRegistered).toBe(false);
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
		expect(snapshot.entriesByTaskId["session-1"]).toHaveLength(1);
		expect(snapshot.entriesByTaskId["session-1"][0].deliveryState).toBe("handed_to_transport");
	});

	it("只有正文摘要的账本不能补证有图请求的完整内容", async () => {
		await beginManagedTaskPromptDelivery({
			workspaceId: "workspace",
			taskId: "session-1",
			text: "含附件的正文",
			origin: { messageType: "programmatic_injection" },
			idempotencyKey: "image-ledger-key",
			injectionLedgerTaskId: "board-task",
			imageAttachments: [{ data: "AQID", mimeType: "image/png" }],
		});
		const ledgerPath = getTaskMessageInjectionLedgerPath(join(isolatedRuntimeHome.path, "workspaces", "workspace"));
		const record = createPendingTaskMessageInjectionRecord({
			taskId: "board-task",
			attemptId: "session-1",
			source: "test",
			idempotencyKey: "image-ledger-key",
			promptSha256: computeQueuedTaskPromptDeliveryTextSha256("含附件的正文"),
			nowIso: new Date().toISOString(),
		});
		await withTaskMessageInjectionLedgerLock(ledgerPath, async () => ({ records: [record], result: null }));
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId: "board-task",
			idempotencyKey: "image-ledger-key",
			status: "delivered_and_submit_confirmed",
			nowIso: new Date().toISOString(),
		});
		const snapshot = await reconcileManagedTaskPromptDeliveryReceipts(
			"workspace",
			await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace"),
		);
		expect(snapshot.entriesByTaskId["session-1"][0].deliveryState).toBe("handed_to_transport");
	});
	it("即时消息不占等待队列容量、不被 dispatcher 认领，回执持久化且幂等", async () => {
		for (let index = 0; index < 21; index++)
			await beginManagedTaskPromptDelivery({
				workspaceId: "workspace",
				taskId: "session-1",
				text: `消息 ${index}`,
				origin: { messageType: "programmatic_injection", sourceLabel: "测试来源" },
				deliveryRequestId: `immediate-${index}`,
			});
		let snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
		expect(isQueuedTaskPromptDeliveryQueueFullForTask(snapshot, "session-1")).toBe(false);
		expect(
			snapshot.entriesByTaskId["session-1"].some((entry) =>
				isQueuedTaskPromptDeliveryAwaitingDispatch(entry, Date.now()),
			),
		).toBe(false);
		await mutateWorkspaceQueuedTaskPromptDeliveries("workspace", {
			kind: "enqueue_prompt_for_delivery_after_current_turn",
			taskId: "session-1",
			queueEntryId: "queued",
			text: "下一轮",
		});
		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: "workspace",
			taskId: "session-1",
			sessionIncarnationId: "current",
			turnSequence: 1,
		});
		expect(claimed?.claimedEntries.map((entry) => entry.queueEntryId)).toEqual(["queued"]);
		const repeated = await beginManagedTaskPromptDelivery({
			workspaceId: "workspace",
			taskId: "session-1",
			text: "消息 0",
			origin: { messageType: "programmatic_injection" },
			deliveryRequestId: "immediate-0",
		});
		expect(repeated.newlyRegistered).toBe(false);
		await repeated.handle.settle({ status: "delivered_and_submit_confirmed", reason: null });
		snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
		expect(snapshot.entriesByTaskId["session-1"].find((entry) => entry.queueEntryId === "immediate-0")).toMatchObject(
			{ deliveryState: "settled_delivered", managedDelivery: { sourceLabel: "测试来源" } },
		);
	});

	it("ACP 即时注入发送前登记，pending 不算送达，协议回执只产生一条结果", async () => {
		let accept: ((accepted: boolean) => void) | undefined;
		const acp = {
			getSummary: () => summary,
			listMessages: () => [],
			sendTaskSessionInput: vi.fn(
				async (_task: string, text: string, _images: unknown, onAcceptance?: (accepted: boolean) => void) => {
					const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace");
					expect(snapshot.entriesByTaskId["session-1"]).toHaveLength(1);
					expect(snapshot.entriesByTaskId["session-1"][0].text).toBe(text);
					accept = onAcceptance;
					return summary;
				},
			),
		} as unknown as AcpTaskSessionService;
		const onChanged = vi.fn(async () => {});
		const stopObserving = observeManagedTaskPromptDeliveryChanges(onChanged);
		try {
			const dependencies = {
				recordManagedTaskPromptDeliveries: true,
				getScopedAcpTaskSessionService: async () => acp,
				getScopedTerminalManager: async () => ({ getSummary: () => null }) as unknown as TerminalSessionManager,
				getScopedClineTaskSessionService: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				resolveClineTaskSessionLaunchConfig: vi.fn(),
			};
			const request = { taskId: "session-1", text: "完整注入正文", source: "rvf-decision", idempotencyKey: "key-1" };
			const response = await sendTaskChatMessageAcrossSessionTransports(
				dependencies,
				{ workspaceId: "workspace", workspacePath: "/isolated-repo" },
				request,
			);
			expect(response.terminalDelivery?.status).toBe("accepted_pending_submit_confirmation");
			expect(
				(await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId["session-1"][0]
					.deliveryState,
			).toBe("handed_to_transport");
			accept?.(true);
			await vi.waitFor(async () =>
				expect(
					(await readWorkspaceQueuedTaskPromptDeliverySnapshot("workspace")).entriesByTaskId["session-1"][0],
				).toMatchObject({
					deliveryState: "settled_delivered",
					managedDelivery: { messageType: "programmatic_injection", sourceLabel: "rvf-decision" },
				}),
			);
			await sendTaskChatMessageAcrossSessionTransports(
				dependencies,
				{ workspaceId: "workspace", workspacePath: "/isolated-repo" },
				request,
			);
			expect(acp.sendTaskSessionInput).toHaveBeenCalledTimes(1);
			expect(onChanged).toHaveBeenCalled();
		} finally {
			stopObserving();
		}
	});
});
