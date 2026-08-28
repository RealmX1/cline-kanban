import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, SlidersHorizontal } from "lucide-react";

import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import {
	type TaskSpotlightSearchResultRowFieldId,
	type TaskSpotlightSearchResultRowFieldVisibility,
	TOGGLEABLE_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS,
} from "@/components/task-spotlight-search-result-row-field-visibility";
import { cn } from "@/components/ui/cn";

/**
 * 结果行字段开关菜单。不可关字段（stage 色块 / 主文本）刻意不出现在这里——关掉它们只会得到空行。
 */
export function TaskSpotlightSearchResultRowFieldVisibilityMenu({
	fieldVisibility,
	onToggleFieldVisibility,
	shouldUseMobileMinimumTouchTarget,
}: {
	fieldVisibility: TaskSpotlightSearchResultRowFieldVisibility;
	onToggleFieldVisibility: (fieldId: TaskSpotlightSearchResultRowFieldId, isVisible: boolean) => void;
	shouldUseMobileMinimumTouchTarget: boolean;
}): React.ReactElement {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label="Choose result fields"
					title="Choose result fields"
					data-testid="task-spotlight-search-result-row-field-visibility-menu-trigger"
					className={cn(
						"inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 px-2 text-text-secondary hover:text-text-primary",
						shouldUseMobileMinimumTouchTarget ? MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME : "h-6",
					)}
				>
					<SlidersHorizontal size={12} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50 min-w-[190px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
				>
					{TOGGLEABLE_TASK_SPOTLIGHT_SEARCH_RESULT_ROW_FIELD_DEFINITIONS.map((definition) => {
						const isVisible = fieldVisibility[definition.id];
						return (
							<DropdownMenu.CheckboxItem
								key={definition.id}
								checked={isVisible}
								onCheckedChange={(nextChecked) => onToggleFieldVisibility(definition.id, nextChecked === true)}
								onSelect={(event) => event.preventDefault()}
								className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-text-secondary outline-none data-[highlighted]:bg-surface-3 data-[state=checked]:text-text-primary"
							>
								<span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
									{isVisible ? <Check size={12} /> : null}
								</span>
								{definition.menuLabel}
							</DropdownMenu.CheckboxItem>
						);
					})}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
