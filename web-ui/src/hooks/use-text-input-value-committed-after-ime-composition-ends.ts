import type { ChangeEvent, CompositionEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type ImeCompositionAwareTextInputElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * 直接摊到 `<input>` / `<textarea>` 上的一组受控绑定：`value` 是**显示值**，其余三个是事件处理器。
 * 组字期间显示值走本 hook 自己的中间态，`onCommitValue` 不会被调用。
 */
export interface ImeCompositionDeferredTextInputBinding {
	value: string;
	onChange: (event: ChangeEvent<ImeCompositionAwareTextInputElement>) => void;
	onCompositionStart: (event: CompositionEvent<ImeCompositionAwareTextInputElement>) => void;
	onCompositionEnd: (event: CompositionEvent<ImeCompositionAwareTextInputElement>) => void;
}

/**
 * hook 的返回物刻意拆成两半：`binding` 摊到 input 上，中止复位则是**给宿主调的**普通函数——
 * 混进 binding 会被 `{...binding}` 当成未知 DOM 属性摊到 `<input>` 上。
 */
export interface ImeCompositionDeferredTextInputController {
	binding: ImeCompositionDeferredTextInputBinding;
	/**
	 * 组字没走完就被外部中止时的唯一复位入口：宿主（弹层、抽屉、条件渲染的面板）在自己关闭/隐藏
	 * 输入框时必须调它。Chromium 在组字进行中卸载 input 时**不补发 compositionend**，不显式复位
	 * 的话「正在组字」会永久停在 true，此后连不组字的输入都再也提交不出去。
	 */
	discardImeCompositionAbortedWithoutCompositionEnd: () => void;
}

/**
 * 把「输入框里显示什么」与「什么值算数、可以拿去驱动下游（检索、过滤、请求）」拆成两件事：
 * 中文输入法组字期间敲下的每个拼音字母都会触发 `change`，但那串字母**不是**用户要检索的东西——
 * 直接喂给检索会让结果列表随 `r` → `re` → `ren` 抖动成一串空结果，直到中文真正上屏才有意义。
 *
 * 因此：`compositionstart` 到 `compositionend` 之间的输入只更新显示值，`compositionend`（中文上屏）
 * 时才把最终文本交给 `onCommitValue`。英文等不组字的输入路径没有 composition 事件，逐字符照常提交，
 * 手感零变化。
 *
 * 组字进行中用 ref 而非 state 判定：`compositionstart` 与紧随其后的 `change` 是两次独立派发，
 * 只读 state 就得赌 React 已经重渲染过；ref 是同步的，不必赌。
 */
export function useTextInputValueCommittedAfterImeCompositionEnds({
	committedValue,
	onCommitValue,
}: {
	committedValue: string;
	onCommitValue: (value: string) => void;
}): ImeCompositionDeferredTextInputController {
	const isImeCompositionInFlightRef = useRef(false);
	const [inFlightCompositionValue, setInFlightCompositionValue] = useState<string | null>(null);

	// 外部把已提交值清空（弹层重开、切项目、打开结果后复位）时，必须连同没上屏的半截拼音一并丢掉，
	// 否则输入框会顶着上一次的组字残留重新出现，而下游拿到的却是空串——显示与生效值就此对不上。
	// 这条路径**只**管「没在组字时被外部清空」：组字进行中的清空会被下面的守卫挡掉（compositionstart
	// 恰好也发生在 committedValue 为空串时，不挡就会当场把刚起头的组字抹掉），所以中止复位另有入口。
	useEffect(() => {
		if (committedValue === "" && !isImeCompositionInFlightRef.current) {
			setInFlightCompositionValue(null);
		}
	}, [committedValue]);

	// 中止复位：既清 ref 也清中间态，两者缺一都会留下「显示值与生效值背离」或「此后再不提交」的残局。
	// 不依赖 committedValue，因此宿主可以在任意时刻幂等地调用。
	const discardImeCompositionAbortedWithoutCompositionEnd = useCallback(() => {
		isImeCompositionInFlightRef.current = false;
		setInFlightCompositionValue(null);
	}, []);

	const onCompositionStart = useCallback((event: CompositionEvent<ImeCompositionAwareTextInputElement>) => {
		isImeCompositionInFlightRef.current = true;
		setInFlightCompositionValue(event.currentTarget.value);
	}, []);

	const onCompositionEnd = useCallback(
		(event: CompositionEvent<ImeCompositionAwareTextInputElement>) => {
			// `input` 与 `compositionend` 的先后在各浏览器间不一致，所以两边都以「当下输入框里的真实文本」
			// 为准：先 input 后 end 时这里提交的是最终文本，先 end 后 input 时下面的 onChange 会再提交一次
			// 同样的值，幂等。
			const nextCommittedValue = event.currentTarget.value;
			isImeCompositionInFlightRef.current = false;
			setInFlightCompositionValue(null);
			onCommitValue(nextCommittedValue);
		},
		[onCommitValue],
	);

	const onChange = useCallback(
		(event: ChangeEvent<ImeCompositionAwareTextInputElement>) => {
			const nextValue = event.currentTarget.value;
			if (isImeCompositionInFlightRef.current) {
				setInFlightCompositionValue(nextValue);
				return;
			}
			onCommitValue(nextValue);
		},
		[onCommitValue],
	);

	return {
		binding: {
			value: inFlightCompositionValue ?? committedValue,
			onChange,
			onCompositionStart,
			onCompositionEnd,
		},
		discardImeCompositionAbortedWithoutCompositionEnd,
	};
}
