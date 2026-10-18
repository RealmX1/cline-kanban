import { type MouseEventHandler, type PointerEventHandler, useCallback, useEffect, useRef } from "react";
import type { AutoRepeatingPressBindings } from "@/hooks/use-auto-repeating-press";

const CONTINUOUS_SCROLL_INITIAL_DELAY_MS = 400;
const CONTINUOUS_SCROLL_ACCELERATION_DURATION_MS = 2000;
const CONTINUOUS_SCROLL_INITIAL_REPEATS_PER_SECOND = 8;
const CONTINUOUS_SCROLL_MAXIMUM_REPEATS_PER_SECOND = 24;

/** 仅滚轮按钮加速；原有终端方向键仍使用固定频率。无需新增手势依赖。 */
export function useAcceleratingMouseWheelScrollPress({
	onScrollStep,
	onUserInteraction,
	interactionIdentity,
	enabled = true,
}: {
	onScrollStep: () => void;
	onUserInteraction?: () => void;
	interactionIdentity: string;
	enabled?: boolean;
}): AutoRepeatingPressBindings {
	const scrollPressCallbacksRef = useRef({ onScrollStep, onUserInteraction });
	scrollPressCallbacksRef.current = { onScrollStep, onUserInteraction };
	const scrollRepeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeScrollPressPointerRef = useRef<{ pointerId: number; captured: boolean } | null>(null);
	const didHandlePointerPress = useRef(false);
	const stopContinuousMouseWheelScroll = useCallback(() => {
		if (scrollRepeatTimeoutRef.current !== null) clearTimeout(scrollRepeatTimeoutRef.current);
		scrollRepeatTimeoutRef.current = null;
		activeScrollPressPointerRef.current = null;
	}, []);
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden) stopContinuousMouseWheelScroll();
		};
		window.addEventListener("blur", stopContinuousMouseWheelScroll);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			stopContinuousMouseWheelScroll();
			window.removeEventListener("blur", stopContinuousMouseWheelScroll);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [stopContinuousMouseWheelScroll]);
	// 换会话、切阅读模式或隐藏控件时，旧按压不得继续驱动新的目标。
	useEffect(() => stopContinuousMouseWheelScroll, [enabled, interactionIdentity, stopContinuousMouseWheelScroll]);
	const scrollMouseWheelOneStep = useCallback(() => {
		scrollPressCallbacksRef.current.onUserInteraction?.();
		scrollPressCallbacksRef.current.onScrollStep();
	}, []);
	const onPointerDown = useCallback<PointerEventHandler<HTMLElement>>(
		(event) => {
			if (
				!enabled ||
				event.button !== 0 ||
				event.isPrimary === false ||
				activeScrollPressPointerRef.current !== null
			)
				return;
			event.preventDefault();
			didHandlePointerPress.current = true;
			let captured = false;
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
				captured = true;
			} catch {
				// 不支持或捕获失败时退回离开按钮即停止，避免连滚失控。
			}
			activeScrollPressPointerRef.current = { pointerId: event.pointerId, captured };
			const scrollPressStartedAtMs = performance.now();
			scrollMouseWheelOneStep();
			const repeatMouseWheelScroll = () => {
				if (activeScrollPressPointerRef.current === null) return;
				const accelerationElapsedMs = Math.max(
					0,
					performance.now() - scrollPressStartedAtMs - CONTINUOUS_SCROLL_INITIAL_DELAY_MS,
				);
				const accelerationProgress = Math.min(
					1,
					accelerationElapsedMs / CONTINUOUS_SCROLL_ACCELERATION_DURATION_MS,
				);
				const repeatsPerSecond =
					CONTINUOUS_SCROLL_INITIAL_REPEATS_PER_SECOND +
					(CONTINUOUS_SCROLL_MAXIMUM_REPEATS_PER_SECOND - CONTINUOUS_SCROLL_INITIAL_REPEATS_PER_SECOND) *
						accelerationProgress;
				scrollMouseWheelOneStep();
				// 向上取整避免计时器截断使实际请求频率超过上限；阻塞后不补发积压事件。
				scrollRepeatTimeoutRef.current = setTimeout(repeatMouseWheelScroll, Math.ceil(1000 / repeatsPerSecond));
			};
			scrollRepeatTimeoutRef.current = setTimeout(repeatMouseWheelScroll, CONTINUOUS_SCROLL_INITIAL_DELAY_MS);
		},
		[enabled, scrollMouseWheelOneStep],
	);
	const onPointerEnded = useCallback<PointerEventHandler<HTMLElement>>(
		(event) => {
			if (event.pointerId === activeScrollPressPointerRef.current?.pointerId) stopContinuousMouseWheelScroll();
		},
		[stopContinuousMouseWheelScroll],
	);
	const onPointerLeave = useCallback<PointerEventHandler<HTMLElement>>(() => {
		if (!activeScrollPressPointerRef.current?.captured) stopContinuousMouseWheelScroll();
	}, [stopContinuousMouseWheelScroll]);
	const onClick = useCallback<MouseEventHandler<HTMLElement>>(
		(event) => {
			event.preventDefault();
			if (didHandlePointerPress.current && event.detail > 0) {
				didHandlePointerPress.current = false;
				return;
			}
			didHandlePointerPress.current = false;
			if (enabled) scrollMouseWheelOneStep();
		},
		[enabled, scrollMouseWheelOneStep],
	);
	return {
		onPointerDown,
		onPointerUp: onPointerEnded,
		onPointerCancel: onPointerEnded,
		onLostPointerCapture: onPointerEnded,
		onPointerLeave,
		onClick,
		onContextMenu: (event) => event.preventDefault(),
	};
}
