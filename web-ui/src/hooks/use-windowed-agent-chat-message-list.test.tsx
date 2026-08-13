// 会话面板的渲染量窗口化。这条能力最要紧的场景是 omp 从 TUI 切到 ACP 时的 session/load
// 历史重播——整段既往对话会一次性灌进来，全量渲染会把上千条塞进 DOM。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_AGENT_CHAT_MESSAGE_WINDOW_SIZE,
	useWindowedAgentChatMessageList,
	type WindowedAgentChatMessageList,
} from "@/hooks/use-windowed-agent-chat-message-list";

function createMessages(count: number): string[] {
	return Array.from({ length: count }, (_unused, index) => `message-${index}`);
}

describe("useWindowedAgentChatMessageList", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function renderWindowedMessageList(initialProps: {
		messages: string[];
		resetWindowKey?: string;
		windowSize?: number;
	}): {
		getState: () => WindowedAgentChatMessageList<string>;
		rerender: (nextProps: { messages: string[]; resetWindowKey?: string; windowSize?: number }) => void;
	} {
		let hookResult: WindowedAgentChatMessageList<string> | null = null;

		function HookHarness(props: { messages: string[]; resetWindowKey?: string; windowSize?: number }): null {
			hookResult = useWindowedAgentChatMessageList(props);
			return null;
		}

		act(() => {
			root.render(<HookHarness {...initialProps} />);
		});

		return {
			getState: () => {
				if (!hookResult) {
					throw new Error("Hook state not available");
				}
				return hookResult;
			},
			rerender: (nextProps) => {
				act(() => {
					root.render(<HookHarness {...nextProps} />);
				});
			},
		};
	}

	it("renders every message when the conversation is shorter than one window", () => {
		const messages = createMessages(5);
		const { getState } = renderWindowedMessageList({ messages, windowSize: 10 });
		expect(getState().visibleMessages).toEqual(messages);
		expect(getState().hiddenOlderMessageCount).toBe(0);
	});

	it("renders only the most recent window and reports how many are hidden", () => {
		const { getState } = renderWindowedMessageList({ messages: createMessages(130), windowSize: 50 });
		expect(getState().visibleMessages).toHaveLength(50);
		expect(getState().visibleMessages[0]).toBe("message-80");
		expect(getState().visibleMessages.at(-1)).toBe("message-129");
		expect(getState().hiddenOlderMessageCount).toBe(80);
	});

	it("backfills one more window each time older messages are revealed", () => {
		const { getState } = renderWindowedMessageList({ messages: createMessages(130), windowSize: 50 });

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().visibleMessages).toHaveLength(100);
		expect(getState().hiddenOlderMessageCount).toBe(30);

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().visibleMessages).toHaveLength(130);
		expect(getState().hiddenOlderMessageCount).toBe(0);

		// 已经到顶之后再回填是 no-op，不会越界切片。
		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().visibleMessages).toHaveLength(130);
		expect(getState().hiddenOlderMessageCount).toBe(0);
	});

	// 回填之后会话再追加新消息，最早那条可见消息不能被重新藏回去。窗口锚点若锚在「渲染多少条」，
	// messages.length 一涨隐藏条数就 +1，正在顶部读历史的用户会看到内容逐条消失并发生滚动跳动。
	it("keeps the backfilled history visible when new messages are appended", () => {
		const { getState, rerender } = renderWindowedMessageList({ messages: createMessages(130), windowSize: 50 });

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().hiddenOlderMessageCount).toBe(30);
		expect(getState().visibleMessages[0]).toBe("message-30");

		rerender({ messages: createMessages(131), windowSize: 50 });
		expect(getState().hiddenOlderMessageCount).toBe(30);
		expect(getState().visibleMessages[0]).toBe("message-30");
		expect(getState().visibleMessages).toHaveLength(101);
		expect(getState().visibleMessages.at(-1)).toBe("message-130");

		rerender({ messages: createMessages(140), windowSize: 50 });
		expect(getState().hiddenOlderMessageCount).toBe(30);
		expect(getState().visibleMessages[0]).toBe("message-30");
		expect(getState().visibleMessages).toHaveLength(110);
	});

	// 已经回填到顶之后同理：新消息不能让顶部那条重新消失。
	it("keeps the whole conversation visible after backfilling to the top", () => {
		const { getState, rerender } = renderWindowedMessageList({ messages: createMessages(80), windowSize: 50 });

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().hiddenOlderMessageCount).toBe(0);

		rerender({ messages: createMessages(95), windowSize: 50 });
		expect(getState().hiddenOlderMessageCount).toBe(0);
		expect(getState().visibleMessages).toHaveLength(95);
		expect(getState().visibleMessages[0]).toBe("message-0");
	});

	// 没回填过时窗口必须继续贴着尾部滑动，否则 session/load 一次性重播回来的整段历史会全量进 DOM。
	it("keeps sliding with the tail while the reader has not backfilled anything", () => {
		const { getState, rerender } = renderWindowedMessageList({ messages: createMessages(60), windowSize: 50 });
		expect(getState().hiddenOlderMessageCount).toBe(10);

		rerender({ messages: createMessages(800), windowSize: 50 });
		expect(getState().visibleMessages).toHaveLength(50);
		expect(getState().hiddenOlderMessageCount).toBe(750);
	});

	// 消息账本被换成更短的一段时，越界的旧锚点不能切出空数组。
	it("clamps a stale backfill anchor when the conversation shrinks", () => {
		const { getState, rerender } = renderWindowedMessageList({ messages: createMessages(130), windowSize: 50 });

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().hiddenOlderMessageCount).toBe(30);

		rerender({ messages: createMessages(20), windowSize: 50 });
		expect(getState().hiddenOlderMessageCount).toBe(0);
		expect(getState().visibleMessages).toHaveLength(20);
	});

	// 切会话必须收回窗口，而且要在**同一次渲染**里生效——否则切过去的第一帧会按上一条会话
	// 撑大的窗口渲染新会话的消息，白白铺一次 DOM。
	it("collapses the window back to one screen when the session changes", () => {
		const { getState, rerender } = renderWindowedMessageList({
			messages: createMessages(130),
			resetWindowKey: "task-a",
			windowSize: 50,
		});

		act(() => {
			getState().revealOlderMessages();
		});
		expect(getState().visibleMessages).toHaveLength(100);

		rerender({ messages: createMessages(200), resetWindowKey: "task-b", windowSize: 50 });
		expect(getState().visibleMessages).toHaveLength(50);
		expect(getState().hiddenOlderMessageCount).toBe(150);
	});

	it("defaults to a 50-message window", () => {
		const { getState } = renderWindowedMessageList({ messages: createMessages(120) });
		expect(DEFAULT_AGENT_CHAT_MESSAGE_WINDOW_SIZE).toBe(50);
		expect(getState().visibleMessages).toHaveLength(DEFAULT_AGENT_CHAT_MESSAGE_WINDOW_SIZE);
	});
});
