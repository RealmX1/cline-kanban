// Exploratory findings 的客户端领域逻辑（纯函数，蓝图 §D / §G.2，M2）。
// 组件（save 对话框 / findings 浏览器 / map 面板 section）只做渲染与事件接线，
// provenance 组装、查重、过滤、预填全部落在这里以便单测——铁律：绝不伪造锚，
// 映射不到 turn 或投影不可用时显式降级 user_authored_freeform。

import { extractSessionMapAnchorMarkers } from "@/components/session-map/session-map-anchor-markers";
import type {
	RuntimeConversationSessionTurnProjectionResponse,
	RuntimeExploratoryFindingEntry,
	RuntimeExploratoryFindingProvenanceLink,
	RuntimeExploratoryFindingStatus,
} from "@/runtime/types";

// 契约上限（api-contract.ts runtimeExploratoryFindingEntrySchema / saveFinding request）。
export const EXPLORATORY_FINDING_TITLE_MAX_LENGTH = 120;
export const EXPLORATORY_FINDING_BODY_MAX_LENGTH = 4000;

// ---- 查重（蓝图 §D.3）----

// 规范化标题：小写 + 去全部空白/标点/符号。查重只比较「活」集合
// （active + suggested_pending_confirmation）——archived/superseded 已退役，
// 与它们撞标题不构成重复。
export function normalizeFindingTitleForDuplicateCheck(title: string): string {
	return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

// 疑似重复 = 规范化标题相等或前缀包含（§D.3）。只提示不阻断；合并入口属 M5。
export function findSimilarExploratoryFindings(
	findings: readonly RuntimeExploratoryFindingEntry[],
	title: string,
): RuntimeExploratoryFindingEntry[] {
	const normalizedTitle = normalizeFindingTitleForDuplicateCheck(title);
	if (normalizedTitle.length === 0) {
		return [];
	}
	return findings.filter((finding) => {
		if (finding.findingStatus !== "active" && finding.findingStatus !== "suggested_pending_confirmation") {
			return false;
		}
		const normalizedCandidate = normalizeFindingTitleForDuplicateCheck(finding.findingTitle);
		if (normalizedCandidate.length === 0) {
			return false;
		}
		return normalizedCandidate.startsWith(normalizedTitle) || normalizedTitle.startsWith(normalizedCandidate);
	});
}

// ---- 「存为 finding」预填（蓝图 §D.2.1）----

// 正文预填：有选区用选中文本，否则用消息正文摘录；统一截断到契约上限。
// 消息正文先经 cleanContent 摘除 map 锚 marker（HTML 注释本就不是正文，不该落进 finding）。
export function buildSaveFindingBodyPrefill(input: { selectedText?: string | null; messageContent: string }): string {
	const selectedText = input.selectedText?.trim() ?? "";
	const source =
		selectedText.length > 0 ? selectedText : extractSessionMapAnchorMarkers(input.messageContent).cleanContent.trim();
	if (source.length <= EXPLORATORY_FINDING_BODY_MAX_LENGTH) {
		return source;
	}
	return `${source.slice(0, EXPLORATORY_FINDING_BODY_MAX_LENGTH - 1).trimEnd()}…`;
}

// ---- provenance 组装（蓝图 §D.2.1）----

export interface SaveFindingTurnAnchor {
	turnNumber: number;
	turnCheckpointCommit: string | null;
}

// 解析 turn 锚：turn 号来自聊天消息的位置性映射（conversation-tree-model），commit 从
// 投影 entries 取（可取到就带，取不到 null = 仅时间锚，语义同蓝图 §B.1）。
// 返回 null = 不可锚（消息映射不到 turn / 投影不可用 / 投影里没有该 turn）——
// 调用方据此降级 freeform，绝不允许拿着不可核验的 turn 号硬造锚。
export function resolveSaveFindingTurnAnchor(input: {
	turnNumber: number | undefined;
	projection: RuntimeConversationSessionTurnProjectionResponse | null;
}): SaveFindingTurnAnchor | null {
	if (input.turnNumber === undefined || input.projection === null) {
		return null;
	}
	const entry = input.projection.turnProjectionEntries.find((candidate) => candidate.turnNumber === input.turnNumber);
	if (!entry) {
		return null;
	}
	return { turnNumber: entry.turnNumber, turnCheckpointCommit: entry.turnCheckpointCommit };
}

// 组装 saveFinding 的 provenance：可锚 → 单条 turn_anchor 链接（三元，commit 允许 null）；
// 不可锚 → 单条 user_authored_freeform（turnNumber/commit 置 null，显式声明无锚）。
export function buildSaveFindingProvenance(input: {
	conversationSessionTaskId: string;
	anchor: SaveFindingTurnAnchor | null;
}): {
	provenanceLinks: RuntimeExploratoryFindingProvenanceLink[];
	originConversationSessionTaskId: string;
} {
	const link: RuntimeExploratoryFindingProvenanceLink = input.anchor
		? {
				linkKind: "turn_anchor",
				conversationSessionTaskId: input.conversationSessionTaskId,
				turnNumber: input.anchor.turnNumber,
				turnCheckpointCommit: input.anchor.turnCheckpointCommit,
			}
		: {
				linkKind: "user_authored_freeform",
				conversationSessionTaskId: input.conversationSessionTaskId,
				turnNumber: null,
				turnCheckpointCommit: null,
			};
	return {
		provenanceLinks: [link],
		originConversationSessionTaskId: input.conversationSessionTaskId,
	};
}

// ---- 过滤（蓝图 §G.2）----

// map 面板「本会话 findings」切片：provenanceLinks 含该会话的条目；archived 不进
// 切片（软删语义 = 不进默认列表）。多条链接任一命中即算（finding 可跨会话引用）。
export function filterFindingsForConversationSession(
	findings: readonly RuntimeExploratoryFindingEntry[],
	conversationSessionTaskId: string,
): RuntimeExploratoryFindingEntry[] {
	return findings.filter(
		(finding) =>
			finding.findingStatus !== "archived" &&
			finding.provenanceLinks.some((link) => link.conversationSessionTaskId === conversationSessionTaskId),
	);
}

// findings 浏览器列表：archived 默认不进列表（开关放行）；搜索 = 标题 + 正文
// substring（§D.3 从简，不引索引库）。大小写不敏感。
export function filterFindingsForBrowserView(
	findings: readonly RuntimeExploratoryFindingEntry[],
	input: { query: string; showArchived: boolean },
): RuntimeExploratoryFindingEntry[] {
	const normalizedQuery = input.query.trim().toLowerCase();
	return findings.filter((finding) => {
		if (!input.showArchived && finding.findingStatus === "archived") {
			return false;
		}
		if (normalizedQuery.length === 0) {
			return true;
		}
		return (
			finding.findingTitle.toLowerCase().includes(normalizedQuery) ||
			finding.findingBodyMarkdown.toLowerCase().includes(normalizedQuery)
		);
	});
}

// ---- 展示派生 ----

export interface FindingStatusDisplay {
	label: string;
	badgeClassName: string;
}

export function getFindingStatusDisplay(status: RuntimeExploratoryFindingStatus): FindingStatusDisplay {
	switch (status) {
		case "suggested_pending_confirmation":
			return { label: "Pending confirmation", badgeClassName: "bg-status-orange/15 text-status-orange" };
		case "active":
			return { label: "Active", badgeClassName: "bg-status-green/15 text-status-green" };
		case "superseded":
			return { label: "Superseded", badgeClassName: "bg-surface-3 text-text-tertiary" };
		case "archived":
			return { label: "Archived", badgeClassName: "bg-surface-3 text-text-tertiary" };
	}
}

// 卡片正文摘要：纯文本截一段（不渲染 markdown，列表行高受限）。
export function buildFindingBodyExcerpt(bodyMarkdown: string, maxLength = 200): string {
	const collapsed = bodyMarkdown.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) {
		return collapsed;
	}
	return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}

// provenance 来源标注（findings 浏览器卡片用）：取首条链接——turn_anchor 带 turn 号，
// freeform 显式标注无锚。深链跳转身属 M3，这里只做文字标注。
export function buildFindingProvenanceLabel(finding: RuntimeExploratoryFindingEntry): string {
	const firstLink = finding.provenanceLinks[0];
	if (!firstLink) {
		return "No source recorded";
	}
	if (firstLink.linkKind === "turn_anchor" && firstLink.turnNumber !== null) {
		return `Session ${firstLink.conversationSessionTaskId} · T${firstLink.turnNumber}`;
	}
	if (firstLink.linkKind === "session_level") {
		return `Session ${firstLink.conversationSessionTaskId}`;
	}
	return `Freeform note · Session ${firstLink.conversationSessionTaskId}`;
}
