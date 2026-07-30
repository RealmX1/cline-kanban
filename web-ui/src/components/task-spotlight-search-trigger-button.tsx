import { Search } from "lucide-react";

import {
	topBarTaskSpotlightSearchTriggerAnchorKey,
	VERIFICATION_ANCHOR_ATTR,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import { isMacPlatform } from "@/utils/platform";

/**
 * 两种形态共用同一个 testid：入口的存在性与点击行为在两种形态下语义相同，
 * 测试与 e2e 不该因为视口宽度改选择器。
 */
export const OPEN_TASK_SPOTLIGHT_SEARCH_BUTTON_TEST_ID = "open-task-spotlight-search-button";

/**
 * 顶栏里打开任务 Spotlight 搜索的常驻入口。`⌘K`/`Ctrl+K` 之外唯一的入口，
 * 因此 mobile（无物理键盘）下它是可达性的唯一保证，绝不可只在 desktop 渲染。
 *
 * desktop 形态刻意做成「假搜索框」（占位文字 + 键帽徽标）而非纯图标按钮：顶栏此前完全没有
 * 任何 `⌘K` 文案，可发现性为零，徽标本身就是这次要补的提示。
 */
export function TaskSpotlightSearchTriggerButton({
	onOpenTaskSpotlightSearch,
	isMobile,
}: {
	onOpenTaskSpotlightSearch: () => void;
	isMobile: boolean;
}): React.ReactElement {
	if (isMobile) {
		return (
			<Button
				variant="ghost"
				size="sm"
				icon={<Search size={16} />}
				onClick={onOpenTaskSpotlightSearch}
				aria-label="Search tasks"
				data-testid={OPEN_TASK_SPOTLIGHT_SEARCH_BUTTON_TEST_ID}
				{...{ [VERIFICATION_ANCHOR_ATTR]: topBarTaskSpotlightSearchTriggerAnchorKey() }}
				className={cn("shrink-0", MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME)}
			/>
		);
	}

	return (
		<Button
			variant="default"
			size="sm"
			onClick={onOpenTaskSpotlightSearch}
			aria-label="Search tasks"
			data-testid={OPEN_TASK_SPOTLIGHT_SEARCH_BUTTON_TEST_ID}
			{...{ [VERIFICATION_ANCHOR_ATTR]: topBarTaskSpotlightSearchTriggerAnchorKey() }}
			// 宽度必须可收缩：固定宽会在窄桌面窗口下把右侧 git 状态区整个挤掉。
			// basis 给出「像搜索框」的舒适宽度，min-w 保证收缩到底时键帽徽标仍完整。
			className="shrink basis-[190px] min-w-[120px] overflow-hidden font-normal"
		>
			<Search size={13} className="shrink-0 text-text-tertiary" aria-hidden />
			<span className="min-w-0 flex-1 truncate text-left text-text-tertiary">Search tasks</span>
			<span className="flex shrink-0 items-center gap-0.5" aria-hidden>
				<Kbd>{isMacPlatform ? "⌘" : "Ctrl"}</Kbd>
				<Kbd>K</Kbd>
			</span>
		</Button>
	);
}
