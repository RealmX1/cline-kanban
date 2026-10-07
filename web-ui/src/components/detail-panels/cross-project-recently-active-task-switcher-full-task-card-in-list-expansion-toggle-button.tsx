import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";

/**
 * 这一行在列表里是否被用户固定展开成完整卡片。hover 原地展开只是临时「偷看」，不改变这个状态。
 */
export type CrossProjectTaskSwitcherFullTaskCardInListExpansionState =
	| "collapsed_to_compact_row"
	| "kept_expanded_in_list";

const IN_LIST_EXPANSION_TOGGLE_LABEL_BY_EXPANSION_STATE: Record<
	CrossProjectTaskSwitcherFullTaskCardInListExpansionState,
	string
> = {
	collapsed_to_compact_row: "Keep expanded in list",
	kept_expanded_in_list: "Collapse to compact row",
};

/**
 * 命中区扩到 24×24（WCAG 2.2 目标尺寸下限），按钮自身盒子（20×20）与图标坐标不动：伪元素向上扩 4px（正好到卡片上沿，
 * 动作组是 top-1）、向右扩 4px（落在动作组 px-0.5 + right-1 共 6px 的空白里），左沿与按钮左沿齐平——左侧隔 2px（gap-0.5）
 * 就是相邻动作按钮，不能盖住它；也不向下扩，不抢卡体 / 精简行下方内容的点击。
 * 伪元素命中的就是按钮本身（click / :hover 都落在 button 上）；pointer-events 随动作组继承，动作组隐形时伪元素也接不到点击。
 * 三态开关同一坐标靠按钮盒子不变（真实浏览器测试按开关的 getBoundingClientRect 断言），所以只能用伪元素，不能加 padding / margin。
 */
const IN_LIST_EXPANSION_TOGGLE_HIT_AREA_EXTENDED_UP_AND_RIGHT_BEYOND_BUTTON_BOX_CLASS_NAME =
	"relative after:absolute after:-top-1 after:-right-1 after:bottom-0 after:left-0";

/**
 * 「固定展开 / 收起」开关。精简行 hover、hover 原地展开、固定展开的卡片三处都画在卡片右上角同一坐标
 *（各自 hover 动作组的最右一格：right-1 + px-0.5 = 距右 6px，top-1 = 距上 4px，20×20），
 * 点完以后下一个状态的开关正好还在光标下。
 *
 * 不叫 Open：这个面板里「打开」是打开任务（点行就是）。也不叫 Pin：Pin 是 Pinboard 的专名。
 * tooltip 用原生 title：精简行一屏几十行，每行挂一个 Radix Tooltip 不划算。
 *
 * 读屏语义用 aria-pressed（「保持展开」这个开关按没按下），不用 aria-expanded：hover 原地展开时内容已可见展开、
 * 开关却没按下；按下以后内容也没有新展开。aria-expanded 宣布的是内容可见与否，与这个开关的状态对不上。
 */
export function CrossProjectTaskSwitcherFullTaskCardInListExpansionToggleButton({
	expansionState,
	onToggleInListExpansion,
}: {
	expansionState: CrossProjectTaskSwitcherFullTaskCardInListExpansionState;
	onToggleInListExpansion: () => void;
}): ReactElement {
	const label = IN_LIST_EXPANSION_TOGGLE_LABEL_BY_EXPANSION_STATE[expansionState];
	return (
		<Button
			icon={expansionState === "kept_expanded_in_list" ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
			variant="ghost"
			size="xs"
			className={IN_LIST_EXPANSION_TOGGLE_HIT_AREA_EXTENDED_UP_AND_RIGHT_BEYOND_BUTTON_BOX_CLASS_NAME}
			aria-label={label}
			aria-pressed={expansionState === "kept_expanded_in_list"}
			title={label}
			data-testid="cross-project-task-switcher-full-task-card-in-list-expansion-toggle-button"
			data-cross-project-task-switcher-full-task-card-in-list-expansion-state={expansionState}
			onClick={(event) => {
				// 不冒泡到卡体 / 行：卡体单击 = 打开任务。
				event.stopPropagation();
				onToggleInListExpansion();
			}}
		/>
	);
}
