// 聊天内导航锚目标元素的 DOM 锚点契约与 spotlight 定位。
// 【休眠】旧 session map 面板节点是它唯一的目标；面板退役后暂无挂 data-conversation-anchor 的元素，
// B.2 的 thread graph turn 行接入后复活（保留原因见 conversation-anchor-kind-display.ts 头注释）。
// 镜像 post-deploy-verification 的 verification-anchor-registry 模式（蓝图代码事实 11）：
// 目标元素挂 data 属性契约（class / DOM 结构重构不破锚点），spotlight 把它滚入视野并
// 临时高亮。高亮复用同一套 CSS 动画类（globals.css 的 .verification-spotlight-active）。
//
// 蓝图 §C.2/§C.3：聊天内锚 chip 点击 → 滚动定位到 map 面板对应节点并短暂高亮；
// 远期（M3 reveal-to-index 落地后）节点也可反向 spotlight 聊天消息（data-turn-anchor）。

import { VERIFICATION_SPOTLIGHT_CLASS } from "@/components/post-deploy-verification/verification-anchor-registry";

export const CONVERSATION_ANCHOR_ATTR = "data-conversation-anchor";

// 默认高亮持续时长（与 verification spotlight 同款）。
const DEFAULT_SPOTLIGHT_DURATION_MS = 2800;

// 把某 anchorId 对应的 map 面板节点滚入视野并临时高亮。返回是否命中元素
// （未命中 → 调用方静默降级：例如面板折叠未展开、或该节点不在当前渲染窗口里）。
// 与 spotlightAnchor 同款地用 getAttribute 精确比对：anchorId 是 agent 可提议的字符串，
// 绝不进 CSS 选择器，避免转义问题。
export function spotlightConversationAnchor(anchorId: string, options?: { durationMs?: number }): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	let target: Element | null = null;
	for (const candidate of document.querySelectorAll(`[${CONVERSATION_ANCHOR_ATTR}]`)) {
		if (candidate.getAttribute(CONVERSATION_ANCHOR_ATTR) === anchorId) {
			target = candidate;
			break;
		}
	}
	if (!target) {
		return false;
	}
	target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
	target.classList.add(VERIFICATION_SPOTLIGHT_CLASS);
	const durationMs = options?.durationMs ?? DEFAULT_SPOTLIGHT_DURATION_MS;
	window.setTimeout(() => {
		target?.classList.remove(VERIFICATION_SPOTLIGHT_CLASS);
	}, durationMs);
	return true;
}
