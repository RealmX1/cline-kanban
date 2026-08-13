// 会话面板的**渲染量**窗口化：只渲染最近 N 条消息，滚到顶部再回填 N 条。
//
// 为什么需要：面板此前是裸 `messages.map(...)`，一条会话的全部消息恒在 DOM 里。这在两种场景下会痛——
//   1. 长会话本身（已知的「无上限聊天缓冲」内存热点）；
//   2. omp 从 TUI 切到 ACP 时的 session/load 历史重播——整段既往对话会一次性灌进来。
// 做成面板级能力而不是重播专用补丁：同样的工作量，Cline SDK 的长会话一并受益。
//
// 诚实边界：这里界定的只是**渲染量**。消息账本仍持有全部消息（回填要用），要连保留量也设上限是另一件事。
import { useCallback, useEffect, useRef, useState } from "react";

// 一屏窗口的消息条数。50 条足够覆盖「刚发生的事」，又不至于让重播把上千条一次性塞进 DOM。
export const DEFAULT_AGENT_CHAT_MESSAGE_WINDOW_SIZE = 50;

export interface WindowedAgentChatMessageList<TMessage> {
	// 当前要渲染的消息（原顺序的末尾一段）。
	visibleMessages: TMessage[];
	// 还没渲染出来的、更早的消息条数。为 0 表示已经到顶。
	hiddenOlderMessageCount: number;
	// 再多渲染一屏更早的消息。已经到顶时是 no-op。
	revealOlderMessages: () => void;
}

export function useWindowedAgentChatMessageList<TMessage>(input: {
	messages: TMessage[];
	// 换会话即重置窗口。不传就永不重置（例如面板只服务单一会话时）。
	resetWindowKey?: string | null;
	windowSize?: number;
}): WindowedAgentChatMessageList<TMessage> {
	const windowSize = input.windowSize ?? DEFAULT_AGENT_CHAT_MESSAGE_WINDOW_SIZE;
	// 窗口锚点记的是「已经回填到哪条历史」——最早一条可见消息在 messages 里的下标，而不是「渲染多少条」。
	// 锚在条数上会坏在尾部追加：会话每来一条新消息 messages.length 就 +1，而从尾部切片算出的隐藏条数
	// 跟着 +1，于是正在顶部读历史的用户会看到最早那条可见消息被重新藏回去（内容逐条消失 + 滚动跳动）。
	// 锚在下标上，尾部追加就动不了已经回填出来的那一段。
	// null = 还没回填过，窗口贴着消息尾部滑动，只渲染最近一屏。
	const [backfilledOldestVisibleMessageIndex, setBackfilledOldestVisibleMessageIndex] = useState<number | null>(null);
	// 切会话时把窗口收回一屏。用 ref 比较而不是 useEffect+deps，是为了在**同一次渲染**里就生效——
	// 否则切过去的第一帧会先按上一条会话撑大的窗口渲染新会话的消息，白白铺一次 DOM。
	const lastResetWindowKeyRef = useRef(input.resetWindowKey ?? null);
	const effectiveBackfilledOldestVisibleMessageIndex =
		lastResetWindowKeyRef.current === (input.resetWindowKey ?? null) ? backfilledOldestVisibleMessageIndex : null;

	useEffect(() => {
		const nextResetWindowKey = input.resetWindowKey ?? null;
		if (lastResetWindowKeyRef.current === nextResetWindowKey) {
			return;
		}
		lastResetWindowKeyRef.current = nextResetWindowKey;
		setBackfilledOldestVisibleMessageIndex(null);
	}, [input.resetWindowKey]);

	// 没回填过时窗口贴着尾部滑动：只渲染最近一屏。session/load 把整段既往对话一次性灌进来时，
	// 靠的就是这条——不能因为「记住了锚点」而把重播的上千条全铺进 DOM。
	const slidingWindowOldestVisibleMessageIndex = Math.max(0, input.messages.length - windowSize);
	// 回填锚点仍要被滑动窗口夹住：消息账本被换成更短的一段时（账本重置、会话被替换），越界的旧锚点
	// 会切出空数组。取较小值只会渲染得更多，永远不会把已经回填出来的内容再藏回去。
	const hiddenOlderMessageCount =
		effectiveBackfilledOldestVisibleMessageIndex === null
			? slidingWindowOldestVisibleMessageIndex
			: Math.min(effectiveBackfilledOldestVisibleMessageIndex, slidingWindowOldestVisibleMessageIndex);

	// 以「当前实际隐藏了多少条」为基准往前推一屏，而不是在旧锚点上做增量：旧锚点可能刚被上面夹过，
	// 基于它推算会算出一次用户看不见任何变化的回填。
	const revealOlderMessages = useCallback(() => {
		setBackfilledOldestVisibleMessageIndex(Math.max(0, hiddenOlderMessageCount - windowSize));
	}, [hiddenOlderMessageCount, windowSize]);

	return {
		visibleMessages: hiddenOlderMessageCount > 0 ? input.messages.slice(hiddenOlderMessageCount) : input.messages,
		hiddenOlderMessageCount,
		revealOlderMessages,
	};
}
