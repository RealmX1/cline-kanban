import { ColumnIndicator } from "@/components/ui/column-indicator";
import type { BoardColumnId } from "@/types";

/**
 * stage（看板列）卡头标签：阶段指示器图标 + 阶段标题 + 卡片计数。
 * 由 Focus View 左侧的 `ColumnSection` 折叠头与跨 stage 浮动钉住条共用，
 * 确保「钉住条里的卡头」与列表里的卡头视觉完全一致。
 */
export function StageHeaderLabel({
	columnId,
	title,
	count,
}: {
	columnId: BoardColumnId;
	title: string;
	count: number;
}): React.ReactElement {
	return (
		<span style={{ display: "flex", alignItems: "center", gap: 8 }}>
			<ColumnIndicator columnId={columnId} />
			<span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span>
			<span className="text-text-secondary" style={{ fontSize: 11 }}>
				{count}
			</span>
		</span>
	);
}
