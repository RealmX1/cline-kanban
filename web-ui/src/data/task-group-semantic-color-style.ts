import type { CSSProperties } from "react";
import { columnIndicatorColors } from "@/data/column-colors";

const taskGroupSemanticColors: Record<string, string> = {
	...columnIndicatorColors,
	pinned: "var(--color-accent)",
	running: "var(--color-status-blue)",
	waiting_automatic_recovery: "var(--color-status-orange)",
	waiting_owned_background_work: "var(--color-status-orange)",
	prompt_cache_warm: "var(--color-status-orange)",
	remaining: "var(--color-text-secondary)",
	shelved: "var(--color-text-secondary)",
};

/** 分组外框与标题共用图标的语义色，卡片内容继续使用中性色。 */
export function getTaskGroupSemanticColorStyle(groupId: string): CSSProperties {
	return {
		"--kb-task-group-color": taskGroupSemanticColors[groupId] ?? "var(--color-text-secondary)",
	} as CSSProperties;
}
