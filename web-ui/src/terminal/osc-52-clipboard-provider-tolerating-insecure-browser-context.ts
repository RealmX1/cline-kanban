import type { ClipboardSelectionType, IClipboardProvider } from "@xterm/addon-clipboard";

// `ClipboardSelectionType` 是 ambient const enum，isolatedModules 下不能引用它的成员值，只能比字面量。
const SYSTEM_CLIPBOARD_SELECTION = "c";

/**
 * 给 `@xterm/addon-clipboard` 用的剪贴板实现：agent 经 OSC 52 发来「写剪贴板」（例如 Claude Code 里拖选即复制）
 * 时，写进浏览器所在设备的剪贴板。
 *
 * 与 addon 自带的 `BrowserClipboardProvider` 只差一点：`navigator.clipboard` 不存在时（经
 * `http://<局域网 / tailnet 地址>` 访问的非安全上下文）静默放弃，而不是每次复制都在控制台抛一个未捕获的
 * TypeError。OSC 52 来自 PTY 输出、不在用户手势里，没有可用的降级通道；要在这种访问方式下拿到 agent 的复制，
 * 只能改用 HTTPS（见 `docs/remote-access-via-tailscale-serve.md`）。
 */
export const OSC_52_CLIPBOARD_PROVIDER_TOLERATING_INSECURE_BROWSER_CONTEXT: IClipboardProvider = {
	readText(selection: ClipboardSelectionType): Promise<string> {
		if ((selection as string) !== SYSTEM_CLIPBOARD_SELECTION || !navigator.clipboard?.readText) {
			return Promise.resolve("");
		}
		return navigator.clipboard.readText();
	},
	writeText(selection: ClipboardSelectionType, text: string): Promise<void> {
		if ((selection as string) !== SYSTEM_CLIPBOARD_SELECTION || !navigator.clipboard?.writeText) {
			return Promise.resolve();
		}
		return navigator.clipboard.writeText(text);
	},
};
