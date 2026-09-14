import { useCallback, useEffect, useRef, useState } from "react";

import {
	boardTaskCardAnchorKey,
	spotlightAnchor,
} from "@/components/post-deploy-verification/verification-anchor-registry";

/**
 * 「把某个任务的**本体卡**滚进视野并脉冲高亮」的共用控制器。
 *
 * 置顶板里的分身刻意不带 `data-task-id` / `data-verification-anchor`（见 `TaskCardBodyRenderRole`），
 * 所以点分身上的 stage 标签时，要跳的目标一定是那张仍待在原 stage 列表里的本体卡。
 * 但本体卡此刻**可能根本不在 DOM 里**，成因有二，各需一道兜底：
 *
 * 1. 渐进渲染：长列表初始只挂载前 10 张。→ 把请求中的 taskId 交给对应列表算出索引，
 *    经 `useProgressiveRenderCount` 的 `ensureVisibleIndex` 强制挂载（该值只增不减，故请求清掉后不会反向卸载）。
 * 2. stage 分段折叠（仅 Focus View）：整段 `display:none` 时 `scrollIntoView` 无效。
 *    → 调用方在 `prepareRevealTarget` 里先展开目标分段。
 *
 * 两道兜底都要等下一次 commit 才生效，因此这里用 rAF 逐帧重试，命中即高亮。
 */

/** 最多重试的帧数：覆盖「展开分段 + 渐进渲染扩容 + 布局」这一串异步 commit，超时即安静放弃。 */
const REVEAL_RETRY_FRAME_BUDGET = 30;

/** 一次「把本体卡滚进视野并脉冲高亮」的在途请求。 */
interface CanonicalTaskCardRevealRequest {
	taskId: string;
	/**
	 * 单调递增的请求序号。连点同一张卡时 taskId 不变，只有它在变——
	 * 它存在的唯一理由，就是让每次请求都产生一个**必然不等于上一个**的 state 值，
	 * 从而保证 effect 一定重跑：取消上一轮 rAF 重试、重新拿满整轮重试预算、重播一次高亮。
	 *
	 * 这里曾经写成 `set(null); set(taskId)` 并注释成「强制 effect 重跑」，但那是自欺：
	 * React 会把同一个事件处理器里的两次 setState 批处理成单次最终更新，最终值仍是同一个 taskId，
	 * `Object.is` 相等即 bailout，组件不重渲、effect 依赖没变、effect 根本不会重跑。
	 */
	revealRequestSequenceNumber: number;
}

export interface RevealCanonicalTaskCardController {
	/** 当前请求跳转的任务 id；列表据此计算 `ensureVisibleIndex`。无请求时为 null。 */
	taskIdRequestedToReveal: string | null;
	requestRevealCanonicalTaskCard: (taskId: string) => void;
}

export function useRevealCanonicalTaskCard({
	prepareRevealTarget,
}: {
	/** 在发起请求的同一帧同步执行，用于「先展开目标所在的折叠分段」这类前置准备。 */
	prepareRevealTarget?: (taskId: string) => void;
} = {}): RevealCanonicalTaskCardController {
	const [pendingRevealRequest, setPendingRevealRequest] = useState<CanonicalTaskCardRevealRequest | null>(null);
	const prepareRevealTargetRef = useRef(prepareRevealTarget);
	prepareRevealTargetRef.current = prepareRevealTarget;

	const requestRevealCanonicalTaskCard = useCallback((taskId: string) => {
		prepareRevealTargetRef.current?.(taskId);
		// 连点同一张卡也要从头重播一次：序号必然递增 ⇒ state 必然是新值 ⇒ effect 必然重跑。
		setPendingRevealRequest((previousRevealRequest) => ({
			taskId,
			revealRequestSequenceNumber: (previousRevealRequest?.revealRequestSequenceNumber ?? 0) + 1,
		}));
	}, []);

	useEffect(() => {
		if (pendingRevealRequest == null) {
			return;
		}
		const taskIdToReveal = pendingRevealRequest.taskId;
		let remainingFrames = REVEAL_RETRY_FRAME_BUDGET;
		let animationFrameHandle = 0;
		let isCancelled = false;

		const attemptReveal = (): void => {
			if (isCancelled) {
				return;
			}
			if (spotlightAnchor(boardTaskCardAnchorKey(taskIdToReveal))) {
				setPendingRevealRequest(null);
				return;
			}
			remainingFrames -= 1;
			if (remainingFrames <= 0) {
				setPendingRevealRequest(null);
				return;
			}
			animationFrameHandle = requestAnimationFrame(attemptReveal);
		};

		animationFrameHandle = requestAnimationFrame(attemptReveal);
		return () => {
			isCancelled = true;
			cancelAnimationFrame(animationFrameHandle);
		};
	}, [pendingRevealRequest]);

	return { taskIdRequestedToReveal: pendingRevealRequest?.taskId ?? null, requestRevealCanonicalTaskCard };
}
