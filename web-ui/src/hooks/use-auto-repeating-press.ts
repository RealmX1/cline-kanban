import { type MouseEventHandler, type PointerEventHandler, useCallback, useRef } from "react";

import { useUnmount } from "@/utils/react-use";

/** 按住多久才开始连发。短于此的按压只算单次点按，避免正常点击被判成长按。 */
const AUTO_REPEAT_INITIAL_DELAY_MS = 400;
/** 连发间隔。物理键盘常见 30-50ms；这里略慢，因为每次都要往 PTY 发一次并等 TUI 重绘。 */
const AUTO_REPEAT_INTERVAL_MS = 60;

export interface AutoRepeatingPressBindings {
	onPointerDown: PointerEventHandler<HTMLElement>;
	onPointerUp: PointerEventHandler<HTMLElement>;
	onPointerCancel: PointerEventHandler<HTMLElement>;
	onLostPointerCapture: PointerEventHandler<HTMLElement>;
	onPointerLeave: PointerEventHandler<HTMLElement>;
	onClick: MouseEventHandler<HTMLElement>;
	onContextMenu: MouseEventHandler<HTMLElement>;
}

interface UseAutoRepeatingPressInput {
	onPress: () => void;
	/** 关掉时退化为「只在按下瞬间触发一次」。破坏性或不可逆的键不该连发。 */
	isAutoRepeatEnabled: boolean;
}

/**
 * 把这一次按压期间的所有指针事件钉在按下时的那个元素上，指针滑出元素边界也照常投递。
 *
 * 返回是否真的建立了捕获。两种情况会失败，调用方必须能分辨：
 * 1. 运行环境根本没实现该 API（jsdom 就没有），此时不能假装捕获成立；
 * 2. `pointerId` 已经不是活跃指针，浏览器按规范抛 `NotFoundError`。
 * 捕获不成立时，指针可能在元素外抬起、`pointerup` 永远不会送达本元素，
 * 因此调用方必须退回「离开元素即停止」的保守兜底，否则连发会失控。
 */
function tryCapturePointerForPressDuration(element: HTMLElement, pointerId: number): boolean {
	if (typeof element.setPointerCapture !== "function") {
		return false;
	}
	try {
		element.setPointerCapture(pointerId);
		return true;
	} catch {
		return false;
	}
}

/**
 * 把一个按钮变成「按下即触发、按住则连发」的键，语义对齐物理键盘的 typematic 重复。
 *
 * 为什么在 pointerdown 而非 click 触发：连发必须在手指仍然按着的时候就开始，而 click 要等抬手。
 * 由此带来的重复触发风险用 `didPointerSequenceHandlePress` 挡掉 —— pointerdown 之后浏览器仍会补
 * 发一个 click，若不吞掉，每次点按都会发两遍按键。键盘用 Enter/Space 激活按钮时只有 click、
 * 没有 pointer 序列，那条路径才让 click 真正触发，故无障碍访问不受影响。
 *
 * 触屏上还必须压掉长按的系统行为：`onContextMenu` 挡住长按弹出的上下文菜单/文本放大镜，
 * 否则手指刚按住到能连发的时长，系统菜单就盖上来了。
 *
 * 按住期间用 `setPointerCapture` 捕获指针，否则连发几乎必然被自己掐断：这套绑定的典型宿主是
 * 只有约 40×36px 的虚拟键帽，手指或鼠标在按住时的轻微位移就会越出键面，`pointerleave` 正好落在
 * 400ms 起步延迟前后，长按连发形同虚设。捕获成立后停止条件只认 `pointerup` / `pointercancel` /
 * `lostpointercapture`；捕获不成立时才退回「离开元素即停止」的兜底（见
 * `tryCapturePointerForPressDuration`）。
 */
export function useAutoRepeatingPress({
	onPress,
	isAutoRepeatEnabled,
}: UseAutoRepeatingPressInput): AutoRepeatingPressBindings {
	const initialDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const repeatIntervalTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const didPointerSequenceHandlePressRef = useRef(false);
	// 本次按压是否真的拿到了指针捕获。只有拿到了，才可以无视 pointerleave 继续连发。
	const didCapturePointerForCurrentPressRef = useRef(false);
	// onPress 通常是每次渲染新建的闭包；存进 ref 让连发定时器始终调到最新的一份，
	// 又不必因为它变化而重建定时器。
	const onPressRef = useRef(onPress);
	onPressRef.current = onPress;

	const stopAutoRepeat = useCallback(() => {
		if (initialDelayTimerRef.current !== null) {
			clearTimeout(initialDelayTimerRef.current);
			initialDelayTimerRef.current = null;
		}
		if (repeatIntervalTimerRef.current !== null) {
			clearInterval(repeatIntervalTimerRef.current);
			repeatIntervalTimerRef.current = null;
		}
	}, []);

	useUnmount(stopAutoRepeat);

	const handlePointerDown = useCallback<PointerEventHandler<HTMLElement>>(
		(event) => {
			// 主键/单指以外的按压（右键、多指）不触发，避免误发。
			if (event.button !== 0) {
				return;
			}
			didPointerSequenceHandlePressRef.current = true;
			didCapturePointerForCurrentPressRef.current = tryCapturePointerForPressDuration(
				event.currentTarget,
				event.pointerId,
			);
			stopAutoRepeat();
			onPressRef.current();
			if (!isAutoRepeatEnabled) {
				return;
			}
			initialDelayTimerRef.current = setTimeout(() => {
				initialDelayTimerRef.current = null;
				repeatIntervalTimerRef.current = setInterval(() => {
					onPressRef.current();
				}, AUTO_REPEAT_INTERVAL_MS);
			}, AUTO_REPEAT_INITIAL_DELAY_MS);
		},
		[isAutoRepeatEnabled, stopAutoRepeat],
	);

	// 抬手 / 系统取消 / 捕获被夺走：这次按压确定结束了。捕获在 pointerup 时由浏览器隐式释放，
	// 随后补发的 lostpointercapture 再停一次是幂等的空操作。
	const handlePointerPressEnded = useCallback<PointerEventHandler<HTMLElement>>(() => {
		didCapturePointerForCurrentPressRef.current = false;
		stopAutoRepeat();
	}, [stopAutoRepeat]);

	const handlePointerLeave = useCallback<PointerEventHandler<HTMLElement>>(() => {
		// 捕获成立时，指针滑出键面只是按住期间的正常抖动，连发必须继续；真正的结束由
		// pointerup / pointercancel / lostpointercapture 负责。
		if (didCapturePointerForCurrentPressRef.current) {
			return;
		}
		stopAutoRepeat();
	}, [stopAutoRepeat]);

	const handleClick = useCallback<MouseEventHandler<HTMLElement>>((event) => {
		// pointerdown 已经处理过这次按压，吞掉浏览器补发的 click。
		if (didPointerSequenceHandlePressRef.current) {
			didPointerSequenceHandlePressRef.current = false;
			return;
		}
		// 走到这里说明是键盘（Enter / Space）激活的合成 click。
		event.preventDefault();
		onPressRef.current();
	}, []);

	const handleContextMenu = useCallback<MouseEventHandler<HTMLElement>>((event) => {
		event.preventDefault();
	}, []);

	return {
		onPointerDown: handlePointerDown,
		onPointerUp: handlePointerPressEnded,
		onPointerCancel: handlePointerPressEnded,
		onLostPointerCapture: handlePointerPressEnded,
		onPointerLeave: handlePointerLeave,
		onClick: handleClick,
		onContextMenu: handleContextMenu,
	};
}
