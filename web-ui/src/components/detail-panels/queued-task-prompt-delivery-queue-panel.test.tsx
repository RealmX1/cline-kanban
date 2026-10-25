// Queue 面板：状态 chip、队首的「为什么还没发」、上移 / 下移的边界、合并开关、重启后待确认的 Keep、
// 以及终态条目归到 Recent 里（失败的给 Requeue）。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QueuedTaskPromptDeliveryQueuePanel } from "@/components/detail-panels/queued-task-prompt-delivery-queue-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueuedTaskPromptDeliveryQueueController } from "@/hooks/use-queued-task-prompt-delivery-queue-controller";
import { createQueuedTaskPromptDeliveryFullTextReader } from "@/runtime/queued-task-prompt-delivery-query";
import type { RuntimeQueuedTaskPromptDeliveryProjection } from "@/runtime/types";

const clipboardMocks = vi.hoisted(() => ({ writeText: vi.fn() }));
const queueReadMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/utils/write-text-to-system-clipboard-with-insecure-context-fallback", () => ({
	writeTextToSystemClipboardWithInsecureContextFallback: clipboardMocks.writeText,
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { getTaskPromptDeliveryQueue: { query: queueReadMocks.query } } }),
}));

function projection(
	queueEntryId: string,
	overrides: Partial<RuntimeQueuedTaskPromptDeliveryProjection> = {},
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId,
		taskId: "task-1",
		deliveryState: "queued",
		textPreview: `正文 ${queueEntryId}`,
		textLength: 5,
		deliverTogetherWithNextQueuedEntry: false,
		dispatchBlockReason: null,
		awaitsHumanReconfirmationAfterRuntimeRestart: false,
		deliveryAttemptCount: 0,
		lastDeliveryFailureNote: null,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
		enqueuedAt: 1,
		expiresAt: 2,
		settledAt: null,
		...overrides,
	};
}

function createControllerDouble(
	projections: RuntimeQueuedTaskPromptDeliveryProjection[],
): QueuedTaskPromptDeliveryQueueController {
	return {
		projections,
		enqueuePromptForDeliveryAfterCurrentTurn: vi.fn(async () => true),
		cancelQueuedPromptDelivery: vi.fn(async () => {}),
		moveQueuedPromptDelivery: vi.fn(async () => {}),
		setQueuedPromptDeliveryMergeWithNext: vi.fn(async () => {}),
		dismissSettledQueuedPromptDelivery: vi.fn(async () => {}),
		retrySettledFailedQueuedPromptDelivery: vi.fn(async () => {}),
		reconfirmQueuedPromptDeliveriesAfterRuntimeRestart: vi.fn(async () => true),
		fetchFullText: vi.fn(() => new Promise<string | null>(() => {})),
		fetchDebugReference: vi.fn(async (entry) => ({ text: `调试引用 ${entry.queueEntryId}`, notice: null })),
	};
}

