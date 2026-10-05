import type { CrossProjectTaskSwitcherPromptCacheWarmthEstimate } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import type { ReactElement } from "react";

import { CrossProjectTaskSwitcherRowPromptCacheWarmthPill } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-prompt-cache-warmth-pill";

/**
 * hover 浮层 / 「Keep open」后那张完整卡片上方的一条：精简行上有、完整卡片上没有的信息（项目名、未读交接圆点、
 * Cache warm 药丸），加上「Keep open」或「Collapse」按钮。
 *
 * 不叫 Pin：Pin 是 Pinboard（置顶）的专名，同一行上已经有置顶按钮。
 */
export function CrossProjectTaskSwitcherFullTaskCardHeaderStrip({
	projectName,
	isUnreadHandoff,
	promptCacheWarmthEstimate,
	nowMs,
	fullTaskCardKeepOpenAction,
}: {
	// null = 只有一个项目，不显示项目名。
	projectName: string | null;
	isUnreadHandoff: boolean;
	promptCacheWarmthEstimate?: CrossProjectTaskSwitcherPromptCacheWarmthEstimate;
	nowMs: number;
	fullTaskCardKeepOpenAction:
		| { kind: "keep_full_task_card_open_in_list"; onKeepOpen: () => void }
		| { kind: "collapse_kept_open_full_task_card_back_to_compact_row"; onCollapse: () => void };
}): ReactElement {
	return (
		<div className="flex min-w-0 items-center gap-1.5 px-1 pb-0.5 text-[10px] leading-4 text-text-tertiary">
			{isUnreadHandoff ? (
				<span
					className="inline-block size-1.5 shrink-0 rounded-full bg-accent"
					title="Unread handoff notification"
				/>
			) : null}
			<span className="min-w-0 flex-1 truncate">{projectName ?? ""}</span>
			{promptCacheWarmthEstimate ? (
				<CrossProjectTaskSwitcherRowPromptCacheWarmthPill
					promptCacheWarmthEstimate={promptCacheWarmthEstimate}
					nowMs={nowMs}
				/>
			) : null}
			{fullTaskCardKeepOpenAction.kind === "keep_full_task_card_open_in_list" ? (
				<button
					type="button"
					onClick={fullTaskCardKeepOpenAction.onKeepOpen}
					title="Keep this task open in the list"
					className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm border-none bg-transparent px-1 text-[10px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
					data-testid="cross-project-task-switcher-keep-full-task-card-open-button"
				>
					<ChevronsUpDown size={10} className="shrink-0" />
					Keep open
				</button>
			) : (
				<button
					type="button"
					onClick={fullTaskCardKeepOpenAction.onCollapse}
					title="Collapse back to the compact row"
					className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm border-none bg-transparent px-1 text-[10px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
					data-testid="cross-project-task-switcher-collapse-kept-open-full-task-card-button"
				>
					<ChevronsDownUp size={10} className="shrink-0" />
					Collapse
				</button>
			)}
		</div>
	);
}
