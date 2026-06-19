export const isMacPlatform =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

// Safari（macOS/iOS/iPadOS 的 WebKit）在 Cmd +/- 整页缩放时不会改变 window.devicePixelRatio，
// 导致 xterm 的 WebGL canvas 不会按新 DPR 重新光栅化、文字发虚。我们让 Safari 走 xterm 的
// DOM 渲染器（任意缩放都清晰）。负向先行断言排除 Chrome/Edge/Brave/Arc/Opera 及 iOS 上的
// Chrome(CriOS)/Firefox(FxiOS)——它们的 UA 里都含 "Safari"。不用 navigator.vendor，因为
// Chromium Edge 与 CriOS/FxiOS 也上报 "Apple Computer, Inc."。
export function isSafariUserAgent(userAgent: string): boolean {
	return /^((?!chrome|android|crios|fxios|edg|opr).)*safari/i.test(userAgent);
}

export const isSafari = typeof navigator !== "undefined" && isSafariUserAgent(navigator.userAgent);

export const modifierKeyLabel = isMacPlatform ? "Cmd" : "Ctrl";
export const optionKeyLabel = isMacPlatform ? "⌥" : "Alt";
export const pasteShortcutLabel = `${modifierKeyLabel}+V`;
