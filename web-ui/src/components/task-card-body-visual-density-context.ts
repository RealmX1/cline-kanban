import { createContext, useContext } from "react";

/**
 * 卡体的视觉密度。只改排版，不改内容：两种密度显示的信息项完全相同。
 *   standard_card_with_floating_capsule —— 主看板：带边框的卡片，agent 图标与时长药丸收在左上角浮动胶囊里。
 *   compact_row_in_focus_view_left_column —— Focus View 左栏（本体卡、rail 焦点卡克隆、置顶板分身）与跨项目面板的
 *     展开卡：与 All projects 行同一风格的平铺行——第 1 行 agent 图标 + 标题，第 2 行会话活动，第 3 行元信息
 *     （目录 / git 统计 / 资源占用 / 置顶 / 徽标）左对齐、时长药丸右对齐。
 * 独立成模块（而不是放在 task-card-body.tsx 里）：不少测试整体 mock 掉 task-card-body，提供方不能跟着被 mock 掉。
 * 用 context 下发而不是逐层透传：Focus View 左栏的三种渲染角色都在 ColumnContextPanel 子树里，一处提供即全覆盖。
 */
export type TaskCardBodyVisualDensity = "standard_card_with_floating_capsule" | "compact_row_in_focus_view_left_column";

const TaskCardBodyVisualDensityContext = createContext<TaskCardBodyVisualDensity>(
	"standard_card_with_floating_capsule",
);

export const TaskCardBodyVisualDensityProvider = TaskCardBodyVisualDensityContext.Provider;

export function useTaskCardBodyVisualDensity(): TaskCardBodyVisualDensity {
	return useContext(TaskCardBodyVisualDensityContext);
}
