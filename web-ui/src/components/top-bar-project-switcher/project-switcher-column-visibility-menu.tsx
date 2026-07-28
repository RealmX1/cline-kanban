import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Columns3 } from "lucide-react";

import {
	type ProjectSwitcherTableColumnId,
	type ProjectSwitcherTableColumnVisibility,
	TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS,
} from "@/components/top-bar-project-switcher/project-switcher-table-column-definitions";
import { Button } from "@/components/ui/button";

/**
 * 可选列的开关菜单。必有两列（项目名 / Live）刻意不出现在这里——它们是切换器存在的理由，
 * 关掉就没有切换器了；其余额外列（含编组槽位 Slot）都在这里逐个开关。
 */
export function ProjectSwitcherColumnVisibilityMenu({
	columnVisibility,
	onToggleColumnVisibility,
}: {
	columnVisibility: ProjectSwitcherTableColumnVisibility;
	onToggleColumnVisibility: (columnId: ProjectSwitcherTableColumnId, isVisible: boolean) => void;
}): React.ReactElement {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<Button
					variant="ghost"
					size="sm"
					icon={<Columns3 size={14} />}
					aria-label="Choose columns"
					title="Choose columns"
					data-testid="project-switcher-column-visibility-menu-trigger"
				/>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50 min-w-[200px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
				>
					{TOGGLEABLE_PROJECT_SWITCHER_TABLE_COLUMN_DEFINITIONS.map((definition) => {
						const isVisible = columnVisibility[definition.id];
						return (
							<DropdownMenu.CheckboxItem
								key={definition.id}
								checked={isVisible}
								onCheckedChange={(nextChecked) => onToggleColumnVisibility(definition.id, nextChecked === true)}
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