function buttonsWithLabel(container: HTMLElement, label: string): HTMLButtonElement[] {
	return Array.from(container.querySelectorAll("button")).filter(
		(candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
	);
}

describe("QueuedTaskPromptDeliveryQueuePanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		clipboardMocks.writeText.mockReset().mockResolvedValue(undefined);
		queueReadMocks.query.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function render(controller: QueuedTaskPromptDeliveryQueueController) {
		act(() => {
			root.render(
				<TooltipProvider>
					<QueuedTaskPromptDeliveryQueuePanel controller={controller} />
				</TooltipProvider>,
			);
		});
	}

	function selectMessageType(label: string) {
		const filter = container.querySelector<HTMLSelectElement>('select[aria-label="按消息类型筛选"]');
		expect(filter).not.toBeNull();
		act(() => {
			if (filter) {
				filter.value = label;
				filter.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
	}

	function selectDisplayOrder(value: string) {
		const select = container.querySelector<HTMLSelectElement>('select[aria-label="队列显示顺序"]');
		expect(select).not.toBeNull();
		act(() => {
			if (select) {
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
	}

	function displayedQueueEntryIds() {
		return Array.from(container.querySelectorAll("[data-queued-prompt-entry-id]")).map((row) =>
			row.getAttribute("data-queued-prompt-entry-id"),
		);
	}

	it("时间不显示年份，尝试次数置于时间信息之外", () => {
		const enqueuedAt = Date.parse("2026-10-24T12:00:00Z");
		render(
			createControllerDouble([
				projection("metadata", { enqueuedAt, deliveryAttemptCount: 1, lastAttemptedAt: enqueuedAt }),
			]),
		);
		const row = container.querySelector('[data-queued-prompt-entry-id="metadata"]');
		expect(row?.textContent).toContain("尝试次数：1");
		expect(row?.querySelector("dl")?.textContent).not.toContain("尝试次数");
		expect(row?.textContent).toContain("最近投递：");
		expect(row?.textContent).not.toContain("最近投递开始");
		for (const timestamp of row?.querySelectorAll("time") ?? []) {
			expect(timestamp.textContent).not.toMatch(/2026|1970/);
			expect(timestamp.getAttribute("title")).toMatch(/^\d{4}-/);
		}
	});

	it("无需新推送也会递增距上次尝试时长，新的尝试立即重新计时", () => {
		vi.useFakeTimers();
		const now = Date.parse("2026-10-25T12:00:00Z");
		vi.setSystemTime(now);
		const controller = createControllerDouble([
			projection("elapsed", { deliveryAttemptCount: 1, lastAttemptedAt: now - 59_000 }),
		]);
		render(controller);
		expect(container.textContent).toContain("距上次尝试：59 秒");
		act(() => vi.advanceTimersByTime(1_000));
		expect(container.textContent).toContain("距上次尝试：1 分钟");
		render({
			...controller,
			projections: [projection("elapsed", { deliveryAttemptCount: 2, lastAttemptedAt: Date.now() })],
		});
		expect(container.textContent).toContain("距上次尝试：0 秒");
	});

	it("未尝试、时间缺失及未来时钟分别如实展示", () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
		render(
			createControllerDouble([
				projection("never"),
				projection("unknown", { deliveryAttemptCount: 2 }),
				projection("future", { deliveryAttemptCount: 1, lastAttemptedAt: Date.now() + 60_000 }),
			]),
		);
		expect(container.querySelector('[data-queued-prompt-entry-id="never"]')?.textContent).toContain(
			"距上次尝试：尚未尝试",
		);
		expect(container.querySelector('[data-queued-prompt-entry-id="unknown"]')?.textContent).toContain(
			"距上次尝试：时间未知",
		);
		expect(container.querySelector('[data-queued-prompt-entry-id="future"]')?.textContent).toContain(
			"距上次尝试：0 秒",
		);
	});

	it("页面隐藏时停止时钟，重新可见时立即补齐经过时长", () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.parse("2026-10-25T12:00:00Z"));
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		render(
			createControllerDouble([
				projection("visible-clock", { deliveryAttemptCount: 1, lastAttemptedAt: Date.now() - 30_000 }),
			]),
		);
		expect(container.textContent).toContain("距上次尝试：30 秒");
		act(() => {
			visibility.mockReturnValue("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		act(() => vi.advanceTimersByTime(120_000));
		expect(container.textContent).toContain("距上次尝试：30 秒");
		act(() => {
			visibility.mockReturnValue("visible");
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(container.textContent).toContain("距上次尝试：2 分钟");
	});

	it("时间排序只改变显示，保留真实投递序号，切回后恢复重排与合并操作", () => {
		const controller = createControllerDouble([
			projection("manual-first", {
				enqueuedAt: 30,
				deliveryAttemptCount: 1,
				lastAttemptedAt: 100,
				deliverTogetherWithNextQueuedEntry: true,
			}),
			projection("enqueued-first", { enqueuedAt: 10 }),
			projection("recent-first", { enqueuedAt: 20, deliveryAttemptCount: 1, lastAttemptedAt: 200 }),
			projection("unknown", { enqueuedAt: 15, deliveryAttemptCount: 2 }),
		]);
		render(controller);
		expect(displayedQueueEntryIds()).toEqual(["manual-first", "enqueued-first", "recent-first", "unknown"]);
		selectDisplayOrder("last_attempt_newest_first");
		expect(displayedQueueEntryIds()).toEqual(["recent-first", "manual-first", "enqueued-first", "unknown"]);
		expect(container.querySelector('[data-queued-prompt-entry-id="recent-first"]')?.textContent).toContain("投递 #3");
		expect(buttonsWithLabel(container, "Move queued prompt up")).toHaveLength(0);
		expect(buttonsWithLabel(container, "Link with next queued prompt")).toHaveLength(0);
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(0);
		selectDisplayOrder("enqueued_oldest_first");
		expect(displayedQueueEntryIds()).toEqual(["enqueued-first", "unknown", "recent-first", "manual-first"]);
		selectDisplayOrder("delivery_order");
		expect(displayedQueueEntryIds()).toEqual(controller.projections.map((entry) => entry.queueEntryId));
		expect(buttonsWithLabel(container, "Move queued prompt up")).toHaveLength(4);
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(1);
		expect(controller.moveQueuedPromptDelivery).not.toHaveBeenCalled();
		expect(controller.setQueuedPromptDeliveryMergeWithNext).not.toHaveBeenCalled();
	});

	it("时间排序与类型筛选组合，终态分区保留且相同时间保持原序", () => {
		render(
			createControllerDouble([
				projection("hidden", { sourcePromptLibraryEntryId: "library", enqueuedAt: 1 }),
				projection("stable-first", { enqueuedAt: 20 }),
				projection("stable-second", { enqueuedAt: 20 }),
				projection("settled-later", { deliveryState: "settled_failed", enqueuedAt: 15 }),
				projection("settled-earlier", { deliveryState: "settled_delivered", enqueuedAt: 5 }),
			]),
		);
		selectMessageType("人工发送");
		selectDisplayOrder("enqueued_oldest_first");
		expect(displayedQueueEntryIds()).toEqual(["stable-first", "stable-second", "settled-earlier", "settled-later"]);
		expect(container.querySelector('[data-queued-prompt-entry-id="stable-first"]')?.textContent).toContain("投递 #2");
	});

	it("准备全文后一次点击复制完整正文，保留换行与首尾空白", async () => {
		const fullText = `  ${"很长的正文".repeat(80)}\n第二行\n  `;
		const controller = createControllerDouble([
			projection("copy", { textPreview: "很长的正文…", textLength: fullText.length }),
		]);
		vi.mocked(controller.fetchFullText).mockResolvedValue(fullText);
		await act(async () => render(controller));
		const copyButton = buttonsWithLabel(container, "复制全文")[0];
		expect(copyButton?.disabled).toBe(false);
		await act(async () => copyButton?.click());
		expect(clipboardMocks.writeText).toHaveBeenCalledWith(fullText);
		expect(container.textContent).toContain("已复制全文");
		await act(async () => buttonsWithLabel(container, `展开全文（${fullText.length} 字符）`)[0]?.click());
		expect(container.textContent).toContain("第二行");
		expect(controller.fetchFullText).toHaveBeenCalledTimes(1);
	});

	it("新行加入旧快照读取后自动准备全文，无需点击重试", async () => {
		let releaseEarlierSnapshot!: () => void;
		const newEntryFullText = "  后加入消息的完整正文\n第二行  ";
		queueReadMocks.query
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseEarlierSnapshot = () =>
							resolve({
								ok: true,
								queue: { entriesByTaskId: { "task-1": [{ queueEntryId: "first", text: "第一条" }] } },
							});
					}),
			)
			.mockResolvedValueOnce({
				ok: true,
				queue: { entriesByTaskId: { "task-1": [{ queueEntryId: "second", text: newEntryFullText }] } },
			});
		const controller = createControllerDouble([projection("first")]);
		controller.fetchFullText = createQueuedTaskPromptDeliveryFullTextReader("workspace", "task-1");
		render(controller);
		controller.projections = [
			...controller.projections,
			projection("second", { textPreview: "后加入消息…", textLength: newEntryFullText.length }),
		];
		render(controller);
		const newEntryRow = container.querySelector<HTMLElement>('[data-queued-prompt-entry-id="second"]');
		expect(newEntryRow).not.toBeNull();
		if (!newEntryRow) throw new Error("未渲染后加入的消息行");
		expect(buttonsWithLabel(newEntryRow, "复制全文")[0]?.disabled).toBe(true);
		expect(queueReadMocks.query).toHaveBeenCalledTimes(1);
		await act(async () => releaseEarlierSnapshot());
		expect(queueReadMocks.query).toHaveBeenCalledTimes(2);
		expect(newEntryRow.textContent).not.toContain("无法读取全文");
		expect(buttonsWithLabel(newEntryRow, "复制全文")[0]?.disabled).toBe(false);
		const expandButton = buttonsWithLabel(newEntryRow, `展开全文（${newEntryFullText.length} 字符）`)[0];
		expect(expandButton?.disabled).toBe(false);
		await act(async () => expandButton?.click());
		expect(newEntryRow.textContent).toContain(newEntryFullText);
		await act(async () => buttonsWithLabel(newEntryRow, "复制全文")[0]?.click());
		expect(clipboardMocks.writeText).toHaveBeenCalledWith(newEntryFullText);
	});

	it("全文读取失败可重试，不能把截断预览复制成全文", async () => {
		const controller = createControllerDouble([projection("retry")]);
		vi.mocked(controller.fetchFullText).mockResolvedValueOnce(null).mockResolvedValueOnce("恢复的完整正文");
		await act(async () => render(controller));
		expect(buttonsWithLabel(container, "复制全文")[0]?.disabled).toBe(true);
		expect(container.textContent).toContain("无法读取全文");
		await act(async () => buttonsWithLabel(container, "重新读取全文")[0]?.click());
		await act(async () => buttonsWithLabel(container, "复制全文")[0]?.click());
		expect(clipboardMocks.writeText).toHaveBeenCalledWith("恢复的完整正文");
	});

	it("剪贴板拒绝后保留可选的完整正文，失败不显示成功", async () => {
		const controller = createControllerDouble([projection("copy-failed")]);
		vi.mocked(controller.fetchFullText).mockResolvedValue("供手动复制的完整正文\n下一行");
		clipboardMocks.writeText.mockRejectedValue(new Error("拒绝"));
		await act(async () => render(controller));
		await act(async () => buttonsWithLabel(container, "复制全文")[0]?.click());
		expect(container.textContent).toContain("复制失败");
		expect(container.textContent).not.toContain("已复制全文");
		expect(
			container.querySelector<HTMLTextAreaElement>('textarea[aria-label="可手动复制的 Prompt 全文"]')?.value,
		).toBe("供手动复制的完整正文\n下一行");
	});

	it("切换项目或会话后不会使用旧全文请求的迟到结果", async () => {
		let resolveOldText: ((value: string) => void) | undefined;
		const previousController = createControllerDouble([projection("same-entry")]);
		vi.mocked(previousController.fetchFullText).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveOldText = resolve;
				}),
		);
		render(previousController);
		const nextController = createControllerDouble([projection("same-entry")]);
		vi.mocked(nextController.fetchFullText).mockResolvedValue("当前会话全文");
		await act(async () => render(nextController));
		await act(async () => resolveOldText?.("旧会话全文"));
		await act(async () => buttonsWithLabel(container, "复制全文")[0]?.click());
		expect(clipboardMocks.writeText).toHaveBeenCalledWith("当前会话全文");
		expect(clipboardMocks.writeText).not.toHaveBeenCalledWith("旧会话全文");
	});

	it("空队列给一句引导", () => {
		render(createControllerDouble([]));
		expect(container.textContent).toContain("当前没有待投递消息");
	});

	it("即时注入与启动提示分型展示，可筛选，且不显示重排或合并操作", () => {
		const controller = createControllerDouble([
			projection("immediate", {
				deliveryState: "handed_to_transport",
				managedDelivery: {
					messageType: "programmatic_injection",
					sourceLabel: "RVF",
					deliveryStrategy: "immediate",
					imageAttachmentCount: 1,
					terminalDeliveryReceipt: null,
				},
			}),
			projection("startup", {
				deliveryState: "settled_failed",
				lastDeliveryFailureNote: "尚未确认",
				managedDelivery: {
					messageType: "session_startup",
					sourceLabel: "ACP",
					deliveryStrategy: "session_startup",
					imageAttachmentCount: 0,
					terminalDeliveryReceipt: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
				},
			}),
		]);
		render(controller);
		expect(container.textContent).toContain("自动注入");
		expect(container.textContent).toContain("启动提示");
		expect(container.textContent).toContain("未确认送达");
		expect(container.textContent).toContain("1 个附件");
		expect(buttonsWithLabel(container, "Move queued prompt up")).toHaveLength(0);
		expect(buttonsWithLabel(container, "Link with next queued prompt")).toHaveLength(0);
		expect(buttonsWithLabel(container, "重新排队")).toHaveLength(0);
		const filter = container.querySelector("select");
		act(() => {
			if (filter) {
				filter.value = "自动注入";
				filter.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(container.querySelector('[data-queued-prompt-entry-id="startup"]')).toBeNull();
		expect(container.querySelector('[data-queued-prompt-entry-id="immediate"]')).not.toBeNull();
	});

	it("直接展示入队时间、尝试次数和最近尝试开始时间，推送后更新", () => {
		const enqueuedAt = Date.parse("2026-10-24T12:00:00Z");
		const expiresAt = enqueuedAt + 86_400_000;
		render(createControllerDouble([projection("timed", { enqueuedAt, expiresAt })]));
		const row = container.querySelector('[data-queued-prompt-entry-id="timed"]');
		expect(row?.textContent).toContain("入队时间");
		expect(row?.textContent).toContain("尝试次数：0");
		expect(row?.textContent).toContain("尚未尝试");
		expect(row?.querySelector(`time[datetime="${new Date(enqueuedAt).toISOString()}"]`)).not.toBeNull();
		expect(row?.querySelector(`time[datetime="${new Date(expiresAt).toISOString()}"]`)).not.toBeNull();
		const lastAttemptedAt = enqueuedAt + 60_000;
		render(
			createControllerDouble([
				projection("timed", { enqueuedAt, expiresAt, deliveryAttemptCount: 1, ...{ lastAttemptedAt } }),
			]),
		);
		expect(row?.textContent).toContain("尝试次数：1");
		expect(row?.textContent).toContain("最近投递：");
		expect(row?.querySelector(`time[datetime="${new Date(lastAttemptedAt).toISOString()}"]`)).not.toBeNull();
	});

	it("旧投影有尝试次数但缺少时间时明确显示时间未知", () => {
		render(createControllerDouble([projection("legacy", { deliveryAttemptCount: 2 })]));
		expect(container.textContent).toContain("尝试次数：2");
		expect(container.textContent).toContain("时间未知");
		expect(container.textContent).not.toContain("尚未尝试");
	});

	it("展开后才读取调试引用，准备完毕后可复制引用和检索指导", async () => {
		const controller = createControllerDouble([projection("debug-entry")]);
		render(controller);
		expect(controller.fetchDebugReference).not.toHaveBeenCalled();
		await act(async () => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		expect(controller.fetchDebugReference).toHaveBeenCalledWith(controller.projections[0]);
		const referenceTextArea = container.querySelector("textarea");
		expect(referenceTextArea?.value).toBe("调试引用 debug-entry");
		await act(async () => {
			buttonsWithLabel(container, "复制引用与检索指导")[0]?.click();
		});
		expect(clipboardMocks.writeText).toHaveBeenCalledWith("调试引用 debug-entry");
		expect(container.textContent).toContain("已复制");
	});

	it("剪贴板失败保留可手动复制的引用，不能显示复制成功", async () => {
		clipboardMocks.writeText.mockRejectedValue(new Error("拒绝写剪贴板"));
		render(createControllerDouble([projection("debug-entry")]));
		await act(async () => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		await act(async () => {
			buttonsWithLabel(container, "复制引用与检索指导")[0]?.click();
		});
		expect(container.textContent).toContain("复制失败");
		expect(container.textContent).not.toContain("已复制");
		expect(container.querySelector("textarea")?.value).toBe("调试引用 debug-entry");
	});

	it("读取缺口提示不妨碍复制已知引用，重新展开会补读", async () => {
		const controller = createControllerDouble([projection("debug-entry")]);
		vi.mocked(controller.fetchDebugReference).mockResolvedValue({
			text: "已知标识",
			notice: "无法读取当前运行时队列",
		});
		render(controller);
		await act(async () => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		expect(container.textContent).toContain("无法读取当前运行时队列");
		expect(buttonsWithLabel(container, "复制引用与检索指导")[0]?.disabled).toBe(false);
		await act(async () => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		await act(async () => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		expect(controller.fetchDebugReference).toHaveBeenCalledTimes(2);
	});

	it("切换项目或会话后忽略旧请求的迟到引用", async () => {
		const controller = createControllerDouble([projection("same-entry")]);
		let resolveReference: ((value: { text: string; notice: null }) => void) | undefined;
		vi.mocked(controller.fetchDebugReference).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveReference = resolve;
				}),
		);
		render(controller);
		act(() => {
			buttonsWithLabel(container, "调试引用")[0]?.click();
		});
		expect(controller.fetchDebugReference).toHaveBeenCalledTimes(1);
		render(createControllerDouble([projection("same-entry")]));
		await act(async () => {
			resolveReference?.({ text: "其他项目的迟到引用", notice: null });
		});
		expect(container.textContent).not.toContain("其他项目的迟到引用");
		expect(container.querySelector("textarea")).toBeNull();
	});

	it("Recent 按终态标明结果时间，过期使用期限而非清理时间", () => {
		const expiresAt = Date.parse("2026-10-24T12:00:00Z");
		const settledAt = expiresAt + 60_000;
		render(
			createControllerDouble(
				(["settled_delivered", "settled_failed", "cancelled", "expired"] as const).map((deliveryState) =>
					projection(deliveryState, { deliveryState, expiresAt, settledAt }),
				),
			),
		);
		for (const [deliveryState, label] of [
			["settled_delivered", "送达时间"],
			["settled_failed", "失败时间"],
			["cancelled", "取消时间"],
			["expired", "过期时间"],
		]) {
			const row = container.querySelector(`[data-queued-prompt-entry-id="${deliveryState}"]`);
			expect(row?.textContent).toContain(label);
			const expectedTimestamp = deliveryState === "expired" ? expiresAt : settledAt;
			expect(row?.querySelector(`time[datetime="${new Date(expectedTimestamp).toISOString()}"]`)).not.toBeNull();
		}
	});

	it("按顺序列出待发条目，队首写明为什么还没发", () => {
		render(
			createControllerDouble([
				projection("q1", { dispatchBlockReason: "agent_still_generating" }),
				projection("q2", { dispatchBlockReason: "agent_still_generating" }),
			]),
		);
		const rows = Array.from(container.querySelectorAll("[data-queued-prompt-entry-id]")).map((row) =>
			row.getAttribute("data-queued-prompt-entry-id"),
		);
		expect(rows).toEqual(["q1", "q2"]);
		expect(container.textContent).toContain("等待 agent 结束当前回合。");
	});

	it("首行不能上移、末行不能下移；中间点击发出对应意图", () => {
		const controller = createControllerDouble([projection("q1"), projection("q2"), projection("q3")]);
		render(controller);
		const moveUpButtons = buttonsWithLabel(container, "Move queued prompt up");
		const moveDownButtons = buttonsWithLabel(container, "Move queued prompt down");
		expect(moveUpButtons[0]?.disabled).toBe(true);
		expect(moveDownButtons[2]?.disabled).toBe(true);
		act(() => {
			moveUpButtons[1]?.click();
		});
		expect(controller.moveQueuedPromptDelivery).toHaveBeenCalledWith("q2", "up");
	});

	it("相邻两行之间的链条开关切换合并", () => {
		const controller = createControllerDouble([projection("q1"), projection("q2")]);
		render(controller);
		const linkButtons = buttonsWithLabel(container, "Link with next queued prompt");
		expect(linkButtons).toHaveLength(1);
		act(() => {
			linkButtons[0]?.click();
		});
		expect(controller.setQueuedPromptDeliveryMergeWithNext).toHaveBeenCalledWith("q1", true);
	});

	it.each([false, true])("筛选隐藏 A/B/C 中间的 B 后，A/C 不显示合并控件或连线（A 原合并值：%s）", (isMerged) => {
		const controller = createControllerDouble([
			projection("A", { deliverTogetherWithNextQueuedEntry: isMerged }),
			projection("B", { sourcePromptLibraryEntryId: "library-entry" }),
			projection("C"),
		]);
		render(controller);
		selectMessageType("人工发送");
		expect(
			Array.from(container.querySelectorAll("[data-queued-prompt-entry-id]")).map((row) =>
				row.getAttribute("data-queued-prompt-entry-id"),
			),
		).toEqual(["A", "C"]);
		expect(buttonsWithLabel(container, "Link with next queued prompt")).toHaveLength(0);
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(0);
		for (const queueEntryId of ["A", "C"]) {
			expect(container.querySelector(`[data-queued-prompt-entry-id="${queueEntryId}"]`)?.className).not.toContain(
				"border-l-accent",
			);
		}
		expect(controller.setQueuedPromptDeliveryMergeWithNext).not.toHaveBeenCalled();

		selectMessageType("all");
		expect(buttonsWithLabel(container, "Link with next queued prompt")).toHaveLength(isMerged ? 1 : 2);
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(isMerged ? 1 : 0);
		act(() => {
			buttonsWithLabel(
				container,
				isMerged ? "Unlink from next queued prompt" : "Link with next queued prompt",
			)[0]?.click();
		});
		expect(controller.setQueuedPromptDeliveryMergeWithNext).toHaveBeenCalledWith("A", !isMerged);
	});

	it("筛选仍保留真实相邻且可见的两条记录的合并操作", () => {
		const controller = createControllerDouble([
			projection("hidden-library", { sourcePromptLibraryEntryId: "library-entry" }),
			projection("human-1", { deliverTogetherWithNextQueuedEntry: true }),
			projection("human-2"),
		]);
		render(controller);
		selectMessageType("人工发送");
		const unlinkButtons = buttonsWithLabel(container, "Unlink from next queued prompt");
		expect(unlinkButtons).toHaveLength(1);
		expect(unlinkButtons[0]?.disabled).toBe(false);
		for (const queueEntryId of ["human-1", "human-2"]) {
			expect(container.querySelector(`[data-queued-prompt-entry-id="${queueEntryId}"]`)?.className).toContain(
				"border-l-accent",
			);
		}
		act(() => {
			unlinkButtons[0]?.click();
		});
		expect(controller.setQueuedPromptDeliveryMergeWithNext).toHaveBeenCalledWith("human-1", false);
	});

	// 那一串在认领时就冻结了：此时改开关，界面显示的与实际发出去的会不一致。
	it("任一侧已在发送时合并开关禁用", () => {
		const controller = createControllerDouble([
			projection("q1", { deliveryState: "handed_to_transport" }),
			projection("q2"),
			projection("q3"),
		]);
		render(controller);
		const toggles = [
			...buttonsWithLabel(container, "Link with next queued prompt"),
			...buttonsWithLabel(container, "Unlink from next queued prompt"),
		];
		expect(toggles).toHaveLength(2);
		expect(toggles[0]?.disabled).toBe(true);
		expect(toggles[1]?.disabled).toBe(false);
	});

	it("重启后待确认的条目给 Keep（显式版的同一条确认）", () => {
		const controller = createControllerDouble([
			projection("q1", {
				awaitsHumanReconfirmationAfterRuntimeRestart: true,
				dispatchBlockReason: "awaiting_human_reconfirmation_after_runtime_restart",
			}),
		]);
		render(controller);
		expect(container.textContent).toContain("此消息在重启前排入");
		act(() => {
			buttonsWithLabel(container, "保留")[0]?.click();
		});
		expect(controller.reconfirmQueuedPromptDeliveriesAfterRuntimeRestart).toHaveBeenCalledWith(["q1"]);
	});

	it("终态条目归到 Recent，失败的给 Requeue 并显示失败说明", () => {
		const controller = createControllerDouble([
			projection("q1"),
			projection("done", { deliveryState: "settled_delivered" }),
			projection("failed", {
				deliveryState: "settled_failed",
				lastDeliveryFailureNote: "It may still be sitting in the input box.",
			}),
		]);
		render(controller);
		expect(container.textContent).toContain("最近结果");
		expect(container.textContent).toContain("It may still be sitting in the input box.");
		const requeueButtons = buttonsWithLabel(container, "重新排队");
		expect(requeueButtons).toHaveLength(1);
		act(() => {
			requeueButtons[0]?.click();
		});
		expect(controller.retrySettledFailedQueuedPromptDelivery).toHaveBeenCalledWith("failed");
	});

	// 程序化条目（kanban task message --deliver-when-agent-idle）永远独占一次投递：服务端在它前面断链，
	// 界面不能显示一条「会一起发」的链、也不能让人点亮它两侧的开关。
	it("程序化条目挂 Automated 徽标；它两侧的合并开关禁用，链条竖线不跨过它", () => {
		const controller = createControllerDouble([
			projection("human-1", { deliverTogetherWithNextQueuedEntry: true }),
			projection("rvf", { programmaticInjectionSource: "rvf-out-of-band-decision-point" }),
			projection("human-2"),
		]);
		render(controller);
		expect(container.textContent).toContain("rvf-out-of-band-decision-point");
		const toggles = [
			...buttonsWithLabel(container, "Link with next queued prompt"),
			...buttonsWithLabel(container, "Unlink from next queued prompt"),
		];
		expect(toggles).toHaveLength(2);
		expect(toggles.every((toggle) => toggle.disabled)).toBe(true);
		// human-1 存着的开关值是 true，但它的下一条是程序化条目 ⇒ 实际不会一起发，界面不画「已合并」。
		expect(buttonsWithLabel(container, "Unlink from next queued prompt")).toHaveLength(0);
		const humanRow = container.querySelector('[data-queued-prompt-entry-id="human-1"]');
		expect(humanRow?.className).not.toContain("border-l-accent");
	});

	it("程序化条目到截止仍没等到 agent 空闲 ⇒ Recent 里说清楚没发的原因", () => {
		const controller = createControllerDouble([
			projection("rvf", { deliveryState: "expired", programmaticInjectionSource: "rvf" }),
		]);
		render(controller);
		expect(container.textContent).toContain("The agent never became idle before the automation's deadline");
	});

	it("正在发送的条目也能尝试取消（晚了由服务端回执如实告知）", () => {
		const controller = createControllerDouble([projection("q1", { deliveryState: "handed_to_transport" })]);
		render(controller);
		const cancelButton = buttonsWithLabel(container, "Cancel queued prompt")[0];
		expect(cancelButton?.disabled).toBe(false);
		act(() => {
			cancelButton?.click();
		});
		expect(controller.cancelQueuedPromptDelivery).toHaveBeenCalledWith("q1");
	});
});
