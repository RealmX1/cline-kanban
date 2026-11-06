import { createContext, useContext } from "react";

/**
 * 两种密度共用信息顺序：摘要、Agent 与标题、状态提示、阶段目标、当前行动和详情。
 * standard_bordered_task_card 用于主看板；compact_row_in_focus_view_left_column 用于 Focus View 和跨项目展开卡。
 * 密度只决定卡框、留白和字号，不改变摘要分组与状态判据。
 * 单独提供 context，避免 mock 卡体时一起替换，也免去宿主逐层透传。
 */
export type TaskCardBodyVisualDensity = "standard_bordered_task_card" | "compact_row_in_focus_view_left_column";

const TaskCardBodyVisualDensityContext = createContext<TaskCardBodyVisualDensity>("standard_bordered_task_card");

export const TaskCardBodyVisualDensityProvider = TaskCardBodyVisualDensityContext.Provider;

export function useTaskCardBodyVisualDensity(): TaskCardBodyVisualDensity {
	return useContext(TaskCardBodyVisualDensityContext);
}
