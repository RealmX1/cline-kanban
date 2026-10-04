import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	boardTaskCardAnchorKey,
	VERIFICATION_ANCHOR_ATTR,
	VERIFICATION_SPOTLIGHT_CLASS,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import {
	type RevealCanonicalTaskCardController,
	useRevealCanonicalTaskCard,
} from "@/hooks/use-reveal-canonical-task-card";

const TASK_ID_OF_CANONICAL_CARD_UNDER_TEST = "task-whose-canonical-card-is-revealed";

/**
 * hook 靠 rAF 逐帧重试等本体卡挂进 DOM，用例必须能精确控制「跑到第几帧」，
 * 所以把 requestAnimationFrame / cancelAnimationFrame 换成手动驱动的队列。
 */
function installManuallyDrivenAnimationFrameQueue(): {
	runAnimationFrames: (frameCount: number) => Promise<void>;
	countAnimationFramesStillScheduled: () => number;
} {
	const frameCallbacksByHandle = new Map<number, FrameRequestCallback>();
	let nextAnimationFrameHandle = 1;

	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
		const handle = nextAnimationFrameHandle;
		nextAnimationFrameHandle += 1;
		frameCallbacksByHandle.set(handle, callback);
		return handle;
	});
	vi.stubGlobal("cancelAnimationFrame", (handle: number): void => {
		frameCallbacksByHandle.delete(handle);
	});

	return {
		runAnimationFrames: async (frameCount: number): Promise<void> => {
			for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
				const callbacksDueThisFrame = [...frameCallbacksByHandle.values()];
				frameCallbacksByHandle.clear();
				await act(async () => {
					for (const callback of callbacksDueThisFrame) {
						callback(0);
					}
				});
			}
		},
		countAnimationFramesStillScheduled: (): number => frameCallbacksByHandle.size,
	};
}

/**
 * 统计元素 class 属性被改写的次数。
 * MutationObserver 的记录会在 microtask 检查点交付给回调，而本用例里穿插着 `await act(...)`，
 * 光靠 takeRecords() 会漏掉已交付的那批——所以回调与 takeRecords() 两头都要计。
 */
function observeClassAttributeMutationCount(element: Element): () => number {
	let mutationCountDeliveredToCallback = 0;
	const observer = new MutationObserver((records) => {
		mutationCountDeliveredToCallback += records.length;
	});
	observer.observe(element, { attributes: true, attributeFilter: ["class"] });
	return (): number => {
		const drainedCount = mutationCountDeliveredToCallback + observer.takeRecords().length;
		mutationCountDeliveredToCallback = 0;
		return drainedCount;
	};
}

function attachCanonicalTaskCardAnchorToDocument(taskId: string): HTMLDivElement {
	const anchorElement = document.createElement("div");
	anchorElement.setAttribute(VERIFICATION_ANCHOR_ATTR, boardTaskCardAnchorKey(taskId));
	anchorElement.scrollIntoView = vi.fn();
	document.body.appendChild(anchorElement);
	return anchorElement;
}

describe("useRevealCanonicalTaskCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let animationFrameQueue: ReturnType<typeof installManuallyDrivenAnimationFrameQueue>;
	let controller: RevealCanonicalTaskCardController | null;
	let taskIdsHandedToPrepareRevealTarget: string[];

	function RevealControllerProbe(): null {
		controller = useRevealCanonicalTaskCard({
			prepareRevealTarget: (taskId) => {
				taskIdsHandedToPrepareRevealTarget.push(taskId);
			},
		});
		return null;
	}

	const requestReveal = async (taskId: string): Promise<void> => {
		await act(async () => {
			controller?.requestRevealCanonicalTaskCard(taskId);
		});
	};

	beforeEach(async () => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		animationFrameQueue = installManuallyDrivenAnimationFrameQueue();
		controller = null;
		taskIdsHandedToPrepareRevealTarget = [];
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root.render(<RevealControllerProbe />);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		document.body.innerHTML = "";
		vi.unstubAllGlobals();
		vi.useRealTimers();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("本体卡已在 DOM 里时，首次请求当帧就滚入视野并挂上高亮类", async () => {
		const anchorElement = attachCanonicalTaskCardAnchorToDocument(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);

		await requestReveal(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		expect(controller?.taskIdRequestedToReveal).toBe(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);

		await animationFrameQueue.runAnimationFrames(1);

		expect(anchorElement.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);
		// 命中即清空请求，避免列表长期被钉在 ensureVisibleIndex 上。
		expect(controller?.taskIdRequestedToReveal).toBeNull();
	});

	it("上一轮重试仍在途时再次请求同一张卡，重试预算必须整轮重置", async () => {
		// 本体卡此刻不在 DOM 里（渐进渲染没挂到 / 分段折叠），第一轮请求只能空转重试。
		await requestReveal(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		await animationFrameQueue.runAnimationFrames(29);
		expect(taskIdsHandedToPrepareRevealTarget).toHaveLength(1);

		// 用户见没反应又点了一次同一个 stage 标签：这一次必须当作全新请求重跑，
		// 而不是被 React 的同值 bailout 吞掉、继续啃上一轮只剩 1 帧的预算。
		await requestReveal(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		expect(taskIdsHandedToPrepareRevealTarget).toHaveLength(2);

		await animationFrameQueue.runAnimationFrames(5);
		expect(animationFrameQueue.countAnimationFramesStillScheduled()).toBe(1);

		const anchorElement = attachCanonicalTaskCardAnchorToDocument(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		await animationFrameQueue.runAnimationFrames(1);

		expect(anchorElement.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);
	});

	it("高亮还没熄灭时再次请求同一张卡，会重播高亮并把熄灭时刻整段后延", async () => {
		const anchorElement = attachCanonicalTaskCardAnchorToDocument(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		const drainClassAttributeMutationCount = observeClassAttributeMutationCount(anchorElement);

		await requestReveal(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		await animationFrameQueue.runAnimationFrames(1);
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);
		drainClassAttributeMutationCount();

		// 第一次高亮的默认时长是 2800ms，在它还亮着的时候连点第二下。
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		await requestReveal(TASK_ID_OF_CANONICAL_CARD_UNDER_TEST);
		await animationFrameQueue.runAnimationFrames(1);

		expect(anchorElement.scrollIntoView).toHaveBeenCalledTimes(2);
		// 高亮类必须被摘掉再挂回去，否则 CSS 脉冲动画不会重新播放。
		expect(drainClassAttributeMutationCount()).toBeGreaterThanOrEqual(2);
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);

		// 熄灭时刻应跟着第二次请求整段后延，而不是被第一次留下的旧计时器提前掐掉。
		await act(async () => {
			vi.advanceTimersByTime(1800);
		});
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(true);

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(anchorElement.classList.contains(VERIFICATION_SPOTLIGHT_CLASS)).toBe(false);
	});
});
