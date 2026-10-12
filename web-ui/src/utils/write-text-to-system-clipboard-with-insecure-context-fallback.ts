/**
 * 把文本写进系统剪贴板。失败时 reject，调用方据此在「打勾」与「报错」之间二选一（两者互斥）。
 *
 * 存在理由：`navigator.clipboard` 只在 secure context（https 或 localhost）里存在。从其他设备经
 * `http://<局域网 / tailnet 地址>` 访问时它是 undefined，直接调用会同步抛 TypeError。这时退回到
 * `document.execCommand("copy")`：它不要求 secure context，但必须发生在用户手势（点击、按键）的同步调用栈里。
 * 本函数在走降级分支之前没有任何 await，所以只要调用方在手势里同步调用它，就满足这个要求。
 */
export async function writeTextToSystemClipboardWithInsecureContextFallback(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	copyTextThroughExecCommandWithoutClipboardApi(text);
}

/**
 * 同步执行，失败抛错。
 *
 * 两道保险：
 * - capture 阶段的 copy 监听直接把 `text` 写进 clipboardData。这样复制结果不依赖焦点或选区落在哪里。
 * - 隐藏 textarea 只负责让浏览器认为「有可复制的选区」，从而启用 copy 命令。它放进当前所在的对话框里：
 *   Radix 对话框有焦点陷阱，焦点落到对话框外会被立刻抢回去。
 *
 * 终端里不要用它：焦点移出 xterm 会向开了焦点上报的 agent 发 `\e[O` / `\e[I`，终端直接走 xterm 自己的 copy 事件。
 */
export function copyTextThroughExecCommandWithoutClipboardApi(text: string): void {
	const previouslyFocusedElement = document.activeElement;
	const enclosingDialog =
		previouslyFocusedElement instanceof HTMLElement
			? previouslyFocusedElement.closest('[role="dialog"], [role="alertdialog"]')
			: null;
	const writeTextIntoCopyEvent = (event: ClipboardEvent) => {
		if (!event.clipboardData) {
			return;
		}
		event.clipboardData.setData("text/plain", text);
		event.preventDefault();
	};
	const clipboardTextArea = document.createElement("textarea");
	clipboardTextArea.value = text;
	clipboardTextArea.setAttribute("readonly", "");
	clipboardTextArea.setAttribute("aria-hidden", "true");
	clipboardTextArea.className = "fixed left-0 top-0 opacity-0 pointer-events-none";
	(enclosingDialog ?? document.body).append(clipboardTextArea);
	document.addEventListener("copy", writeTextIntoCopyEvent, true);
	try {
		clipboardTextArea.focus({ preventScroll: true });
		clipboardTextArea.select();
		if (!document.execCommand("copy")) {
			throw new Error("The browser refused to copy to the clipboard.");
		}
	} finally {
		document.removeEventListener("copy", writeTextIntoCopyEvent, true);
		clipboardTextArea.remove();
		if (previouslyFocusedElement instanceof HTMLElement) {
			previouslyFocusedElement.focus({ preventScroll: true });
		}
	}
}
