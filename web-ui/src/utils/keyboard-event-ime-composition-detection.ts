/**
 * 「这次按键事件是不是输入法（IME）组字过程中发出的」。
 *
 * 中文/日文/韩文输入法在组字期间会把 Enter、↑、↓、Escape 等键**先给自己用**（上屏字符原文、翻候选页、
 * 取消组字），此时应用层的键盘处理器必须整体让开——否则用户拼音打到一半按 Enter 想上屏，按键却被
 * 搜索框当成「打开高亮结果」执行。踩过的实例见 `task-spotlight-search-dialog.tsx`。
 *
 * 判据刻意查两个信号：
 * - `isComposing`：标准属性，Chromium 与 Firefox 在「结束组字的那次 keydown」上都置 true。
 * - `keyCode === 229`：早于 `isComposing` 的事实标准。keyCode 本身已废弃，但组字期间置 229 是各浏览器
 *   至今仍保持的行为，留作兜底成本极低。
 *
 * 刻意**不**引入「compositionend 之后一小段时间内忽略按键」的时序兜底：那能覆盖 Safari 已知的
 * 「compositionend 先于 keydown」路径，但会让上屏后极快连按的第二次 Enter 被吞。当前只覆盖
 * Chromium / Firefox（含 Electron 桌面壳），是有意的取舍。
 */

/** 组字期间浏览器统一上报的 legacy keyCode。 */
export const IME_COMPOSITION_IN_PROGRESS_KEY_CODE = 229;

interface KeyboardEventImeCompositionSignals {
	readonly isComposing: boolean;
	readonly keyCode: number;
}

/**
 * 同时接受原生 `KeyboardEvent` 与 React 合成事件：React 的合成键盘事件不透出 `isComposing`，
 * 只能经 `nativeEvent` 读，所以这里按有没有 `nativeEvent` 自行取信号源，调用方不必各自记住该取哪个。
 */
export type ImeCompositionDetectableKeyboardEvent =
	| KeyboardEventImeCompositionSignals
	| { readonly nativeEvent: KeyboardEventImeCompositionSignals };

export function isKeyboardEventEmittedDuringImeComposition(event: ImeCompositionDetectableKeyboardEvent): boolean {
	const signals = "nativeEvent" in event ? event.nativeEvent : event;
	return signals.isComposing || signals.keyCode === IME_COMPOSITION_IN_PROGRESS_KEY_CODE;
}
