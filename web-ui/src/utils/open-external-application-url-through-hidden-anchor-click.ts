/**
 * 打开一个交给本机应用处理的 URL（`vscode://…` 等自定义协议）。
 *
 * 用临时 `<a>` 点击而不是 `window.location.href =`：自定义协议没有被任何应用接管时，后者可能把当前页面
 * 导航到一个错误页；前者最多只是浏览器弹出「打开某某应用？」或什么也不发生，看板页面保持不动。
 */
export function openExternalApplicationUrlThroughHiddenAnchorClick(url: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.rel = "noopener noreferrer";
	anchor.style.display = "none";
	document.body.append(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
	}
}
