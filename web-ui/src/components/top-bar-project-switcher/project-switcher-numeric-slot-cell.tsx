import * as RadixPopover from "@radix-ui/react-popover";
import { Plus } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useState } from "react";

import {
	describeProjectNumericSlotGroupJumpHotkey,
	formatProjectNumericSlotGroupJumpHotkeyLabel,
	isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem,
} from "@/components/top-bar-project-switcher/project-numeric-slot-group-hotkey-descriptors";
import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import {
	PROJECT_NUMERIC_SLOT_GROUP_NUMBERS,
	type ProjectNumericSlotGroupNumber,
} from "@/hooks/use-project-numeric-slot-group-assignments";

/**
 * 表格里的编组槽位单元格：鼠标绑定路径。（键盘绑定路径是 use-project-numeric-slot-group-hotkeys 的
 * `mod+alt+数字`，两条路都要有——见计划里用户的明确要求。）
 *
 * 这里用嵌套 Radix Popover 是安全的：DismissableLayer 通过 React 树上的 `onPointerDownCapture`
 * 判定「点击是否落在本层内部」，而 Portal 出去的子 Popover 仍是外层 Content 的 React 子树，
 * 所以点内层不会误关外层（见 @radix-ui/react-dismissable-layer 的 isPointerInsideReactTreeRef）。
 */
export function ProjectSwitcherNumericSlotCell({
	projectId,
	projectName,
	numericSlotGroupNumber,
	projectNameByNumericSlotGroupNumber,
	onAssignProjectToNumericSlotGroupNumber,
	onClearNumericSlotGroupNumber,
}: {
	projectId: string;
	projectName: string;
	numericSlotGroupNumber: ProjectNumericSlotGroupNumber | null;
	projectNameByNumericSlotGroupNumber: ReadonlyMap<ProjectNumericSlotGroupNumber, string>;
	onAssignProjectToNumericSlotGroupNumber: (
		slotNumber: ProjectNumericSlotGroupNumber,
		targetProjectId: string,
	) => void;
	onClearNumericSlotGroupNumber: (slotNumber: ProjectNumericSlotGroupNumber) => void;
}): React.ReactElement {
	const [isSlotPickerOpen, setIsSlotPickerOpen] = useState(false);

	// 行本身可点击（点行=切项目），槽位单元格的所有点击都必须就地截停。
	const stopRowSelection = (event: ReactMouseEvent) => {
		event.stopPropagation();
	};

	const isJumpHotkeyPreempted =
		numericSlotGroupNumber !== null &&
		isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem(numericSlotGroupNumber);

	return (
		<RadixPopover.Root open={isSlotPickerOpen} onOpenChange={setIsSlotPickerOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					onClick={stopRowSelection}
					onMouseDown={stopRowSelection}
					className={cn(
						"inline-flex h-6 min-w-[28px] items-center justify-center rounded-md border border-transparent px-1",
						"hover:border-border-bright hover:bg-surface-3",
						isSlotPickerOpen && "border-border-bright bg-surface-3",
					)}
					aria-label={
						numericSlotGroupNumber === null
							? `Assign a jump hotkey slot to ${projectName}`
							: `Change the jump hotkey slot for ${projectName} (currently ${formatProjectNumericSlotGroupJumpHotkeyLabel(numericSlotGroupNumber)})`
					}
					title={
						numericSlotGroupNumber === null
							? "Assign a jump hotkey slot"
							: describeProjectNumericSlotGroupJumpHotkey(numericSlotGroupNumber)
					}
					data-testid="project-switcher-numeric-slot-cell-trigger"
				>
					{numericSlotGroupNumber === null ? (
						<Plus size={11} className="text-text-tertiary" aria-hidden />
					) : (
						<Kbd className={cn(isJumpHotkeyPreempted && "opacity-50")}>{numericSlotGroupNumber}</Kbd>
					)}
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					className="z-50 rounded-lg border border-border bg-surface-2 p-2 shadow-xl"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					align="start"
					sideOffset={5}
					collisionPadding={8}
					onClick={stopRowSelection}
					onMouseDown={stopRowSelection}
				>
					<div className="mb-1.5 px-0.5 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
						Jump hotkey slot
					</div>
					<div className="grid grid-cols-3 gap-1">
						{PROJECT_NUMERIC_SLOT_GROUP_NUMBERS.map((slotNumber) => {
							const occupyingProjectName = projectNameByNumericSlotGroupNumber.get(slotNumber) ?? null;
							const isAssignedToThisProject = slotNumber === numericSlotGroupNumber;
							const isPreempted = isProjectNumericSlotGroupJumpHotkeyPreemptedByOperatingSystem(slotNumber);
							return (
								<button
									key={slotNumber}
									type="button"
									className={cn(
										"flex h-7 w-9 items-center justify-center rounded-md border text-xs font-medium",
										isAssignedToThisProject
											? "border-accent bg-accent/20 text-accent"
											: "border-border bg-surface-1 text-text-secondary hover:bg-surface-3 hover:text-text-primary",
										isPreempted && !isAssignedToThisProject && "opacity-50",
									)}
									title={[
										describeProjectNumericSlotGroupJumpHotkey(slotNumber),
										occupyingProjectName && !isAssignedToThisProject
											? `Currently bound to ${occupyingProjectName}.`
											: null,
									]
										.filter((line): line is string => line !== null)
										.join(" ")}
									onClick={(event) => {
										stopRowSelection(event);
										onAssignProjectToNumericSlotGroupNumber(slotNumber, projectId);
										setIsSlotPickerOpen(false);
									}}
								>
									{slotNumber}
									{occupyingProjectName && !isAssignedToThisProject ? (
										<span className="ml-1 h-1 w-1 rounded-full bg-text-tertiary" aria-hidden />
									) : null}
								</button>
							);
						})}
					</div>
					{numericSlotGroupNumber !== null ? (
						<button
							type="button"
							className="mt-1.5 w-full rounded-md px-2 py-1 text-left text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
							onClick={(event) => {
								stopRowSelection(event);
								onClearNumericSlotGroupNumber(numericSlotGroupNumber);
								setIsSlotPickerOpen(false);
							}}
						>
							Clear slot {numericSlotGroupNumber}
						</button>
					) : null}
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
